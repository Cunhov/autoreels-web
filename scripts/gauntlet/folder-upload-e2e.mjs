#!/usr/bin/env node
/**
 * E2E repro: folder (carousel) upload grouping.
 *
 * Simulates REAL drag-drop of multiple folders in the browser (Playwright),
 * driving the actual client code (collectDroppedFiles → addFolderFiles →
 * chunk upload → finalize with parentId) against a real server, then checks
 * the library listing: each carousel folder must contain ONLY its own slides.
 *
 * Usage:
 *   node folder-upload-e2e.mjs --base http://127.0.0.1:PORT --db <test.db>
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

const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
	const res = await fetch(`${BASE}${path}`, {
		headers: { Cookie: `next-auth.session-token=${SESSION_TOKEN}` },
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

/** Dispatch a synthetic drop of "folders" (files with webkitRelativePath). */
async function dropFolders(page, files) {
	await page.evaluate(
		async ({ files, pngB64 }) => {
			const makeFile = (p) => {
				const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
				const name = p.split("/").pop();
				const f = new File([bytes], name, { type: "image/png" });
				Object.defineProperty(f, "webkitRelativePath", {
					value: p,
					configurable: true,
				});
				return f;
			};
			const dt = new DataTransfer();
			files.forEach((p) => dt.items.add(makeFile(p)));

			// Drop zone on /upload: the div with the "Drag & drop files or folders" text.
			// Use the DEEPEST match (the drop-zone itself) — an ancestor wrapper also
			// contains the text and dispatching there never reaches the zone's onDrop.
			const all = [...document.querySelectorAll("div")].filter((d) =>
				d.textContent.includes("Drag & drop files or folders"),
			);
			const zone = all[all.length - 1];
			if (!zone) throw new Error("drop zone not found");
			zone.dispatchEvent(
				new DragEvent("drop", {
					dataTransfer: dt,
					bubbles: true,
					cancelable: true,
				}),
			);
		},
		{ files, pngB64: PNG_1PX.toString("base64") },
	);
}

/** Wait until the DB has `count` content_items of type `type`. */
async function waitForRows(type, count, timeoutMs = 90_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const n = await prisma.contentItem.count({ where: { type } });
		if (n >= count) return n;
		await sleep(1000);
	}
	throw new Error(`timeout waiting for ${count} rows of type ${type}`);
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });

	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
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
	const page = await ctx.newPage();
	page.on("pageerror", (err) =>
		console.error("[pageerror]", err?.stack || err),
	);
	page.on("console", (msg) => {
		if (msg.type() === "error" || msg.type() === "warning")
			console.log(`[browser:${msg.type()}]`, msg.text().slice(0, 300));
	});

	const results = [];

	// ── TEST A: drop 3 separate carousel folders on the /upload page ─────────
	console.log("== TEST A: 3 folders dropped separately on /upload ==");
	await page.goto(`${BASE}/upload`, { waitUntil: "domcontentloaded" });
	await page
		.getByText("Drag & drop files or folders")
		.waitFor({ timeout: 20_000 });
	await sleep(1500);

	await dropFolders(page, [
		"Carrossel1/01.jpg",
		"Carrossel1/02.jpg",
		"Carrossel1/03.jpg",
		"Carrossel2/01.jpg",
		"Carrossel2/02.jpg",
		"Carrossel3/01.jpg",
		"Carrossel3/02.jpg",
	]);
	console.log("  dropped 3 folders (7 files)");

	// Sanity: did the drop register at all? The queue should show tasks.
	try {
		await page
			.getByText("Carrossel1/01.jpg", { exact: false })
			.waitFor({ timeout: 10_000 });
		console.log("  queue shows the dropped file (drop handler fired)");
	} catch {
		console.log(
			"  !! queue does NOT show dropped files — drop handler likely not fired",
		);
	}

	const foldersA = await waitForRows("carousel_folder", 3);
	console.log(`  carousel folders created: ${foldersA}`);

	// Wait for all slide uploads to land (3 folders × 2-3 slides = 7 items)
	await waitForRows("image", 7);
	await sleep(1500);

	// Verify per-folder children via API
	const rootList = await api(`/api/content-items?parent_id=&limit=100`);
	const folders = rootList.body.items.filter(
		(i) => i.type === "carousel_folder",
	);
	console.log(
		`  root items: ${rootList.body.items.length}, folders: ${folders.map((f) => f.name).join(", ")}`,
	);
	for (const f of folders) {
		const kids = await api(`/api/content-items?parent_id=${f.id}&limit=100`);
		const names = kids.body.items.map((k) => k.name).sort();
		console.log(`  folder "${f.name}": ${names.join(", ") || "(EMPTY)"}`);
		results.push({ folder: f.name, slides: names });
	}

	// UI check: click Carrossel1 in the library, see only its slides
	await page.goto(`${BASE}/content`, { waitUntil: "domcontentloaded" });
	await sleep(1200);
	await page.getByText("Carrossel1", { exact: true }).first().click();
	await sleep(1500);
	const visibleText = await page.locator("body").innerText();
	const uiSlides = visibleText
		.split("\n")
		.filter((t) => /^\d+\.jpg$/.test(t.trim()));
	console.log(
		`  [UI] inside Carrossel1, slides shown: ${[...new Set(uiSlides)].join(", ")}`,
	);
	results.push({ uiInCarrossel1: [...new Set(uiSlides)] });

	// ── TEST B: drop ONE parent folder with carousel subfolders ──────────────
	console.log("== TEST B: parent folder with 2 carousel subfolders ==");
	await page.goto(`${BASE}/upload`, { waitUntil: "domcontentloaded" });
	await sleep(800);
	await dropFolders(page, [
		"Pasta/CarrosselA/01.jpg",
		"Pasta/CarrosselA/02.jpg",
		"Pasta/CarrosselB/01.jpg",
		"Pasta/CarrosselB/02.jpg",
		"Pasta/CarrosselB/03.jpg",
	]);
	console.log("  dropped parent folder (5 files)");

	const foldersBefore = await prisma.contentItem.count({
		where: { type: "carousel_folder" },
	});
	await waitForRows("carousel_folder", foldersBefore + 2);
	await waitForRows("image", 7 + 5);
	await sleep(1500);

	const rootList2 = await api(`/api/content-items?parent_id=&limit=100`);
	const folders2 = rootList2.body.items
		.filter((i) => i.type === "carousel_folder")
		.sort((a, b) => a.name.localeCompare(b.name));
	console.log(`  root folders now: ${folders2.map((f) => f.name).join(", ")}`);
	const carouselA = folders2.find((f) => f.name === "CarrosselA");
	const carouselB = folders2.find((f) => f.name === "CarrosselB");
	if (!carouselA || !carouselB) {
		console.error(
			"  !! CarrosselA/CarrosselB not found:",
			folders2.map((f) => f.name),
		);
		process.exit(1);
	}
	const kidsA = (
		await api(`/api/content-items?parent_id=${carouselA.id}&limit=100`)
	).body.items;
	const kidsB = (
		await api(`/api/content-items?parent_id=${carouselB.id}&limit=100`)
	).body.items;
	const nameA = kidsA
		.map((k) => k.name)
		.sort()
		.join(",");
	const nameB = kidsB
		.map((k) => k.name)
		.sort()
		.join(",");
	console.log(`  CarrosselA slides: ${nameA}`);
	console.log(`  CarrosselB slides: ${nameB}`);
	results.push({ carouselA: nameA, carouselB: nameB });

	// Also check: no loose "Pasta" folder and no stray root slides from Test B
	const rootSlides = rootList2.body.items.filter(
		(i) => i.type !== "carousel_folder",
	);
	console.log(
		`  loose root slides after Test B: ${rootSlides.map((s) => s.name).join(", ") || "(none)"}`,
	);
	results.push({ looseRootSlides: rootSlides.map((s) => s.name) });

	// ── Verdicts ─────────────────────────────────────────────────────────────
	const failures = [];
	const ok = (cond, label) => {
		console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
		if (!cond) failures.push(label);
	};

	const folderA = results.find((r) => r.folder === "Carrossel1");
	ok(
		folderA?.slides?.join(",") === "01.jpg,02.jpg,03.jpg",
		"Carrossel1 contains exactly its 3 slides",
	);
	const folderB = results.find((r) => r.folder === "Carrossel2");
	ok(
		folderB?.slides?.join(",") === "01.jpg,02.jpg",
		"Carrossel2 contains exactly its 2 slides",
	);
	const folderC = results.find((r) => r.folder === "Carrossel3");
	ok(
		folderC?.slides?.join(",") === "01.jpg,02.jpg",
		"Carrossel3 contains exactly its 2 slides",
	);
	ok(
		results.find((r) => r.carouselA)?.carouselA === "01.jpg,02.jpg",
		"CarrosselA (nested) contains exactly its 2 slides",
	);
	ok(
		results.find((r) => r.carouselB)?.carouselB === "01.jpg,02.jpg,03.jpg",
		"CarrosselB (nested) contains exactly its 3 slides",
	);
	const loose = results.find((r) => r.looseRootSlides)?.looseRootSlides || [];
	ok(loose.length === 0, "no loose slides leaked to root from Test B");

	// ── TEST C: drop 2 folders directly on the LIBRARY (/content) ────────────
	console.log("== TEST C: folders dropped directly on the Library ==");
	await page.goto(`${BASE}/content`, { waitUntil: "domcontentloaded" });
	await page
		.getByRole("heading", { name: "Library" })
		.waitFor({ timeout: 20_000 });
	await sleep(1500);

	// Drop onto the library root area (the page-level dropzone root)
	await page.evaluate(
		async ({ pngB64 }) => {
			const makeFile = (p) => {
				const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
				const name = p.split("/").pop();
				const f = new File([bytes], name, { type: "image/png" });
				Object.defineProperty(f, "webkitRelativePath", {
					value: p,
					configurable: true,
				});
				return f;
			};
			const dt = new DataTransfer();
			[
				"LibCarrX/01.jpg",
				"LibCarrX/02.jpg",
				"LibCarrY/01.jpg",
				"LibCarrY/02.jpg",
			].forEach((p) => dt.items.add(makeFile(p)));
			// Drop on an element INSIDE the library dropzone root (the component's
			// outermost div) so the synthetic event bubbles through it to
			// react-dropzone's root handler. main/body are ANCESTORS — a drop there
			// never passes through the dropzone.
			const zone =
				document.querySelector('input[placeholder*="Search"]') ||
				document.querySelector(".scroller") ||
				document.querySelector("h2");
			zone.dispatchEvent(
				new DragEvent("drop", {
					dataTransfer: dt,
					bubbles: true,
					cancelable: true,
				}),
			);
		},
		{ pngB64: PNG_1PX.toString("base64") },
	);
	console.log("  dropped 2 folders on /content");

	const foldersBeforeC = await prisma.contentItem.count({
		where: { type: "carousel_folder" },
	});
	await waitForRows("carousel_folder", foldersBeforeC + 2);
	await waitForRows("image", 7 + 5 + 4);
	await sleep(1500);

	const rootList3 = await api(`/api/content-items?parent_id=&limit=100`);
	const lcX = rootList3.body.items.find((i) => i.name === "LibCarrX");
	const lcY = rootList3.body.items.find((i) => i.name === "LibCarrY");
	if (!lcX || !lcY) {
		console.error("  !! LibCarrX/LibCarrY missing after library drop");
		process.exit(1);
	}
	const kidsX = (await api(`/api/content-items?parent_id=${lcX.id}&limit=100`))
		.body.items;
	const kidsY = (await api(`/api/content-items?parent_id=${lcY.id}&limit=100`))
		.body.items;
	const nX = kidsX
		.map((k) => k.name)
		.sort()
		.join(",");
	const nY = kidsY
		.map((k) => k.name)
		.sort()
		.join(",");
	console.log(`  LibCarrX slides: ${nX}`);
	console.log(`  LibCarrY slides: ${nY}`);
	ok(nX === "01.jpg,02.jpg", "library drop: LibCarrX has exactly its 2 slides");
	ok(nY === "01.jpg,02.jpg", "library drop: LibCarrY has exactly its 2 slides");

	// ── TEST D: REAL FileSystemEntry path (webkitGetAsEntry mock) ────────────
	// The synthetic drops above fall back to dataTransfer.files. This test
	// overrides DataTransferItem.prototype.webkitGetAsEntry to hand the app a
	// realistic FileSystemEntry tree, exercising collectDroppedFiles' readEntry
	// + Object.defineProperty(webkitRelativePath) path — what a real browser
	// drag of multiple folders produces.
	console.log("== TEST D: real Entry-API path (webkitGetAsEntry mock) ==");
	await page.goto(`${BASE}/upload`, { waitUntil: "domcontentloaded" });
	await page
		.getByText("Drag & drop files or folders")
		.waitFor({ timeout: 20_000 });
	await sleep(1200);

	await page.evaluate(
		async ({ pngB64 }) => {
			const bytes = () => Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));

			// Mock FileSystemEntry tree: RootDirA/1.jpg, RootDirA/2.jpg,
			// RootDirB/1.jpg, RootDirB/2.jpg
			const tree = {
				RootDirA: ["1.jpg", "2.jpg"],
				RootDirB: ["1.jpg", "2.jpg"],
			};
			const mkFile = (name) => ({
				isFile: true,
				isDirectory: false,
				name,
				file: (resolve) => {
					const f = new File([bytes()], name, { type: "image/png" });
					resolve(f);
				},
			});
			const mkDir = (name, children) => ({
				isFile: false,
				isDirectory: true,
				name,
				createReader: () => {
					let returned = false;
					return {
						readEntries: (resolve) => {
							if (returned) return resolve([]);
							returned = true;
							resolve(children.map(mkFile));
						},
					};
				},
			});

			const entriesByRoot = {};
			for (const [rootName, files] of Object.entries(tree)) {
				entriesByRoot[rootName] = mkDir(rootName, files);
			}
			const orig = DataTransferItem.prototype.webkitGetAsEntry;
			DataTransferItem.prototype.webkitGetAsEntry = function () {
				const f = this.getAsFile();
				if (!f) return null;
				for (const [root, entry] of Object.entries(entriesByRoot)) {
					if (f.name === `${root}__dir`) return entry;
				}
				return null;
			};
			window.__restoreEntry = () => {
				DataTransferItem.prototype.webkitGetAsEntry = orig;
			};

			// Two DataTransferItems, each a directory placeholder whose getAsFile
			// name maps back to the mock entry.
			const dt = new DataTransfer();
			dt.items.add(new File([bytes()], "RootDirA__dir", { type: "image/png" }));
			dt.items.add(new File([bytes()], "RootDirB__dir", { type: "image/png" }));

			const all = [...document.querySelectorAll("div")].filter((d) =>
				d.textContent.includes("Drag & drop files or folders"),
			);
			const zone = all[all.length - 1];
			zone.dispatchEvent(
				new DragEvent("drop", {
					dataTransfer: dt,
					bubbles: true,
					cancelable: true,
				}),
			);
		},
		{ pngB64: PNG_1PX.toString("base64") },
	);
	console.log("  dropped 2 folders via Entry API mock");

	const foldersBeforeD = await prisma.contentItem.count({
		where: { type: "carousel_folder" },
	});
	await waitForRows("carousel_folder", foldersBeforeD + 2);
	await waitForRows("image", 7 + 5 + 4 + 4);
	await sleep(1500);

	const rootList4 = await api(`/api/content-items?parent_id=&limit=100`);
	const rdA = rootList4.body.items.find((i) => i.name === "RootDirA");
	const rdB = rootList4.body.items.find((i) => i.name === "RootDirB");
	if (!rdA || !rdB) {
		console.error("  !! RootDirA/RootDirB missing after Entry API drop");
		process.exit(1);
	}
	const kidsRdA = (
		await api(`/api/content-items?parent_id=${rdA.id}&limit=100`)
	).body.items;
	const kidsRdB = (
		await api(`/api/content-items?parent_id=${rdB.id}&limit=100`)
	).body.items;
	const nRdA = kidsRdA
		.map((k) => k.name)
		.sort()
		.join(",");
	const nRdB = kidsRdB
		.map((k) => k.name)
		.sort()
		.join(",");
	console.log(`  RootDirA slides: ${nRdA}`);
	console.log(`  RootDirB slides: ${nRdB}`);
	ok(nRdA === "1.jpg,2.jpg", "Entry API: RootDirA has exactly its 2 slides");
	ok(nRdB === "1.jpg,2.jpg", "Entry API: RootDirB has exactly its 2 slides");

	// ── TEST E: MULTIPLE parent folders each containing carousel subfolders ──
	// The regression this guards: keying the group on the top-level root only
	// merged every subfolder of a parent into ONE carousel (the reported bug).
	console.log("== TEST E: multiple parents with carousel subfolders ==");
	await page.goto(`${BASE}/upload`, { waitUntil: "domcontentloaded" });
	await page
		.getByText("Drag & drop files or folders")
		.waitFor({ timeout: 20_000 });
	await sleep(1200);
	await dropFolders(page, [
		"Pasta1/CarrX/1.jpg",
		"Pasta1/CarrX/2.jpg",
		"Pasta1/CarrY/1.jpg",
		"Pasta1/CarrY/2.jpg",
		"Pasta2/CarrZ/1.jpg",
		"Pasta2/CarrZ/2.jpg",
	]);
	console.log("  dropped 2 parents (Pasta1{CarrX,CarrY}, Pasta2{CarrZ})");

	const foldersBeforeE = await prisma.contentItem.count({
		where: { type: "carousel_folder" },
	});
	await waitForRows("carousel_folder", foldersBeforeE + 3);
	await waitForRows("image", 7 + 5 + 4 + 4 + 6);
	await sleep(1500);

	const rootList5 = await api(`/api/content-items?parent_id=&limit=100`);
	const carrX = rootList5.body.items.find((i) => i.name === "CarrX");
	const carrY = rootList5.body.items.find((i) => i.name === "CarrY");
	const carrZ = rootList5.body.items.find((i) => i.name === "CarrZ");
	if (!carrX || !carrY || !carrZ) {
		console.error(
			"  !! CarrX/CarrY/CarrZ missing:",
			rootList5.body.items
				.filter((i) => i.type === "carousel_folder")
				.map((i) => i.name),
		);
		process.exit(1);
	}
	const xKids = (
		await api(`/api/content-items?parent_id=${carrX.id}&limit=100`)
	).body.items;
	const yKids = (
		await api(`/api/content-items?parent_id=${carrY.id}&limit=100`)
	).body.items;
	const zKids = (
		await api(`/api/content-items?parent_id=${carrZ.id}&limit=100`)
	).body.items;
	const nxSlides = xKids
		.map((k) => k.name)
		.sort()
		.join(",");
	const nySlides = yKids
		.map((k) => k.name)
		.sort()
		.join(",");
	const nzSlides = zKids
		.map((k) => k.name)
		.sort()
		.join(",");
	console.log(`  CarrX slides: ${nxSlides}`);
	console.log(`  CarrY slides: ${nySlides}`);
	console.log(`  CarrZ slides: ${nzSlides}`);
	ok(
		nxSlides === "1.jpg,2.jpg",
		"CarrX (nested in Pasta1) has exactly its 2 slides",
	);
	ok(
		nySlides === "1.jpg,2.jpg",
		"CarrY (nested in Pasta1) has exactly its 2 slides — NOT merged with CarrX",
	);
	ok(
		nzSlides === "1.jpg,2.jpg",
		"CarrZ (nested in Pasta2) has exactly its 2 slides",
	);
	// No stray parent-named carousels (Pasta1/Pasta2 must not exist as folders)
	const parentFolders = rootList5.body.items.filter(
		(i) =>
			i.type === "carousel_folder" &&
			(i.name === "Pasta1" || i.name === "Pasta2"),
	);
	ok(
		parentFolders.length === 0,
		"no parent-named merged carousels (Pasta1/Pasta2)",
	);

	writeFileSync(
		join(OUT_DIR, "folder-upload-results.json"),
		JSON.stringify({ results, failures }, null, 2),
	);

	await browser.close();
	if (failures.length > 0) {
		console.error(
			`\n${failures.length} FAILURE(S):\n- ${failures.join("\n- ")}`,
		);
		process.exit(1);
	}
	console.log("\nALL CHECKS PASSED");
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
