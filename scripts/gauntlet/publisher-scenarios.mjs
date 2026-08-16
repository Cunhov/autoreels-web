#!/usr/bin/env node
/**
 * Publisher gauntlet scenario runner — P1..P11.
 *
 * Drives a RUNNING standalone app (see boot.sh) whose Graph API calls are
 * intercepted by scripts/gauntlet/fetch-mock.mjs (preload). This file seeds DB
 * rows, writes mock rules, triggers cron ticks and asserts the bar scenarios
 * in gauntlet-runs/module-01-publisher/refs/bar-scenarios.md. NO product fixes.
 *
 * Usage:
 *   node publisher-scenarios.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --cron-secret <CRON_SECRET> --mock-state <state.json>
 *        --mock-calls <calls.jsonl> --server-log <server.log> --out <dir>
 *
 * Exit code 0 only if every scenario passes.
 */
import {
	appendFileSync,
	writeFileSync,
	readFileSync,
	existsSync,
	truncateSync,
} from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// ── Config ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (key) => {
	const i = argv.indexOf(key);
	return i >= 0 ? argv[i + 1] : null;
};
const BASE = getArg("--base");
const DB_PATH = getArg("--db");
const CRON_SECRET = getArg("--cron-secret");
const MOCK_STATE = getArg("--mock-state");
const MOCK_CALLS = getArg("--mock-calls");
const SERVER_LOG = getArg("--server-log");
const OUT_DIR = getArg("--out");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--cron-secret", CRON_SECRET],
	["--mock-state", MOCK_STATE],
	["--mock-calls", MOCK_CALLS],
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

// ── Small helpers ───────────────────────────────────────────────────────────

function writeState(rules) {
	const consumed = {};
	rules.forEach((_, i) => (consumed[i] = 0));
	writeFileSync(MOCK_STATE, JSON.stringify({ rules, consumed }));
	truncateSync(MOCK_CALLS, 0);
}

function readCalls() {
	if (!existsSync(MOCK_CALLS)) return [];
	return readFileSync(MOCK_CALLS, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

/** count calls: {kind?, method?, urlIncludes?, urlRegex?, status?} */
function countCalls({ kind, method, urlIncludes, urlRegex, status } = {}) {
	return readCalls().filter((c) => {
		if (kind && c.kind !== kind) return false;
		if (method && c.method !== method) return false;
		if (urlIncludes && !c.url.includes(urlIncludes)) return false;
		if (urlRegex && !new RegExp(urlRegex).test(c.url)) return false;
		if (status !== undefined && c.status !== status) return false;
		return true;
	}).length;
}

let logOffset = 0;
function readServerLog() {
	if (!existsSync(SERVER_LOG)) return "";
	const content = readFileSync(SERVER_LOG, "utf8");
	if (logOffset > content.length) logOffset = 0;
	const tail = content.slice(logOffset);
	logOffset = content.length;
	return tail;
}

let resultsTotal = [];
/** Parse stored instagram_child_ids (index-aware / legacy positional) → Map<index,id>. */
function parseChildIdEntriesForTest(raw) {
	const entries = new Map();
	if (!raw) return entries;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return entries;
	}
	if (!Array.isArray(parsed)) return entries;
	const first = parsed[0];
	if (first && typeof first === "object" && typeof first.index === "number" && typeof first.id === "string") {
		for (const item of parsed) {
			if (item && typeof item.index === "number" && typeof item.id === "string") entries.set(item.index, item.id);
		}
	} else {
		for (let i = 0; i < parsed.length; i++) entries.set(i, parsed[i]);
	}
	return entries;
}

function record(label, pass, line, detail = {}) {
	resultsTotal.push({ scenario: label, pass, line, detail });
	// Best-effort raw evidence snapshot at verdict time (calls before the next
	// scenario's state reset truncates them). P3's per-tick child-create counts
	// are captured inside the scenario BEFORE resets — see the summary line.
	try {
		writeFileSync(
			join(OUT_DIR, `calls-${label}.jsonl`),
			readCalls()
				.map((c) => JSON.stringify(c))
				.join("\n"),
		);
	} catch {
		/* non-fatal: summary remains the source of truth */
	}
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
}

async function tick() {
	const start = Date.now();
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), 150_000);
	let res;
	try {
		res = await fetch(`${BASE}/api/cron/publisher`, {
			method: "POST",
			headers: { "x-cron-auth": CRON_SECRET },
			signal: ctl.signal,
		});
	} finally {
		clearTimeout(timer);
	}
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* non-JSON */
	}
	return { status: res.status, json, text, elapsedMs: Date.now() - start };
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000);
const future = (ms) => new Date(Date.now() + ms);
const JSON_OF = (items) => JSON.stringify(items);

async function seedUser() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
}

async function seedChannel(overrides) {
	const base = {
		user_id: "admin",
		name: "chan",
		platform: "instagram",
		access_token: "IGGauntletToken",
		token_source: "manual",
		token_refreshed_at: future(60 * 60_000),
		token_expires_at: future(30 * 24 * 60 * 60_000),
		account_id: "acct",
		status: "active",
		settings: null,
	};
	await prisma.channel.create({ data: { ...base, ...overrides } });
}

async function seedPost(overrides) {
	const base = {
		user_id: "admin",
		status: "pending",
		scheduled_at: null,
		media_type: "REELS",
		video_url: "/api/file/seed.mp4",
		attempts: 0,
	};
	return prisma.post.create({ data: { ...base, ...overrides } });
}

async function cleanupScenario(ids) {
	if (ids?.posts?.length)
		await prisma.post.deleteMany({ where: { id: { in: ids.posts } } });
	if (ids?.channels?.length)
		await prisma.channel.deleteMany({ where: { id: { in: ids.channels } } });
}

// A rule builder flattening {urlIn, bodyIn, status, body2, delayMs, method} → mock rule
function rule(urlSub, bodySub, responses, method = "POST") {
	const r = { method, responses };
	if (urlSub) r.match = urlSub;
	if (bodySub) r.matchBody = bodySub;
	return r;
}
const okId = (id) => ({ status: 200, body: { id } });
const okStatus = (code) => ({ status: 200, body: { status_code: code } });

// FINISHED for any container status poll (rule must be BEFORE media create rules
// only if URLs collide — poll URLs contain 'fields=status_code', they never do).
const finishedPoll = rule(
	"fields=status_code",
	null,
	[okStatus("FINISHED")],
	"GET",
);
const inProgressPoll = rule(
	"fields=status_code",
	null,
	[okStatus("IN_PROGRESS")],
	"GET",
);
const publishOk = rule("media_publish", null, [okId("media-ok")]);

// ── P1 ──────────────────────────────────────────────────────────────────────
async function scenarioP1() {
	const ids = { posts: [], channels: [] };
	const postCtx = { user_id: "admin", channel_id: "chan-p1", planner_id: null };
	await seedChannel({ id: "chan-p1", account_id: "acct-p1" });
	ids.channels.push("chan-p1");

	// (a) stuck 'processing', no container, created 20 min ago
	ids.posts.push(
		(
			await seedPost({
				id: "p1a",
				...postCtx,
				status: "processing",
				created_at: minutesAgo(20),
				last_attempt_at: null,
			})
		).id,
	);
	// (b) stuck 'processing_upload' 3h, with container
	ids.posts.push(
		(
			await seedPost({
				id: "p1b",
				...postCtx,
				status: "processing_upload",
				instagram_container_id: "cnt-b",
				container_created_at: minutesAgo(180),
				created_at: minutesAgo(190),
				last_attempt_at: minutesAgo(180),
			})
		).id,
	);
	// (c) stuck 'processing_children' 3h
	ids.posts.push(
		(
			await seedPost({
				id: "p1c",
				...postCtx,
				status: "processing_children",
				instagram_child_ids: JSON_OF(["cnt-c0"]),
				created_at: minutesAgo(190),
				last_attempt_at: minutesAgo(180),
			})
		).id,
	);

	writeState([inProgressPoll]);
	const r = await tick();

	const [pa, pb, pc] = await Promise.all([
		prisma.post.findUnique({ where: { id: "p1a" } }),
		prisma.post.findUnique({ where: { id: "p1b" } }),
		prisma.post.findUnique({ where: { id: "p1c" } }),
	]);
	const terminal = (p) =>
		![
			"pending",
			"processing",
			"processing_upload",
			"processing_children",
		].includes(p?.status);
	const pass =
		pa?.status === "pending" &&
		pb?.status === "failed" &&
		pb?.failed_reason === "Processing Timeout" &&
		pc?.status === "failed" &&
		pc?.failed_reason === "Processing Timeout" &&
		terminal(pa) === false &&
		terminal(pb) &&
		terminal(pc) &&
		r.status === 200;

	record(
		"P1",
		Boolean(pass),
		`a=${pa?.status} b=${pb?.status}/${pb?.failed_reason} c=${pc?.status}/${pc?.failed_reason} cron=${r.status} timeout=${r.json?.timeout}`,
		{ states: [pa?.status, pb?.status, pc?.status], results: r.json || r.text },
	);
	await cleanupScenario(ids);
}

// ── P2 ──────────────────────────────────────────────────────────────────────
async function scenarioP2() {
	const ids = { posts: [], channels: [] };
	const postCtx = { user_id: "admin", channel_id: "chan-p2", planner_id: null };
	await seedChannel({ id: "chan-p2", account_id: "acct-p2" });
	ids.channels.push("chan-p2");

	// (a) happy path
	ids.posts.push(
		(
			await seedPost({
				id: "p2a",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-2a",
			})
		).id,
	);
	writeState([publishOk]);
	let r = await tick();
	let p2a = await prisma.post.findUnique({ where: { id: "p2a" } });
	const aOk =
		p2a?.status === "published" &&
		p2a?.instagram_media_id === "media-ok" &&
		r.json?.published === 1;
	console.log(
		`  P2a: status=${p2a?.status} media_id=${p2a?.instagram_media_id} published=${r.json?.published} → ${aOk ? "ok" : "FAIL"}`,
	);

	// (b) double-publish convergence via IG "already published" error
	ids.posts.push(
		(
			await seedPost({
				id: "p2b",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-2b",
			})
		).id,
	);
	writeState([
		rule("media_publish", null, [
			{
				status: 400,
				body: { error: { message: "(#401) The media was already published." } },
			},
		]),
	]);
	r = await tick();
	const p2b = await prisma.post.findUnique({ where: { id: "p2b" } });
	const publishCalls2b = countCalls({
		method: "POST",
		urlIncludes: "media_publish",
	});
	const bOk =
		p2b?.status === "published" &&
		r.json?.published === 1 &&
		publishCalls2b === 1;
	console.log(
		`  P2b: status=${p2b?.status} publish_calls=${publishCalls2b} published=${r.json?.published} → ${bOk ? "ok" : "FAIL"}`,
	);

	// (c) process-death simulation: container published before status was saved
	ids.posts.push(
		(
			await seedPost({
				id: "p2c",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-2c",
			})
		).id,
	);
	writeState([publishOk]);
	r = await tick();
	const p2c = await prisma.post.findUnique({ where: { id: "p2c" } });
	const publishCalls2c = countCalls({
		method: "POST",
		urlIncludes: "media_publish",
	});
	const cOk =
		p2c?.status === "published" &&
		publishCalls2c === 1 &&
		r.json?.published === 1;
	console.log(
		`  P2c: status=${p2c?.status} publish_calls=${publishCalls2c} published=${r.json?.published} → ${cOk ? "ok" : "FAIL"}`,
	);

	record(
		"P2",
		Boolean(aOk) && Boolean(bOk) && Boolean(cOk),
		`a=${aOk} b=${bOk} c=${cOk}`,
	);
	await cleanupScenario(ids);
}

// ── P3 ──────────────────────────────────────────────────────────────────────
async function scenarioP3() {
	const ids = { posts: [], channels: [] };
	const postCtx = { user_id: "admin", channel_id: "chan-p3", planner_id: null };
	await seedChannel({ id: "chan-p3", account_id: "acct-p3" });
	ids.channels.push("chan-p3");
	ids.posts.push(
		(
			await seedPost({
				id: "p3",
				...postCtx,
				status: "pending",
				media_type: "CAROUSEL",
				video_url: null,
				caption: "carousel",
				children_urls: JSON_OF([
					{ url: "/api/file/a.mp4", type: "video" },
					{ url: "/api/file/b.mp4", type: "video" },
					{ url: "/api/file/c.mp4", type: "video" },
				]),
			})
		).id,
	);

	// Tick 1: child b fails with 500. Children are created concurrently; rules are
	// body-matched per media URL so the failure is deterministic on child b.
	writeState([
		rule(null, "a.mp4", [okId("cnt-c0")]),
		rule(null, "b.mp4", [
			{ status: 500, body: { error: { message: "boom" } } },
		]),
		rule(null, "c.mp4", [okId("cnt-c2")]),
	]);
	await tick();
	const childCreatesTick1 = readCalls().filter(
		(c) =>
			c.method === "POST" &&
			c.url.includes(`/v24.0/acct-p3/media`) &&
			!c.body.includes("CAROUSEL"),
	).length;
	const p3after1 = await prisma.post.findUnique({ where: { id: "p3" } });

	// Tick 2: healthy — the whole carousel is re-created (current code) or only
	// the missing child (bar). Tick 3: carousel container polled → published.
	const healthyRules = [
		rule(null, "a.mp4", [okId("cnt-c0")]),
		rule(null, "b.mp4", [okId("cnt-c1")]),
		rule(null, "c.mp4", [okId("cnt-c2")]),
		rule(null, "CAROUSEL", [okId("cnt-car")]),
		finishedPoll,
		publishOk,
	];
	writeState(healthyRules);
	await tick();
	const childCreatesTick2 = readCalls().filter(
		(c) =>
			c.method === "POST" &&
			c.url.includes(`/v24.0/acct-p3/media`) &&
			!c.body.includes("CAROUSEL"),
	).length;
	// The 3-minute container safety delay: fast-forward time so the carousel
	// container (created this tick) is eligible in the final tick.
	await prisma.post.update({
		where: { id: "p3" },
		data: { container_created_at: minutesAgo(5) },
	});
	writeState(healthyRules);
	await tick();
	const p3after2 = await prisma.post.findUnique({ where: { id: "p3" } });
	const childCreateTotal = childCreatesTick1 + childCreatesTick2;
	// Invariants (bar P3): every child index created AT MOST ONCE successfully —
	// t1 attempts all 3 (2 ok + 1 deterministic 500), t2 retries ONLY the failed
	// child (1 ok) → 4 calls total, 3 UNIQUE stored ids, 0 duplicates, 0 orphans.
	const stored = parseChildIdEntriesForTest(p3after2?.instagram_child_ids ?? null);
	const uniqueStored = stored.size; // index→id map
	const noDupeIndices =
		new Set([...stored.keys()]).size === uniqueStored && uniqueStored === 3;
	const noOrphanIds = uniqueStored === 3; // every created id is referenced (3/3)
	const pass =
		childCreateTotal === 4 &&
		noDupeIndices &&
		noOrphanIds &&
		p3after2?.status === "published" &&
		p3after1?.attempts === 1;
	record(
		"P3",
		Boolean(pass),
		`child_create_calls_total=${childCreateTotal} (t1=${childCreatesTick1}+t2=${childCreatesTick2}; bar: 4 = 2 ok + 1 failed attempt + 1 retry of the missing child) uniqueStored=${uniqueStored} after1=${p3after1?.status}/attempts=${p3after1?.attempts} final=${p3after2?.status}`,
		{
			childCreatesTick1,
			childCreatesTick2,
			uniqueStored,
			tick1Status: p3after1?.status,
			tick1Attempts: p3after1?.attempts,
			finalStatus: p3after2?.status,
		},
	);
	await cleanupScenario(ids);
}

// ── P4 ──────────────────────────────────────────────────────────────────────
async function scenarioP4() {
	const ids = { posts: [], channels: [] };
	const postCtx = { user_id: "admin", channel_id: "chan-p4", planner_id: null };
	await seedChannel({ id: "chan-p4", account_id: "acct-p4" });
	ids.channels.push("chan-p4");
	ids.posts.push(
		(
			await seedPost({
				id: "p4-1",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-41",
				created_at: minutesAgo(5),
			})
		).id,
	);
	ids.posts.push(
		(
			await seedPost({
				id: "p4-2",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-42",
				created_at: minutesAgo(4),
			})
		).id,
	);

	writeState([
		rule("media_publish", null, [
			{ status: 429, body: { error: { message: "rate limited" } } },
			okId("media-4"),
		]),
	]);
	const r1 = await tick();
	const [p41a, p42a] = await Promise.all([
		prisma.post.findUnique({ where: { id: "p4-1" } }),
		prisma.post.findUnique({ where: { id: "p4-2" } }),
	]);
	// Batch stop: post2 untouched in tick 1
	const tick1Stopped =
		p41a?.status === "ready_to_publish" &&
		p41a?.attempts === 1 &&
		p42a?.status === "ready_to_publish" &&
		p42a?.attempts === 0;
	const rateCalls = countCalls({
		method: "POST",
		urlIncludes: "media_publish",
		status: 429,
	});

	writeState([publishOk]);
	const r2 = await tick();
	const [p41b, p42b] = await Promise.all([
		prisma.post.findUnique({ where: { id: "p4-1" } }),
		prisma.post.findUnique({ where: { id: "p4-2" } }),
	]);
	const okCalls = countCalls({
		method: "POST",
		urlIncludes: "media_publish",
		status: 200,
	});
	const pass =
		tick1Stopped &&
		rateCalls === 1 &&
		p41b?.status === "published" &&
		p42b?.status === "published" &&
		okCalls === 2 &&
		(r1.json?.rate_limited || 0) >= 1;

	record(
		"P4",
		Boolean(pass),
		`t1: p1=${p41a?.status}/att=${p41a?.attempts} p2=${p42a?.status}/att=${p42a?.attempts} 429calls=${rateCalls} | t2: p1=${p41b?.status} p2=${p42b?.status} okCalls=${okCalls}`,
		{ resultsTick1: r1.json, resultsTick2: r2.json },
	);
	await cleanupScenario(ids);
}

// ── P5 ──────────────────────────────────────────────────────────────────────
async function scenarioP5() {
	const ids = { posts: [], channels: [] };
	const postCtx = { user_id: "admin", channel_id: "chan-p5", planner_id: null };
	await seedChannel({ id: "chan-p5", account_id: "acct-p5" });
	ids.channels.push("chan-p5");
	ids.posts.push(
		(
			await seedPost({
				id: "p5",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-5",
			})
		).id,
	);

	writeState([
		rule("media_publish", null, [
			{ status: 400, body: { error: { message: "OAuth invalid" } } },
		]),
	]);
	await tick();
	await tick();
	const p5 = await prisma.post.findUnique({ where: { id: "p5" } });
	const publishCalls = countCalls({
		method: "POST",
		urlIncludes: "media_publish",
	});
	const notifyCalls = countCalls({ kind: "notify" });
	const pass =
		p5?.status === "failed" &&
		p5?.failed_reason === "Publishing Failed" &&
		publishCalls === 1 &&
		notifyCalls === 1;

	record(
		"P5",
		Boolean(pass),
		`status=${p5?.status}/${p5?.failed_reason} publish_calls=${publishCalls} notify=${notifyCalls}`,
		{ status: p5?.status, publishCalls, notifyCalls },
	);
	await cleanupScenario(ids);
}

// ── P6 ──────────────────────────────────────────────────────────────────────
async function scenarioP6() {
	const ids = { posts: [], channels: [] };
	const postCtx = { user_id: "admin", channel_id: "chan-p6", planner_id: null };
	await seedChannel({ id: "chan-p6", account_id: "acct-p6" });
	ids.channels.push("chan-p6");
	ids.posts.push(
		(
			await seedPost({
				id: "p6",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-6",
			})
		).id,
	);

	writeState([
		rule("media_publish", null, [
			{ status: 500, body: { error: { message: "burst" } } },
		]),
	]);
	for (let i = 0; i < 6; i++) await tick();
	const p6 = await prisma.post.findUnique({ where: { id: "p6" } });
	const publishCalls = countCalls({
		method: "POST",
		urlIncludes: "media_publish",
		status: 500,
	});
	const pass =
		p6?.status === "failed" &&
		(p6?.attempts || 0) >= 5 &&
		publishCalls <= 6 &&
		publishCalls >= 5;

	record(
		"P6",
		Boolean(pass),
		`status=${p6?.status} attempts=${p6?.attempts} 500_calls=${publishCalls} (budget finite)`,
		{ status: p6?.status, attempts: p6?.attempts, publishCalls },
	);
	await cleanupScenario(ids);
}

// ── P7 ──────────────────────────────────────────────────────────────────────
async function scenarioP7() {
	// (a) per-channel max_posts_per_hour=1
	const ids = { posts: [], channels: [] };
	const postCtx = { user_id: "admin", channel_id: "chan-p7", planner_id: null };
	await seedChannel({
		id: "chan-p7",
		account_id: "acct-p7",
		settings: JSON.stringify({ max_posts_per_hour: 1 }),
	});
	ids.channels.push("chan-p7");
	ids.posts.push(
		(
			await seedPost({
				id: "p7-1",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-71",
				created_at: minutesAgo(5),
			})
		).id,
	);
	ids.posts.push(
		(
			await seedPost({
				id: "p7-2",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-72",
				created_at: minutesAgo(4),
			})
		).id,
	);

	writeState([publishOk]);
	const r1 = await tick();
	const [p71a, p72a] = await Promise.all([
		prisma.post.findUnique({ where: { id: "p7-1" } }),
		prisma.post.findUnique({ where: { id: "p7-2" } }),
	]);
	const tick1Ok =
		p71a?.status === "published" &&
		p72a?.status === "ready_to_publish" &&
		(r1.json?.throttled || 0) >= 1;

	// backdate the published post so the throttle window opens
	await prisma.post.update({
		where: { id: "p7-1" },
		data: { published_at: minutesAgo(120) },
	});
	await tick();
	const p72b = await prisma.post.findUnique({ where: { id: "p7-2" } });
	const okCalls = countCalls({
		method: "POST",
		urlIncludes: "media_publish",
		status: 200,
	});
	const passA = tick1Ok && p72b?.status === "published" && okCalls === 2;

	// (b) global interval via AppConfig PUBLISH_MIN_INTERVAL_SECONDS
	await prisma.appConfig.upsert({
		where: { key: "PUBLISH_MIN_INTERVAL_SECONDS" },
		update: { value: "600" },
		create: { key: "PUBLISH_MIN_INTERVAL_SECONDS", value: "600" },
	});
	const idsB = { posts: [], channels: [] };
	const postCtxB = {
		user_id: "admin",
		channel_id: "chan-p7b",
		planner_id: null,
	};
	await seedChannel({ id: "chan-p7b", account_id: "acct-p7b", settings: null });
	idsB.channels.push("chan-p7b");
	idsB.posts.push(
		(
			await seedPost({
				id: "p7b-1",
				...postCtxB,
				status: "ready_to_publish",
				instagram_container_id: "cnt-7b1",
				created_at: minutesAgo(5),
			})
		).id,
	);
	idsB.posts.push(
		(
			await seedPost({
				id: "p7b-2",
				...postCtxB,
				status: "ready_to_publish",
				instagram_container_id: "cnt-7b2",
				created_at: minutesAgo(4),
			})
		).id,
	);
	writeState([publishOk]);
	await tick();
	const [pb1a, pb2a] = await Promise.all([
		prisma.post.findUnique({ where: { id: "p7b-1" } }),
		prisma.post.findUnique({ where: { id: "p7b-2" } }),
	]);
	await prisma.post.update({
		where: { id: "p7b-1" },
		data: { published_at: minutesAgo(120) },
	});
	await tick();
	const pb2 = await prisma.post.findUnique({ where: { id: "p7b-2" } });
	const passB =
		pb1a?.status === "published" &&
		pb2a?.status === "ready_to_publish" &&
		pb2?.status === "published";
	await prisma.appConfig
		.delete({ where: { key: "PUBLISH_MIN_INTERVAL_SECONDS" } })
		.catch(() => {});

	record(
		"P7",
		Boolean(passA) && Boolean(passB),
		`chan: t1=${p71a?.status}/${p72a?.status}->${p72b?.status} okCalls=${okCalls} | global: t1=${pb1a?.status}/${pb2a?.status}->${pb2?.status}`,
	);
	await cleanupScenario({ ...ids, ...idsB });
}

// ── P8 ──────────────────────────────────────────────────────────────────────
async function scenarioP8() {
	const ids = { posts: [], channels: [] };
	await seedChannel({
		id: "chan-p8",
		account_id: "acct-p8",
		access_token: "IGgarbage-token-not-real",
		token_refreshed_at: null,
		token_expires_at: null,
	});
	ids.channels.push("chan-p8");
	ids.posts.push(
		(
			await seedPost({
				id: "p8",
				user_id: "admin",
				channel_id: "chan-p8",
				status: "ready_to_publish",
				instagram_container_id: "cnt-8",
			})
		).id,
	);

	writeState([
		rule(
			"refresh_access_token",
			null,
			[
				{
					status: 400,
					body: {
						error: {
							message:
								"Error validating access token: Session key is malformed because of invalid user id.",
						},
					},
				},
			],
			"GET",
		),
		rule("media_publish", null, [
			{
				status: 400,
				body: { error: { message: "Invalid OAuth 2.0 Access Token" } },
			},
		]),
	]);
	await tick();
	await tick();
	const p8 = await prisma.post.findUnique({ where: { id: "p8" } });
	const ch8 = await prisma.channel.findUnique({ where: { id: "chan-p8" } });
	const refreshCalls = countCalls({ urlIncludes: "refresh_access_token" });
	const spam = readServerLog().match(/\[ChannelRefresh\]/g) || [];
	const pass =
		p8?.status === "failed" &&
		ch8?.status === "inactive" &&
		ch8?.token_expires_at === null &&
		refreshCalls <= 1 &&
		spam.length <= 1;

	record(
		"P8",
		Boolean(pass),
		`post=${p8?.status} channel=${ch8?.status}/expires=${ch8?.token_expires_at === null} refresh_calls=${refreshCalls} ChannelRefresh_lines=${spam.length}`,
		{
			refreshCalls,
			channelStatus: ch8?.status,
			tokenExpiresNull: ch8?.token_expires_at === null,
		},
	);
	await cleanupScenario(ids);
}

// ── P9 ──────────────────────────────────────────────────────────────────────
async function scenarioP9() {
	const ids = { posts: [], channels: [] };
	const postCtx = { user_id: "admin", channel_id: "chan-p9", planner_id: null };
	await seedChannel({ id: "chan-p9", account_id: "acct-p9" });
	ids.channels.push("chan-p9");
	for (let i = 1; i <= 10; i++) {
		ids.posts.push(
			(
				await seedPost({
					id: `p9-${i}`,
					...postCtx,
					status: "ready_to_publish",
					instagram_container_id: `cnt-9${i}`,
					created_at: new Date(Date.now() - 10 * 60_000 + i * 1000),
				})
			).id,
		);
	}

	writeState([
		rule("media_publish", null, [
			{ status: 200, body: { id: "media-9" }, delayMs: 2000 },
		]),
	]);
	const t1start = Date.now();
	await tick();
	const t1elapsed = Date.now() - t1start;
	const okCallsTick1 = countCalls({
		method: "POST",
		urlIncludes: "media_publish",
		status: 200,
	});
	const published1 = await prisma.post.findMany({
		where: { channel_id: "chan-p9", status: "published" },
	});
	const expectedFirst5 = new Set(["p9-1", "p9-2", "p9-3", "p9-4", "p9-5"]);
	const aOk =
		published1.length === 5 &&
		published1.every((p) => expectedFirst5.has(p.id)) &&
		t1elapsed < 60_000;
	console.log(
		`  P9a: t1_elapsed=${Math.round(t1elapsed)}ms published_t1=${published1.length} oldest5=${aOk} → ${aOk ? "ok" : "FAIL"}`,
	);

	writeState([publishOk]);
	await tick();
	const publishedAll = await prisma.post.findMany({
		where: { channel_id: "chan-p9", status: "published" },
	});
	const okCallsAll =
		okCallsTick1 +
		countCalls({ method: "POST", urlIncludes: "media_publish", status: 200 });
	const a2Ok = publishedAll.length === 10 && okCallsAll === 10;
	console.log(
		`  P9a(2): published_all=${publishedAll.length} ok_publish_calls(all)=${okCallsAll} → ${a2Ok ? "ok" : "FAIL"}`,
	);

	// P9b — the 45s MAX_EXEC_MS budget actually fires mid-tick. Two pending
	// posts: the first takes 46s on media-create; the SECOND loop-top check then
	// exceeds the budget → results.timeout=true. The second post is claimed but
	// unprocessed — it must not be lost: after its created_at ages past 15 min,
	// phase 2.5 reverts it to pending and the next tick completes it.
	const slowPost = await seedPost({
		id: "p9-budget-1",
		...postCtx,
		status: "pending",
		media_type: "REELS",
	});
	const queuedPost = await seedPost({
		id: "p9-budget-2",
		...postCtx,
		status: "pending",
		media_type: "REELS",
	});
	ids.posts.push(slowPost.id, queuedPost.id);
	writeState([
		{
			method: "POST",
			matchRegex: "/acct-p9/media$",
			responses: [{ status: 200, body: { id: "cnt-slow" }, delayMs: 46000 }],
		},
	]);
	const t2start = Date.now();
	const r3 = await tick();
	const t2elapsed = Date.now() - t2start;
	const slowAfter = await prisma.post.findUnique({
		where: { id: "p9-budget-1" },
	});
	const queuedAfter = await prisma.post.findUnique({
		where: { id: "p9-budget-2" },
	});
	const b1Ok =
		r3.json?.timeout === true &&
		t2elapsed < 65_000 &&
		slowAfter?.status === "processing_upload" &&
		queuedAfter?.status === "processing";
	// recovery: age the queued post past 15 min → revert to pending → next tick completes it
	await prisma.post.update({
		where: { id: "p9-budget-2" },
		data: { created_at: minutesAgo(20) },
	});
	writeState([
		{
			method: "POST",
			matchRegex: "/acct-p9/media$",
			responses: [{ status: 200, body: { id: "cnt-queued" } }],
		},
		finishedPoll,
		publishOk,
	]);
	await tick();
	const queuedRecovered = await prisma.post.findUnique({
		where: { id: "p9-budget-2" },
	});
	const b2Ok =
		queuedRecovered?.status === "processing_upload" ||
		queuedRecovered?.status === "pending";
	console.log(
		`  P9b: elapsed=${Math.round(t2elapsed)}ms timeout=${r3.json?.timeout} slow=${slowAfter?.status} queued=${queuedAfter?.status} → ${b1Ok ? "ok" : "FAIL"}`,
	);
	console.log(
		`  P9b(2 recovery): queued=${queuedRecovered?.status} → ${b2Ok ? "ok" : "FAIL"}`,
	);

	record(
		"P9",
		Boolean(aOk) && Boolean(a2Ok) && Boolean(b1Ok) && Boolean(b2Ok),
		`a(ordem+bounded)=${aOk} a2(exactly-once)=${a2Ok} b(budget)=${b1Ok} b2(recovery)=${b2Ok}`,
	);
	await cleanupScenario(ids);
}

// ── P10 ─────────────────────────────────────────────────────────────────────
async function scenarioP10() {
	const ids = { posts: [], channels: [] };
	const postCtx = {
		user_id: "admin",
		channel_id: "chan-p10",
		planner_id: null,
	};
	await seedChannel({ id: "chan-p10", account_id: "acct-p10" });
	ids.channels.push("chan-p10");
	ids.posts.push(
		(
			await seedPost({
				id: "p10-1",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-101",
				created_at: minutesAgo(5),
			})
		).id,
	);
	ids.posts.push(
		(
			await seedPost({
				id: "p10-2",
				...postCtx,
				status: "ready_to_publish",
				instagram_container_id: "cnt-102",
				created_at: minutesAgo(4),
			})
		).id,
	);

	writeState([
		rule("media_publish", null, [
			{ status: 200, body: { id: "media-10" }, delayMs: 2000 },
		]),
	]);
	const [rA, rB] = await Promise.all([tick(), tick()]);
	const skippedList = [rA, rB].filter((r) => r.json?.skipped === true);
	const runner = [rA, rB].find((r) => r.json?.skipped !== true);
	const published = await prisma.post.findMany({
		where: { channel_id: "chan-p10", status: "published" },
	});
	const pass =
		skippedList.length === 1 &&
		runner?.json?.published === 2 &&
		published.length === 2;

	record(
		"P10",
		Boolean(pass),
		`skipped=${skippedList.length}/2 winner_published=${runner?.json?.published} db_published=${published.length}`,
		{ skipped: skippedList.length, winner: runner?.json },
	);
	await cleanupScenario(ids);
}

// ── P11 ─────────────────────────────────────────────────────────────────────
async function scenarioP11() {
	const ids = { posts: [], channels: [] };
	await seedChannel({ id: "chan-p11", account_id: "acct-p11" });
	ids.channels.push("chan-p11");
	ids.posts.push(
		(
			await seedPost({
				id: "p11",
				user_id: "admin",
				channel_id: "chan-p11",
				video_url: null,
				image_url: null,
				children_urls: null,
			})
		).id,
	);

	writeState([]);
	await tick();
	const p11 = await prisma.post.findUnique({ where: { id: "p11" } });
	const notifyCalls = countCalls({ kind: "notify" });
	const pass =
		p11?.status === "failed" &&
		p11?.failed_reason === "Missing Media" &&
		notifyCalls >= 1;

	record(
		"P11",
		Boolean(pass),
		`status=${p11?.status}/${p11?.failed_reason} notify=${notifyCalls}`,
		{ status: p11?.status, notifyCalls },
	);
	await cleanupScenario(ids);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO P12 — phase-2 carousel lane, two sub-scenarios:
//   a) RECONCILE: post already in processing_children with a PARTIAL
//      index-aware child set → the tick creates ONLY the missing child, then
//      assembles the group container exactly once and publishes once.
//   b) REUSE GUARD: complete children AND an existing instagram_container_id
//      (re-claim after a lost write) → NO second group container (IG children
//      are single-use), the existing container is polled and published.
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioP12() {
	const ids = { posts: [], channels: [] };
	const kids = (prefix) => [
		{ url: `/api/file/${prefix}1.mp4`, type: "video" },
		{ url: `/api/file/${prefix}2.mp4`, type: "video" },
		{ url: `/api/file/${prefix}3.mp4`, type: "video" },
	];
	// container-create calls for a channel (excludes media_publish, whose URL
	// contains the same "/media" prefix substring).
	const mediaCreates = (acct) =>
		readCalls().filter(
			(c) =>
				c.method === "POST" &&
				c.url.includes(`/v24.0/${acct}/media`) &&
				!c.url.includes("media_publish"),
		);

	// ── P12a: reconcile lane ──────────────────────────────────────────────────
	await seedChannel({ id: "chan-p12a", account_id: "acct-p12a" });
	ids.channels.push("chan-p12a");
	ids.posts.push(
		(
			await seedPost({
				id: "p12a",
				user_id: "admin",
				channel_id: "chan-p12a",
				planner_id: null,
				status: "processing_children",
				media_type: "CAROUSEL",
				video_url: null,
				caption: "p12a",
				children_urls: JSON_OF(kids("xa")),
				instagram_child_ids: JSON_OF([
					{ index: 0, id: "cnt-xa0" },
					{ index: 2, id: "cnt-xa2" },
				]),
				container_created_at: new Date(),
			})
		).id,
	);
	const p12aRules = [
		rule(null, "xa1.mp4", [okId("cnt-xa0")]), // stored — must never be re-created
		rule(null, "xa2.mp4", [okId("cnt-xa1")]), // missing index 1 — the ONLY create allowed
		rule(null, "xa3.mp4", [okId("cnt-xa2")]), // stored — must never be re-created
		rule(null, "CAROUSEL", [okId("cnt-xag")]),
		finishedPoll,
		publishOk,
	];
	writeState(p12aRules);
	await tick();
	const p12aTick1 = mediaCreates("acct-p12a");
	const p12aChild1 = p12aTick1.filter((c) => !c.body.includes("CAROUSEL"));
	const p12aGroup1 = p12aTick1.filter((c) => c.body.includes("CAROUSEL"));
	const p12aMid = await prisma.post.findUnique({ where: { id: "p12a" } });

	// Fast-forward the group container's 3-min safety gate, then publish.
	await prisma.post.update({
		where: { id: "p12a" },
		data: { container_created_at: minutesAgo(5) },
	});
	writeState(p12aRules);
	await tick();
	const p12aCreations2 = mediaCreates("acct-p12a");
	const p12aPublish = readCalls().filter((c) => c.url.includes("media_publish"));
	const p12a = await prisma.post.findUnique({ where: { id: "p12a" } });
	const p12aStored = parseChildIdEntriesForTest(p12a?.instagram_child_ids ?? null);
	const p12aOk =
		p12aChild1.length === 1 &&
		p12aChild1[0]?.body?.includes("xa2.mp4") &&
		p12aGroup1.length === 1 &&
		p12aMid?.status === "processing_upload" &&
		p12aMid?.instagram_container_id === "cnt-xag" &&
		p12aCreations2.length === 0 && // publish tick re-creates nothing
		p12aPublish.length === 1 &&
		p12a?.status === "published" &&
		p12aStored.size === 3 &&
		p12aStored.get(1) === "cnt-xa1";

	// ── P12b: reuse guard ─────────────────────────────────────────────────────
	await seedChannel({ id: "chan-p12b", account_id: "acct-p12b" });
	ids.channels.push("chan-p12b");
	ids.posts.push(
		(
			await seedPost({
				id: "p12b",
				user_id: "admin",
				channel_id: "chan-p12b",
				planner_id: null,
				status: "processing_children",
				media_type: "CAROUSEL",
				video_url: null,
				caption: "p12b",
				children_urls: JSON_OF(kids("xb")),
				instagram_child_ids: JSON_OF([
					{ index: 0, id: "cnt-xb0" },
					{ index: 1, id: "cnt-xb1" },
					{ index: 2, id: "cnt-xb2" },
				]),
				instagram_container_id: "cnt-xbg",
				container_created_at: minutesAgo(5),
			})
		).id,
	);
	const p12bRules = [
		rule(null, "xb1.mp4", [okId("cnt-xb0")]),
		rule(null, "xb2.mp4", [okId("cnt-xb1")]),
		rule(null, "xb3.mp4", [okId("cnt-xb2")]),
		rule(null, "CAROUSEL", [okId("cnt-xbg2")]), // fresh id — a buggy re-create would return this
		finishedPoll,
		publishOk,
	];
	writeState(p12bRules);
	await tick();
	const p12bMid = await prisma.post.findUnique({ where: { id: "p12b" } });
	const p12bCreations1 = mediaCreates("acct-p12b");
	writeState(p12bRules);
	await tick();
	const p12bCreations2 = mediaCreates("acct-p12b");
	const p12bPublish = readCalls().filter((c) => c.url.includes("media_publish"));
	const p12b = await prisma.post.findUnique({ where: { id: "p12b" } });
	const p12bOk =
		p12bCreations1.length === 0 && // guard fired: NO group re-create
		p12bCreations2.length === 0 &&
		p12bMid?.status === "processing_upload" &&
		p12bMid?.instagram_container_id === "cnt-xbg" && // existing id preserved
		p12bPublish.length === 1 &&
		p12b?.status === "published" &&
		p12b?.instagram_container_id === "cnt-xbg";

	record(
		"P12",
		Boolean(p12aOk && p12bOk),
		`a(reconcile): childCreates=${p12aChild1.length} groupCreates=${p12aGroup1.length} mid=${p12aMid?.status}/${p12aMid?.instagram_container_id} final=${p12a?.status} stored=${p12aStored.size} | b(guard): creations=${p12bCreations1.length}/${p12bCreations2.length} mid=${p12bMid?.status}/${p12bMid?.instagram_container_id} final=${p12b?.status} publish=${p12bPublish.length}`,
		{
			reconcile: { childCreates: p12aChild1.length, groupCreates: p12aGroup1.length, midStatus: p12aMid?.status, finalStatus: p12a?.status, stored: p12aStored.size },
			guard: { creations1: p12bCreations1.length, creations2: p12bCreations2.length, midContainer: p12bMid?.instagram_container_id, finalStatus: p12b?.status, publishCalls: p12bPublish.length },
		},
	);
	await cleanupScenario(ids);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
	await seedUser();
	// Notification webhook for every scenario (Telegram keys deliberately absent).
	await prisma.appConfig.upsert({
		where: { key: "NOTIFY_WEBHOOK_URL" },
		update: { value: "https://mock-webhook.invalid/hook" },
		create: {
			key: "NOTIFY_WEBHOOK_URL",
			value: "https://mock-webhook.invalid/hook",
		},
	});

	const scenarios = [
		["P1", scenarioP1],
		["P2", scenarioP2],
		["P3", scenarioP3],
		["P4", scenarioP4],
		["P5", scenarioP5],
		["P6", scenarioP6],
		["P7", scenarioP7],
		["P8", scenarioP8],
		["P9", scenarioP9],
		["P10", scenarioP10],
		["P11", scenarioP11],
		["P12", scenarioP12],
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
		/* evidence dir may not be writable — summary already printed */
	}
	await prisma.$disconnect();
	process.exit(failed > 0 || anyPass !== resultsTotal.length ? 1 : 0);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
