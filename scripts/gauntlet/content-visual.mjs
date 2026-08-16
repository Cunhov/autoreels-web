#!/usr/bin/env node
/**
 * Content Library visual gauntlet — L7.
 *
 * Playwright (chromium-core) screenshots of the /content library page at fixed
 * viewports, with the session cookie injected, animations disabled. Captures:
 *   (a) empty state (fresh DB)          -> out/visual-empty-<mode>.png
 *   (b) populated grid (desktop)        -> out/visual-grid-desktop-<mode>.png
 *   (c) bulk-select toolbar (desktop)   -> out/visual-select-<mode>.png
 *   (d) populated grid (mobile 390x844) -> out/visual-grid-mobile-<mode>.png
 * Records every browser console 'error' message + pageerror.
 *
 * Usage:
 *   node content-visual.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --uploads-dir <dir> --out <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
const SESSION_TOKEN = await encode({
	token: { sub: "admin" },
	secret: SECRET,
	maxAge: 3600,
});

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const NS = "admin/gauntlet-mod2";

const consoleErrors = [];
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
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
	page.on("pageerror", (err) => pageErrors.push(err?.stack || String(err)));

	const screens = {};

	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});

	// Sanity: the listing API must return the seeded root items.
	const sanity = await fetch(`${BASE}/api/content-items?parent_id=&limit=100`, {
		headers: { Cookie: `next-auth.session-token=${SESSION_TOKEN}` },
	}).then(async (r) => ({
		status: r.status,
		body: await r.json().catch(() => null),
	}));
	const sanityCount = sanity.body?.items?.length ?? -1;
	console.log(
		`  sanity GET /api/content-items -> status=${sanity.status} rootItems=${sanityCount}`,
	);

	// (a) EMPTY STATE — the DB is fresh at this point (visual runs first).
	await page.goto(`${BASE}/content`, { waitUntil: "domcontentloaded" });
	try {
		await page
			.getByText("Current folder is empty")
			.waitFor({ timeout: 15_000 });
	} catch {
		// fallback: accept any of the empty-state variants
		await page
			.getByText("Nenhum item encontrado")
			.waitFor({ timeout: 5_000 })
			.catch(() => {});
	}
	await sleep(600);
	screens.empty = await page.screenshot({ fullPage: false });
	writeFileSync(join(OUT_DIR, "visual-empty-baseline.png"), screens.empty);

	// ── Seed the populated library ───────────────────────────────────────────
	const folder = await prisma.contentItem.create({
		data: { user_id: "admin", name: "Visual Folder", type: "carousel_folder" },
	});
	const carousel = await prisma.contentItem.create({
		data: {
			user_id: "admin",
			name: "Visual Carousel",
			type: "carousel_folder",
		},
	});
	const itemIds = [];
	for (let i = 1; i <= 6; i++) {
		const img = await prisma.contentItem.create({
			data: {
				user_id: "admin",
				name: `Visual Image ${i}`,
				type: "image",
				url: `/api/file/${NS}/v-img-${i}.png`,
				thumbnail_url: `/api/file/${NS}/v-img-${i}.png`,
				size: 100,
				parent_id: folder.id,
			},
		});
		itemIds.push(img.id);
	}
	for (let i = 1; i <= 6; i++) {
		const vid = await prisma.contentItem.create({
			data: {
				user_id: "admin",
				name: `Visual Video ${i}`,
				type: "video",
				url: `/api/file/${NS}/v-vid-${i}.mp4`,
				thumbnail_url: `/api/file/${NS}/v-vid-${i}.png`,
				size: 200,
			},
		});
		itemIds.push(vid.id);
	}
	for (let i = 1; i <= 3; i++) {
		const child = await prisma.contentItem.create({
			data: {
				user_id: "admin",
				name: `Visual Child ${i}`,
				type: "carousel_item",
				url: `/api/file/${NS}/v-child-${i}.png`,
				thumbnail_url: `/api/file/${NS}/v-child-${i}.png`,
				size: 50,
				parent_id: carousel.id,
			},
		});
		itemIds.push(child.id);
	}
	// tiny valid PNGs so cards render real thumbnails
	const fs = await import("node:fs");
	const { join: pjoin, dirname } = await import("node:path");
	for (let i = 1; i <= 6; i++) {
		for (const kind of ["img", "vid", "child"]) {
			const rel = `${NS}/v-${kind}-${i}.png`;
			fs.mkdirSync(pjoin(UPLOADS_DIR, dirname(rel)), { recursive: true });
			fs.writeFileSync(pjoin(UPLOADS_DIR, rel), PNG);
		}
	}

	// (b) POPULATED GRID (desktop)
	await page.goto(`${BASE}/content`, { waitUntil: "domcontentloaded" });
	try {
		await page
			.getByText("Visual Video", { exact: false })
			.first()
			.waitFor({ timeout: 20_000 });
	} catch {
		const dump = await page.evaluate(
			() => document.body?.innerText?.slice(0, 1500) || "(no body)",
		);
		const url = page.url();
		console.error(`  VISUAL-FAIL: populated grid not visible (url=${url})`);
		console.error(`  BODY-DUMP: ${JSON.stringify(dump)}`);
		console.error(
			`  CONSOLE-ERRORS: ${JSON.stringify(consoleErrors.slice(0, 10))}`,
		);
		writeFileSync(
			join(OUT_DIR, "visual-fail-diagnostic.json"),
			JSON.stringify({ url, dump, consoleErrors, pageErrors }, null, 2),
		);
		await browser.close().catch(() => {});
		await prisma.$disconnect().catch(() => {});
		process.exit(2);
	}
	await sleep(800);
	screens.grid = await page.screenshot();
	writeFileSync(
		join(OUT_DIR, "visual-grid-desktop-baseline.png"),
		screens.grid,
	);

	// (c) BULK-SELECT — click the first video card
	try {
		await page.getByText("Visual Video 1", { exact: true }).click();
		await sleep(500);
	} catch {
		/* selection UI may differ — screenshot anyway */
	}
	screens.select = await page.screenshot();
	writeFileSync(join(OUT_DIR, "visual-select-baseline.png"), screens.select);

	// (c2) BULK-DELETE CASCADE WARNING (critic gap): with folders in the
	// selection, the confirm dialog must NAME the nested-contents count before
	// the user commits. Select all via Ctrl+A (folders are not click-selectable
	// in manage mode), press Delete, capture window.confirm via the dialog
	// event, then dismiss (nothing is deleted).
	let confirmMessage = "";
	const dialogPromise = new Promise((resolve) => {
		page.once("dialog", async (dialog) => {
			confirmMessage = dialog.message();
			await dialog.dismiss().catch(() => {});
			resolve(true);
		});
	});
	await page.goto(`${BASE}/content`, { waitUntil: "domcontentloaded" });
	await page
		.getByText("Visual Video", { exact: false })
		.first()
		.waitFor({ timeout: 20_000 });
	await sleep(500);
	await page.keyboard.press("Control+a");
	await sleep(500);
	await page.keyboard.press("Delete");
	await Promise.race([
		dialogPromise,
		new Promise((_, reject) =>
			setTimeout(
				() => reject(new Error("confirm dialog never appeared")),
				15_000,
			),
		),
	]);
	const confirmHasNested =
		/Delete \d+ items and \d+ nested contents\?/.test(confirmMessage);
	console.log(
		`  bulk-delete confirm: "${confirmMessage}" → nestedWarning=${confirmHasNested}`,
	);

	// (d) MOBILE 390x844
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/content`, { waitUntil: "domcontentloaded" });
	await page
		.getByText("Visual Video", { exact: false })
		.first()
		.waitFor({ timeout: 20_000 });
	await sleep(800);
	screens.mobile = await page.screenshot();
	writeFileSync(
		join(OUT_DIR, "visual-grid-mobile-baseline.png"),
		screens.mobile,
	);

	// horizontal-scroll check on mobile
	const hScroll = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);

	await browser.close();

	const report = {
		screenshots: Object.keys(screens),
		consoleErrors,
		pageErrors,
		mobileHorizontalOverflowPx: hScroll,
		bulkDeleteConfirm: confirmMessage,
		bulkDeleteNestedWarning: confirmHasNested,
	};
	writeFileSync(
		join(OUT_DIR, "visual-report.json"),
		JSON.stringify(report, null, 2),
	);
	const pass =
		consoleErrors.length === 0 &&
		pageErrors.length === 0 &&
		hScroll <= 2 &&
		confirmHasNested;
	console.log(
		`SCENARIO L7: ${pass ? "PASS" : "FAIL"} — consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length} mobileHScroll=${hScroll}px bulkDeleteNestedWarning=${confirmHasNested} screens=${Object.keys(screens).join(",")}`,
	);
	if (consoleErrors.length > 0) {
		console.log("  console errors:");
		for (const e of consoleErrors.slice(0, 10))
			console.log(`    - ${e.slice(0, 200)}`);
	}
	if (pageErrors.length > 0) {
		console.log("  page errors:");
		for (const e of pageErrors.slice(0, 10))
			console.log(`    - ${e.slice(0, 200)}`);
	}

	await prisma.contentItem
		.deleteMany({ where: { id: { in: itemIds } } })
		.catch(() => {});
	await prisma.contentItem
		.deleteMany({ where: { id: { in: [folder.id, carousel.id] } } })
		.catch(() => {});
	await prisma.$disconnect();
	process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
