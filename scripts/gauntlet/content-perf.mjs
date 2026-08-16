#!/usr/bin/env node
/**
 * Content Library performance gauntlet — L8.
 *
 * Seeds 1,200 ContentItems and measures, in a real Chromium against the running
 * standalone server:
 *   - FCP (performance paint entry)
 *   - renderMs: Node-side time from goto to first card visible
 *   - scroll stability: rAF-gap probe during a scripted scroll pass over the
 *     virtualized grid (after loading 3 pages), maxGapMs + frames over 200ms
 *   - console error count during the flows
 *
 * Writes JSON to --out/perf-baseline.json (later rounds must not regress these
 * numbers by more than 10%).
 *
 * Usage:
 *   node content-perf.mjs --base http://127.0.0.1:PORT --db <test.db>
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

async function main() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});

	// Seed 1,200 root items (createMany in chunks well below the SQLite bind limit).
	const CHUNK = 400;
	let seeded = 0;
	for (let start = 0; start < 1200; start += CHUNK) {
		const rows = [];
		for (let i = start; i < start + CHUNK; i++) {
			rows.push({
				user_id: "admin",
				name: `perf-item-${String(i).padStart(4, "0")}.${i % 2 === 0 ? "mp4" : "png"}`,
				type: i % 2 === 0 ? "video" : "image",
				size: 100,
			});
		}
		const res = await prisma.contentItem.createMany({ data: rows });
		seeded += res.count;
	}
	console.log(`seeded ${seeded} items`);

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

	const t0 = Date.now();
	await page.goto(`${BASE}/content`, { waitUntil: "domcontentloaded" });
	try {
		await page
			.getByText("perf-item-0000", { exact: false })
			.first()
			.waitFor({ timeout: 30_000 });
	} catch {
		const dump = await page.evaluate(
			() => document.body?.innerText?.slice(0, 1500) || "(no body)",
		);
		console.error(`  PERF-FAIL: grid not visible (url=${page.url()})`);
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

	// Load 2 more pages via the "Load more" button (pagination contract).
	for (let i = 0; i < 2; i++) {
		try {
			await page
				.getByRole("button", { name: /Load more/ })
				.click({ timeout: 5_000 });
			await sleep(1200);
		} catch {
			break;
		}
	}

	// Scroll-stability probe: scripted scroll over the virtualized scroller.
	const scrollProbe = await page.evaluate(async () => {
		const scroller =
			document.querySelector(".scroller") || document.scrollingElement;
		const maxScroll = scroller.scrollHeight - scroller.clientHeight;
		const steps = 25;
		const gaps = [];
		let last = performance.now();
		const tick = () => {
			const now = performance.now();
			gaps.push(now - last);
			last = now;
		};
		const raf = () => new Promise((r) => requestAnimationFrame(r));
		for (let i = 0; i <= steps; i++) {
			scroller.scrollTop = (maxScroll / steps) * i;
			await raf();
			tick();
			await new Promise((r) => setTimeout(r, 60));
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
		seeded,
		renderMs,
		fcpMs: paint.fcpMs,
		maxFrameGapMs: Math.round(scrollProbe.maxGap),
		framesOver200ms: scrollProbe.framesOver200,
		totalFrames: scrollProbe.totalFrames,
		consoleErrors,
		measuredAt: new Date().toISOString(),
	};
	writeFileSync(
		join(OUT_DIR, "perf-baseline.json"),
		JSON.stringify(report, null, 2),
	);
	console.log(
		`SCENARIO L8: renderMs=${renderMs} fcpMs=${paint.fcpMs} maxFrameGapMs=${Math.round(scrollProbe.maxGap)} framesOver200=${scrollProbe.framesOver200}/${scrollProbe.totalFrames} consoleErrors=${consoleErrors.length}`,
	);
	console.log(JSON.stringify(report));

	// Baseline record: this IS the bar for later rounds; L8 passes when the
	// candidate does not regress the recorded numbers by more than 10% AND keeps
	// maxFrameGapMs <= 200 (rounds) / records whatever it finds (round 0).
	await prisma.contentItem
		.deleteMany({
			where: { user_id: "admin", name: { startsWith: "perf-item-" } },
		})
		.catch(() => {});
	await prisma.$disconnect();
	process.exit(0);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
