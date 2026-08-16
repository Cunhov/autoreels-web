#!/usr/bin/env node
/**
 * Upload gauntlet scenario runner.
 *
 * Drives a RUNNING instance of the app over real HTTP and asserts the bar
 * scenarios A-E from gauntlet-runs/upload-robustness/refs/bar-scenarios.md.
 * This file contains NO product fixes — it only measures. On the current code
 * the expected outcome is A/B/C/D FAIL, E PASS.
 *
 * Usage:
 *   node harness.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --cron-secret <CRON_SECRET>
 *        --uploads <uploads-root> --out <evidence-dir>
 *
 * Exit code 0 only if every scenario passes.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { encode } from "next-auth/jwt";
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
const SECRET = getArg("--secret");
const CRON_SECRET = getArg("--cron-secret");
const UPLOADS_ROOT = getArg("--uploads");
const OUT_DIR = getArg("--out");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--cron-secret", CRON_SECRET],
	["--uploads", UPLOADS_ROOT],
	["--out", OUT_DIR],
]) {
	if (!value) {
		console.error(`Missing required argument ${name}`);
		process.exit(2);
	}
}

const CHUNK = 5 * 1024 * 1024; // 5MB — must match the client/server convention
const SERVER_LOG = join(UPLOADS_ROOT, "..", "server.log");
const GARBAGE_TOKEN =
	"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.garbage-not-a-valid-instagram-token";

// ── Prisma (verify side: test DB) ───────────────────────────────────────────
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function chunkBuffer(seed, index, size = CHUNK) {
	const rnd = mulberry32(((seed * 31 + index) >>> 0) ^ 0x9e3779b9);
	const buf = Buffer.allocUnsafe(size);
	for (let i = 0; i < size; i += 4) {
		buf.writeUInt32LE((rnd() * 4294967296) >>> 0, i);
	}
	return buf;
}

function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

function makeFile(seed, chunkCount) {
	const chunks = [];
	const hasher = createHash("sha256");
	for (let i = 0; i < chunkCount; i++) {
		const c = chunkBuffer(seed, i);
		chunks.push(c);
		hasher.update(c);
	}
	return { chunks, size: chunkCount * CHUNK, hash: hasher.digest("hex") };
}

async function req(
	path,
	{ method = "GET", headers = {}, body, timeoutMs = 120000 } = {},
) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(BASE + path, {
			method,
			headers,
			body,
			signal: ctl.signal,
			redirect: "manual",
		});
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* non-JSON body */
		}
		return { status: res.status, ok: res.ok, json, text };
	} finally {
		clearTimeout(timer);
	}
}

async function uploadChunk(path, index, total, size, chunk) {
	return req("/api/upload-chunk", {
		method: "POST",
		headers: {
			"x-chunk-index": String(index),
			"x-total-chunks": String(total),
			"x-file-size": String(size),
			"x-file-name": path,
			"Content-Type": "application/octet-stream",
			Cookie: SESSION_COOKIE,
		},
		body: chunk,
		timeoutMs: 60000,
	});
}

async function uploadAllChunks(path, file, indices = null) {
	const list = indices ?? file.chunks.map((_, i) => i);
	for (const i of list) {
		const r = await uploadChunk(
			path,
			i,
			file.chunks.length,
			file.size,
			file.chunks[i],
		);
		if (!r.ok) {
			throw new Error(`chunk ${i} failed: ${r.status} ${r.text.slice(0, 200)}`);
		}
	}
}

async function completeUpload(name, path, size, totalChunks) {
	const fd = new FormData();
	fd.append("filename", name);
	fd.append("size", String(size));
	fd.append("path", path);
	fd.append("totalChunks", String(totalChunks));
	fd.append("type", "video");
	return req("/api/upload-chunk/complete", {
		method: "POST",
		headers: { Cookie: SESSION_COOKIE },
		body: fd,
		timeoutMs: 180000,
	});
}

async function statusOf(path) {
	return req(`/api/upload-chunk/status?path=${encodeURIComponent(path)}`, {
		headers: { Cookie: SESSION_COOKIE },
	});
}

async function cancelUpload(path) {
	return req(`/api/upload-chunk?path=${encodeURIComponent(path)}`, {
		method: "DELETE",
		headers: { Cookie: SESSION_COOKIE },
	});
}

async function diskHashFromItem(item) {
	if (!item?.url) return null;
	const rel = item.url.replace(/^\/api\/file\//, "");
	const disk = join(UPLOADS_ROOT, rel);
	const buf = await readFile(disk);
	return { disk, hash: sha256(buf), size: buf.length };
}

// ── Server log tailing (scoped assertions) ──────────────────────────────────
let logOffset = 0;
async function logTail() {
	try {
		const text = await readFile(SERVER_LOG, "utf8");
		const fresh = logOffset === 0 ? text : text.slice(logOffset);
		logOffset = text.length;
		return fresh;
	} catch {
		return "";
	}
}

// ── Result plumbing ─────────────────────────────────────────────────────────
const results = {};
function record(name, pass, evidence, extra = {}) {
	results[name] = { pass, evidence, ...extra };
	console.log(`SCENARIO ${name}: ${pass ? "PASS" : "FAIL"} — ${evidence}`);
	writeFileSync(
		join(OUT_DIR, `scenario-${name.toLowerCase()}.json`),
		JSON.stringify({ pass, evidence, ...extra }, null, 2),
	);
}

// ── Baseline seed: the app requires the admin User row (FK enforced) ────────
// Production always has this user (next-auth authorize returns id 'admin');
// without it every contentItem.create() fails with P2003.
async function seedBaseline() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
	await prisma.contentItem.deleteMany({ where: { user_id: "admin" } });
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO A — stress: concurrent uploads, listener-leak scan
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioA() {
	await logTail(); // reset tail
	const files = [
		{ name: "gauntlet-a-1.mp4", seed: 101, chunks: 4 },
		{ name: "gauntlet-a-2.mp4", seed: 102, chunks: 4 },
		{ name: "gauntlet-a-3.mp4", seed: 103, chunks: 20 }, // >5 chunks → listener leak on current code
	].map((f) => ({ ...f, file: makeFile(f.seed, f.chunks) }));

	const outcomes = await Promise.all(
		files.map(async (f) => {
			await uploadAllChunks(`admin/${f.name}`, f.file);
			const done = await completeUpload(
				f.name,
				`admin/${f.name}`,
				f.file.size,
				f.file.chunks.length,
			);
			return { name: f.name, done, file: f.file };
		}),
	);

	const log = await logTail();
	const leaked = /MaxListenersExceededWarning/i.test(log);
	const problems = [];
	for (const o of outcomes) {
		if (!o.done.ok) {
			problems.push(`${o.name}: complete ${o.done.status}`);
			continue;
		}
		const item = o.done.json?.item;
		const onDisk = await diskHashFromItem(item);
		if (!onDisk || onDisk.hash !== o.file.hash) {
			problems.push(
				`${o.name}: hash mismatch (disk=${onDisk?.hash?.slice(0, 12) ?? "missing"} src=${o.file.hash.slice(0, 12)})`,
			);
		}
		const count = await prisma.contentItem.count({
			where: { user_id: "admin", name: o.name },
		});
		if (count !== 1)
			problems.push(`${o.name}: ${count} ContentItems (expected 1)`);
	}
	record(
		"A",
		!leaked && problems.length === 0,
		leaked
			? `MaxListenersExceededWarning found in server log`
			: problems.length
				? problems.join("; ")
				: `3 files (4/4/20 chunks) finalized, hashes match, 1 item each, no warnings`,
		{
			leaked,
			problems,
			serverLogProbe: log
				.split("\n")
				.filter((l) => /MaxListeners/i.test(l))
				.slice(0, 3),
		},
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO B — overlapping finalize + cancel + chunk re-POST race
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioB() {
	await logTail();
	const name = "gauntlet-b-1.mp4";
	const path = `admin/${name}`;
	// 40 chunks (200MB): concat takes hundreds of ms, so the racing DELETE and
	// the overlapping complete deterministically land mid-concat on current code.
	const file = makeFile(201, 40);
	await uploadAllChunks(path, file);

	const r1p = completeUpload(name, path, file.size, file.chunks.length); // t=0
	await sleep(80);
	const r2p = completeUpload(name, path, file.size, file.chunks.length); // retry race
	await sleep(70);
	const r3p = cancelUpload(path); // user-cancel during finalize
	await sleep(100);
	const r4p = uploadChunk(
		path,
		3,
		file.chunks.length,
		file.size,
		file.chunks[3],
	); // part re-POST mid-finalize

	const [r1, r2, r3, r4] = await Promise.all([r1p, r2p, r3p, r4p]);

	const log = await logTail();
	const enoent = /ENOENT|Finalizing upload error|Internal server error/i.test(
		log,
	);
	const completes = [r1, r2].filter((r) => r.ok);
	const items = await prisma.contentItem.findMany({
		where: { user_id: "admin", name },
	});
	let hashOk = false;
	if (items.length === 1 && items[0].url) {
		const onDisk = await diskHashFromItem(items[0]);
		hashOk = Boolean(onDisk && onDisk.hash === file.hash);
	}
	const { readdir } = await import("node:fs/promises");
	const partsDir = join(UPLOADS_ROOT, "admin");
	let orphan = [];
	try {
		const entries = await readdir(partsDir);
		orphan = entries.filter((e) => e.includes(`${name}.part.`));
	} catch {
		orphan = ["<no admin dir>"];
	}

	record(
		"B",
		!enoent &&
			completes.length === 1 &&
			items.length === 1 &&
			hashOk &&
			orphan.length === 0,
		`completes ok=${completes.length}/2 items=${items.length} hashOk=${hashOk} orphanParts=${orphan.length} enoent=${enoent}`,
		{
			statuses: {
				r1: r1.status,
				r2: r2.status,
				delete: r3.status,
				chunkRePost: r4.status,
			},
			enoent,
			orphan,
			serverLogProbe: log
				.split("\n")
				.filter((l) => /ENOENT|Finalizing|error/i.test(l))
				.slice(0, 6),
		},
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO C — same name + same folder, interleaved clients
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioC() {
	await logTail();
	const name = "gauntlet-c-shared.mp4";
	const path = `admin/${name}`;
	const f1 = makeFile(301, 4);
	const f2 = makeFile(302, 4); // different content

	// Interleave so the last writer differs per chunk index → mixed parts on disk.
	await uploadChunk(path, 0, 4, f1.size, f1.chunks[0]); // c1: 0
	await uploadChunk(path, 0, 4, f2.size, f2.chunks[0]); // c2: 0
	await uploadChunk(path, 1, 4, f2.size, f2.chunks[1]); // c2: 1
	await uploadChunk(path, 1, 4, f1.size, f1.chunks[1]); // c1: 1
	await uploadChunk(path, 2, 4, f1.size, f1.chunks[2]); // c1: 2
	await uploadChunk(path, 2, 4, f2.size, f2.chunks[2]); // c2: 2
	await uploadChunk(path, 3, 4, f1.size, f1.chunks[3]); // c1: 3
	await uploadChunk(path, 3, 4, f2.size, f2.chunks[3]); // c2: 3

	const [c1, c2] = await Promise.all([
		completeUpload(name, path, f1.size, 4),
		completeUpload(name, path, f2.size, 4),
	]);

	const log = await logTail();
	const enoent = /ENOENT|Finalizing upload error/i.test(log);
	const bothOk = c1.ok && c2.ok;
	const items = await prisma.contentItem.findMany({
		where: { user_id: "admin", name },
	});
	let matchesSource = false;
	if (items.length >= 1 && items[0].url) {
		const onDisk = await diskHashFromItem(items[0]);
		matchesSource = Boolean(
			onDisk && (onDisk.hash === f1.hash || onDisk.hash === f2.hash),
		);
	}

	record(
		"C",
		!enoent && bothOk && items.length === 1 && matchesSource,
		`completes ok=${c1.ok}/${c2.ok} items=${items.length} matchesSource=${matchesSource} enoent=${enoent}`,
		{
			enoent,
			items,
			serverLogProbe: log
				.split("\n")
				.filter((l) => /ENOENT|Finalizing|error/i.test(l))
				.slice(0, 6),
		},
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO D — invalid IG token must be marked, not retried every tick
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioD() {
	await logTail();
	const channelId = "chan-gauntlet-d";
	await prisma.channel.upsert({
		where: { id: channelId },
		update: {
			status: "active",
			access_token: GARBAGE_TOKEN,
			token_refreshed_at: null,
		},
		create: {
			id: channelId,
			user_id: "admin",
			name: "Gauntlet D",
			platform: "instagram",
			status: "active",
			access_token: GARBAGE_TOKEN,
			token_source: "manual",
		},
	});

	const r1 = await req("/api/cron/publisher", {
		method: "POST",
		headers: { "x-cron-auth": CRON_SECRET },
		timeoutMs: 90000,
	});
	await sleep(300);
	const r2 = await req("/api/cron/publisher", {
		method: "POST",
		headers: { "x-cron-auth": CRON_SECRET },
		timeoutMs: 90000,
	});
	await sleep(300);

	const log = await logTail();
	const lines = log
		.split("\n")
		.filter((l) => l.includes(`[ChannelRefresh] ${channelId}`));
	const channel = await prisma.channel.findUnique({ where: { id: channelId } });
	const terminal =
		channel &&
		(channel.status !== "active" || channel.token_refreshed_at !== null);

	record(
		"D",
		lines.length <= 1 && Boolean(terminal),
		`ChannelRefresh lines=${lines.length} (bar ≤1) terminalState=${terminal} cronStatus=${r1.status}/${r2.status}`,
		{
			lines,
			channelStatus: channel?.status,
			cronStatuses: [r1.status, r2.status],
		},
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO E — resume contract: partial upload, status, rest, complete
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioE() {
	await logTail();
	const name = "gauntlet-e-1.mp4";
	const path = `admin/${name}`;
	const file = makeFile(401, 10);

	await uploadAllChunks(path, file, [0, 1, 2]);
	const st = await statusOf(path);
	const chunksBefore = st.json?.chunks ?? null;
	const resumeOk =
		Array.isArray(chunksBefore) && JSON.stringify(chunksBefore) === "[0,1,2]";

	await uploadAllChunks(path, file, [3, 4, 5, 6, 7, 8, 9]);
	const done = await completeUpload(name, path, file.size, file.chunks.length);
	const items = await prisma.contentItem.findMany({
		where: { user_id: "admin", name },
	});
	let hashOk = false;
	if (items.length === 1 && items[0].url) {
		const onDisk = await diskHashFromItem(items[0]);
		hashOk = Boolean(onDisk && onDisk.hash === file.hash);
	}
	record(
		"E",
		resumeOk && done.ok && items.length === 1 && hashOk,
		`statusChunks=${JSON.stringify(chunksBefore)} complete=${done.status} items=${items.length} hashOk=${hashOk}`,
		{
			chunksBefore,
			doneStatus: done.status,
			statusResponse: { status: st.status, body: st.text.slice(0, 500) },
		},
	);
}

// ── Run ─────────────────────────────────────────────────────────────────────
console.log(`base=${BASE} db=${DB_PATH} uploads=${UPLOADS_ROOT}`);
console.log(`session cookie: ${SESSION_COOKIE.slice(0, 24)}…`);
await seedBaseline();
await scenarioA();
await scenarioB();
await scenarioC();
await scenarioD();
await scenarioE();
await prisma.$disconnect();

const allPass = Object.values(results).every((r) => r.pass);
console.log("");
console.log(
	`TOTAL: ${allPass ? "ALL PASS" : "FAILURES PRESENT"} (A-E: ${Object.entries(
		results,
	)
		.map(([k, v]) => `${k}=${v.pass ? "PASS" : "FAIL"}`)
		.join(" ")})`,
);
process.exit(allPass ? 0 : 1);
