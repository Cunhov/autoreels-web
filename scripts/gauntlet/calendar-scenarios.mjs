#!/usr/bin/env node
/**
 * Calendar gauntlet scenario runner — C1..C6 (invariant harness).
 *
 * Drives a RUNNING standalone app (see calendar-run.sh). Seeds Posts + a
 * planner/channel directly via prisma; uses the real HTTP API for the
 * OPERATIONS under test (calendar window query, posts PATCH/DELETE, posts
 * create). NO product fixes.
 *
 * Usage:
 *   node calendar-scenarios.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --server-log <log> --out <dir>
 *
 * Exit code 0 only if every scenario passes.
 */
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { encode } from "next-auth/jwt";

// ── Config ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (key) => {
	const i = argv.indexOf(key);
	return i >= 0 ? argv[i + 1] : null;
};
const BASE = getArg("--base");
const DB_PATH = getArg("--db");
const SECRET = getArg("--secret");
const SERVER_LOG = getArg("--server-log");
const OUT_DIR = getArg("--out");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--server-log", SERVER_LOG],
	["--out", OUT_DIR],
]) {
	if (!value) {
		console.error(`Missing required argument ${name}`);
		process.exit(2);
	}
}

const prisma = new PrismaClient({
	adapter: new PrismaBetterSqlite3({ url: "file:" + DB_PATH }),
});

// ── Auth: mint a next-auth session JWT (sub='admin') ────────────────────────
const SESSION_COOKIE = `next-auth.session-token=${await encode({
	token: { sub: "admin" },
	secret: SECRET,
	maxAge: 3600,
})}`;

const NS_POST_PREFIX = "cal-gauntlet-"; // post ids use this prefix for cleanup

let resultsTotal = [];

function record(label, pass, line, detail = {}) {
	resultsTotal.push({ scenario: label, pass, line, detail });
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
}

async function req(path, { method = "GET", body, headers = {} } = {}) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: { Cookie: SESSION_COOKIE, ...headers },
		body,
	});
	let json = null;
	try {
		json = await res.json();
	} catch {
		/* non-JSON */
	}
	return { status: res.status, ok: res.ok, json };
}

async function seedUser() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
}

async function seedChannel(id = "cal-chan-1") {
	await prisma.channel.upsert({
		where: { id },
		update: {},
		create: {
			id,
			user_id: "admin",
			name: `Cal Chan ${id}`,
			platform: "instagram",
			access_token: "IG-token-for-calendar-harness",
			account_id: "acct-cal",
			status: "active",
		},
	});
	return id;
}

async function seedPlanner(id = "cal-planner-1", name = "Planner Alfa") {
	await prisma.planner.upsert({
		where: { id },
		update: {},
		create: {
			id,
			user_id: "admin",
			name,
			config: JSON.stringify({
				frequency: { value: 5, unit: "minutes" },
				content: [
					{
						type: "config",
						url: "https://example.com/x.mp4",
						media_type: "REELS",
					},
				],
			}),
			status: "active",
		},
	});
	return id;
}

async function seedPost(data) {
	const id =
		data.id || `${NS_POST_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
	return prisma.post.create({
		data: {
			id,
			user_id: "admin",
			status: "pending",
			media_type: "REELS",
			...data,
		},
	});
}

const ISO = (d) => new Date(d).toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// C1 — calendar window query correctness
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioC1() {
	const W_START = "2026-01-01T00:00:00Z";
	const W_END = "2026-01-31T23:59:59Z";
	await seedPost({
		id: `${NS_POST_PREFIX}c1-a`,
		scheduled_at: "2026-01-05T12:00:00Z",
		caption: "A",
	});
	await seedPost({
		id: `${NS_POST_PREFIX}c1-b`,
		scheduled_at: "2026-01-15T12:00:00Z",
		caption: "B",
	});
	await seedPost({
		id: `${NS_POST_PREFIX}c1-c`,
		scheduled_at: "2026-01-25T12:00:00Z",
		caption: "C",
	});
	await seedPost({
		id: `${NS_POST_PREFIX}c1-before`,
		scheduled_at: "2025-12-31T23:00:00Z",
	});
	await seedPost({
		id: `${NS_POST_PREFIX}c1-after`,
		scheduled_at: "2026-02-01T00:00:00Z",
	});
	await seedPost({ id: `${NS_POST_PREFIX}c1-null`, scheduled_at: null });
	await seedPost({
		id: `${NS_POST_PREFIX}c1-pub`,
		scheduled_at: "2026-01-10T12:00:00Z",
		status: "published",
		published_at: "2026-01-10T12:05:00Z",
	});

	const r = await req(
		`/api/calendar?start=${encodeURIComponent(W_START)}&end=${encodeURIComponent(W_END)}`,
	);
	const posts = r.json?.posts || [];
	const ids = posts.map((p) => p.id);
	const ordered = posts.every(
		(p, i) =>
			i === 0 ||
			new Date(posts[i - 1].scheduled_at) <= new Date(p.scheduled_at),
	);
	const hasFields = posts.every(
		(p) =>
			p.status !== undefined &&
			p.media_type !== undefined &&
			p.scheduled_at !== undefined &&
			p.caption !== undefined,
	);
	const inWindowOnly =
		ids.includes(`${NS_POST_PREFIX}c1-a`) &&
		ids.includes(`${NS_POST_PREFIX}c1-b`) &&
		ids.includes(`${NS_POST_PREFIX}c1-c`) &&
		ids.includes(`${NS_POST_PREFIX}c1-pub`) &&
		!ids.includes(`${NS_POST_PREFIX}c1-before`) &&
		!ids.includes(`${NS_POST_PREFIX}c1-after`) &&
		!ids.includes(`${NS_POST_PREFIX}c1-null`) &&
		posts.length === 4;

	const pass = r.status === 200 && inWindowOnly && ordered && hasFields;

	// Edge cases (record real behavior; no 500 allowed):
	const edgeTooFar = await req(
		"/api/calendar?start=2026-06-01T00:00:00Z&end=2026-01-01T00:00:00Z",
	);
	const edgeMissing = await req("/api/calendar");
	const edgeBadDate = await req(
		"/api/calendar?start=notadate&end=2026-01-31T00:00:00Z",
	);
	const edgeLimit = await req(
		`/api/calendar?start=${encodeURIComponent(W_START)}&end=${encodeURIComponent(W_END)}&limit=2`,
	);
	const edgeFilter = await req(
		`/api/calendar?start=${encodeURIComponent(W_START)}&end=${encodeURIComponent(W_END)}&status=published`,
	);
	const no500 =
		edgeTooFar.status !== 500 &&
		edgeMissing.status !== 500 &&
		edgeBadDate.status !== 500 &&
		edgeLimit.status !== 500 &&
		edgeFilter.status !== 500;

	record(
		"C1",
		Boolean(pass && no500),
		`window: ${posts.length} posts (A,B,C,pub in; before/after/null excluded) ordered=${ordered} fields=${hasFields} | edges: start>end=${edgeTooFar.status}/${edgeTooFar.json?.posts?.length ?? "-"} missing=${edgeMissing.status} badDate=${edgeBadDate.status} limit=2→${edgeLimit.json?.posts?.length ?? "-"} status=published→${edgeFilter.json?.posts?.length ?? "-"} no500=${no500}`,
		{
			windowStatus: r.status,
			ids,
			edges: {
				tooFar: edgeTooFar.status,
				missing: edgeMissing.status,
				badDate: edgeBadDate.status,
				limit2: edgeLimit.json?.posts?.length ?? null,
				filterPublished: edgeFilter.json?.posts?.length ?? null,
			},
		},
	);
	await prisma.post
		.deleteMany({
			where: { id: { startsWith: NS_POST_PREFIX + "c1" } },
		})
		.catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// C2 — move/reschedule invariants
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioC2() {
	await seedChannel("cal-chan-2");
	const future1 = new Date(Date.now() + 60 * 60 * 1000);
	const future2 = new Date(Date.now() + 2 * 60 * 60 * 1000);
	const future3 = new Date(Date.now() + 3 * 60 * 60 * 1000);
	const future4 = new Date(Date.now() + 4 * 60 * 60 * 1000);
	const past = new Date(Date.now() - 60 * 60 * 1000);

	// Create via the real API (whitelist + ownership + status=pending).
	const created = await req("/api/posts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			caption: "C2 move",
			media_type: "REELS",
			channel_id: "cal-chan-2",
			scheduled_at: future1.toISOString(),
		}),
	});
	const postId = created.json?.id;

	// Move to a different future slot → lands in the new window only.
	const moved = await req(`/api/posts/${postId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scheduled_at: future2.toISOString() }),
	});
	const inNew = await req(
		`/api/calendar?start=${encodeURIComponent(ISO(new Date(future2.getTime() - 60_000)))}&end=${encodeURIComponent(ISO(new Date(future2.getTime() + 60_000)))}`,
	);
	const inOld = await req(
		`/api/calendar?start=${encodeURIComponent(ISO(new Date(future1.getTime() - 60_000)))}&end=${encodeURIComponent(ISO(new Date(future1.getTime() + 60_000)))}`,
	);
	const moveOk =
		moved.status === 200 &&
		(inNew.json?.posts || []).some((p) => p.id === postId) &&
		!(inOld.json?.posts || []).some((p) => p.id === postId);

	// Move to the past → rejected (documented contract: scheduled_at must be future).
	const toPast = await req(`/api/posts/${postId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scheduled_at: past.toISOString() }),
	});
	const pastRejected = toPast.status === 400;

	// Concurrent PATCHes to two different future slots → both 200, final is one of them.
	const [c1, c2] = await Promise.all([
		req(`/api/posts/${postId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scheduled_at: future3.toISOString() }),
		}),
		req(`/api/posts/${postId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scheduled_at: future4.toISOString() }),
		}),
	]);
	const finalRow = await prisma.post.findUnique({ where: { id: postId } });
	const finalTs = finalRow?.scheduled_at
		? new Date(finalRow.scheduled_at).getTime()
		: null;
	const concurrentOk =
		c1.status === 200 &&
		c2.status === 200 &&
		(finalTs === future3.getTime() || finalTs === future4.getTime());

	// Published posts cannot be modified.
	await prisma.post.update({
		where: { id: postId },
		data: { status: "published", published_at: new Date() },
	});
	const touchPublished = await req(`/api/posts/${postId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scheduled_at: future3.toISOString() }),
	});
	const publishedProtected = touchPublished.status === 400;

	// Scheduling-layer contract: a slot violating the channel's publish interval
	// is allowed here (the publisher throttles at publish time, not here).
	await prisma.post.create({
		data: {
			id: `${NS_POST_PREFIX}c2-interval`,
			user_id: "admin",
			channel_id: "cal-chan-2",
			caption: "recent publish",
			media_type: "REELS",
			status: "published",
			published_at: new Date(),
			scheduled_at: new Date(Date.now() - 60_000),
		},
	});
	await prisma.post.create({
		data: {
			id: `${NS_POST_PREFIX}c2-near`,
			user_id: "admin",
			channel_id: "cal-chan-2",
			caption: "near interval",
			media_type: "REELS",
			status: "pending",
			scheduled_at: new Date(Date.now() + 60_000),
		},
	});
	const nearInterval = await req(`/api/posts/${NS_POST_PREFIX}c2-near`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			scheduled_at: new Date(Date.now() + 2 * 60_000).toISOString(),
		}),
	});
	const intervalContract = nearInterval.status === 200;

	const pass =
		moveOk &&
		pastRejected &&
		concurrentOk &&
		publishedProtected &&
		intervalContract;
	record(
		"C2",
		Boolean(pass),
		`move: ${moveOk} pastRejected=${pastRejected}(${toPast.status}) concurrent: ${c1.status}/${c2.status} final∈{3h,4h}=${concurrentOk} publishedProtected=${publishedProtected}(${touchPublished.status}) intervalViolationAllowedAtSchedulingLayer=${intervalContract}`,
		{
			moveOk,
			pastStatus: toPast.status,
			concurrentStatuses: [c1.status, c2.status],
			finalTs: finalTs ? new Date(finalTs).toISOString() : null,
			publishedPatchStatus: touchPublished.status,
		},
	);
	await prisma.post
		.deleteMany({
			where: { id: { startsWith: NS_POST_PREFIX + "c2" } },
		})
		.catch(() => {});
	await prisma.post.delete({ where: { id: postId } }).catch(() => {});
	await prisma.channel
		.deleteMany({ where: { id: "cal-chan-2" } })
		.catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// C3 — delete from calendar
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioC3() {
	await seedChannel("cal-chan-3");
	await seedPlanner("cal-planner-3", "Planner Three");
	const p = await seedPost({
		id: `${NS_POST_PREFIX}c3-post`,
		channel_id: "cal-chan-3",
		planner_id: "cal-planner-3",
		scheduled_at: "2026-02-10T12:00:00Z",
		caption: "C3 delete me",
	});
	const before = await req(
		"/api/calendar?start=2026-02-01T00:00:00Z&end=2026-02-28T23:59:59Z",
	);
	const del = await req(`/api/posts/${p.id}`, { method: "DELETE" });
	const after = await req(
		"/api/calendar?start=2026-02-01T00:00:00Z&end=2026-02-28T23:59:59Z",
	);
	const rowGone =
		(await prisma.post.findUnique({ where: { id: p.id } })) === null;
	const delAgain = await req(`/api/posts/${p.id}`, { method: "DELETE" });
	const channelStill =
		(await prisma.channel.findUnique({ where: { id: "cal-chan-3" } })) !== null;
	const plannerStill =
		(await prisma.planner.findUnique({ where: { id: "cal-planner-3" } })) !==
		null;
	const inBefore = (before.json?.posts || []).some((x) => x.id === p.id);
	const inAfter = !(after.json?.posts || []).some((x) => x.id === p.id);

	const pass =
		del.status === 200 &&
		inBefore &&
		rowGone &&
		inAfter &&
		delAgain.status === 404 &&
		channelStill &&
		plannerStill;
	record(
		"C3",
		Boolean(pass),
		`delete: ${del.status} inBefore=${inBefore} rowGone=${rowGone} inAfter=${inAfter} again=${delAgain.status} channelIntact=${channelStill} plannerIntact=${plannerStill}`,
		{ delStatus: del.status, againStatus: delAgain.status },
	);
	await prisma.channel
		.deleteMany({ where: { id: "cal-chan-3" } })
		.catch(() => {});
	await prisma.planner
		.deleteMany({ where: { id: "cal-planner-3" } })
		.catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// C4 — every UI status flows through the API
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioC4() {
	const statuses = [
		"pending",
		"scheduled",
		"processing",
		"processing_upload",
		"processing_children",
		"ready_to_publish",
		"published",
		"failed",
		"cancelled",
	];
	let i = 0;
	for (const status of statuses) {
		await seedPost({
			id: `${NS_POST_PREFIX}c4-${i}`,
			status,
			scheduled_at: "2026-03-05T12:00:00Z",
			caption: `C4 ${status}`,
			...(status === "published"
				? { published_at: "2026-03-05T12:05:00Z" }
				: {}),
			...(status === "failed"
				? { error_message: "boom", failed_reason: "Test" }
				: {}),
		});
		i++;
	}
	const r = await req(
		"/api/calendar?start=2026-03-01T00:00:00Z&end=2026-03-31T23:59:59Z",
	);
	const returned = (r.json?.posts || []).map((p) => p.status).sort();
	const expected = [...statuses].sort();
	const allStatuses = returned.join(",") === expected.join(",");
	const pass = r.status === 200 && allStatuses;
	record(
		"C4",
		Boolean(pass),
		`statuses returned: ${returned.join(",")} (expected ${expected.join(",")}) → all=${allStatuses}`,
		{ returned, expected },
	);
	await prisma.post
		.deleteMany({
			where: { id: { startsWith: NS_POST_PREFIX + "c4" } },
		})
		.catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// C5 — planner-created posts appear with their planner_id
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioC5() {
	await seedChannel("cal-chan-5");
	await seedPlanner("cal-planner-5", "Planner Five");
	const p = await seedPost({
		id: `${NS_POST_PREFIX}c5-planned`,
		channel_id: "cal-chan-5",
		planner_id: "cal-planner-5",
		scheduled_at: "2026-04-12T09:30:00Z",
		caption: "C5 from planner",
	});
	const r = await req(
		"/api/calendar?start=2026-04-01T00:00:00Z&end=2026-04-30T23:59:59Z",
	);
	const hit = (r.json?.posts || []).find((x) => x.id === p.id);
	const pass =
		r.status === 200 &&
		hit !== undefined &&
		hit.planner_id === "cal-planner-5" &&
		hit.channel_id === "cal-chan-5";
	record(
		"C5",
		Boolean(pass),
		`planner post: found=${hit !== undefined} planner_id=${hit?.planner_id ?? "-"} channel_id=${hit?.channel_id ?? "-"} (modal planner-name rendering is checked in the visual part)`,
		{ planner_id: hit?.planner_id ?? null },
	);
	await prisma.post
		.deleteMany({
			where: { id: { startsWith: NS_POST_PREFIX + "c5" } },
		})
		.catch(() => {});
	await prisma.channel
		.deleteMany({ where: { id: "cal-chan-5" } })
		.catch(() => {});
	await prisma.planner
		.deleteMany({ where: { id: "cal-planner-5" } })
		.catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// C6 — large window: 300 posts / 3 months + one 40-post day
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioC6() {
	// 100 posts per month over 3 months + 40 posts on a single day (2026-05-10).
	const rows = [];
	for (let m = 3; m <= 5; m++) {
		for (let i = 0; i < 100; i++) {
			const day = 1 + (i % 27);
			rows.push({
				id: `${NS_POST_PREFIX}c6-m${m}-${i}`,
				user_id: "admin",
				status: i % 3 === 0 ? "published" : "pending",
				media_type: "REELS",
				caption: `C6 m${m} i${i}`,
				scheduled_at: new Date(
					`2026-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00Z`,
				),
			});
		}
	}
	for (let i = 0; i < 40; i++) {
		rows.push({
			id: `${NS_POST_PREFIX}c6-burst-${i}`,
			user_id: "admin",
			status: "pending",
			media_type: "REELS",
			caption: `C6 burst ${i}`,
			scheduled_at: new Date(
				`2026-05-10T${String(9 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
			),
		});
	}
	// createMany in chunks (SQLite bind limit).
	for (let start = 0; start < rows.length; start += 200) {
		await prisma.post.createMany({ data: rows.slice(start, start + 200) });
	}

	const r = await req(
		"/api/calendar?start=2026-03-01T00:00:00Z&end=2026-05-31T23:59:59Z",
	);
	const posts = r.json?.posts || [];
	const burstCount = posts.filter((p) =>
		p.id.startsWith(`${NS_POST_PREFIX}c6-burst`),
	).length;
	const cap = await req(
		"/api/calendar?start=2026-03-01T00:00:00Z&end=2026-05-31T23:59:59Z&limit=250",
	);
	// 300 (3 months × 100) + 40 burst all live INSIDE the window → 340 total.
	const pass =
		r.status === 200 &&
		posts.length === 340 &&
		burstCount === 40 &&
		(cap.json?.posts?.length ?? 0) === 250;
	record(
		"C6",
		Boolean(pass),
		`340 posts window (300 monthly + 40 burst) → ${posts.length} (burst day = ${burstCount}/40) limit=250→${cap.json?.posts?.length ?? "-"}`,
		{
			total: posts.length,
			burstCount,
			limited: cap.json?.posts?.length ?? null,
		},
	);
	await prisma.post
		.deleteMany({
			where: { id: { startsWith: NS_POST_PREFIX + "c6" } },
		})
		.catch(() => {});
}

/**
 * C6b — >500-post window: the page passes limit=1000 (the route's max) so the
 * NEWEST posts are never silently truncated. The route's DEFAULT cap is 500
 * (ordered asc → the newest are dropped); the page's explicit limit=1000 is
 * what fixes the truncation the critic found. Seeds 520 posts in the current
 * month and asserts both behaviors.
 */
async function scenarioC6b() {
	const now = new Date();
	const year = now.getFullYear();
	const month = now.getMonth();
	const rows = [];
	for (let day = 1; day <= 26; day++) {
		for (let i = 0; i < 20; i++) {
			rows.push({
				id: `${NS_POST_PREFIX}c6b-d${day}-${i}`,
				user_id: "admin",
				status: i % 3 === 0 ? "published" : "pending",
				media_type: "REELS",
				caption: `C6b d${day} i${i}`,
				scheduled_at: new Date(year, month, day, 9 + (i % 10), i % 60, 0),
			});
		}
	}
	for (let start = 0; start < rows.length; start += 200) {
		await prisma.post.createMany({ data: rows.slice(start, start + 200) });
	}

	const startIso = `${year}-${String(month + 1).padStart(2, "0")}-01T00:00:00Z`;
	const endIso = new Date(year, month + 1, 0).toISOString();
	const newestId = `${NS_POST_PREFIX}c6b-d26-19`; // last seeded → newest by asc order

	// Page contract: explicit limit=1000 → all 520 returned, newest present.
	const full = await req(
		`/api/calendar?start=${startIso}&end=${endIso}&limit=1000`,
	);
	const fullPosts = full.json?.posts || [];
	const newestPresent = fullPosts.some((p) => p.id === newestId);

	// Documented default: no limit → route cap 500 drops the newest (ordered
	// asc) — the exact silent truncation the page's limit=1000 avoids.
	const def = await req(`/api/calendar?start=${startIso}&end=${endIso}`);
	const defPosts = def.json?.posts || [];
	const newestAbsentAtDefault = !defPosts.some((p) => p.id === newestId);

	const pass =
		full.status === 200 &&
		fullPosts.length === 520 &&
		newestPresent &&
		defPosts.length === 500 &&
		newestAbsentAtDefault;
	record(
		"C6b",
		Boolean(pass),
		`520-post window: limit=1000 → ${fullPosts.length}/520 newestPresent=${newestPresent} | default(500 cap) → ${defPosts.length} newestAbsent=${newestAbsentAtDefault}`,
		{ full: fullPosts.length, default: defPosts.length, newestPresent },
	);
	await prisma.post
		.deleteMany({
			where: { id: { startsWith: NS_POST_PREFIX + "c6b" } },
		})
		.catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════════════
await seedUser();

const scenarios = [
	["C1", scenarioC1],
	["C2", scenarioC2],
	["C3", scenarioC3],
	["C4", scenarioC4],
	["C5", scenarioC5],
	["C6", scenarioC6],
	["C6b", scenarioC6b],
];
let failed = 0;
for (const [label, fn] of scenarios) {
	try {
		await fn();
	} catch (err) {
		failed++;
		resultsTotal.push({
			scenario: label,
			pass: false,
			line: `EXCEPTION: ${err?.message || err}`,
		});
		console.error(`SCENARIO ${label}: EXCEPTION — ${err?.stack || err}`);
	}
}
const anyPass = resultsTotal.filter((r) => r.pass).length;
console.log("\n=== SUMMARY ===");
for (const r of resultsTotal)
	console.log(`${r.scenario}: ${r.pass ? "PASS" : "FAIL"} — ${r.line}`);
console.log(`\nTOTAL: ${anyPass}/${resultsTotal.length} pass`);

// Global no-crash check on the server log (whole run).
const wholeLog = readFileSync(SERVER_LOG, "utf8");
const crashes = (wholeLog.match(/Unhandled|TypeError|ENOENT/g) || []).length;
console.log(`server log crash-signal lines: ${crashes}`);
if (crashes > 0 && failed === 0) failed = 1;

try {
	appendFileSync(
		join(OUT_DIR, "summary.txt"),
		`\nserver-log crash-signal lines: ${crashes}\n`,
	);
} catch {
	/* evidence dir may not be writable */
}
await prisma.$disconnect();
process.exit(failed > 0 || anyPass !== resultsTotal.length ? 1 : 0);
