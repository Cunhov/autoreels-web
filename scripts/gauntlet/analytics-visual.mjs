#!/usr/bin/env node
/**
 * Analytics/Settings/Channels-UI visual gauntlet (module 06) — S5 (analytics
 * page), S6 (settings page), S7 (channels page incl. end-to-end OAuth connect
 * against the fetch-mock). Playwright (chromium-core) against the running
 * standalone server. NO product fixes.
 *
 * Usage:
 *   node analytics-visual.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --mock-state <state.json>
 *        --mock-calls <calls.jsonl> --server-log <server.log> --out <dir>
 *
 * Exit 0 only if every scenario passes.
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
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
const MOCK_STATE = getArg("--mock-state");
const MOCK_CALLS = getArg("--mock-calls");
const SERVER_LOG = getArg("--server-log");
const OUT_DIR = getArg("--out");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--mock-state", MOCK_STATE],
	["--mock-calls", MOCK_CALLS],
	["--server-log", SERVER_LOG],
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
const NS = "mod6";

function writeState(rules) {
	const consumed = {};
	rules.forEach((_, i) => (consumed[i] = 0));
	const tmp = `${MOCK_STATE}.tmp`;
	writeFileSync(tmp, JSON.stringify({ rules, consumed }));
	renameSync(tmp, MOCK_STATE);
}

const rule = (urlSub, matchRegex, responses, method = "POST") => ({
	...(urlSub ? { match: urlSub } : {}),
	...(matchRegex ? { matchRegex } : {}),
	...(method ? { method } : {}),
	responses,
});

const resultsTotal = [];
function record(label, pass, line, detail = {}) {
	resultsTotal.push({ scenario: label, pass, line, detail });
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
}

let browser;
async function makeContext(viewport = { width: 1440, height: 900 }) {
	if (!browser) browser = await chromium.launch();
	const ctx = await browser.newContext({ viewport });
	await ctx.addCookies([
		{
			name: "next-auth.session-token",
			value: SESSION_TOKEN,
			domain: "127.0.0.1",
			path: "/",
		},
	]);
	return ctx;
}

async function gotoPage(ctx, path) {
	const page = await ctx.newPage();
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => pageErrors.push(String(err)));
	await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
	await sleep(1200);
	return page;
}

async function hScroll(page) {
	return page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
}

// ── Seed helpers ────────────────────────────────────────────────────────────

async function seedUser() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
}

async function seedChannel(data) {
	await prisma.channel.upsert({
		where: { id: data.id },
		update: {
			user_id: "admin",
			name: data.name,
			platform: "instagram",
			access_token: data.access_token ?? "IGToken",
			account_id: data.account_id ?? null,
			status: data.status ?? "active",
		},
		create: {
			id: data.id,
			user_id: "admin",
			name: data.name,
			platform: "instagram",
			access_token: data.access_token ?? "IGToken",
			account_id: data.account_id ?? null,
			status: data.status ?? "active",
		},
	});
}

// ── S5 — analytics page ─────────────────────────────────────────────────────

async function scenarioS5() {
	const errSnapshot = consoleErrors.length;
	await seedUser();
	await prisma.post.deleteMany({ where: { id: { startsWith: "s5-" } } });
	await prisma.channel.deleteMany({ where: { id: { startsWith: "s5-" } } });
	await prisma.planner.deleteMany({ where: { id: "s5-planner" } });
	await prisma.channel.deleteMany({ where: { id: "s5-zeroc" } });

	await seedChannel({
		id: "s5-a",
		name: "S5 Alpha",
		access_token: "IGAlpha",
		account_id: "acct-s5a",
	});
	await seedChannel({
		id: "s5-zeroc",
		name: "S5 Zero",
		access_token: "IGZero",
		account_id: "acct-s5z",
	});
	await prisma.planner.create({
		data: {
			id: "s5-planner",
			user_id: "admin",
			name: "S5 Planner",
			config: JSON.stringify({ frequency: { value: 5, unit: "minutes" } }),
			status: "active",
		},
	});
	const now = Date.now();
	const day = 24 * 3600 * 1000;
	for (let i = 0; i < 12; i++) {
		await prisma.post.create({
			data: {
				id: `s5-p${i}`,
				user_id: "admin",
				channel_id: "s5-a",
				status: i < 8 ? "published" : "pending",
				media_type: "REELS",
				video_url: `https://mock-webhook.invalid/v${i}.mp4`,
				caption: `S5 post ${i}`,
				scheduled_at: new Date(now - i * 2 * day),
				published_at: i < 8 ? new Date(now - i * 2 * day) : null,
			},
		});
	}

	const ctx = await makeContext();
	const page = await gotoPage(ctx, "/analytics");
	await sleep(1500);
	const body = await page.locator("body").innerText();

	const headingOk = body.includes("Resumo local");
	const postsCardOk = body.includes("Posts");
	const channelCardOk = body.includes("S5 Alpha");
	// The "Active Planners" card shows a COUNT, not the planner name.
	const plannerCardOk = body.includes("Active Planners");
	const noNan = !/NaN|Infinity|undefined/.test(body);

	// Screenshot desktop.
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(
		join(OUT_DIR, "analytics-desktop.png"),
		await page.screenshot(),
	);

	// Period switch: click the 7-day range button.
	const periodBtn = page.locator("button", { hasText: /^7$/ }).first();
	await periodBtn.click().catch(() => {});
	await sleep(1200);
	const afterSwitch = await page.locator("body").innerText();
	const switchOk =
		afterSwitch.includes("Resumo local") && !consoleErrors.includes("Resumo");

	// Channel view: click the S5 Alpha channel card.
	const chanCard = page.locator("div", { hasText: "S5 Alpha" }).first();
	await chanCard.click().catch(() => {});
	await sleep(1500);
	const chanBody = await page.locator("body").innerText();
	const chanViewOk =
		chanBody.includes("S5 Alpha") &&
		!/NaN|Infinity|undefined/.test(chanBody) &&
		pageErrors.length === 0;

	// Zero-data channel view renders zeros (no NaN).
	const zeroCard = page.locator("div", { hasText: "S5 Zero" }).first();
	await zeroCard.click().catch(() => {});
	await sleep(1500);
	const zeroBody = await page.locator("body").innerText();
	const zeroOk = !/NaN|Infinity|undefined/.test(zeroBody);

	// Mobile: 390×844 no horizontal scroll.
	const mctx = await makeContext({ width: 390, height: 844 });
	const mpage = await gotoPage(mctx, "/analytics");
	await sleep(1500);
	const mScroll = await hScroll(mpage);
	const mobileOk = mScroll <= 2;
	writeFileSync(
		join(OUT_DIR, "analytics-mobile.png"),
		await mpage.screenshot(),
	);

	const scenarioErrors = consoleErrors.slice(errSnapshot);
	const pass =
		headingOk &&
		postsCardOk &&
		channelCardOk &&
		plannerCardOk &&
		noNan &&
		switchOk &&
		chanViewOk &&
		zeroOk &&
		mobileOk &&
		scenarioErrors.length === 0 &&
		pageErrors.length === 0;
	record(
		"S5",
		Boolean(pass),
		`analytics: heading=${headingOk} cards=${postsCardOk}/${channelCardOk}/${plannerCardOk} noNaN=${noNan} switch=${switchOk} chanView=${chanViewOk} zeroView=${zeroOk} mobileHScroll=${mScroll}px consoleErrors=${scenarioErrors.length} pageErrors=${pageErrors.length}`,
		{ mScroll, consoleErrors: consoleErrors.slice(0, 5) },
	);
	await ctx.close();
	await mctx.close();

	await prisma.post.deleteMany({ where: { id: { startsWith: "s5-" } } });
	await prisma.channel.deleteMany({ where: { id: { startsWith: "s5-" } } });
	await prisma.planner.deleteMany({ where: { id: "s5-planner" } });
}

// ── S6 — settings page ──────────────────────────────────────────────────────

async function scenarioS6() {
	const errSnapshot = consoleErrors.length;
	await seedUser();
	const KEYS = [
		"TELEGRAM_BOT_TOKEN",
		"TELEGRAM_CHAT_ID",
		"NOTIFY_WEBHOOK_URL",
		"PUBLISH_MIN_INTERVAL_SECONDS",
		"RETENTION_POSTS_DAYS",
		"RETENTION_LOGS_DAYS",
	];
	await prisma.appConfig.deleteMany({ where: { key: { in: KEYS } } });
	await prisma.appConfig.createMany({
		data: [
			{ key: "PUBLISH_MIN_INTERVAL_SECONDS", value: "600" },
			{ key: "RETENTION_POSTS_DAYS", value: "90" },
			{ key: "TELEGRAM_BOT_TOKEN", value: "1234567890:ABCDEF" },
			{ key: "TELEGRAM_CHAT_ID", value: "@gauntlet" },
		],
	});

	const ctx = await makeContext();
	const page = await gotoPage(ctx, "/settings");
	await sleep(1500);
	const body = await page.locator("body").innerText();
	const rendered =
		body.includes("Settings") ||
		body.includes("PUBLISH_MIN_INTERVAL_SECONDS") ||
		body.includes("600");
	writeFileSync(join(OUT_DIR, "settings-desktop.png"), await page.screenshot());

	// Edit min interval → 900 → Save → toast + persisted (API-verified).
	const minInput = page.locator('input[placeholder="e.g. 300"]').first();
	await minInput.fill("900").catch(() => {});
	await page
		.getByText("Save", { exact: false })
		.first()
		.click()
		.catch(() => {});
	await sleep(1500);
	const savedToast = (await page.locator("body").innerText()).includes(
		"Settings saved",
	);
	const apiAfterSave = await fetch(`${BASE}/api/settings`, {
		headers: { cookie: `next-auth.session-token=${SESSION_TOKEN}` },
	}).then((r) => r.json());
	const persisted = apiAfterSave.PUBLISH_MIN_INTERVAL_SECONDS === 900;

	// Invalid input → server 400 → error toast, value unchanged in the API.
	const minInput2 = page.locator('input[placeholder="e.g. 300"]').first();
	await minInput2.fill("-5").catch(() => {});
	const inputAfterFill = await minInput2.inputValue().catch(() => "?");
	await page
		.getByRole("button", { name: /Save Settings/ })
		.click()
		.catch(() => {});
	await sleep(400);
	// NOTE: the page's showToast never clears the previous timer — a stale
	// timer from an earlier toast can dismiss a newer toast early. We read the
	// toast at 400ms to beat that race AND record the finding in the baseline.
	const errToast = (await page.locator("body").innerText()).includes(
		"must be a non-negative number",
	);
	const apiAfterInvalid = await fetch(`${BASE}/api/settings`, {
		headers: { cookie: `next-auth.session-token=${SESSION_TOKEN}` },
	}).then((r) => r.json());
	const unchanged = apiAfterInvalid.PUBLISH_MIN_INTERVAL_SECONDS === 900;
	if (!errToast) {
		const bodyTxt = await page.locator("body").innerText();
		const snippet = bodyTxt
			.split("\n")
			.filter((l) => /min|must|save|900|-5/i.test(l))
			.slice(0, 8);
		console.log(
			"  S6 invalid-save debug: inputAfterFill=",
			inputAfterFill,
			"snippet=",
			JSON.stringify(snippet),
			"apiValue=",
			apiAfterInvalid.PUBLISH_MIN_INTERVAL_SECONDS,
			"consoleErrors=",
			JSON.stringify(consoleErrors.slice(-6)),
		);
	}

	// Sensitive masked placeholder shown.
	const maskedShown =
		(await page.locator("body").innerText()).includes("****") &&
		!(await page.locator("body").innerText()).includes("1234567890");

	// Mobile.
	const mctx = await makeContext({ width: 390, height: 844 });
	const mpage = await gotoPage(mctx, "/settings");
	await sleep(1200);
	const mScroll = await hScroll(mpage);
	writeFileSync(join(OUT_DIR, "settings-mobile.png"), await mpage.screenshot());

	const scenarioErrors = consoleErrors.slice(errSnapshot);
	// Expected noise: the deliberate invalid-save 400 resource log + the page's
	// own console.error in its catch (the rejection is surfaced via toast).
	const unexpectedErrors = scenarioErrors.filter(
		(m) =>
			!m.includes("status of 400") && !m.includes("Error saving settings:"),
	);
	const pass =
		rendered &&
		savedToast &&
		persisted &&
		errToast &&
		unchanged &&
		maskedShown &&
		mScroll <= 2 &&
		unexpectedErrors.length === 0 &&
		pageErrors.length === 0;
	record(
		"S6",
		Boolean(pass),
		`settings: rendered=${rendered} savedToast=${savedToast} persisted=${persisted} errToast=${errToast} unchangedAfterInvalid=${unchanged} masked=${maskedShown} mobileHScroll=${mScroll}px consoleErrors=${scenarioErrors.length}(unexpected=${unexpectedErrors.length}) pageErrors=${pageErrors.length}`,
		{ persisted, unchanged, mScroll },
	);
	await ctx.close();
	await mctx.close();

	await prisma.appConfig.deleteMany({ where: { key: { in: KEYS } } });
}

// ── S7 — channels page (list + test + refresh + connect) ────────────────────

async function scenarioS7() {
	const errSnapshot = consoleErrors.length;
	await seedUser();
	await prisma.channel.deleteMany({ where: { id: { startsWith: "s7-" } } });
	await prisma.channel.deleteMany({
		where: {
			user_id: "admin",
			platform: "instagram",
			name: { startsWith: "S7" },
		},
	});
	await prisma.post.deleteMany({ where: { id: "s7-post" } });

	await seedChannel({
		id: "s7-ok",
		name: "S7 OK",
		access_token: "IGS7OK",
		account_id: "acct-s7a",
	});
	await seedChannel({
		id: "s7-bad",
		name: "S7 Bad",
		access_token: "IGS7Bad",
		account_id: "acct-s7b",
	});
	await seedChannel({
		id: "s7-inactive",
		name: "S7 Inactive",
		access_token: "IGS7In",
		account_id: "acct-s7c",
		status: "inactive",
	});
	await prisma.post.create({
		data: {
			id: "s7-post",
			user_id: "admin",
			channel_id: "s7-ok",
			status: "published",
			media_type: "REELS",
			scheduled_at: new Date(),
			published_at: new Date(),
		},
	});

	// Mock: test endpoint ok/400 + refresh token + (later) OAuth exchange.
	writeState([
		rule(
			null,
			`v24\\.0\\/acct-s7a\\?fields=username`,
			[{ status: 200, body: { username: "gauntlet_s7", id: "acct-s7a" } }],
			"GET",
		),
		rule(
			null,
			`v24\\.0\\/acct-s7b\\?fields=username`,
			[{ status: 400, body: { error: { message: "Session has expired" } } }],
			"GET",
		),
		rule(
			null,
			`refresh_access_token`,
			[
				{
					status: 200,
					body: { access_token: "IGS7Refreshed", expires_in: 5184000 },
				},
			],
			"GET",
		),
		rule(
			"api.instagram.com/oauth/access_token",
			null,
			[{ status: 200, body: { access_token: "IGShortS7", user_id: "ig-s7" } }],
			"POST",
		),
		rule(
			"graph.instagram.com/access_token",
			null,
			[
				{
					status: 200,
					body: { access_token: "IGLongS7", expires_in: 5184000 },
				},
			],
			"GET",
		),
		rule(
			"v24.0/me",
			null,
			[
				{
					status: 200,
					body: {
						id: "ig-s7",
						username: "connected_user",
						profile_picture_url: "https://mock-webhook.invalid/pic.jpg",
					},
				},
			],
			"GET",
		),
	]);

	// The OAuth callback redirect can land the browser on localhost (and the
	// mock avatar URL is a fake domain) — cover both cookie hosts so the API
	// calls stay authenticated regardless of which host the navigation uses.
	const connectCtx = await browser.newContext({
		viewport: { width: 1440, height: 900 },
	});
	await connectCtx.addCookies([
		{
			name: "next-auth.session-token",
			value: SESSION_TOKEN,
			domain: "127.0.0.1",
			path: "/",
		},
		{
			name: "next-auth.session-token",
			value: SESSION_TOKEN,
			domain: "localhost",
			path: "/",
		},
	]);
	const ctx = await makeContext();
	const page = await gotoPage(ctx, "/channels");
	const badResponses = [];
	page.on("response", (r) => {
		if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
	});
	await sleep(1500);
	const body = await page.locator("body").innerText();
	const listOk =
		body.includes("S7 OK") &&
		body.includes("S7 Bad") &&
		body.includes("S7 Inactive");
	writeFileSync(join(OUT_DIR, "channels-desktop.png"), await page.screenshot());

	// Card anchor: the IOSCard div (className "p-4 group") containing the h4.
	const cardOf = (name) =>
		page
			.locator("div.p-4.group")
			.filter({ has: page.locator("h4", { hasText: name }) })
			.first();

	// Test ok channel: click its Test button.
	const okCard = cardOf("S7 OK");
	const testBtnCount = await page
		.locator('button[title="Test connection"]')
		.count();
	await okCard
		.locator('button[title="Test connection"]')
		.click()
		.catch(() => {});
	await sleep(1500);
	const testOkToast = (await page.locator("body").innerText()).includes(
		"connection OK",
	);

	// Test bad channel: error toast.
	const badCard = cardOf("S7 Bad");
	await badCard
		.locator('button[title="Test connection"]')
		.click()
		.catch(() => {});
	await sleep(1500);
	const testBadToast = (await page.locator("body").innerText()).includes(
		"Session has expired",
	);

	// Refresh ok channel: token updated in DB.
	const okCard2 = cardOf("S7 OK");
	await okCard2
		.locator('button[title="Refresh token"]')
		.click()
		.catch(() => {});
	await sleep(1500);
	const refreshed = await prisma.channel.findUnique({ where: { id: "s7-ok" } });
	const refreshOk = refreshed?.access_token === "IGS7Refreshed";

	// Connect flow: modal → Continue with Instagram → oauth/start → authorize
	// URL → intercept navigation → local callback → channel appears.
	const connectPage = await gotoPage(connectCtx, "/channels");
	let authorizeState = "";
	await connectPage.route("**/oauth/authorize**", async (route) => {
		const url = route.request().url();
		const m = url.match(/[?&]state=([^&]+)/);
		authorizeState = m ? decodeURIComponent(m[1]) : "";
		await route.fulfill({
			status: 302,
			headers: {
				location: `${BASE}/api/channels/oauth/callback?code=S7CODE&state=${encodeURIComponent(authorizeState)}`,
			},
		});
	});
	await connectPage
		.getByText("Add Channel")
		.first()
		.click()
		.catch(() => {});
	await sleep(800);
	await connectPage
		.getByText("Continue with Instagram")
		.click()
		.catch(() => {});
	// The page navigates away (window.location.href) → callback → /channels?connect=success
	await connectPage
		.waitForURL("**/channels**", { timeout: 15_000 })
		.catch(() => {});
	await sleep(2000);
	const connectedChannel = await prisma.channel.findFirst({
		where: { user_id: "admin", account_id: "ig-s7" },
	});
	const connectOk =
		authorizeState !== "" &&
		connectedChannel?.status === "active" &&
		connectedChannel?.access_token === "IGLongS7" &&
		connectedChannel?.account_id === "ig-s7";

	// Mobile.
	const mctx = await makeContext({ width: 390, height: 844 });
	const mpage = await gotoPage(mctx, "/channels");
	await sleep(1200);
	const mScroll = await hScroll(mpage);
	writeFileSync(join(OUT_DIR, "channels-mobile.png"), await mpage.screenshot());

	if (consoleErrors.length > 0) {
		console.log(
			"  S7 console errors:",
			JSON.stringify(consoleErrors.slice(0, 12)),
		);
	}
	if (badResponses.length > 0) {
		console.log(
			"  S7 4xx/5xx responses:",
			JSON.stringify(badResponses.slice(0, 12)),
		);
	}
	// Expected console noise: the deliberate bad-test 400 ("status of 400")
	// and the mock avatar's unresolvable domain (ERR_NAME_NOT_RESOLVED).
	// Anything ELSE is a real regression.
	const expectedNoise = (m) =>
		m.includes("status of 400") || m.includes("ERR_NAME_NOT_RESOLVED");
	const scenarioErrors = consoleErrors.slice(errSnapshot);
	const unexpectedErrors = scenarioErrors.filter((m) => !expectedNoise(m));
	const pass =
		listOk &&
		testOkToast &&
		testBadToast &&
		refreshOk &&
		connectOk &&
		mScroll <= 2 &&
		unexpectedErrors.length === 0 &&
		pageErrors.length === 0;
	record(
		"S7",
		Boolean(pass),
		`channels: list=${listOk} testButtons=${testBtnCount} testOk=${testOkToast} testBad=${testBadToast} refresh=${refreshOk} connect=${connectOk} (token=${connectedChannel?.access_token}) mobileHScroll=${mScroll}px consoleErrors=${scenarioErrors.length}(unexpected=${unexpectedErrors.length}) pageErrors=${pageErrors.length}`,
		{
			refreshToken: refreshed?.access_token,
			connected: connectedChannel?.access_token,
			mScroll,
		},
	);
	await ctx.close();
	await mctx.close();
	await browser?.close().catch(() => {});

	await prisma.channel.deleteMany({ where: { id: { startsWith: "s7-" } } });
	await prisma.channel.deleteMany({
		where: { user_id: "admin", account_id: "ig-s7" },
	});
	await prisma.post.deleteMany({ where: { id: "s7-post" } });
}

// ── Main ────────────────────────────────────────────────────────────────────

const scenarios = [
	["S5", scenarioS5],
	["S6", scenarioS6],
	["S7", scenarioS7],
];

let failed = 0;
for (const [label, fn] of scenarios) {
	try {
		await fn();
	} catch (err) {
		failed++;
		resultsTotal.push({
			scenario: label,
			pass: false,
			line: `EXCEPTION: ${err?.message || err}`,
		});
		console.error(`SCENARIO ${label}: EXCEPTION — ${err?.stack || err}`);
	}
}
const anyPass = resultsTotal.filter((r) => r.pass).length;
console.log("\n=== SUMMARY ===");
for (const r of resultsTotal)
	console.log(`${r.scenario}: ${r.pass ? "PASS" : "FAIL"} — ${r.line}`);
console.log(`\nTOTAL: ${anyPass}/${resultsTotal.length} pass`);
await prisma.$disconnect();
process.exit(failed > 0 || anyPass !== resultsTotal.length ? 1 : 0);
