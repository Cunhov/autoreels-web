#!/usr/bin/env node
/**
 * Channels/Backup gauntlet — M1 (OAuth), M2 (refresh), M3 (insights), M4a/M4c
 * (backup create/prune + restore abuse). M4b (restore SUCCESS) runs LAST in a
 * separate process (channels-restore.mjs) because the prod route schedules
 * process.exit(0) after responding.
 *
 * Drives the REAL app (see channels-run.sh) with the IG/Graph API mocked by
 * scripts/gauntlet/fetch-mock.mjs (preload — hosts graph.instagram.com,
 * graph.facebook.com, api.instagram.com, mock-webhook.invalid). NO product
 * fixes. Bar: gauntlet-runs/module-04-channels-media/refs/bar-scenarios.md.
 *
 * Usage:
 *   node channels-scenarios.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --uploads-dir <dir> --backups-dir <dir>
 *        --mock-state <state.json> --mock-calls <calls.jsonl>
 *        --server-log <server.log> --out <dir>
 *
 * Exit 0 only if every scenario passes.
 */
import {
	appendFileSync,
	writeFileSync,
	readFileSync,
	existsSync,
	truncateSync,
	unlinkSync,
	readdirSync,
	statSync,
	copyFileSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHmac, createHash } from "node:crypto";
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
const UPLOADS_DIR = getArg("--uploads-dir");
const BACKUPS_DIR = getArg("--backups-dir");
const MOCK_STATE = getArg("--mock-state");
const MOCK_CALLS = getArg("--mock-calls");
const SERVER_LOG = getArg("--server-log");
const OUT_DIR = getArg("--out");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--uploads-dir", UPLOADS_DIR],
	["--backups-dir", BACKUPS_DIR],
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
const SESSION_COOKIE = `next-auth.session-token=${await encode({
	token: { sub: "admin" },
	secret: SECRET,
	maxAge: 3600,
})}`;

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

function rule(urlSub, matchRegex, responses, method = "POST") {
	return {
		...(urlSub ? { match: urlSub } : {}),
		...(matchRegex ? { matchRegex } : {}),
		...(method ? { method } : {}),
		responses,
	};
}

const okId = (id, extra = {}) => ({
	status: 200,
	body: { id, ...extra },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(
	path,
	{
		method = "GET",
		body,
		headers = {},
		redirect = "follow",
		timeoutMs = 60_000,
	} = {},
) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${BASE}${path}`, {
			method,
			headers: { Cookie: SESSION_COOKIE, ...headers },
			body,
			redirect,
			signal: controller.signal,
		});
		let json = null;
		try {
			json = await res.json();
		} catch {
			/* non-JSON body */
		}
		return {
			ok: res.ok,
			status: res.status,
			json,
			location: res.headers.get("location") || "",
		};
	} finally {
		clearTimeout(timer);
	}
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Mint an OAuth state exactly like lib/instagram.ts signOAuthState. */
function signState(userId, ts) {
	const payload = Buffer.from(JSON.stringify({ userId, ts })).toString(
		"base64url",
	);
	const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
	return `${payload}.${sig}`;
}

let resultsTotal = [];
function record(label, pass, line, detail = {}) {
	resultsTotal.push({ scenario: label, pass, line, detail });
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
}

async function cleanupScenario(ids) {
	if (ids.posts?.length) {
		await prisma.post.deleteMany({ where: { id: { in: ids.posts } } });
	}
	if (ids.channels?.length) {
		await prisma.channel.deleteMany({ where: { id: { in: ids.channels } } });
	}
	if (ids.items?.length) {
		await prisma.contentItem.deleteMany({ where: { id: { in: ids.items } } });
	}
}

// ── SCENARIO M1 — OAuth lifecycle ────────────────────────────────────────────

async function scenarioM1() {
	const ids = { posts: [], channels: [] };
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});

	// Full happy path: start -> state -> callback (short exchange, long
	// exchange, profile) -> channel created active with the long token.
	writeState([
		rule("api.instagram.com/oauth/access_token", null, [
			{
				status: 200,
				body: { access_token: "IGShortTokenM1", user_id: "ig-acc-1" },
			},
		]),
		rule(
			"graph.instagram.com/access_token",
			null,
			[
				{
					status: 200,
					body: { access_token: "IGLongM1Token", expires_in: 5184000 },
				},
			],
			"GET",
		),
		rule(
			"v24.0/me",
			null,
			[
				{
					status: 200,
					body: {
						id: "ig-acc-1",
						username: "gauntlet_user",
						profile_picture_url: "https://mock-webhook.invalid/pic.jpg",
					},
				},
			],
			"GET",
		),
	]);

	const startRes = await req("/api/channels/oauth/start");
	const startOk = startRes.ok && typeof startRes.json?.url === "string";
	const url = startRes.json?.url || "";
	const stateMatch = url.match(/[?&]state=([^&]+)/);
	const state = stateMatch ? decodeURIComponent(stateMatch[1]) : "";
	const clientIdOk = url.includes("client_id=gauntlet-client");

	const cb = await req(
		`/api/channels/oauth/callback?code=SHORTCODE&state=${encodeURIComponent(state)}`,
		{ redirect: "manual" },
	);
	const cbOk = cb.status === 307 && cb.location.includes("connect=success");

	const channel = await prisma.channel.findFirst({
		where: { user_id: "admin", platform: "instagram" },
	});
	const channelOk =
		channel?.account_id === "ig-acc-1" &&
		channel.access_token === "IGLongM1Token" &&
		channel.token_source === "oauth" &&
		channel.status === "active" &&
		channel.token_expires_at !== null;
	ids.channels.push(channel?.id || "");

	const seqOk =
		countCalls({
			urlIncludes: "api.instagram.com/oauth/access_token",
			method: "POST",
		}) === 1 &&
		countCalls({ urlIncludes: "ig_exchange_token" }) === 1 &&
		countCalls({ urlIncludes: "v24.0/me" }) === 1;

	// Tampered state -> 4xx redirect, no channel created.
	const tampered = await req(
		"/api/channels/oauth/callback?code=SHORTCODE&state=not.a.valid.state",
		{ redirect: "manual" },
	);
	const tamperedOk =
		tampered.status === 307 && tampered.location.includes("connect=error");

	// Expired state (minted 11 min ago) -> error redirect.
	const expired = await req(
		`/api/channels/oauth/callback?code=SHORTCODE&state=${encodeURIComponent(signState("admin", Date.now() - 11 * 60 * 1000))}`,
		{ redirect: "manual" },
	);
	const expiredOk =
		expired.status === 307 && expired.location.includes("connect=error");

	// Invalid code (mock 400) -> error redirect, no partial channel row.
	writeState([
		rule("api.instagram.com/oauth/access_token", null, [
			{ status: 400, body: { error_message: "Invalid authorization code" } },
		]),
	]);
	const invalid = await req(
		`/api/channels/oauth/callback?code=BADCODE&state=${encodeURIComponent(state)}`,
		{ redirect: "manual" },
	);
	const invalidOk =
		invalid.status === 307 && invalid.location.includes("connect=error");

	const channelCountAfter = await prisma.channel.count({
		where: { user_id: "admin", platform: "instagram" },
	});

	const pass =
		startOk &&
		clientIdOk &&
		Boolean(state) &&
		cbOk &&
		channelOk &&
		seqOk &&
		tamperedOk &&
		expiredOk &&
		invalidOk &&
		channelCountAfter === 1;

	record(
		"M1",
		Boolean(pass),
		`start=${startOk}/clientId=${clientIdOk}/state=${Boolean(state)} callback=${cb.status}/success=${cbOk} channel=${channelOk} seq=${seqOk} tampered=${tamperedOk} expired=${expiredOk} invalid=${invalidOk} rows=${channelCountAfter}`,
		{
			startStatus: startRes.status,
			cbStatus: cb.status,
			cbLocation: cb.location,
			channel,
		},
	);

	await cleanupScenario(ids);
}

// ── SCENARIO M2 — token refresh lifecycle ────────────────────────────────────

async function scenarioM2() {
	const ids = { posts: [], channels: [] };
	const chan = await prisma.channel.create({
		data: {
			id: "chan-m2",
			user_id: "admin",
			name: "M2",
			platform: "instagram",
			access_token: "IGRevokableToken",
			account_id: "acct-m2",
			status: "active",
			token_source: "manual",
		},
	});
	ids.channels.push(chan.id);

	// Happy path
	writeState([
		rule(
			"refresh_access_token",
			null,
			[
				{
					status: 200,
					body: { access_token: "IGRefreshedM2", expires_in: 5184000 },
				},
			],
			"GET",
		),
	]);
	const happy = await req(`/api/channels/chan-m2/refresh`, { method: "POST" });
	const afterHappy = await prisma.channel.findUnique({
		where: { id: "chan-m2" },
	});
	const happyOk =
		happy.ok &&
		afterHappy?.access_token === "IGRefreshedM2" &&
		afterHappy?.token_expires_at !== null &&
		afterHappy?.token_refreshed_at !== null;

	// Revoked token (mock 400) -> NOT 2xx, token untouched (no half-update).
	await prisma.channel.update({
		where: { id: "chan-m2" },
		data: { access_token: "IGRevokedToken" },
	});
	writeState([
		rule(
			"refresh_access_token",
			null,
			[
				{
					status: 400,
					body: {
						error: {
							message: "Session has expired on Tuesday, August 15th 2026",
						},
					},
				},
			],
			"GET",
		),
	]);
	const revoked = await req(`/api/channels/chan-m2/refresh`, {
		method: "POST",
	});
	const afterRevoked = await prisma.channel.findUnique({
		where: { id: "chan-m2" },
	});
	const revokedOk =
		!revoked.ok &&
		revoked.status >= 400 &&
		afterRevoked?.access_token === "IGRevokedToken" &&
		afterRevoked?.token_expires_at?.getTime() ===
			afterHappy?.token_expires_at?.getTime();

	// Concurrent refreshes: FIFO mock returns token A then B — final must be
	// one of them, never a torn/interleaved value, both calls 2xx.
	await prisma.channel.update({
		where: { id: "chan-m2" },
		data: { access_token: "IGConcurrentStart" },
	});
	writeState([
		rule(
			"refresh_access_token",
			null,
			[
				{
					status: 200,
					body: { access_token: "IGConcurrentA", expires_in: 5184000 },
				},
				{
					status: 200,
					body: { access_token: "IGConcurrentB", expires_in: 5184000 },
				},
			],
			"GET",
		),
	]);
	const [c1, c2] = await Promise.all([
		req(`/api/channels/chan-m2/refresh`, { method: "POST" }),
		req(`/api/channels/chan-m2/refresh`, { method: "POST" }),
	]);
	const afterConcurrent = await prisma.channel.findUnique({
		where: { id: "chan-m2" },
	});
	const refreshCalls = countCalls({ urlIncludes: "refresh_access_token" });
	const concurrentOk =
		c1.ok &&
		c2.ok &&
		["IGConcurrentA", "IGConcurrentB"].includes(
			afterConcurrent?.access_token || "",
		) &&
		refreshCalls === 2;

	// Redis-backed guard
	await prisma.channel.update({
		where: { id: "chan-m2" },
		data: { access_token: "token_redis-key" },
	});
	const redisGuard = await req(`/api/channels/chan-m2/refresh`, {
		method: "POST",
	});
	const redisOk = redisGuard.status === 400;

	const pass = happyOk && revokedOk && concurrentOk && redisOk;
	record(
		"M2",
		Boolean(pass),
		`happy=${happyOk} revoked=${revokedOk}/status=${revoked.status}/tokenUntouched=${afterRevoked?.access_token === "IGRevokedToken"} concurrent=${concurrentOk}/calls=${refreshCalls}/final=${afterConcurrent?.access_token} redis=${redisOk}/${redisGuard.status}`,
		{
			happy: happy.json,
			revoked: revoked.json,
			concurrent: [c1.json, c2.json],
			refreshCalls,
		},
	);

	await cleanupScenario(ids);
}

// ── SCENARIO M3 — insights ───────────────────────────────────────────────────

const M3_CHANNEL = "chan-m3";
const insightsBody = (likes) => ({
	data: [
		{ name: "impressions", values: [{ value: likes * 10 }] },
		{ name: "reach", values: [{ value: likes * 5 }] },
		{ name: "saved", values: [{ value: 1 }] },
		{ name: "plays", values: [{ value: likes * 20 }] },
	],
});

async function seedM3Posts(count) {
	await prisma.post.deleteMany({ where: { channel_id: M3_CHANNEL } });
	for (let i = 1; i <= count; i++) {
		await prisma.post.create({
			data: {
				id: `p3-${i}`,
				user_id: "admin",
				channel_id: M3_CHANNEL,
				status: "published",
				media_type: "VIDEO",
				instagram_media_id: `ig-media-${i}`,
				published_at: new Date(Date.now() - i * 24 * 3600 * 1000),
			},
		});
	}
}

async function scenarioM3() {
	const ids = { posts: [], channels: [], items: [] };
	await prisma.channel.upsert({
		where: { id: M3_CHANNEL },
		update: {
			access_token: "IGInsightsToken",
			account_id: "acct-m3",
			status: "active",
		},
		create: {
			id: M3_CHANNEL,
			user_id: "admin",
			name: "M3",
			platform: "instagram",
			access_token: "IGInsightsToken",
			account_id: "acct-m3",
			status: "active",
		},
	});
	ids.channels.push(M3_CHANNEL);

	const params = `days=7&force=1&from=${encodeURIComponent(new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`;

	// (a) totals accumulate across 3 posts (batched 5 at a time).
	await seedM3Posts(3);
	const rules = [];
	for (let i = 1; i <= 3; i++) {
		rules.push(
			rule(
				null,
				`v24\\.0\\/ig-media-${i}\\?fields=timestamp`,
				[
					{
						status: 200,
						body: {
							id: `ig-media-${i}`,
							media_type: "VIDEO",
							permalink: `https://mock-webhook.invalid/p${i}`,
						},
					},
				],
				"GET",
			),
			rule(
				null,
				`v24\\.0\\/ig-media-${i}\\/insights`,
				[{ status: 200, body: insightsBody(i * 10) }],
				"GET",
			),
		);
	}
	writeState(rules);
	const a = await req(`/api/channels/${M3_CHANNEL}/insights?${params}`);
	const aOk =
		a.ok &&
		a.json?.posts?.length === 3 &&
		a.json?.totals?.impressions === 600 &&
		a.json?.totals?.plays === 1200 &&
		a.json?.source === "ig" &&
		a.json?.has_more === false;

	// (b) empty data -> zeros, no crash.
	await prisma.post.deleteMany({ where: { channel_id: M3_CHANNEL } });
	writeState([]);
	const b = await req(`/api/channels/${M3_CHANNEL}/insights?${params}`);
	const bTotals = b.json?.totals || {};
	const bOk =
		b.ok &&
		Object.values(bTotals).every((v) => v === 0) &&
		b.json?.posts?.length === 0;

	// (c) 400 on every IG call -> current behavior: silent zeros (200), not 4xx.
	await seedM3Posts(1);
	writeState([
		rule(
			null,
			`v24\\.0\\/ig-media-1\\?fields=timestamp`,
			[{ status: 400, body: { error: { message: "Media not found" } } }],
			"GET",
		),
		rule(
			null,
			`v24\\.0\\/ig-media-1\\/insights`,
			[{ status: 400, body: { error: { message: "Media not found" } } }],
			"GET",
		),
	]);
	const c = await req(`/api/channels/${M3_CHANNEL}/insights?${params}`);
	const cOk = c.ok && c.json?.posts?.length === 1;

	// (d) malformed JSON bodies -> classified, no 500, no crash.
	writeState([
		rule(
			null,
			`v24\\.0\\/ig-media-1\\?fields=timestamp`,
			[{ status: 200, body: "this-is-not-json{{{" }],
			"GET",
		),
		rule(
			null,
			`v24\\.0\\/ig-media-1\\/insights`,
			[{ status: 200, body: "also-not-json[[[" }],
			"GET",
		),
	]);
	const d = await req(`/api/channels/${M3_CHANNEL}/insights?${params}`);
	const dOk = d.ok && d.json?.posts?.length === 1;

	const pass = aOk && bOk && cOk && dOk;
	record(
		"M3",
		Boolean(pass),
		`a(totals)=${aOk}/likes=${a.json?.totals?.likes} b(empty)=${bOk}/zeros=${Object.values(bTotals).every((v) => v === 0)} c(400)=${cOk}/status=${c.status} d(malformed)=${dOk}/status=${d.status}`,
		{ a: a.json, b: b.json, cStatus: c.status, dStatus: d.status },
	);

	await cleanupScenario(ids);
}

// ── SCENARIO M4a/M4c — backup create/prune + restore abuse ───────────────────

function backupFiles() {
	try {
		return readdirSync(BACKUPS_DIR)
			.filter((f) => /^backup-\d{8}\.db$/.test(f))
			.sort();
	} catch {
		return [];
	}
}

function cleanBackups() {
	for (const f of backupFiles()) {
		unlinkSync(join(BACKUPS_DIR, f));
	}
}

async function scenarioM4() {
	// Clean slate for backup scenarios.
	cleanBackups();

	// (a) create -> file exists, idempotent per day.
	const create = await req("/api/admin/backups", { method: "POST" });
	const file = create.json?.file || "";
	const fileName = file.split("/").pop() || "";
	const fileOk =
		create.ok &&
		create.json?.ok === true &&
		create.json?.skipped !== true &&
		/^backup-\d{8}\.db$/.test(fileName) &&
		existsSync(file) &&
		statSync(file).size > 0;

	const create2 = await req("/api/admin/backups", { method: "POST" });
	const idemOk = create2.ok && create2.json?.skipped === true;

	// Prune: 8 past-named backups + today's create -> 9, prune keeps 7.
	cleanBackups();
	for (let i = 8; i >= 1; i--) {
		const d = new Date(Date.now() - i * 24 * 3600 * 1000);
		const name = `backup-${[
			d.getFullYear(),
			String(d.getMonth() + 1).padStart(2, "0"),
			String(d.getDate()).padStart(2, "0"),
		].join("")}.db`;
		copyFileSync(DB_PATH, join(BACKUPS_DIR, name));
	}
	const pruneCreate = await req("/api/admin/backups", { method: "POST" });
	const afterPrune = backupFiles();
	const pruneOk =
		pruneCreate.ok &&
		afterPrune.length === 7 &&
		existsSync(
			join(BACKUPS_DIR, pruneCreate.json?.file?.split("/").pop() || ""),
		);

	// (c) restore abuse — live DB untouched each time.
	const dbHashBefore = sha256File(DB_PATH);
	const traversal1 = await req("/api/admin/restore", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ filename: "../backup-20200101.db" }),
	});
	const traversal2 = await req("/api/admin/restore", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ filename: "backup-20200101.db/../../etc/passwd" }),
	});
	const missing = await req("/api/admin/restore", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ filename: "backup-20200101.db" }),
	});
	writeFileSync(
		join(BACKUPS_DIR, "backup-20200101.db"),
		"definitely-not-a-sqlite-db",
	);
	const corrupt = await req("/api/admin/restore", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ filename: "backup-20200101.db" }),
	});
	unlinkSync(join(BACKUPS_DIR, "backup-20200101.db"));
	const dbHashAfter = sha256File(DB_PATH);

	const abuseOk =
		traversal1.status === 400 &&
		traversal2.status === 400 &&
		missing.status === 404 &&
		corrupt.status === 422 &&
		dbHashBefore === dbHashAfter;

	const list = await req("/api/admin/backups");
	const listOk =
		list.ok &&
		Array.isArray(list.json?.backups) &&
		list.json.backups.length === 7;

	const pass = fileOk && idemOk && pruneOk && abuseOk && listOk;
	record(
		"M4",
		Boolean(pass),
		`create=${fileOk}/name=${fileName} idem=${idemOk} prune=${pruneOk}/count=${afterPrune.length} traversal=${traversal1.status}/${traversal2.status} missing=${missing.status} corrupt=${corrupt.status} dbUntouched=${dbHashBefore === dbHashAfter} list=${listOk}/count=${list.json?.backups?.length}`,
		{ create: create.json, pruneCreate: pruneCreate.json, afterPrune },
	);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });

	const scenarios = [
		["M1", scenarioM1],
		["M2", scenarioM2],
		["M3", scenarioM3],
		["M4", scenarioM4],
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

	console.log("\n=== SUMMARY ===");
	for (const r of resultsTotal)
		console.log(`${r.scenario}: ${r.pass ? "PASS" : "FAIL"} — ${r.line}`);
	const anyPass = resultsTotal.filter((r) => r.pass).length;
	console.log(`\nTOTAL: ${anyPass}/${resultsTotal.length} pass`);

	try {
		appendFileSync(
			join(OUT_DIR, "summary.txt"),
			`\nTOTAL: ${anyPass}/${resultsTotal.length} pass\n`,
		);
	} catch {
		/* non-fatal */
	}

	await prisma.$disconnect();
	process.exit(failed > 0 || anyPass !== resultsTotal.length ? 1 : 0);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
