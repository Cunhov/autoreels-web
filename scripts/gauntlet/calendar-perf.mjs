#!/usr/bin/env node
/**
 * Calendar performance gauntlet — C9.
 *
 * Seeds 300 posts (3 months + one 40-post day) and measures, in a real
 * Chromium against the running standalone server at "/":
 *   - renderMs: Node-side time from goto to the first day cell visible
 *   - FCP (performance paint entry)
 *   - month navigation stability: rAF-gap probe while clicking Prev/Next
 *     repeatedly (the heaviest render path), maxGapMs + frames over 200ms
 *   - console error count during the flows
 *
 * Writes JSON to --out/perf-baseline.json. Later rounds must not regress these
 * numbers by more than 10%.
 *
 * Usage:
 *   node calendar-perf.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --out <dir>
 */
import { writeFileSync } from "node:fs";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NS_PREFIX = "cal-perf-";

async function main() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});

	// Seed 300 posts: 100 per month (2026-04/05/06) + 40 on 2026-05-10.
	const rows = [];
	for (let m = 4; m <= 6; m++) {
		for (let i = 0; i < 100; i++) {
			const day = 1 + (i % 27);
			rows.push({
				id: `${NS_PREFIX}m${m}-${i}`,
				user_id: "admin",
				status: i % 3 === 0 ? "published" : "pending",
				media_type: "REELS",
				caption: `perf m${m} i${i}`,
				scheduled_at: new Date(
					`2026-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00Z`,
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
				`2026-05-10T${String(9 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
			),
		});
	}
	for (let start = 0; start < rows.length; start += 200) {
		await prisma.post.createMany({ data: rows.slice(start, start + 200) });
	}
	console.log(`seeded ${rows.length} posts`);

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

	const report = {
		seeded: rows.length,
		renderMs,
		fcpMs: paint.fcpMs,
		maxFrameGapMs: Math.round(navProbe.maxGap),
		framesOver200ms: navProbe.framesOver200,
		totalFrames: navProbe.totalFrames,
		consoleErrors,
		measuredAt: new Date().toISOString(),
	};
	writeFileSync(
		join(OUT_DIR, "perf-baseline.json"),
		JSON.stringify(report, null, 2),
	);
	console.log(
		`SCENARIO C9: renderMs=${renderMs} fcpMs=${paint.fcpMs} maxFrameGapMs=${Math.round(navProbe.maxGap)} framesOver200=${navProbe.framesOver200}/${navProbe.totalFrames} consoleErrors=${consoleErrors.length}`,
	);
	console.log(JSON.stringify(report));

	await prisma.post
		.deleteMany({ where: { id: { startsWith: NS_PREFIX } } })
		.catch(() => {});
	await prisma.$disconnect();
	process.exit(0);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
