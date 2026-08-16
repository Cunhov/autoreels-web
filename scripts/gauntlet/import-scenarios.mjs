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
 * I1 uses https://example.com (FIXTURE_HOST) as the import target: the app's
 * SSRF guard blocks loopback/private hosts by design (verified as a scenario),
 * so a local fixture server is unreachable through the real route. The
 * import-fixture.mjs preload (loaded into the app server process) intercepts
 * example.com and serves deterministic fixture content — no real example.com
 * traffic, and the SSRF guard's DNS check passes (public addresses).
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

const FIXTURE_HOST = "example.com";
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

/** Write the full fixture route map ONCE (paths are per-case, never collide). */
function writeFixtureState() {
	const routes = {
		"/fixture/a.mp4": { status: 200, contentType: "video/mp4", size: 102400 },
		"/fixture/b.png": { status: 200, contentType: "image/png", size: 1024 },
		"/fixture/c-redirect": { redirectTo: "/fixture/c-target.mp4" },
		"/fixture/c-target.mp4": { status: 200, contentType: "video/mp4", size: 4096 },
		"/fixture/d-404.mp4": { status: 404, bodyText: "nope" },
		"/fixture/e-403.mp4": { status: 403, bodyText: "denied" },
		"/fixture/f-big.mp4": { status: 200, contentType: "video/mp4", size: 310 * 1024 * 1024 },
		"/fixture/g.mp4": { status: 200, contentType: "text/html", bodyText: "<html>fake video</html>" },
		"/fixture/h-slow.mp4": { status: 200, contentType: "video/mp4", size: 2048, delayMs: 95_000 },
	};
	writeFileSync(FIXTURE_STATE, JSON.stringify({ routes }));
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
		travRes.status === 403 &&
		backslashRes.status === 403 &&
		absoluteRes.status === 403 &&
		dirRes.status === 404;
	record(
		"I2",
		Boolean(pass),
		`serve: ${raw.status}/video-mp4/${rawBody.length}B etag=${Boolean(etagValue)} range=${rangeRes.status}/100B/${rangeHeaders["content-range"]} etag304=${etagRes.status} head=${headRes.status}/${headBody.length}B unicode=${unicodeRes.status} nested=${nestedRes.status} missing=${missingRes.status} trav=${travRes.status}/${travPlain.status} backslash=${backslashRes.status} absolute=${absoluteRes.status} dir=${dirRes.status} (route streams via createReadStream; no auth — UUID names by design)`,
		{ serveStatus: raw.status, rangeStatus: rangeRes.status, travStatuses: [travRes.status, travPlain.status] },
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// I1 — import-url robustness (SSRF matrix + fixture download cases)
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioI1() {
	writeFixtureState();

	const importUrl = async (url, name) => {
		const body = JSON.stringify({ url, name });
		const started = Date.now();
		const res = await req("/api/import-url", { method: "POST", body, headers: { "Content-Type": "application/json" } });
		return { ...res, elapsedMs: Date.now() - started };
	};

	// ── SSRF guard matrix (no fetch ever leaves the machine) ──────────────
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

	// ── Fixture download cases ─────────────────────────────────────────────
	const a = await importUrl(`https://${FIXTURE_HOST}/fixture/a.mp4`, "gauntlet-a.mp4");
	const aFiles = findUploadedFile("-gauntlet-a.mp4");
	const aFileOk = aFiles.length === 1 && statSync(join(UPLOADS_DIR, "admin", aFiles[0])).size === 102400;

	const b = await importUrl(`https://${FIXTURE_HOST}/fixture/b.png`, "gauntlet-b.png");
	const bFiles = findUploadedFile("-gauntlet-b.png");
	const bFileOk = bFiles.length === 1 && statSync(join(UPLOADS_DIR, "admin", bFiles[0])).size === 1024;

	const c = await importUrl(`https://${FIXTURE_HOST}/fixture/c-redirect`, "gauntlet-c.mp4");
	const cFiles = findUploadedFile("-gauntlet-c.mp4");
	const cFileOk = cFiles.length === 1 && statSync(join(UPLOADS_DIR, "admin", cFiles[0])).size === 4096;

	const d = await importUrl(`https://${FIXTURE_HOST}/fixture/d-404.mp4`, "gauntlet-d.mp4");
	const dNoFile = findUploadedFile("-gauntlet-d.mp4").length === 0;

	const e = await importUrl(`https://${FIXTURE_HOST}/fixture/e-403.mp4`, "gauntlet-e.mp4");
	const eNoFile = findUploadedFile("-gauntlet-e.mp4").length === 0;

	const f = await importUrl(`https://${FIXTURE_HOST}/fixture/f-big.mp4`, "gauntlet-f.mp4");
	const fNoFile = findUploadedFile("-gauntlet-f.mp4").length === 0;

	const g = await importUrl(`https://${FIXTURE_HOST}/fixture/g.mp4`, "gauntlet-g.mp4");
	const gNoFile = findUploadedFile("-gauntlet-g.mp4").length === 0;

	const h = await importUrl(`https://${FIXTURE_HOST}/fixture/h-slow.mp4`, "gauntlet-h.mp4");
	const hNoFile = findUploadedFile("-gauntlet-h.mp4").length === 0;

	const fixtureOk =
		a.status === 201 && a.json?.type === "video" && a.json?.size === 102400 && aFileOk &&
		b.status === 201 && b.json?.type === "image" && bFileOk &&
		c.status === 201 && c.json?.type === "video" && cFileOk &&
		d.status === 400 && dNoFile &&
		e.status === 400 && eNoFile &&
		f.status === 413 && fNoFile &&
		g.status === 400 && gNoFile &&
		h.status === 400 && hNoFile &&
		h.elapsedMs >= 80_000; // bounded by the 90s fetch timeout — clean error

	const pass = ssrfOk && inputOk && fixtureOk;
	record(
		"I1",
		Boolean(pass),
		`ssrf=${ssrfOk}(400×${ssrfResults.length}) inputs=${inputOk} a=${a.status}/102400/${aFileOk} b=${b.status}/${bFileOk} c=${c.status}/${cFileOk} d=${d.status}/noFile=${dNoFile} e=${e.status}/noFile=${eNoFile} f=${f.status}(413)/noFile=${fNoFile} g=${g.status}/noFile=${gNoFile} h=${h.status}/noFile=${hNoFile}/elapsed=${(h.elapsedMs / 1000).toFixed(0)}s (SSRF guard blocks loopback/private by design — fixture host ${FIXTURE_HOST} passes DNS, intercepted by preload)`,
		{
			ssrf: ssrfResults,
			statuses: { a: a.status, b: b.status, c: c.status, d: d.status, e: e.status, f: f.status, g: g.status, h: h.status },
			slowElapsedMs: h.elapsedMs,
		},
	);

	// Cleanup items created by I1 (keep the quota aggregate clean for later).
	const created = await prisma.contentItem.findMany({ where: { user_id: "admin" } });
	for (const item of created) {
		await req(`/api/content-items/${item.id}`, { method: "DELETE" }).catch(() => {});
		if (item.path) rmFile(item.path);
	}
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
