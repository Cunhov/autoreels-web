#!/usr/bin/env node
/**
 * Module-07 gauntlet — I1..I4 invariant harness (import-url, file serving,
 * storage/quota, drift maintenance).
 *
 * Drives a RUNNING standalone app (see import-run.sh). NO product fixes.
 *
 * Scenario order matters: I3 (quota) runs FIRST — the quota aggregate counts
 * every content item, and I1's imports would otherwise fill it.
 *
 * I1 asserts the SSRF guard matrix + input validation + a graceful real
 * download failure. REAL CONTRACT FINDINGS: the SSRF guard blocks
 * loopback/private hosts by design (a local fixture server is unreachable
 * through the real route), and the route's fetch in the standalone build
 * bypasses process-level fetch preloads — so the download success-path is not
 * hermetically exercisable; the download logic is code-reviewed instead.
 *
 * Usage:
 *   node import-scenarios.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --uploads-dir <dir> --server-log <log>
 *        --out <dir> --fixture-state <json-path>
 *
 * Exit code 0 only if every scenario passes.
 */
import {
	appendFileSync,
	writeFileSync,
	readFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	rmSync,
	utimesSync,
} from "node:fs";
import { join, dirname } from "node:path";
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
const SERVER_LOG = getArg("--server-log");
const OUT_DIR = getArg("--out");
const FIXTURE_STATE = getArg("--fixture-state");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--uploads-dir", UPLOADS_DIR],
	["--server-log", SERVER_LOG],
	["--out", OUT_DIR],
	["--fixture-state", FIXTURE_STATE],
]) {
	if (!value) {
		console.error(`Missing required argument ${name}`);
		process.exit(2);
	}
}

const NS = "admin";

const prisma = new PrismaClient({
	adapter: new PrismaBetterSqlite3({ url: "file:" + DB_PATH }),
});

// ── Auth: mint a next-auth session JWT (sub='admin') ────────────────────────
const SESSION_COOKIE = `next-auth.session-token=${await encode({
	token: { sub: "admin" },
	secret: SECRET,
	maxAge: 3600,
})}`;

// ── Small helpers ───────────────────────────────────────────────────────────
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

function writeSeedFile(relPath, bytes) {
	const abs = join(UPLOADS_DIR, relPath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
}

function rmFile(relPath) {
	try {
		rmSync(join(UPLOADS_DIR, relPath), { force: true });
	} catch {
		/* ignore */
	}
}

function ageFile(relPath, hoursAgo) {
	const abs = join(UPLOADS_DIR, relPath);
	if (!existsSync(abs)) return;
	const past = new Date(Date.now() - hoursAgo * 3600 * 1000);
	utimesSync(abs, past, past);
}

/** Recursively list relative paths under UPLOADS_DIR (for drift scans). */
function listFiles(dir = UPLOADS_DIR, prefix = "") {
	const out = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...listFiles(join(dir, e.name), rel));
		else out.push(rel);
	}
	return out;
}

/** Files under <uploads>/admin matching a basename suffix. */
function findUploadedFile(suffix) {
	return listFiles(join(UPLOADS_DIR, "admin")).filter((p) => p.endsWith(suffix));
}

async function seedUser() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// I3 — storage API + quota (runs FIRST: the quota aggregate must start empty)
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioI3() {
	await seedUser();

	// Real contract: /api/storage is DELETE-only (no GET quota endpoint exists —
	// quota lives in the upload-complete route via UPLOAD_QUOTA_BYTES=4096).
	// (a) DELETE removes the file.
	const delFileRel = `${NS}/i3-delete-me.mp4`;
	writeSeedFile(delFileRel, Buffer.alloc(1024, 1));
	const del = await req(`/api/storage?path=${encodeURIComponent(delFileRel)}`, {
		method: "DELETE",
	});
	const delGone = !existsSync(join(UPLOADS_DIR, delFileRel));
	// (b) traversal → 403, nothing deleted outside uploads.
	const outside = join(UPLOADS_DIR, "..", "escape-i3.txt");
	writeFileSync(outside, "x");
	const trav = await req(`/api/storage?path=${encodeURIComponent("../escape-i3.txt")}`, {
		method: "DELETE",
	});
	const outsideIntact = existsSync(outside);
	// (c) missing file → still success (ENOENT swallowed), no crash.
	const missing = await req(`/api/storage?path=${encodeURIComponent(`${NS}/i3-never-existed.mp4`)}`, {
		method: "DELETE",
	});

	// (d) quota enforcement at upload-complete: A(2048) ok, B(2048) ok,
	// C(2048) → 413 (used=4096), delete A → used=2048 → D(2048) ok again.
	const uploadParts = async (name) => {
		const partBase = `${NS}/${name}.part`;
		writeSeedFile(`${partBase}.0`, Buffer.alloc(1024, 5));
		writeSeedFile(`${partBase}.1`, Buffer.alloc(1024, 6));
		const fd = new FormData();
		fd.append("filename", name);
		fd.append("size", "2048");
		fd.append("path", `${NS}/${name}`);
		fd.append("totalChunks", "2");
		fd.append("type", "video");
		const r = await req("/api/upload-chunk/complete", { method: "POST", body: fd });
		for (const i of [0, 1]) rmFile(`${partBase}.${i}`);
		return r;
	};
	const rA = await uploadParts("quota-a.mp4");
	const itemAId = rA.json?.item?.id;
	const rB = await uploadParts("quota-b.mp4");
	const rC = await uploadParts("quota-c.mp4"); // → 413
	await req(`/api/content-items/${itemAId}`, { method: "DELETE" });
	const rD = await uploadParts("quota-d.mp4"); // after delete → ok again

	// Cleanup the uploaded files (delete remaining items via API).
	for (const name of ["quota-b.mp4", "quota-c.mp4", "quota-d.mp4"]) {
		const row = await prisma.contentItem.findFirst({ where: { user_id: "admin", name } });
		if (row) await req(`/api/content-items/${row.id}`, { method: "DELETE" });
	}
	try {
		rmSync(outside, { force: true });
	} catch {
		/* ignore */
	}

	const pass =
		del.status === 200 && delGone &&
		trav.status === 403 && outsideIntact &&
		missing.status === 200 &&
		rA.status === 200 && rB.status === 200 &&
		rC.status === 413 && rD.status === 200;
	record(
		"I3",
		Boolean(pass),
		`storage: del=${del.status}/gone=${delGone} trav=${trav.status}/outsideIntact=${outsideIntact} missing=${missing.status} quota: A=${rA.status} B=${rB.status} C=${rC.status}(413) delete→D=${rD.status}`,
		{ delStatus: del.status, travStatus: trav.status, quotaStatuses: [rA.status, rB.status, rC.status, rD.status] },
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// I4 — drift maintenance (the real drift path: orphan .part > 24h) + delete-time
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioI4() {
	const CRON_HEADERS = { "x-cron-auth": "unused" };

	// Stale parts (25h) — recursive dir — must be removed.
	writeSeedFile(`${NS}/i4-stale-1.part`, Buffer.alloc(16, 1));
	writeSeedFile(`${NS}/i4-sub/stale-2.part`, Buffer.alloc(16, 1));
	ageFile(`${NS}/i4-stale-1.part`, 25);
	ageFile(`${NS}/i4-sub/stale-2.part`, 25);
	// Fresh part (1h) — must STAY.
	writeSeedFile(`${NS}/i4-fresh.part`, Buffer.alloc(16, 2));
	ageFile(`${NS}/i4-fresh.part`, 1);
	// Non-.part old file — must STAY.
	writeSeedFile(`${NS}/i4-old.mp4`, Buffer.alloc(16, 3));
	ageFile(`${NS}/i4-old.mp4`, 25);
	// Final file with NO DB row — must STAY (documented: no final-file sweep exists).
	writeSeedFile(`${NS}/i4-orphan-final.mp4`, Buffer.alloc(16, 4));

	// Terminal posts: old (-100d) → deleted; recent (-10d) → stays; pending (-100d) → stays.
	const oldPost = await prisma.post.create({
		data: { id: "i4-old-post", user_id: "admin", status: "published", media_type: "REELS", published_at: new Date(Date.now() - 100 * 86400e3), created_at: new Date(Date.now() - 100 * 86400e3) },
	});
	await prisma.post.create({
		data: { id: "i4-recent-post", user_id: "admin", status: "published", media_type: "REELS", published_at: new Date(Date.now() - 10 * 86400e3), created_at: new Date(Date.now() - 10 * 86400e3) },
	});
	await prisma.post.create({
		data: { id: "i4-pending-post", user_id: "admin", status: "pending", media_type: "REELS", created_at: new Date(Date.now() - 100 * 86400e3) },
	});
	// Old planner log (-40d) → deleted (planner row must exist for the FK).
	await prisma.planner.create({
		data: { id: "i4-planner", user_id: "admin", name: "I4 Planner", config: JSON.stringify({ frequency: { value: 5, unit: "minutes" } }), status: "active" },
	}).catch(() => {});
	await prisma.plannerLog.create({
		data: { id: "i4-old-log", planner_id: "i4-planner", message: "old", level: "info", created_at: new Date(Date.now() - 40 * 86400e3) },
	}).catch(() => {});

	const unauth = await req("/api/cron/maintenance", { method: "POST" });
	const res = await req("/api/cron/maintenance", { method: "POST", headers: CRON_HEADERS });

	const stale1Gone = !existsSync(join(UPLOADS_DIR, `${NS}/i4-stale-1.part`));
	const stale2Gone = !existsSync(join(UPLOADS_DIR, `${NS}/i4-sub/stale-2.part`));
	const freshStays = existsSync(join(UPLOADS_DIR, `${NS}/i4-fresh.part`));
	const oldNonPartStays = existsSync(join(UPLOADS_DIR, `${NS}/i4-old.mp4`));
	const orphanFinalStays = existsSync(join(UPLOADS_DIR, `${NS}/i4-orphan-final.mp4`));
	const oldPostGone = (await prisma.post.findUnique({ where: { id: "i4-old-post" } })) === null;
	const recentStays = (await prisma.post.findUnique({ where: { id: "i4-recent-post" } })) !== null;
	const pendingStays = (await prisma.post.findUnique({ where: { id: "i4-pending-post" } })) !== null;
	const partsDeleted = res.json?.parts_deleted;
	const postsDeleted = res.json?.posts_deleted;

	const pass =
		unauth.status === 401 &&
		res.status === 200 &&
		stale1Gone && stale2Gone &&
		freshStays && oldNonPartStays && orphanFinalStays &&
		oldPostGone && recentStays && pendingStays &&
		partsDeleted >= 2 && postsDeleted >= 1;
	record(
		"I4",
		Boolean(pass),
		`maintenance: unauth=${unauth.status} ok=${res.status} parts_deleted=${partsDeleted} posts_deleted=${postsDeleted} staleGone=${stale1Gone}/${stale2Gone} freshStays=${freshStays} oldNonPartStays=${oldNonPartStays} orphanFinalStays=${orphanFinalStays} oldPostGone=${oldPostGone} recentStays=${recentStays} pendingStays=${pendingStays} (documented: no final-file drift sweep exists)`,
		{ partsDeleted, postsDeleted, staleGone: stale1Gone && stale2Gone, orphanFinalStays },
	);
	for (const rel of [`${NS}/i4-fresh.part`, `${NS}/i4-old.mp4`, `${NS}/i4-orphan-final.mp4`]) rmFile(rel);
}

// ═══════════════════════════════════════════════════════════════════════════
// I2 — file serving (path-based route; no auth — UUID names, by design)
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioI2() {
	const mp4Rel = `${NS}/i2-hello-world.mp4`;
	const unicodeRel = `${NS}/meu arquivo (1).mp4`;
	const nestedRel = `${NS}/i2-nested/sub/file.png`;
	const mp4Bytes = Buffer.alloc(10 * 1024, 7);
	writeSeedFile(mp4Rel, mp4Bytes);
	writeSeedFile(unicodeRel, Buffer.alloc(512, 8));
	writeSeedFile(nestedRel, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

	// Fetch raw for headers/body.
	const raw = await fetch(`${BASE}/api/file/${mp4Rel}`);
	const rawBody = Buffer.from(await raw.arrayBuffer());
	const rawHeaders = Object.fromEntries(raw.headers.entries());
	const etagValue = rawHeaders["etag"] || "";

	const rangeRes = await fetch(`${BASE}/api/file/${mp4Rel}`, { headers: { Range: "bytes=0-99" } });
	const rangeBody = Buffer.from(await rangeRes.arrayBuffer());
	const rangeHeaders = Object.fromEntries(rangeRes.headers.entries());

	const etagRes = await fetch(`${BASE}/api/file/${mp4Rel}`, { headers: { "If-None-Match": etagValue } });

	const headRes = await fetch(`${BASE}/api/file/${mp4Rel}`, { method: "HEAD" });
	const headBody = Buffer.from(await headRes.arrayBuffer());

	const unicodeRes = await fetch(`${BASE}/api/file/${encodeURIComponent(unicodeRel)}`);
	const nestedRes = await fetch(`${BASE}/api/file/${nestedRel}`);
	const nestedBytes = Buffer.from(await nestedRes.arrayBuffer());

	const missingRes = await fetch(`${BASE}/api/file/${NS}/i2-missing.mp4`);
	const travRes = await fetch(`${BASE}/api/file/${NS}/%2e%2e/etc/passwd`);
	const travPlain = await fetch(`${BASE}/api/file/../etc/passwd`);
	const backslashRes = await fetch(`${BASE}/api/file/${NS}/..%5C..%5Cx`);
	const absoluteRes = await fetch(`${BASE}/api/file//etc/passwd`);
	const dirRes = await fetch(`${BASE}/api/file/${NS}/i2-nested`);

	const is4xx = (n) => n >= 400 && n < 500;
	// Traversal is rejected at the router level (encoded `..` → 404 before the
	// route; backslash reaches the route's own guard → 403). Both are SAFE:
	// 4xx, never 200, never serving outside uploads.
	const pass =
		raw.status === 200 &&
		rawHeaders["content-type"] === "video/mp4" &&
		rawBody.length === mp4Bytes.length &&
		Boolean(etagValue) &&
		rangeRes.status === 206 &&
		rangeBody.length === 100 &&
		rangeHeaders["content-range"] === `bytes 0-99/${mp4Bytes.length}` &&
		etagRes.status === 304 &&
		headRes.status === 200 &&
		headBody.length === 0 &&
		unicodeRes.status === 200 &&
		nestedRes.status === 200 &&
		nestedBytes.length === 8 &&
		missingRes.status === 404 &&
		is4xx(travRes.status) && is4xx(travPlain.status) && is4xx(backslashRes.status) && is4xx(absoluteRes.status) &&
		dirRes.status === 404;
	record(
		"I2",
		Boolean(pass),
		`serve: ${raw.status}/video-mp4/${rawBody.length}B etag=${Boolean(etagValue)} range=${rangeRes.status}/100B/${rangeHeaders["content-range"]} etag304=${etagRes.status} head=${headRes.status}/${headBody.length}B unicode=${unicodeRes.status} nested=${nestedRes.status} missing=${missingRes.status} trav=${travRes.status}/${travPlain.status}(4xx-safe) backslash=${backslashRes.status} absolute=${absoluteRes.status} dir=${dirRes.status} (route streams via createReadStream; no auth — UUID names by design; traversal blocked at router level for .. and at the route for backslash)`,
		{ serveStatus: raw.status, rangeStatus: rangeRes.status, travStatuses: [travRes.status, travPlain.status] },
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// I1 — import-url robustness (SSRF matrix + fixture download cases)
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioI1() {
	const importUrl = async (url, name) => {
		const body = JSON.stringify({ url, name });
		const started = Date.now();
		const res = await req("/api/import-url", { method: "POST", body, headers: { "Content-Type": "application/json" } });
		return { ...res, elapsedMs: Date.now() - started };
	};

	// ── SSRF guard matrix (no network for these — the guard fires first) ──
	const blockedHosts = [
		"http://127.0.0.1:9999/x.mp4",
		"http://localhost/x.mp4",
		"http://10.0.0.1/x.mp4",
		"http://192.168.1.1/x.mp4",
		"http://172.16.0.1/x.mp4",
		"http://169.254.1.1/x.mp4",
	];
	const ssrfResults = [];
	for (const u of blockedHosts) {
		const r = await importUrl(u, "ssrf.mp4");
		ssrfResults.push({ url: u, status: r.status, error: r.json?.error });
	}
	const ssrfOk =
		ssrfResults.every((r) => r.status === 400) &&
		ssrfResults.every((r) => String(r.error).includes("not publicly reachable"));

	// ── Input validation matrix ────────────────────────────────────────────
	const badUrl = await importUrl("not a url", "x.mp4");
	const ftpUrl = await importUrl("ftp://example.com/x.mp4", "x.mp4");
	const credUrl = await importUrl("http://user:pass@example.com/x.mp4", "x.mp4");
	const noExtUrl = await importUrl("https://example.com/fixture/noext", "x.mp4");
	const missingUrl = await req("/api/import-url", { method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } });
	const inputOk =
		badUrl.status === 400 && ftpUrl.status === 400 && credUrl.status === 400 &&
		noExtUrl.status === 400 && missingUrl.status === 400;

	// ── Real failed download → clean 400, no partial file, no crash ───────
	// A public host (graph.instagram.com — passes the SSRF guard) with an
	// unknown path returns non-2xx; the route must map it to a clean 400,
	// unlink any partial file, and never crash. Bounded (elapsed < 10s).
	const realFail = await importUrl("https://graph.instagram.com/fixture/gauntlet-real.mp4", "gauntlet-real.mp4");
	const realNoFile = findUploadedFile("-gauntlet-real.mp4").length === 0;
	const realOk = realFail.status === 400 && realNoFile && realFail.elapsedMs < 10_000;

	const pass = ssrfOk && inputOk && realOk;
	record(
		"I1",
		Boolean(pass),
		`ssrf=${ssrfOk}(400x${ssrfResults.length} "not publicly reachable") inputs=${inputOk}(bad/ftp/creds/noext/missing→400) realFail=${realFail.status}/noFile=${realNoFile}/elapsed=${(realFail.elapsedMs / 1000).toFixed(1)}s — DOCUMENTED LIMITATION: local fixture is blocked by the app's own SSRF guard (by design) and the download path is not hermetically exercisable through the real route (standalone build bypasses process-level fetch preloads for this route); download logic code-reviewed (redirect-follow + redirect-host re-validation, mid-stream 300MB cap→413+unlink, content-type check, cleanup-on-failure, 90s timeout)`,
		{
			ssrf: ssrfResults,
			statuses: { realFail: realFail.status },
			limitation: "download-path-not-hermetically-exercisable",
		},
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════
const scenarios = [
	["I3", scenarioI3],
	["I4", scenarioI4],
	["I2", scenarioI2],
	["I1", scenarioI1],
];

let failed = 0;
for (const [label, fn] of scenarios) {
	try {
		await fn();
	} catch (err) {
		failed++;
		resultsTotal.push({ scenario: label, pass: false, line: `EXCEPTION: ${err?.message || err}` });
		console.error(`SCENARIO ${label}: EXCEPTION — ${err?.stack || err}`);
	}
}
const anyPass = resultsTotal.filter((r) => r.pass).length;
console.log("\n=== SUMMARY ===");
for (const r of resultsTotal) console.log(`${r.scenario}: ${r.pass ? "PASS" : "FAIL"} — ${r.line}`);
console.log(`\nTOTAL: ${anyPass}/${resultsTotal.length} pass`);

const wholeLog = readFileSync(SERVER_LOG, "utf8");
const crashes = (wholeLog.match(/Unhandled|TypeError|ENOENT/g) || []).length;
console.log(`server log crash-signal lines: ${crashes}`);

try {
	writeFileSync(join(OUT_DIR, "import-summary.txt"), resultsTotal.map((r) => `${r.scenario}: ${r.pass ? "PASS" : "FAIL"} — ${r.line}`).join("\n"));
} catch {
	/* ignore */
}
await prisma.$disconnect();
process.exit(failed > 0 || anyPass !== resultsTotal.length || crashes > 0 ? 1 : 0);
