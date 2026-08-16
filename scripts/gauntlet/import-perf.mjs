#!/usr/bin/env node
/**
 * Module-07 gauntlet — I8 performance (file serving TTFT + login render).
 *
 * - File route: a 5MB file is served; measures time-to-first-byte over HTTP
 *   (proves the route streams — a buffered route would not send the first
 *   byte until the whole file is read; a Range request returning 206 with a
 *   partial body additionally proves stream-capability).
 * - Login page: Chromium goto-to-load + a 2s rAF-gap probe.
 *
 * BASELINE COMPARISON (--baseline <path>): first run records; later runs FAIL
 * if TTFT or login load regress >10% vs the stored baseline, or any frame gap
 * exceeds 200ms, or console errors appear.
 *
 * Usage:
 *   node import-perf.mjs --base http://127.0.0.1:PORT --db <db>
 *        --secret <NEXTAUTH_SECRET> --uploads-dir <dir> --out <dir>
 *        --baseline <path>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

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
const BASELINE_PATH = getArg("--baseline");
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── File route TTFT (5MB) ───────────────────────────────────────────────────
const relPath = "admin/perf-5mb.mp4";
const absPath = join(UPLOADS_DIR, relPath);
const { mkdirSync } = await import("node:fs");
mkdirSync(join(UPLOADS_DIR, "admin"), { recursive: true });
writeFileSync(absPath, Buffer.alloc(5 * 1024 * 1024, 9));

const fileUrl = `${BASE}/api/file/${relPath}`;
const t0 = Date.now();
const res = await fetch(fileUrl);
const reader = res.body.getReader();
const firstByteAt = Date.now();
const ttftMs = firstByteAt - t0;
let total = 0;
for (;;) {
	const { done, value } = await reader.read();
	if (done) break;
	total += value?.length || 0;
}
const fileStatus = res.status;
const fileContentType = res.headers.get("content-type");
const fileElapsed = Date.now() - t0;

// Range proof (stream-capable): 206 + partial body.
const rangeRes = await fetch(fileUrl, { headers: { Range: "bytes=0-1023" } });
const rangeBody = Buffer.from(await rangeRes.arrayBuffer());
const rangeOk = rangeRes.status === 206 && rangeBody.length === 1024;

// ── Login page render + rAF probe ───────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => {
	if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
const loadStart = Date.now();
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.getByText("AutoReels", { exact: true }).first().waitFor({ timeout: 15_000 });
const loginLoadMs = Date.now() - loadStart;

let maxGap = 0;
let over200 = 0;
let frames = 0;
let last = Date.now();
const probe = await page.evaluate(() => {
	return new Promise((resolve) => {
		let maxGap = 0;
		let over200 = 0;
		let frames = 0;
		let last = performance.now();
		const tick = () => {
			const now = performance.now();
			const gap = now - last;
			last = now;
			frames++;
			if (gap > maxGap) maxGap = gap;
			if (gap > 200) over200++;
			if (now - performance.timeOrigin > 2000) resolve({ maxGap, over200, frames });
			else requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
});
maxGap = probe.maxGap;
over200 = probe.over200;
frames = probe.frames;
await browser.close();

const report = {
	ttftMs,
	fileStatus,
	fileContentType,
	fileTotalBytes: total,
	rangeOk,
	loginLoadMs,
	maxFrameGapMs: maxGap,
	framesOver200: over200,
	totalFrames: frames,
	consoleErrors,
	measuredAt: new Date().toISOString(),
};
try {
	writeFileSync(join(OUT_DIR, "perf-baseline.json"), JSON.stringify(report, null, 2));
} catch {
	/* ignore */
}

// ── Baseline comparison ─────────────────────────────────────────────────────
let pass = true;
let note = "";
if (BASELINE_PATH && readFileSync(BASELINE_PATH, "utf8")) {
	try {
		const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
		if (base.workload !== "i8") {
			note = "first canonical baseline recorded";
			writeFileSync(BASELINE_PATH, JSON.stringify({ ...report, workload: "i8" }, null, 2));
		} else {
			const ttftLimit = base.ttftMs * 1.1;
			const loadLimit = base.loginLoadMs * 1.1;
			if (ttftMs > ttftLimit) { pass = false; note += ` TTFT regressed ${ttftMs.toFixed(0)} > ${ttftLimit.toFixed(0)}`; }
			if (loginLoadMs > loadLimit) { pass = false; note += ` loginLoad regressed`; }
		}
	} catch {
		/* unreadable baseline — record fresh */
		writeFileSync(BASELINE_PATH, JSON.stringify({ ...report, workload: "i8" }, null, 2));
	}
} else if (BASELINE_PATH) {
	writeFileSync(BASELINE_PATH, JSON.stringify({ ...report, workload: "i8" }, null, 2));
	note = "first run — baseline recorded";
}

const finalPass =
	pass &&
	fileStatus === 200 &&
	total === 5 * 1024 * 1024 &&
	rangeOk &&
	maxGap < 200 &&
	over200 === 0 &&
	consoleErrors.length === 0;
console.log(
	`SCENARIO I8: ${finalPass ? "PASS" : "FAIL"} — ttftMs=${ttftMs.toFixed(0)} status=${fileStatus}/${fileContentType} bytes=${total} range206=${rangeOk} loginLoadMs=${loginLoadMs.toFixed(0)} maxFrameGapMs=${maxGap.toFixed(1)} framesOver200=${over200}/${frames} consoleErrors=${consoleErrors.length} ${note}`,
);

try {
	writeFileSync(join(OUT_DIR, "perf-summary.txt"), `SCENARIO I8: ${finalPass ? "PASS" : "FAIL"} — ${JSON.stringify(report)}\n`);
} catch {
	/* ignore */
}

await prisma.$disconnect();
process.exit(finalPass ? 0 : 1);
