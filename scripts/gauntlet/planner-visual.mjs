#!/usr/bin/env node
/**
 * Planners gauntlet — visual + functional wizard scenario PL8.
 *
 * Playwright (chromium-core) over /planners with the session cookie injected
 * and animations disabled. Flows:
 *   (a) list renders with the seeded planner
 *   (b) create: New Planner → name → channel → library item → frequency → Finish
 *   (c) edit: change frequency 2 → 7, save, persists
 *   (d) validation: sleep start==end → inline error shown, nothing submitted
 *   (e) mobile 390x844: no horizontal scroll
 * Zero console/page errors across all flows. Screenshots → out/.
 *
 * Usage:
 *   node planner-visual.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --out <dir>
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

const consoleErrors = [];
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the wizard modal to close (its root overlay is the sentinel). */
async function waitModalClosed(page) {
	await page
		.locator("div.fixed.inset-0.z-50")
		.first()
		.waitFor({ state: "detached", timeout: 15_000 })
		.catch(() => {});
	await sleep(300);
}

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
	page.on("framenavigated", (f) => {
		if (f === page.mainFrame()) globalThis.__lastUrl = page.url();
	});
	globalThis.__dumpBody = async () =>
		page
			.evaluate(() => document.body?.innerText?.slice(0, 1500) || "(no body)")
			.catch(() => "(no body)");
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => pageErrors.push(err?.stack || String(err)));

	// ── Seed ──────────────────────────────────────────────────────────────────
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
	const channel = await prisma.channel.create({
		data: {
			id: "pl8-c",
			user_id: "admin",
			platform: "instagram",
			name: "Visual Channel",
			token_source: "manual",
			account_id: "acct-pl8",
			status: "active",
			access_token: "token-pl8",
			token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000),
		},
	});
	await prisma.contentItem.create({
		data: {
			user_id: "admin",
			name: "Planner Video",
			type: "video",
			url: "/api/file/admin/planner-video.mp4",
			thumbnail_url: "/api/file/admin/planner-video.png",
			size: 100,
		},
	});
	// tiny valid PNG so the card renders a real thumbnail (no 404 console error)
	const { mkdirSync: mkdirDyn, writeFileSync: wfsDyn } = await import(
		"node:fs"
	);
	const { join: jn, dirname: dn } = await import("node:path");
	const thumbAbs = jn(UPLOADS_DIR, "admin", "planner-video.png");
	mkdirDyn(dn(thumbAbs), { recursive: true });
	wfsDyn(
		thumbAbs,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		),
	);
	await prisma.planner.create({
		data: {
			id: "pl8-seed",
			user_id: "admin",
			name: "Visual Planner",
			status: "active",
			config: JSON.stringify({
				frequency: { value: 3, unit: "hours" },
				sort_order: "old_to_new",
				content: [
					{
						type: "config",
						url: "https://example.com/v.mp4",
						media_type: "REELS",
					},
				],
			}),
			channels: { connect: [{ id: channel.id }] },
		},
	});

	const flows = {};

	// (a) LIST renders with the seeded planner
	await page.goto(`${BASE}/planners`, { waitUntil: "domcontentloaded" });
	await page.getByText("Visual Planner").first().waitFor({ timeout: 20_000 });
	await sleep(500);
	flows.list = await page.screenshot();
	writeFileSync(join(OUT_DIR, "planners-list-desktop.png"), flows.list);

	// (b) CREATE a new planner
	await page.getByRole("button", { name: "New Planner", exact: true }).click();
	await page.getByPlaceholder("My Awesome Scheduler").fill("Wizard Created");
	const localNow = new Date();
	const localISO = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, "0")}-${String(localNow.getDate()).padStart(2, "0")}T${String(localNow.getHours()).padStart(2, "0")}:${String(localNow.getMinutes()).padStart(2, "0")}`;
	await page.locator('input[type="datetime-local"]').fill(localISO);
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page.getByText("Visual Channel").first().click();
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page.getByRole("button", { name: "From Library", exact: true }).click();
	const videoCard = page
		.locator("div.aspect-square.rounded-2xl", { hasText: "Planner Video" })
		.first();
	await videoCard.evaluate((el) => el.click());
	await sleep(400);
	// Templates + auto-rotation (user-reported bug: templates with rotation
	// "off" were silently ignored). Typing a template must flip the rotation
	// selector to "sequential" automatically. The templates textarea lives on
	// the CONTENT step (step 2), before the sleep/frequency step.
	const tplTextarea = page
		.locator('textarea[placeholder*="One template per line"]')
		.first();
	await tplTextarea.fill("Wizard template {date}");
	const rotationValue = await page
		.locator("select")
		.filter({ hasText: "Rotation:" })
		.first()
		.inputValue()
		.catch(() => "");
	const autoRotation = rotationValue === "sequential";
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page.locator('input[type="number"]').first().fill("2");
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page
		.getByRole("button", { name: "Finish", exact: true })
		.evaluate((el) => el.click());
	await waitModalClosed(page);
	await page.getByText("Wizard Created").first().waitFor({ timeout: 20_000 });
	await sleep(400);
	// DB-level proof: the saved planner must carry the template + sequential.
	const savedWizardPlanner = await prisma.planner.findFirst({
		where: { name: "Wizard Created" },
	});
	let savedConfig = null;
	try {
		savedConfig = savedWizardPlanner?.config
			? JSON.parse(savedWizardPlanner.config)
			: null;
	} catch {
		savedConfig = null;
	}
	const savedTplOk =
		savedConfig?.caption_rotation === "sequential" &&
		Array.isArray(savedConfig?.caption_templates) &&
		savedConfig.caption_templates.length === 1 &&
		savedConfig.caption_templates[0] === "Wizard template {date}";
	flows.autoRotation = autoRotation;
	const createdFreqVisible = await page
		.getByText("Every 2 hours", { exact: false })
		.first()
		.isVisible()
		.catch(() => false);
	flows.created = await page.screenshot();
	writeFileSync(join(OUT_DIR, "planners-created.png"), flows.created);

	// (c) EDIT the created planner: frequency 2 → 7
	const wizardCard = page
		.getByText("Wizard Created")
		.first()
		.locator("xpath=ancestor::div[.//button[@title='Edit planner']][1]");
	await sleep(600);
	await wizardCard
		.locator('button[title="Edit planner"]')
		.evaluate((el) => el.click());
	await page
		.getByPlaceholder("My Awesome Scheduler")
		.waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: "Next", exact: true }).click(); // step 1 (channel preselected)
	await page.getByRole("button", { name: "Next", exact: true }).click(); // step 2 (content)
	// FIX PROOF (user-reported bug): the previously selected library item MUST
	// appear pre-selected when editing — the wizard used to show "0 library
	// items selected" because a re-render reset the selection after load.
	await sleep(600);
	const editSelText = await page.locator("body").innerText();
	const preSelected = /1 library items? selected/.test(editSelText);
	console.log(
		`  (c) EDIT pre-selection: preSelected=${preSelected} (bar: the selected item must survive the edit open)`,
	);
	await page.getByRole("button", { name: "Next", exact: true }).click(); // step 3 (settings)
	await page.locator('input[type="number"]').first().fill("7");
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page
		.getByRole("button", { name: "Finish", exact: true })
		.evaluate((el) => el.click());
	await waitModalClosed(page);
	const modalStillOpen = await page
		.getByText("Planner Name", { exact: true })
		.isVisible()
		.catch(() => false);
	const formErrCount = await page
		.getByText("Failed to save planner")
		.count()
		.catch(() => 0);
	console.log(
		`  (c) after Finish: modalOpen=${modalStillOpen} saveError=${formErrCount} consoleErrors=${consoleErrors.length}`,
	);
	await page
		.getByText("Every 7 hours", { exact: false })
		.first()
		.waitFor({ timeout: 20_000 });
	await sleep(300);
	flows.edited = await page.screenshot();
	writeFileSync(join(OUT_DIR, "planners-edited.png"), flows.edited);

	// (d) VALIDATION: sleep start == end → inline error, nothing submitted
	await page.getByRole("button", { name: "New Planner", exact: true }).click();
	await page.getByPlaceholder("My Awesome Scheduler").fill("Bad Sleep Planner");
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page.getByText("Visual Channel").first().click();
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page.getByRole("button", { name: "From Library", exact: true }).click();
	const videoCardD = page
		.locator("div.aspect-square.rounded-2xl", { hasText: "Planner Video" })
		.first();
	await videoCardD.evaluate((el) => el.click());
	await sleep(400);
	await page.getByRole("button", { name: "Next", exact: true }).click(); // step 3 (settings)
	// enable sleep timer + equal start/end
	await page
		.locator("div.w-12.h-7.rounded-full.cursor-pointer.relative")
		.first()
		.click();
	await page.locator('input[type="time"]').nth(0).fill("10:00");
	await page.locator('input[type="time"]').nth(1).fill("10:00");
	const inlineErrorVisible = await page
		.getByText("Sleep start and end must be different times.")
		.isVisible()
		.catch(() => false);
	const nextDisabled = await page
		.getByRole("button", { name: "Next", exact: true })
		.isDisabled()
		.catch(() => false);
	// close the wizard without saving; assert no planner was created
	// (the modal has no Escape handler — reload the page to unmount it)
	await page.goto(`${BASE}/planners`, { waitUntil: "domcontentloaded" });
	await sleep(600);
	const badPlannerAbsent =
		(await page
			.getByText("Bad Sleep Planner")
			.count()
			.catch(() => 0)) === 0;
	flows.validation = inlineErrorVisible;
	flows.nextDisabledOnInvalid = nextDisabled;

	// (e) MOBILE 390x844 — no horizontal scroll
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/planners`, { waitUntil: "domcontentloaded" });
	await page.getByText("Visual Planner").first().waitFor({ timeout: 20_000 });
	await sleep(500);
	flows.mobile = await page.screenshot();
	writeFileSync(join(OUT_DIR, "planners-mobile.png"), flows.mobile);
	const hScroll = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);

	// Capture the wizard-created planner presence BEFORE closing the browser
	// (querying after close always returns 0 — that was a harness bug).
	const wizardCreatedCount = await page
		.getByText("Wizard Created")
		.count()
		.catch(() => 0);

	await browser.close();

	const createdOk = createdFreqVisible === true && wizardCreatedCount >= 1;
	const pass =
		consoleErrors.length === 0 &&
		pageErrors.length === 0 &&
		createdOk &&
		autoRotation &&
		savedTplOk &&
		preSelected &&
		inlineErrorVisible &&
		nextDisabled &&
		badPlannerAbsent &&
		hScroll <= 2;

	const report = {
		flows: Object.keys(flows),
		createdFrequencyVisible: createdFreqVisible,
		editedFrequencyVisible: true,
		validationInlineError: inlineErrorVisible,
		validationNextDisabled: nextDisabled,
		badPlannerAbsent,
		consoleErrors,
		pageErrors,
		mobileHorizontalOverflowPx: hScroll,
	};
	writeFileSync(
		join(OUT_DIR, "planners-visual-report.json"),
		JSON.stringify(report, null, 2),
	);
	console.log(
		`SCENARIO PL8: ${pass ? "PASS" : "FAIL"} — consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length} created=${createdFreqVisible} autoRotation=${autoRotation}/${savedTplOk} preSelected=${preSelected} edited=7h validation=${inlineErrorVisible}/${nextDisabled} badAbsent=${badPlannerAbsent} mobileHScroll=${hScroll}px`,
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

	await prisma.planner
		.deleteMany({ where: { id: { in: ["pl8-seed", "pl8-wizard"] } } })
		.catch(() => {});
	await prisma.post
		.deleteMany({ where: { planner_id: { in: ["pl8-seed", "pl8-wizard"] } } })
		.catch(() => {});
	await prisma.contentItem
		.deleteMany({ where: { name: "Planner Video" } })
		.catch(() => {});
	await prisma.channel.deleteMany({ where: { id: "pl8-c" } }).catch(() => {});
	await prisma.$disconnect();
	process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	try {
		const dump = {
			url: globalThis.__lastUrl || "",
			body: await globalThis.__dumpBody?.(),
			consoleErrors,
			pageErrors: pageErrors.slice(0, 3),
		};
		writeFileSync(
			join(OUT_DIR, "planners-fail-diagnostic.json"),
			JSON.stringify(dump, null, 2),
		);
	} catch {
		/* best-effort */
	}
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
