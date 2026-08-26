#!/usr/bin/env node
/**
 * Planners gauntlet — "edit selection + caption tags" module (Playwright + HTTP).
 *
 * Scenarios (baseline expected: S1/S2 FAIL — selection lost on edit; S3
 * measures whether template tags leak literally in the preview lane):
 *
 *   S1  Create a planner selecting ALL 130 seeded library items through the
 *       wizard UI (Select All → Load more → Select All). Save. Reopen the
 *       edit wizard. ASSERT: the selection counter reads 130 immediately on
 *       open, and every rendered row is checked after clicking "Load more"
 *       until everything is loaded.
 *   S2  In the same loaded session deselect 3 specific items (one beyond the
 *       first page), save, reopen. ASSERT: exactly 127 checked everywhere,
 *       and the 3 deselected items remain unchecked after Load more.
 *   S3  HTTP: planner whose content entry caption is
 *       "A {post_caption} B {date} C {unknown_var}" bound to a library item
 *       WITHOUT caption, rotation off. GET /api/planners/:id/preview → the
 *       final caption must contain no "{" and {date} must be resolved.
 *   S4  HTTP: same but the library item HAS caption "MinhaLegenda" → preview
 *       caption must contain "A MinhaLegenda B".
 *       (The runPlannerOnce publish-lane twins live in planner-edit-direct.mts.)
 *
 * Zero console/page errors required. List view is forced via localStorage
 * (cl.viewMode) so all loaded rows render in the DOM without virtualization.
 *
 * Usage:
 *   node planner-edit-scenarios.mjs --base http://127.0.0.1:PORT --db <test.db>
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

const TOTAL_ITEMS = 130;
const PAGE_SIZE = 100; // must match ContentLibrary's PAGE_SIZE
const PLANNER_NAME = "Edit Sel Planner";
const DESELECT_NAMES = ["Sel Item 005", "Sel Item 060", "Sel Item 120"]; // 060/120 cross the page-1 boundary at load time
const TPL = "A {post_caption} B {date} C {unknown_var}";
const DATE_RE = /\d{2}\/\d{2}\/\d{4}/;

const prisma = new PrismaClient({
	adapter: new PrismaBetterSqlite3({ url: "file:" + DB_PATH }),
});
const SESSION_TOKEN = await encode({
	token: { sub: "admin" },
	secret: SECRET,
	maxAge: 3600,
});

const consoleErrors = [];
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitModalClosed(page) {
	await page
		.locator("div.fixed.inset-0.z-50")
		.first()
		.waitFor({ state: "detached", timeout: 15_000 })
		.catch(() => {});
	await sleep(300);
}

/** Body innerText snapshot (single source of truth for state polling). */
const bodyText = (page) =>
	page.evaluate(() => document.body?.innerText || "");

/**
 * Click "Load more" until the button disappears (all pages loaded).
 * Polls on rendered state, never fixed sleeps longer than one tick.
 */
async function loadAll(page) {
	for (let i = 0; i < 10; i++) {
		const btn = page.getByRole("button", { name: "Load more" });
		if (!(await btn.isVisible().catch(() => false))) break;
		await btn.evaluate((el) => el.click());
		try {
			await page.waitForFunction(
				() => !document.body.innerText.includes("Load more"),
				{ timeout: 20_000 },
			);
		} catch {
			/* one more loop iteration will re-check visibility */
		}
		await sleep(150);
	}
}

/** Count checked checkboxes across all rendered library rows (list view). */
const countCheckedRows = (page) =>
	page.evaluate(
		() =>
			document.querySelectorAll(
				"tbody tr td:first-child div.bg-ios-blue.border-ios-blue",
			).length,
	);

const countRows = (page) =>
	page.evaluate(() => document.querySelectorAll("tbody tr").length);

/** Read the "selected / total" badge text, e.g. "100 / 130". */
async function readBadge(page) {
	const txt = await bodyText(page);
	const m = txt.match(/(\d+) \/ (\d+)/);
	return m ? { selected: Number(m[1]), total: Number(m[2]) } : null;
}

/** Read the wizard sentence "N library item(s) selected." */
function readWizardCounter(text) {
	const m = text.match(/(\d+) library items? selected/);
	return m ? Number(m[1]) : null;
}

/** Open /planners → the planner card → Edit → walk to the content step. */
async function openEditAtContentStep(page) {
	await page.goto(`${BASE}/planners`, { waitUntil: "domcontentloaded" });
	await page.getByText(PLANNER_NAME).first().waitFor({ timeout: 20_000 });
	const card = page
		.getByText(PLANNER_NAME)
		.first()
		.locator("xpath=ancestor::div[.//button[@title='Edit planner']][1]");
	await card.locator('button[title="Edit planner"]').evaluate((el) => el.click());
	await page.getByPlaceholder("My Awesome Scheduler").waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: "Next", exact: true }).click(); // step 1 (channels preselected)
	await page.getByRole("button", { name: "Next", exact: true }).click(); // step 2 (content — library tab auto-selected)
	// Wait until the selection counter shows a non-zero value (initial fetch done).
	await page.waitForFunction(
		() => /[1-9]\d* library items? selected/.test(document.body.innerText),
		{ timeout: 20_000 },
	);
	await sleep(300); // let the badge settle after the keep-selection prune
}

async function savePlanner(page) {
	await page.getByRole("button", { name: "Next", exact: true }).click(); // step 3 (settings)
	await page.locator('input[type="number"]').first().fill("1");
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page
		.getByRole("button", { name: "Finish", exact: true })
		.evaluate((el) => el.click());
	await waitModalClosed(page);
	await page.getByText(PLANNER_NAME).first().waitFor({ timeout: 20_000 });
}

/** Row locator by seeded item name. */
const rowByName = (page, name) =>
	page.locator("tbody tr", { hasText: name }).first();

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });

	// ── Seed ──────────────────────────────────────────────────────────────────
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
	const channel = await prisma.channel.create({
		data: {
			id: "pledit-c",
			user_id: "admin",
			platform: "instagram",
			name: "Edit Sel Channel",
			token_source: "manual",
			account_id: "acct-pledit",
			status: "active",
			access_token: "token-pledit",
			token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000),
		},
	});
	// One tiny valid PNG shared by every item — no 404 console noise.
	const { mkdirSync: mkdirDyn, writeFileSync: wfsDyn } = await import("node:fs");
	const { join: jn, dirname: dn } = await import("node:path");
	const thumbAbs = jn(UPLOADS_DIR, "admin", "sel-thumb.png");
	mkdirDyn(dn(thumbAbs), { recursive: true });
	wfsDyn(
		thumbAbs,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		),
	);
	const items = [];
	for (let i = 0; i < TOTAL_ITEMS; i++) {
		const nn = String(i).padStart(3, "0");
		items.push({
			id: `pledit-item-${nn}`,
			user_id: "admin",
			name: `Sel Item ${nn}`,
			type: "image",
			url: "/api/file/admin/sel-thumb.png",
			thumbnail_url: "/api/file/admin/sel-thumb.png",
			size: 100,
		});
	}
	await prisma.contentItem.createMany({ data: items });

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
		try {
			// Force LIST view so every loaded row renders in the DOM (the grid is
			// virtualized and would make DOM-count assertions meaningless).
			localStorage.setItem("cl.viewMode", "list");
		} catch {
			/* private mode — grid fallback would degrade assertions, not crash */
		}
	});
	const page = await ctx.newPage();
	globalThis.__lastUrl = "";
	page.on("framenavigated", (f) => {
		if (f === page.mainFrame()) globalThis.__lastUrl = page.url();
	});
	globalThis.__dumpBody = async () =>
		bodyText(page).then((t) => t.slice(0, 2000)).catch(() => "(no body)");
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => pageErrors.push(err?.stack || String(err)));

	const evidence = {};

	try {
		// ── S1: create with ALL 130 selected, reopen, verify ──────────────────
		await page.goto(`${BASE}/planners`, { waitUntil: "domcontentloaded" });
		await page.getByRole("button", { name: "New Planner", exact: true }).click();
		await page.getByPlaceholder("My Awesome Scheduler").fill(PLANNER_NAME);
		const localNow = new Date();
		const pad = (n) => String(n).padStart(2, "0");
		await page
			.locator('input[type="datetime-local"]')
			.fill(
				`${localNow.getFullYear()}-${pad(localNow.getMonth() + 1)}-${pad(localNow.getDate())}T${pad(localNow.getHours())}:${pad(localNow.getMinutes())}`,
			);
		await page.getByRole("button", { name: "Next", exact: true }).click();
		await page.getByText("Edit Sel Channel").first().click();
		await page.getByRole("button", { name: "Next", exact: true }).click();
		await page.getByRole("button", { name: "From Library", exact: true }).click();
		// Wait until page 1 is fully rendered before bulk-selecting (exact match:
		// the "Showing 100 of 130 items" footer also contains "130 items").
		await page
			.getByText(`${TOTAL_ITEMS} items`, { exact: true })
			.waitFor({ timeout: 20_000 });
		await sleep(300);

		// Select page 1 (100 items), load the rest, select those too.
		await page
			.getByRole("button", { name: "Select All", exact: true })
			.evaluate((el) => el.click());
		await page
			.getByText(`${PAGE_SIZE} / ${TOTAL_ITEMS}`)
			.waitFor({ timeout: 10_000 });
		await loadAll(page);
		const rowsAfterLoad = await countRows(page);
		await page
			.getByRole("button", { name: "Select All", exact: true })
			.evaluate((el) => el.click());
		await page
			.getByText(`${TOTAL_ITEMS} / ${TOTAL_ITEMS}`)
			.waitFor({ timeout: 10_000 });
		evidence.s1_createdWithSelection = await readWizardCounter(
			await bodyText(page),
		);
		await page.screenshot({
			path: join(OUT_DIR, "s1-create-all-selected.png"),
			fullPage: false,
		});
		await savePlanner(page);

		// Reopen the edit wizard — the moment of truth.
		await openEditAtContentStep(page);
		evidence.s1_reopenedBadge = await readBadge(page);
		evidence.s1_reopenedWizardCounter = readWizardCounter(await bodyText(page));
		await page.screenshot({
			path: join(OUT_DIR, "s1-reopen-before-loadmore.png"),
			fullPage: false,
		});
		await loadAll(page);
		evidence.s1_rowsRendered = await countRows(page);
		evidence.s1_checkedAfterFullLoad = await countCheckedRows(page);
		evidence.s1_badgeAfterFullLoad = await readBadge(page);
		await page.screenshot({
			path: join(OUT_DIR, "s1-reopen-after-loadmore.png"),
			fullPage: false,
		});
		const s1pass =
			evidence.s1_reopenedWizardCounter === TOTAL_ITEMS &&
			evidence.s1_badgeAfterFullLoad?.selected === TOTAL_ITEMS &&
			evidence.s1_checkedAfterFullLoad === TOTAL_ITEMS &&
			evidence.s1_rowsRendered === TOTAL_ITEMS;
		console.log(
			`SCENARIO S1: ${s1pass ? "PASS" : "FAIL"} — reopened counter=${evidence.s1_reopenedWizardCounter} (want ${TOTAL_ITEMS}), badge=${JSON.stringify(evidence.s1_reopenedBadge)}, checked=${evidence.s1_checkedAfterFullLoad}/${evidence.s1_rowsRendered}`,
		);

		// ── S2: deselect 3 (one beyond page 1), save, reopen, verify ──────────
		for (const name of DESELECT_NAMES) {
			const row = rowByName(page, name);
			await row.waitFor({ timeout: 10_000 });
			await row.locator("td").first().evaluate((el) => el.click());
		}
		await sleep(300);
		evidence.s2_afterDeselect = await readBadge(page);
		await page.screenshot({
			path: join(OUT_DIR, "s2-after-deselect.png"),
			fullPage: false,
		});
		await savePlanner(page);

		await openEditAtContentStep(page);
		evidence.s2_reopenedBadge = await readBadge(page);
		evidence.s2_reopenedWizardCounter = readWizardCounter(await bodyText(page));
		await loadAll(page);
		evidence.s2_checkedAfterFullLoad = await countCheckedRows(page);
		evidence.s2_deselectedStillUnchecked = {};
		for (const name of DESELECT_NAMES) {
			const row = rowByName(page, name);
			const stillUnchecked = (await row.count()) > 0 &&
				(await row.locator("td").first().locator("div.bg-ios-blue").count()) === 0;
			evidence.s2_deselectedStillUnchecked[name] = stillUnchecked;
		}
		await page.screenshot({
			path: join(OUT_DIR, "s2-final-state.png"),
			fullPage: false,
		});
		const s2pass =
			evidence.s2_reopenedWizardCounter === TOTAL_ITEMS - DESELECT_NAMES.length &&
			evidence.s2_checkedAfterFullLoad === TOTAL_ITEMS - DESELECT_NAMES.length &&
			Object.values(evidence.s2_deselectedStillUnchecked).every(Boolean);
		console.log(
			`SCENARIO S2: ${s2pass ? "PASS" : "FAIL"} — reopened counter=${evidence.s2_reopenedWizardCounter} (want ${TOTAL_ITEMS - DESELECT_NAMES.length}), checked=${evidence.s2_checkedAfterFullLoad}, deselectedIntact=${JSON.stringify(evidence.s2_deselectedStillUnchecked)}`,
		);

		// Leave the wizard cleanly before the HTTP part.
		await page.goto(`${BASE}/planners`, { waitUntil: "domcontentloaded" });
		await sleep(400);

		// ── S3/S4: preview-lane tag leakage (rotation OFF lane) ───────────────
		const cookieHeader = `next-auth.session-token=${SESSION_TOKEN}`;
		const previewCaption = async (plannerId) => {
			const res = await fetch(`${BASE}/api/planners/${plannerId}/preview`, {
				headers: { cookie: cookieHeader },
			});
			if (!res.ok) return { error: `HTTP ${res.status}` };
			const json = await res.json();
			return {
				caption:
					json?.runtime?.preview?.caption ?? json?.runtime?.caption ?? "",
			};
		};

		for (const scenario of [
			{ id: "pledit-nocap", itemId: "pledit-nocap-item", itemCaption: null },
			{
				id: "pledit-cap",
				itemId: "pledit-cap-item",
				itemCaption: "MinhaLegenda",
			},
		]) {
			await prisma.contentItem.create({
				data: {
					id: scenario.itemId,
					user_id: "admin",
					name: `${scenario.itemId}.mp4`,
					type: "video",
					url: "/api/file/admin/sel-thumb.png",
					thumbnail_url: "/api/file/admin/sel-thumb.png",
					size: 100,
					...(scenario.itemCaption === null
						? {}
						: { caption: scenario.itemCaption }),
				},
			});
			await prisma.planner.create({
				data: {
					id: scenario.id,
					user_id: "admin",
					name: scenario.id,
					status: "active",
					config: JSON.stringify({
						frequency: { value: 5, unit: "minutes" },
						timezone: "America/Sao_Paulo",
						sort_order: "old_to_new",
						caption_templates: [TPL],
						caption_rotation: "off",
						content: [
							{
								type: "library_item",
								id: scenario.itemId,
								url: "https://example.com/pledit.mp4",
								media_type: "REELS",
								caption: TPL,
							},
						],
					}),
					channels: { connect: [{ id: channel.id }] },
				},
			});
		}

		const nocap = await previewCaption("pledit-nocap");
		evidence.s3_previewCaption = nocap.caption ?? nocap.error;
		const s3pass = Boolean(
			nocap.caption &&
				!nocap.caption.includes("{") &&
				DATE_RE.test(nocap.caption),
		);
		console.log(
			`SCENARIO S3-preview: ${s3pass ? "PASS" : "FAIL"} — caption="${String(nocap.caption).slice(0, 80)}" (no "{" allowed; {date} must resolve)`,
		);

		const cap = await previewCaption("pledit-cap");
		evidence.s4_previewCaption = cap.caption ?? cap.error;
		const s4pass = Boolean(
			cap.caption && cap.caption.includes("A MinhaLegenda B"),
		);
		console.log(
			`SCENARIO S4-preview: ${s4pass ? "PASS" : "FAIL"} — caption="${String(cap.caption).slice(0, 80)}" (must contain "A MinhaLegenda B")`,
		);

		const pass =
			s1pass &&
			s2pass &&
			s3pass &&
			s4pass &&
			consoleErrors.length === 0 &&
			pageErrors.length === 0;

		const report = {
			scenarios: {
				S1: {
					pass: s1pass,
					reopenedBadge: evidence.s1_reopenedBadge,
					reopenedWizardCounter: evidence.s1_reopenedWizardCounter,
					checkedAfterFullLoad: evidence.s1_checkedAfterFullLoad,
					rowsRendered: evidence.s1_rowsRendered,
				},
				S2: {
					pass: s2pass,
					reopenedBadge: evidence.s2_reopenedBadge,
					reopenedWizardCounter: evidence.s2_reopenedWizardCounter,
					checkedAfterFullLoad: evidence.s2_checkedAfterFullLoad,
					deselectedStillUnchecked: evidence.s2_deselectedStillUnchecked,
				},
				S3preview: { pass: s3pass, caption: evidence.s3_previewCaption },
				S4preview: { pass: s4pass, caption: evidence.s4_previewCaption },
			},
			evidence,
			consoleErrors,
			pageErrors,
			pass,
		};
		writeFileSync(
			join(OUT_DIR, "planner-edit-report.json"),
			JSON.stringify(report, null, 2),
		);
		console.log(
			`PLANNER-EDIT VISUAL: ${pass ? "PASS" : "FAIL"} — consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`,
		);
		if (consoleErrors.length > 0) {
			for (const e of consoleErrors.slice(0, 10))
				console.log(`    console: ${e.slice(0, 200)}`);
		}
		if (pageErrors.length > 0) {
			for (const e of pageErrors.slice(0, 10))
				console.log(`    pageerror: ${e.slice(0, 200)}`);
		}

		await browser.close();

		// Cleanup (best-effort; the runner uses a throwaway DB anyway).
		await prisma.post
			.deleteMany({ where: { planner_id: { in: ["pledit-nocap", "pledit-cap"] } } })
			.catch(() => {});
		await prisma.planner
			.deleteMany({ where: { id: { in: ["pledit-nocap", "pledit-cap"] } } })
			.catch(() => {});
		await prisma.contentItem
			.deleteMany({ where: { user_id: "admin", name: { startsWith: "Sel Item" } } })
			.catch(() => {});
		await prisma.contentItem
			.deleteMany({
				where: { id: { in: ["pledit-nocap-item", "pledit-cap-item"] } },
			})
			.catch(() => {});
		await prisma.planner.deleteMany({ where: { name: PLANNER_NAME } }).catch(() => {});
		await prisma.channel.deleteMany({ where: { id: "pledit-c" } }).catch(() => {});
		await prisma.$disconnect();
		process.exit(pass ? 0 : 1);
	} catch (err) {
		console.error("FATAL:", err?.stack || err);
		try {
			const dump = {
				url: globalThis.__lastUrl || page.url(),
				body: (await globalThis.__dumpBody?.()) || "",
				consoleErrors,
				pageErrors: pageErrors.slice(0, 3),
			};
			writeFileSync(
				join(OUT_DIR, "planner-edit-fail-diagnostic.json"),
				JSON.stringify(dump, null, 2),
			);
		} catch {
			/* best-effort */
		}
		await browser.close().catch(() => {});
		await prisma.$disconnect().catch(() => {});
		process.exit(2);
	}
}

main().catch((err) => {
	console.error("FATAL:", err?.stack || err);
	process.exit(2);
});
