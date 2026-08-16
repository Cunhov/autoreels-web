#!/usr/bin/env node
/**
 * Calendar performance gauntlet — C9.
 *
 * Seeds a HEAVY CURRENT-MONTH workload (the bar's "heaviest month": days 1-27
 * with 10 posts each + one 40-post burst day — ~310 posts, all inside the
 * default month view) and measures, in a real Chromium against the running
 * standalone server at "/":
 *   - renderMs: Node-side time from goto to the first day cell visible
 *   - FCP (performance paint entry)
 *   - month navigation stability: rAF-gap probe while clicking Prev/Next
 *     repeatedly (the heaviest render path), maxGapMs + frames over 200ms
 *   - heavy-day render proof: the 40-post burst day cell shows the "+N more" chip
 *   - console error count during the flows
 *
 * BASELINE COMPARISON (--baseline <path>): the first run at a given code state
 * records the canonical baseline (gates/calendar-perf-baseline.json). Later
 * runs FAIL if renderMs or maxFrameGapMs regress >10% vs the stored baseline,
 * or if any frame gap exceeds 200ms, or console errors appear. If the stored
 * baseline's WORKLOAD differs from the current seed (seeded count or burst
 * day), the baseline is recomputed instead of compared — the numbers only
 * compare like-for-like workloads.
 *
 * Writes the full report to --out/perf-baseline.json (copied by the runner
 * into gates/round-<ts>-perf.json).
 *
 * Usage:
 *   node calendar-perf.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --out <dir> --baseline <path>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
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
const OUT_DIR = getArg("--out");
const BASELINE_PATH = getArg("--baseline");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
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
const SESSION_TOKEN = await encode({
	token: { sub: "admin" },
	secret: SECRET,
	maxAge: 3600,
});

const consoleErrors = [];
const NS_PREFIX = "cal-perf-";

/** Load the canonical baseline, or null when absent/corrupt. */
function loadBaseline() {
	if (!BASELINE_PATH) return null;
	try {
		const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
		if (b && typeof b.renderMs === "number" && typeof b.maxFrameGapMs === "number") {
			return b;
		}
	} catch {
		/* no baseline yet */
	}
	return null;
}

function saveBaseline(report) {
	if (!BASELINE_PATH) return;
	try {
		writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2));
	} catch (err) {
		console.error(`  C9-BASELINE: could not write baseline (${err.message})`);
	}
}

async function main() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});

	// ── Seed relative to the CURRENT month (the default view) ────────────────
	// The previous version seeded FIXED dates (2026-04/05/06) while the view
	// showed the current month → the harness measured an EMPTY month. The bar's
	// "heaviest month" workload: days 1-27 with 10 posts each (270) + one
	// 40-post burst day (day 10) → 310 posts, all inside the visible window.
	const now = new Date();
	const year = now.getFullYear();
	const month = now.getMonth();
	const BURST_DAY = 10;
	const rows = [];
	for (let day = 1; day <= 27; day++) {
		for (let i = 0; i < 10; i++) {
			rows.push({
				id: `${NS_PREFIX}d${day}-${i}`,
				user_id: "admin",
				status: i % 3 === 0 ? "published" : "pending",
				media_type: "REELS",
				caption: `perf d${day} i${i}`,
				scheduled_at: new Date(
					year,
					month,
					day,
					9 + (i % 10),
					i % 60,
					0,
				),
			});
		}
	}
	for (let i = 0; i < 40; i++) {
		rows.push({
			id: `${NS_PREFIX}burst-${i}`,
			user_id: "admin",
			status: "pending",
			media_type: "REELS",
			caption: `perf burst ${i}`,
			scheduled_at: new Date(
				year,
				month,
				BURST_DAY,
				9 + (i % 10),
				i % 60,
				0,
			),
		});
	}
	// createMany in chunks (SQLite bind limit).
	for (let start = 0; start < rows.length; start += 200) {
		await prisma.post.createMany({ data: rows.slice(start, start + 200) });
	}
	console.log(`seeded ${rows.length} posts (current month, burst day ${BURST_DAY})`);

	const browser = await chromium.launch();
	const ctx = await browser.newContext({
		viewport: { width: 1440, height: 900 },
	});
	await ctx.addCookies([
		{
			name: "next-auth.session-token",
			value: SESSION_TOKEN,
			domain: "127.0.0.1",
			path: "/",
		},
	]);
	await ctx.addInitScript(() => {
		const apply = () => {
			const style = document.createElement("style");
			style.textContent =
				"*{animation:none!important;transition:none!important}";
			(document.head || document.documentElement).appendChild(style);
		};
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", apply, { once: true });
		} else {
			apply();
		}
	});
	const page = await ctx.newPage();
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err}`));

	const t0 = Date.now();
	await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
	try {
		await page
			.locator("div.min-h-\\[140px\\]")
			.first()
			.waitFor({ timeout: 30_000 });
	} catch {
		const dump = await page.evaluate(
			() => document.body?.innerText?.slice(0, 1500) || "(no body)",
		);
		console.error(`  PERF-FAIL: calendar grid not visible (url=${page.url()})`);
		console.error(`  BODY-DUMP: ${JSON.stringify(dump)}`);
		console.error(
			`  CONSOLE-ERRORS: ${JSON.stringify(consoleErrors.slice(0, 10))}`,
		);
		writeFileSync(
			join(OUT_DIR, "perf-fail-diagnostic.json"),
			JSON.stringify({ url: page.url(), dump, consoleErrors }, null, 2),
		);
		await browser.close().catch(() => {});
		await prisma.$disconnect().catch(() => {});
		process.exit(2);
	}
	const renderMs = Date.now() - t0;

	// Heavy-day render proof: the 40-post burst day cell must show the
	// "+N more" chip — ties the measured workload to what actually rendered.
	const burstCell = page
		.locator("div.min-h-\\[140px\\]")
		.filter({
			has: page.locator("span.text-\\[13px\\]", {
				hasText: String(BURST_DAY),
			}),
		})
		.first();
	const burstChip = await burstCell
		.getByText(/^\+.*more$/)
		.first()
		.isVisible()
		.catch(() => false);

	const paint = await page.evaluate(() => {
		const entries = performance.getEntriesByType("paint");
		const fcp = entries.find((e) => e.name === "first-contentful-paint");
		return { fcpMs: fcp ? fcp.startTime : null };
	});

	// Navigation-stability probe: 6 month switches (next/next/prev/prev/next/prev)
	// via the page's ArrowLeft/ArrowRight keyboard shortcuts (the header nav
	// buttons are icon-only; keyboard dispatch is deterministic).
	const navProbe = await page.evaluate(async () => {
		const gaps = [];
		let last = performance.now();
		const tick = () => {
			const now = performance.now();
			gaps.push(now - last);
			last = now;
		};
		const raf = () => new Promise((r) => requestAnimationFrame(r));
		const press = (key) =>
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
			);
		const dirs = [
			"ArrowRight",
			"ArrowRight",
			"ArrowLeft",
			"ArrowLeft",
			"ArrowRight",
			"ArrowLeft",
		];
		for (const dir of dirs) {
			press(dir);
			await raf();
			await raf();
			tick();
			await new Promise((r) => setTimeout(r, 80));
		}
		const maxGap = Math.max(...gaps);
		return {
			maxGap,
			framesOver200: gaps.filter((g) => g > 200).length,
			totalFrames: gaps.length,
		};
	});

	await browser.close();

	const workload = { seeded: rows.length, burstDay: BURST_DAY };
	const report = {
		workload,
		renderMs,
		fcpMs: paint.fcpMs,
		maxFrameGapMs: Math.round(navProbe.maxGap),
		framesOver200ms: navProbe.framesOver200,
		totalFrames: navProbe.totalFrames,
		consoleErrors,
		burstChipRendered: burstChip,
		measuredAt: new Date().toISOString(),
	};
	writeFileSync(
		join(OUT_DIR, "perf-baseline.json"),
		JSON.stringify(report, null, 2),
	);

	// ── Baseline comparison ───────────────────────────────────────────────────
	const baseline = loadBaseline();
	let pass = true;
	let baselineNote = "";
	if (baseline && baseline.workload &&
		(baseline.workload.seeded !== workload.seeded ||
			baseline.workload.burstDay !== workload.burstDay)) {
		saveBaseline(report);
		baselineNote = "workload changed — baseline recomputed";
		console.log(
			`  C9-BASELINE: recomputed (workload ${workload.seeded} posts, burst day ${workload.burstDay})`,
		);
	} else if (!baseline) {
		saveBaseline(report);
		baselineNote = "first run — baseline recorded";
		console.log(
			`  C9-BASELINE: recorded (${workload.seeded} posts, burst day ${workload.burstDay})`,
		);
	} else {
		const renderLimit = baseline.renderMs * 1.1;
		const gapLimit = baseline.maxFrameGapMs * 1.1;
		const renderOk = report.renderMs <= renderLimit;
		const gapOk = report.maxFrameGapMs <= gapLimit;
		const framesOk = report.framesOver200ms === 0;
		const errorsOk = report.consoleErrors.length === 0;
		pass = renderOk && gapOk && framesOk && errorsOk;
		console.log(
			`  C9-BASELINE: render ${report.renderMs} vs ${baseline.renderMs} (<=${renderLimit.toFixed(0)}) ${renderOk ? "OK" : "FAIL"} | ` +
				`gap ${report.maxFrameGapMs} vs ${baseline.maxFrameGapMs} (<=${gapLimit.toFixed(0)}) ${gapOk ? "OK" : "FAIL"} | ` +
				`framesOver200 ${report.framesOver200ms} ${framesOk ? "OK" : "FAIL"} | ` +
				`consoleErrors ${report.consoleErrors.length} ${errorsOk ? "OK" : "FAIL"}`,
		);
	}
	pass = pass && burstChip;

	console.log(
		`SCENARIO C9: renderMs=${renderMs} fcpMs=${paint.fcpMs} maxFrameGapMs=${Math.round(navProbe.maxGap)} framesOver200=${navProbe.framesOver200}/${navProbe.totalFrames} burstChip=${burstChip} consoleErrors=${consoleErrors.length} [${baselineNote}]`,
	);
	console.log(JSON.stringify(report));

	await prisma.post
		.deleteMany({ where: { id: { startsWith: NS_PREFIX } } })
		.catch(() => {});
	await prisma.$disconnect();
	process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
