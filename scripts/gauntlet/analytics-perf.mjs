#!/usr/bin/env node
/**
 * Analytics performance gauntlet (module 06) — S8.
 *
 * Seeds 6 channels × 12 weeks of posts+metrics (the "heavy" analytics
 * workload) and measures in real Chromium against the running server:
 *   - renderMs: goto /analytics until the summary heading appears
 *   - FCP (paint entry)
 *   - period-switch stability: rAF-gap probe while switching 30→7→30→90→30
 *   - console errors during the flows
 *
 * BASELINE COMPARISON (--baseline <path>): first run at a given workload
 * records the canonical baseline; later runs FAIL if renderMs or maxFrameGapMs
 * regress >10% vs the stored baseline, or any frame gap exceeds 200ms, or
 * console errors appear. If the stored baseline's workload differs (seeded
 * posts or channels), the baseline is recomputed instead of compared.
 *
 * Usage:
 *   node analytics-perf.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --out <dir> --baseline <path>
 *
 * Exit 0 only if the budget holds (or the baseline was just recorded).
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
const NS = "s8-";
const day = 24 * 3600 * 1000;

function loadBaseline() {
	if (!BASELINE_PATH) return null;
	try {
		const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
		if (
			b &&
			typeof b.renderMs === "number" &&
			typeof b.maxFrameGapMs === "number"
		) {
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
		console.error(`  S8-BASELINE: could not write baseline (${err.message})`);
	}
}

async function main() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
	// Hermetic seed: 6 channels × 12 weeks × 2 posts/week (144 posts) with
	// PostMetrics — the heavy analytics workload.
	await prisma.channel.deleteMany({ where: { id: { startsWith: NS } } });
	await prisma.post.deleteMany({ where: { id: { startsWith: NS } } });
	await prisma.postMetric.deleteMany({
		where: { post_id: { startsWith: NS } },
	});
	const week = 7 * 24 * 3600 * 1000;
	let posts = 0;
	for (let c = 1; c <= 6; c++) {
		const cid = `${NS}chan-${c}`;
		await prisma.channel.create({
			data: {
				id: cid,
				user_id: "admin",
				name: `S8 Channel ${c}`,
				platform: "instagram",
				access_token: `IGPerf${c}`,
				account_id: `acct-s8-${c}`,
				status: "active",
			},
		});
		for (let w = 0; w < 12; w++) {
			for (let k = 0; k < 2; k++) {
				const pid = `${NS}p-${c}-${w}-${k}`;
				await prisma.post.create({
					data: {
						id: pid,
						user_id: "admin",
						channel_id: cid,
						status: "published",
						media_type: "REELS",
						instagram_media_id: `ig-s8-${c}-${w}-${k}`,
						published_at: new Date(Date.now() - w * week - k * day),
						scheduled_at: new Date(Date.now() - w * week - k * day),
					},
				});
				await prisma.postMetric.create({
					data: {
						post_id: pid,
						channel_id: cid,
						likes: w + k,
						comments: k,
						plays: w * 10,
						reach: w * 5,
						impressions: w * 20,
						saved: k,
						shares: k,
						fetched_at: new Date(),
					},
				});
				posts++;
			}
		}
	}
	console.log(`seeded ${posts} posts across 6 channels x 12 weeks`);

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
	const page = await ctx.newPage();
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err}`));

	const t0 = Date.now();
	await page.goto(`${BASE}/analytics`, { waitUntil: "domcontentloaded" });
	try {
		await page.getByText("Resumo local").waitFor({ timeout: 30_000 });
	} catch {
		const dump = await page.evaluate(
			() => document.body?.innerText?.slice(0, 1200) || "(no body)",
		);
		console.error(`  S8-FAIL: analytics summary not visible`);
		console.error(`  BODY-DUMP: ${JSON.stringify(dump)}`);
		console.error(
			`  CONSOLE-ERRORS: ${JSON.stringify(consoleErrors.slice(0, 8))}`,
		);
		writeFileSync(
			join(OUT_DIR, "analytics-perf-fail.json"),
			JSON.stringify({ dump, consoleErrors }, null, 2),
		);
		await browser.close().catch(() => {});
		await prisma.$disconnect().catch(() => {});
		process.exit(2);
	}
	const renderMs = Date.now() - t0;

	const paint = await page.evaluate(() => {
		const entries = performance.getEntriesByType("paint");
		const fcp = entries.find((e) => e.name === "first-contentful-paint");
		return { fcpMs: fcp ? fcp.startTime : null };
	});

	// Period-switch stability probe: click the 7/30/90 range buttons repeatedly.
	const navProbe = await page.evaluate(async () => {
		const gaps = [];
		let last = performance.now();
		const tick = () => {
			const now = performance.now();
			gaps.push(now - last);
			last = now;
		};
		const raf = () => new Promise((r) => requestAnimationFrame(r));
		const click = (label) => {
			const btn = [...document.querySelectorAll("button")].find(
				(b) => b.textContent.trim() === label,
			);
			if (btn) btn.click();
		};
		const dirs = ["7", "90", "30", "7", "90", "30"];
		for (const dir of dirs) {
			click(dir);
			await raf();
			await raf();
			tick();
		}
		return { gaps };
	});
	const maxFrameGapMs = Math.max(...navProbe.gaps);
	const framesOver200 = navProbe.gaps.filter((g) => g > 200).length;
	const bodyNoNaN = !/NaN|Infinity|undefined/.test(
		await page.locator("body").innerText(),
	);

	const report = {
		seeded: posts,
		renderMs,
		fcpMs: paint.fcpMs ?? null,
		maxFrameGapMs,
		framesOver200,
		totalFrames: navProbe.gaps.length,
		consoleErrors,
		bodyNoNaN,
		measuredAt: new Date().toISOString(),
	};
	console.log(`SCENARIO S8: ${JSON.stringify(report)}`);
	writeFileSync(
		join(OUT_DIR, "analytics-perf.json"),
		JSON.stringify(report, null, 2),
	);

	const baseline = loadBaseline();
	let pass;
	let note;
	if (!baseline) {
		saveBaseline(report);
		pass = maxFrameGapMs <= 200 && consoleErrors.length === 0 && bodyNoNaN;
		note = "[first run — baseline recorded]";
	} else if (
		baseline.seeded !== report.seeded ||
		baseline.totalFrames !== report.totalFrames
	) {
		saveBaseline(report);
		pass = maxFrameGapMs <= 200 && consoleErrors.length === 0 && bodyNoNaN;
		note = "[workload changed — baseline recomputed]";
	} else {
		const renderOk = report.renderMs <= baseline.renderMs * 1.1;
		const frameOk = report.maxFrameGapMs <= baseline.maxFrameGapMs * 1.1;
		pass =
			renderOk &&
			frameOk &&
			report.maxFrameGapMs <= 200 &&
			consoleErrors.length === 0 &&
			bodyNoNaN;
		note = `[vs baseline: render ${report.renderMs}<=${Math.round(baseline.renderMs * 1.1)}? ${renderOk} | gap ${report.maxFrameGapMs}<=${Math.round(baseline.maxFrameGapMs * 1.1)}? ${frameOk}]`;
	}

	console.log(
		`SCENARIO S8: ${pass ? "PASS" : "FAIL"} — renderMs=${report.renderMs} fcpMs=${report.fcpMs} maxFrameGapMs=${report.maxFrameGapMs} framesOver200=${report.framesOver200} consoleErrors=${consoleErrors.length} bodyNoNaN=${bodyNoNaN} ${note}`,
	);

	await browser.close();
	await prisma.channel.deleteMany({ where: { id: { startsWith: NS } } });
	await prisma.post.deleteMany({ where: { id: { startsWith: NS } } });
	await prisma.postMetric.deleteMany({
		where: { post_id: { startsWith: NS } },
	});
	await prisma.$disconnect();
	process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
