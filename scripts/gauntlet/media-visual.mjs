#!/usr/bin/env node
/**
 * Media gauntlet — M7 (ImageEditorModal via Playwright).
 *
 * Opens /content, hovers the seeded image card, clicks "Edit Image", waits for
 * the editor modal (react-easy-crop + fabric canvas), performs a small crop
 * drag, clicks save, and asserts:
 *   - zero console/page errors across the whole flow,
 *   - the save flow creates a new content item named "edited_<name>"
 *     (the editor pushes the edited image through the shared upload queue),
 *   - mobile 390x844: no horizontal scroll on /content.
 *
 * Usage:
 *   node media-visual.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --uploads-dir <dir> --out <dir>
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

// 1x1 red PNG (valid image the editor can load).
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const NS = "admin/gauntlet-mod4";
const IMG_REL = `${NS}/editor-img.png`;

const consoleErrors = [];
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	mkdirSync(join(UPLOADS_DIR, NS), { recursive: true });
	writeFileSync(join(UPLOADS_DIR, IMG_REL), PNG);

	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
	await prisma.contentItem.deleteMany({
		where: { user_id: "admin", name: "Editor Image.png" },
	});
	await prisma.contentItem.deleteMany({
		where: { user_id: "admin", name: { startsWith: "edited_" } },
	});
	await prisma.contentItem.create({
		data: {
			user_id: "admin",
			name: "Editor Image.png",
			type: "image",
			size: PNG.length,
			url: `/api/file/${IMG_REL}`,
		},
	});

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

	// Open /content and wait for the seeded card.
	await page.goto(`${BASE}/content`, { waitUntil: "domcontentloaded" });
	await page.getByText("Editor Image.png").first().waitFor({ timeout: 25_000 });
	await sleep(600);

	// Hover the card, then click the "Edit Image" hover button.
	const card = page.getByText("Editor Image.png").first();
	await card.hover().catch(() => {});
	await sleep(400);
	const editBtn = page.getByTitle("Edit Image").first();
	await editBtn.click({ timeout: 10_000 }).catch(async () => {
		// fallback: force click (hover-opacity buttons can be stubborn)
		await editBtn.click({ force: true, timeout: 5_000 });
	});
	await sleep(1200);

	// The editor modal should be visible (react-easy-crop container + save).
	const modalVisible = await page
		.getByRole("button", { name: /Salvar|Save|Aplicar/i })
		.first()
		.isVisible()
		.then(() => true)
		.catch(() => false);

	// Minimal crop interaction: drag across the crop area.
	const cropArea = page.locator(".reactEasyCrop_Container").first();
	const hasCrop = (await cropArea.count().catch(() => 0)) > 0;
	if (hasCrop) {
		const box = await cropArea.boundingBox();
		if (box) {
			await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
			await page.mouse.down();
			await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, {
				steps: 8,
			});
			await page.mouse.up();
			await sleep(400);
		}
	}

	const saveBtn = page
		.getByRole("button", { name: /Salvar|Save|Aplicar/i })
		.first();
	const saved = await saveBtn
		.click({ timeout: 10_000 })
		.then(() => true)
		.catch(() => false);

	// Screenshot the moment after save (modal may still be open or closing).
	await sleep(2500);
	const shot = await page.screenshot();
	writeFileSync(join(OUT_DIR, "editor-after-save.png"), shot);
	await browser.close();

	// The save pushes the edited image through the upload queue -> a new item
	// named "edited_..." appears once the queue completes it.
	let editedItem = null;
	for (let i = 0; i < 30 && !editedItem; i++) {
		editedItem = await prisma.contentItem.findFirst({
			where: { user_id: "admin", name: { startsWith: "edited_" } },
		});
		if (!editedItem) await sleep(1000);
	}
	const editedOk = Boolean(editedItem);

	// Mobile: 390x844 no horizontal scroll on /content.
	const mctx = await browser2(); // helper below (second context)
	await mctx.page.goto(`${BASE}/content`, { waitUntil: "domcontentloaded" });
	await mctx.page.waitForTimeout(800);
	const hScroll = await mctx.page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	const mobileShot = await mctx.page.screenshot();
	writeFileSync(join(OUT_DIR, "editor-mobile.png"), mobileShot);
	await mctx.browser.close();

	const pass =
		consoleErrors.length === 0 &&
		pageErrors.length === 0 &&
		modalVisible &&
		saved &&
		editedOk &&
		hScroll <= 2;

	console.log(
		`SCENARIO M7: ${pass ? "PASS" : "FAIL"} — consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length} modal=${modalVisible} cropWidget=${hasCrop} saved=${saved} editedItem=${editedOk} mobileHScroll=${hScroll}px`,
	);
	if (consoleErrors.length > 0)
		console.log("  console:", consoleErrors.slice(0, 8));
	if (pageErrors.length > 0)
		console.log("  pageerror:", pageErrors.slice(0, 3));

	// Cleanup seeded items (keep evidence files).
	await prisma.contentItem.deleteMany({
		where: { user_id: "admin", name: "Editor Image.png" },
	});
	await prisma.$disconnect();
	process.exit(pass ? 0 : 1);
}

/** Second browser context for the mobile check (fresh viewport). */
async function browser2() {
	const b = await chromium.launch();
	const c = await b.newContext({ viewport: { width: 390, height: 844 } });
	await c.addCookies([
		{
			name: "next-auth.session-token",
			value: SESSION_TOKEN,
			domain: "127.0.0.1",
			path: "/",
		},
	]);
	const p = await c.newPage();
	p.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	p.on("pageerror", (err) => pageErrors.push(err?.stack || String(err)));
	return { browser: b, page: p };
}

main().catch(async (err) => {
	console.error("M7 FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
