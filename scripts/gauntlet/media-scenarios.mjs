#!/usr/bin/env node
/**
 * Media gauntlet — M5 (trim) + M6 (thumbnail), real ffmpeg/ffprobe.
 *
 * Requires ffmpeg + ffprobe on the host (lib/ffmpeg.ts checks availability and
 * the trim/thumbnail routes return 501 without it). Generates a 3s test clip
 * with ffmpeg at setup and writes real files into the uploads dir used by the
 * server (--uploads-dir). NO product fixes.
 *
 * Usage:
 *   node media-scenarios.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --uploads-dir <dir> --out <dir>
 */
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	existsSync,
	statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { encode } from "next-auth/jwt";

const argv = process.argv.slice(2);
const getArg = (key) => {
	const i = argv.indexOf(key);
	return i >= 0 ? argv[i + 1] : null;
};
const BASE = getArg("--base");
const DB_PATH = getArg("--db");
const SECRET = getArg("--secret");
const UPLOADS_DIR = getArg("--uploads-dir");
const OUT_DIR = getArg("--out");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--uploads-dir", UPLOADS_DIR],
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

const NS = "admin/gauntlet-mod4";
const NS_DIR = join(UPLOADS_DIR, NS);
const CLIP = join(NS_DIR, "clip.mp4");
const CORRUPT = join(NS_DIR, "corrupt.mp4");

function runFfmpeg(args) {
	return execFileSync("ffmpeg", args, {
		stdio: "pipe",
		timeout: 120_000,
	});
}

function probeDuration(path) {
	try {
		const out = execFileSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"default=noprint_wrappers=1:nokey=1",
				path,
			],
			{ stdio: "pipe", timeout: 30_000 },
		);
		return Number(String(out).trim());
	} catch {
		return null;
	}
}

function listThumbs() {
	// Thumbnails land at uploads/admin/thumb-*.jpg (userId dir, NOT the NS dir).
	try {
		return readdirSync(join(UPLOADS_DIR, "admin")).filter((f) =>
			f.startsWith("thumb-"),
		);
	} catch {
		return [];
	}
}

async function req(
	path,
	{ method = "POST", body, headers = {}, timeoutMs = 90_000 } = {},
) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${BASE}${path}`, {
			method,
			headers: { Cookie: SESSION_COOKIE, ...headers },
			body,
			signal: controller.signal,
		});
		let json = null;
		try {
			json = await res.json();
		} catch {
			/* non-JSON */
		}
		return { ok: res.ok, status: res.status, json };
	} finally {
		clearTimeout(timer);
	}
}

let resultsTotal = [];
function record(label, pass, line, detail = {}) {
	resultsTotal.push({ scenario: label, pass, line, detail });
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── SCENARIO M5 — trim correctness ───────────────────────────────────────────

async function scenarioM5() {
	const ids = { posts: [], channels: [], items: [] };

	// Happy path: start 0.5s end 2.5s -> ~2s output.
	const trim = await req("/api/video/trim", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: `${NS}/clip.mp4`, start: 0.5, end: 2.5 }),
	});
	const outRel = trim.json?.url || "";
	const outName = outRel.split("/").pop() || "";
	const outPath = join(UPLOADS_DIR, outRel.replace("/api/file/", ""));
	const outDur = existsSync(outPath) ? probeDuration(outPath) : null;
	const happyOk =
		trim.status === 201 &&
		outName.startsWith("trim-") &&
		trim.json?.type === "video" &&
		typeof trim.json?.duration === "number" &&
		Math.abs(trim.json.duration - 2) <= 0.5 &&
		outDur !== null &&
		Math.abs(outDur - 2) <= 0.3;
	ids.items.push(trim.json?.id || "");
	// cleanup trim output file
	try {
		unlinkSync(outPath);
	} catch {
		/* non-fatal */
	}

	// start >= end -> 400
	const invRange = await req("/api/video/trim", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: `${NS}/clip.mp4`, start: 2.5, end: 0.5 }),
	});
	const invRangeOk = invRange.status === 400;

	// duration below MIN (1s) -> 400
	const tooShort = await req("/api/video/trim", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: `${NS}/clip.mp4`, start: 0, end: 0.5 }),
	});
	const tooShortOk = tooShort.status === 400;

	// start beyond the video duration (clip is 3s) -> 400
	const beyond = await req("/api/video/trim", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: `${NS}/clip.mp4`, start: 10, end: 11 }),
	});
	const beyondOk = beyond.status === 400;

	// nonexistent source -> 404
	const missing = await req("/api/video/trim", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: `${NS}/nope.mp4`, start: 0, end: 1 }),
	});
	const missingOk = missing.status === 404;

	// corrupt file -> clean error (>=400), bounded time, no hang
	writeFileSync(
		CORRUPT,
		"this is definitely not a video file, just garbage bytes 0123456789",
	);
	const corrupt = await req("/api/video/trim", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: `${NS}/corrupt.mp4`, start: 0, end: 1 }),
		timeoutMs: 90_000,
	});
	const corruptOk = corrupt.status >= 400;

	const pass =
		happyOk && invRangeOk && tooShortOk && beyondOk && missingOk && corruptOk;
	record(
		"M5",
		Boolean(pass),
		`happy=${happyOk}/status=${trim.status}/dur=${trim.json?.duration}/probe=${outDur} invRange=${invRangeOk}/${invRange.status} tooShort=${tooShortOk}/${tooShort.status} beyond=${beyondOk}/${beyond.status} missing=${missingOk}/${missing.status} corrupt=${corruptOk}/${corrupt.status}`,
		{ trim: trim.json, outDur, invRange: invRange.json, corrupt: corrupt.json },
	);

	await prisma.contentItem.deleteMany({
		where: { id: { in: ids.items.filter(Boolean) } },
	});
}

// ── SCENARIO M6 — thumbnail generation ───────────────────────────────────────

async function scenarioM6() {
	const ids = { posts: [], channels: [], items: [] };

	const item = await prisma.contentItem.create({
		data: {
			user_id: "admin",
			name: "clip.mp4",
			type: "video",
			size: statSync(CLIP).size,
			url: `/api/file/${NS}/clip.mp4`,
		},
	});
	ids.items.push(item.id);

	const thumbsBefore = listThumbs().length;

	const thumb = await req("/api/video/thumbnail", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			item_id: item.id,
			path: `${NS}/clip.mp4`,
			time: 1.0,
		}),
	});
	const thumbUrl = thumb.json?.thumbnail_url || "";
	const thumbPath = thumbUrl
		? join(UPLOADS_DIR, thumbUrl.replace("/api/file/", ""))
		: "";
	const magicOk =
		existsSync(thumbPath) &&
		readFileSync(thumbPath)
			.subarray(0, 3)
			.equals(Buffer.from([0xff, 0xd8, 0xff]));
	const happyOk =
		thumb.ok &&
		thumbUrl.startsWith("/api/file/") &&
		thumbUrl.includes("thumb-") &&
		magicOk;

	// Corrupt input -> >=400, NO partial thumbnail file created.
	const corruptItem = await prisma.contentItem.create({
		data: {
			user_id: "admin",
			name: "corrupt.mp4",
			type: "video",
			size: statSync(CORRUPT).size,
			url: `/api/file/${NS}/corrupt.mp4`,
		},
	});
	ids.items.push(corruptItem.id);
	const corrupt = await req("/api/video/thumbnail", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			item_id: corruptItem.id,
			path: `${NS}/corrupt.mp4`,
			time: 0.5,
		}),
		timeoutMs: 90_000,
	});
	const thumbsAfter = listThumbs().length;
	const corruptOk = corrupt.status >= 400 && thumbsAfter === thumbsBefore + 1; // only the happy thumb

	// Missing item -> 404
	const noItem = await req("/api/video/thumbnail", {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ item_id: "does-not-exist", path: `${NS}/clip.mp4` }),
	});
	const noItemOk = noItem.status === 404;

	const pass = happyOk && corruptOk && noItemOk;
	record(
		"M6",
		Boolean(pass),
		`happy=${happyOk}/status=${thumb.status}/magic=${magicOk} corrupt=${corruptOk}/${corrupt.status}/partials=${thumbsAfter - thumbsBefore - 1} noItem=${noItemOk}/${noItem.status}`,
		{ thumb: thumb.json, corrupt: corrupt.json },
	);

	await prisma.contentItem.deleteMany({
		where: { id: { in: ids.items.filter(Boolean) } },
	});
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	mkdirSync(NS_DIR, { recursive: true });
	mkdirSync(OUT_DIR, { recursive: true });

	// Setup: 3s test clip + user row.
	if (!existsSync(CLIP)) {
		runFfmpeg([
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=3:size=320x240:rate=30",
			"-pix_fmt",
			"yuv420p",
			CLIP,
		]);
	}
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
	const clipDur = probeDuration(CLIP);
	console.log(`  setup: clip=${CLIP} duration=${clipDur}s ffmpeg=ok`);

	const scenarios = [
		["M5", scenarioM5],
		["M6", scenarioM6],
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

	await prisma.$disconnect();
	process.exit(failed > 0 || anyPass !== resultsTotal.length ? 1 : 0);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
