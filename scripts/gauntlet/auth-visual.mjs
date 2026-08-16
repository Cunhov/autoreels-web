#!/usr/bin/env node
/**
 * Module-07 gauntlet — I7 login page visual (Playwright).
 *
 * Against the running standalone app. Real next-auth logins from the browser
 * key the rate limiter on ip="unknown" (no x-forwarded-for) — independent of
 * the scenario harness's fixed test IPs, so ordering never interferes.
 *
 * Usage:
 *   node auth-visual.mjs --base http://127.0.0.1:PORT --db <db>
 *        --secret <NEXTAUTH_SECRET> --out <dir> --admin-email <e>
 *        --admin-password <p>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const argv = process.argv.slice(2);
const getArg = (key) => {
	const i = argv.indexOf(key);
	return i >= 0 ? argv[i + 1] : null;
};
const BASE = getArg("--base");
const DB_PATH = getArg("--db");
const SECRET = getArg("--secret");
const OUT_DIR = getArg("--out");
const ADMIN_EMAIL = getArg("--admin-email");
const ADMIN_PASSWORD = getArg("--admin-password");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--out", OUT_DIR],
	["--admin-email", ADMIN_EMAIL],
	["--admin-password", ADMIN_PASSWORD],
]) {
	if (!value) {
		console.error(`Missing required argument ${name}`);
		process.exit(2);
	}
}

const prisma = new PrismaClient({
	adapter: new PrismaBetterSqlite3({ url: "file:" + DB_PATH }),
});

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on("console", (m) => {
	if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (a) RENDER + autofocus record
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.getByText("AutoReels", { exact: true }).first().waitFor({ timeout: 15_000 });
await sleep(400);
const focusedPlaceholder = await page.evaluate(
	() => document.activeElement?.getAttribute("placeholder") || null,
);
writeFileSync(join(OUT_DIR, "login-desktop.png"), await page.screenshot());

// (b) WRONG PASSWORD → inline error
await page.getByPlaceholder("admin@example.com").fill(ADMIN_EMAIL);
await page.getByPlaceholder("Required").fill("WrongPassword1!");
await page.getByRole("button", { name: "Sign In", exact: true }).click();
const inlineError = await page
	.getByText("Invalid email or password", { exact: true })
	.isVisible()
	.catch(() => false);
await sleep(300);

// (c) EMPTY SUBMIT → record the real contract (error appears or button validates)
await page.getByPlaceholder("admin@example.com").fill("");
await page.getByPlaceholder("Required").fill("");
await page.getByRole("button", { name: "Sign In", exact: true }).click();
await sleep(800);
const emptySubmitError = await page
	.getByText("Invalid email or password", { exact: true })
	.isVisible()
	.catch(() => false);
const emptySubmitNoCrash = pageErrors.length === 0;

// (d) MOBILE 390×844 — no horizontal scroll
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.getByText("AutoReels", { exact: true }).first().waitFor({ timeout: 15_000 });
await sleep(400);
const hScroll = await page.evaluate(
	() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
writeFileSync(join(OUT_DIR, "login-mobile.png"), await page.screenshot());

// (e) SUCCESS login → redirected to the app root
await page.getByPlaceholder("admin@example.com").fill(ADMIN_EMAIL);
await page.getByPlaceholder("Required").fill(ADMIN_PASSWORD);
await page.getByRole("button", { name: "Sign In", exact: true }).click();
const redirected = await page
	.waitForURL((u) => u.pathname === "/", { timeout: 15_000 })
	.then(() => true)
	.catch(() => false);
await sleep(600);

await browser.close();

const pass =
	consoleErrors.length === 0 &&
	pageErrors.length === 0 &&
	inlineError &&
	emptySubmitNoCrash &&
	hScroll <= 2 &&
	redirected;

console.log(
	`SCENARIO I7: ${pass ? "PASS" : "FAIL"} — render=true autofocus="${focusedPlaceholder || "none"}" wrongPassError=${inlineError} emptySubmitError=${emptySubmitError}/noCrash=${emptySubmitNoCrash} mobileHScroll=${hScroll}px successRedirect=${redirected} consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`,
);
if (consoleErrors.length > 0) console.log("  console errors:", JSON.stringify(consoleErrors.slice(0, 5)));
if (pageErrors.length > 0) console.log("  page errors:", JSON.stringify(pageErrors.slice(0, 5)));

try {
	writeFileSync(
		join(OUT_DIR, "auth-visual-report.json"),
		JSON.stringify({ consoleErrors, pageErrors, inlineError, emptySubmitError, hScroll, redirected, focusedPlaceholder }, null, 2),
	);
} catch {
	/* ignore */
}

await prisma.$disconnect();
process.exit(pass ? 0 : 1);
