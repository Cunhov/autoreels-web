#!/usr/bin/env node
/**
 * Calendar visual gauntlet — C4-render, C5-modal, C7, C8.
 *
 * Playwright (chromium-core) against the running standalone server at "/" (the
 * calendar page). The BROWSER is launched with TZ=America/Sao_Paulo so that
 * C8 can prove the classic timezone trap: a post scheduled at an instant that
 * is UTC-day X but local-day X-1 must be placed on the LOCAL day cell.
 *
 * Seeds (via prisma, before launch):
 *   - C4: one post per UI status on a fixed local day
 *   - C5: a planner-created post (caption unique)
 *   - C8: a post at 22:00 local (SP) = 01:00Z next UTC day
 *   - C6-render: 40 posts on another local day (the "+N more" burst)
 *
 * Captures screenshots into --out. Records console/page errors.
 *
 * Usage:
 *   node calendar-visual.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --out <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { encode } from "next-auth/jwt";

// ── Timezone: the WHOLE harness reasons in America/Sao_Paulo (UTC-3, no DST
//    since 2019). Set it before any Date math so seeding and assertions agree.
process.env.TZ = "America/Sao_Paulo";

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

const NS_PREFIX = "cal-vis-";
const consoleErrors = [];
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});

	// ── Seed (all in the current SP-local month so the default view shows them) ──
	const now = new Date();
	const spYear = now.getFullYear();
	const spMonth = now.getMonth(); // 0-based
	const pad = (n) => String(n).padStart(2, "0");
	// Local day number in SP for "today" (we seeded relative to the 1st..28th).
	const todayLocal = now.getDate();

	// C4: one post per status on local day 15 (or today if the month has it).
	const statuses = [
		"pending",
		"scheduled",
		"processing",
		"processing_upload",
		"processing_children",
		"ready_to_publish",
		"published",
		"failed",
		"cancelled",
	];
	const c4LocalDay = Math.min(15, 28);
	for (let i = 0; i < statuses.length; i++) {
		const local = new Date(spYear, spMonth, c4LocalDay, 9 + i, 0, 0);
		await prisma.post.create({
			data: {
				id: `${NS_PREFIX}c4-${i}`,
				user_id: "admin",
				status: statuses[i],
				media_type: "REELS",
				caption: `VIS-C4 ${statuses[i]}`,
				scheduled_at: local,
				...(statuses[i] === "published"
					? { published_at: new Date(local.getTime() + 60_000) }
					: {}),
			},
		});
	}

	// C5: planner post on its OWN local day (keeps the C4 day badge exact).
	await prisma.planner.upsert({
		where: { id: "cal-vis-planner" },
		update: {},
		create: {
			id: "cal-vis-planner",
			user_id: "admin",
			name: "Planner Alfa Visual",
			config: JSON.stringify({ frequency: { value: 5, unit: "minutes" } }),
			status: "active",
		},
	});
	const c5LocalDay = Math.min(16, 28);
	const c5Local = new Date(spYear, spMonth, c5LocalDay, 14, 30, 0);
	await prisma.post.create({
		data: {
			id: `${NS_PREFIX}c5-planned`,
			user_id: "admin",
			status: "pending",
			media_type: "REELS",
			planner_id: "cal-vis-planner",
			caption: "VIS-C5 from planner",
			scheduled_at: c5Local,
		},
	});

	// C8: TZ trap — local 22:00 on day X (SP) = 01:00Z on UTC day X+1.
	// The month view must place it on the LOCAL day X cell, not the UTC day X+1.
	const c8LocalDay = Math.min(20, 28);
	const c8Local = new Date(spYear, spMonth, c8LocalDay, 22, 0, 0);
	const c8UtcDay = c8Local.toISOString().slice(8, 10); // the UTC day number
	const c8LocalDayNum = String(c8LocalDay).padStart(2, "0");
	await prisma.post.create({
		data: {
			id: `${NS_PREFIX}c8-trap`,
			user_id: "admin",
			status: "pending",
			media_type: "REELS",
			caption: "VIS-C8 TZ TRAP",
			scheduled_at: c8Local,
		},
	});

	// C6-render: 40 posts on another local day (the "+N more" burst chip).
	const burstLocalDay = Math.min(25, 28);
	for (let i = 0; i < 40; i++) {
		const local = new Date(
			spYear,
			spMonth,
			burstLocalDay,
			9 + (i % 10),
			i % 60,
			0,
		);
		await prisma.post.create({
			data: {
				id: `${NS_PREFIX}burst-${i}`,
				user_id: "admin",
				status: "pending",
				media_type: "REELS",
				caption: `VIS-BURST ${i}`,
				scheduled_at: local,
			},
		});
	}

	// ── Launch chromium with the SP timezone ──────────────────────────────────
	const browser = await chromium.launch({
		env: { ...process.env, TZ: "America/Sao_Paulo" },
	});
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
	page.on("pageerror", (err) => pageErrors.push(String(err)));

	// Helper: wait for the month grid + a specific day cell.
	const gotoCalendar = async () => {
		await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
		await page
			.locator(".grid.grid-cols-7")
			.first()
			.waitFor({ timeout: 30_000 });
		await sleep(600);
	};

	const monthTitle = () =>
		page
			.locator("h2.text-xl")
			.first()
			.textContent()
			.catch(() => "");

	// ── C7a: month renders with statuses + count badge ────────────────────────
	await gotoCalendar();
	const monthName = await monthTitle();
	const badgeText = await page
		.locator("span.text-\\[9px\\]", {
			hasText: new RegExp(`^${statuses.length}$`),
		})
		.first()
		.textContent()
		.catch(() => "");
	const c4BadgeOk = badgeText.trim() === String(statuses.length);
	writeFileSync(
		join(OUT_DIR, "calendar-month-desktop.png"),
		await page.screenshot(),
	);

	// ── C5-modal: open the day modal on the C5 day, assert caption + statuses ─
	await page
		.locator("div.min-h-\\[140px\\]")
		.filter({
			has: page.locator("span.text-\\[13px\\]", {
				hasText: String(c5LocalDay),
			}),
		})
		.first()
		.click();
	await sleep(500);
	const modalVisible = await page
		.getByText("scheduled", { exact: false })
		.first()
		.isVisible()
		.catch(() => false);
	const modalCaption = await page
		.getByText("VIS-C5 from planner", { exact: false })
		.first()
		.isVisible()
		.catch(() => false);
	const plannerNameInModal = await page
		.getByText("Planner Alfa Visual", { exact: false })
		.first()
		.isVisible()
		.catch(() => false);
	writeFileSync(
		join(OUT_DIR, "calendar-day-modal.png"),
		await page.screenshot(),
	);
	// Close the modal (X button).
	await page
		.locator('button[title="Close"]')
		.first()
		.click()
		.catch(() => {});
	await sleep(300);

	// ── C7b: week view renders ────────────────────────────────────────────────
	await page
		.getByRole("button", { name: "Week", exact: true })
		.click()
		.catch(() => {});
	await sleep(500);
	writeFileSync(join(OUT_DIR, "calendar-week.png"), await page.screenshot());
	const weekRenders = await page
		.locator(".grid.grid-cols-7")
		.first()
		.isVisible()
		.catch(() => false);

	// ── C7c: month navigation (prev/next) updates the title ───────────────────
	// The header nav buttons are icon-only (no accessible name); the page also
	// handles ArrowLeft/ArrowRight keyboard shortcuts — use those (deterministic).
	await page
		.getByRole("button", { name: "Month", exact: true })
		.click()
		.catch(() => {});
	await sleep(400);
	const title0 = await monthTitle();
	await page.keyboard.press("ArrowRight");
	await sleep(500);
	const titleAfterNext = await monthTitle();
	await page.keyboard.press("ArrowLeft");
	await sleep(500);
	const titleAfterPrev = await monthTitle();
	const navOk =
		title0 !== titleAfterNext &&
		titleAfterNext !== titleAfterPrev &&
		Boolean(titleAfterPrev) &&
		Boolean(title0);

	// ── C8: TZ trap placement ─────────────────────────────────────────────────
	// Locate the day cells by their day-number span (robust to locale/time
	// formatting): the LOCAL day cell must contain the post card (its count
	// badge == 1), the UTC day cell must NOT. Also dump sample card times for
	// the record (headless chromium defaults to en-US → "10:00 PM").
	const tzPlacement = await page.evaluate(
		({ utcDay, localDay }) => {
			const cells = [...document.querySelectorAll("div.min-h-\\[140px\\]")];
			const dayOf = (cell) =>
				cell.querySelector("span.text-\\[13px\\]")?.textContent?.trim();
			const cardCount = (cell) =>
				cell.querySelectorAll(".aspect-\\[4\\/5\\]").length;
			const badge = (cell) =>
				cell.querySelector("span.text-\\[9px\\]")?.textContent?.trim();
			const localCell = cells.find((c) => dayOf(c) === localDay);
			const utcCell = cells.find((c) => dayOf(c) === utcDay);
			return {
				localDay,
				utcDay,
				localCellFound: Boolean(localCell),
				localCards: localCell ? cardCount(localCell) : -1,
				localBadge: localCell ? badge(localCell) : null,
				utcCellFound: Boolean(utcCell),
				utcCards: utcCell ? cardCount(utcCell) : -1,
				utcBadge: utcCell ? badge(utcCell) : null,
				sampleTimes: [...document.querySelectorAll(".aspect-\\[4\\/5\\]")]
					.map((c) => c.textContent.trim())
					.slice(0, 12),
			};
		},
		{ utcDay: c8UtcDay, localDay: c8LocalDayNum },
	);
	const tzOk =
		tzPlacement.localCellFound &&
		tzPlacement.localCards >= 1 &&
		(!tzPlacement.utcCellFound || tzPlacement.utcCards === 0) &&
		tzPlacement.localDay !== tzPlacement.utcDay;

	// ── C6-render: the 40-post burst day shows the "+N more" chip ─────────────
	const moreChip = await page
		.getByText(/^\+\d+ more$/)
		.first()
		.isVisible()
		.catch(() => false);

	// ── C7d: mobile 390x844 — no horizontal scroll, day grid visible ──────────
	const mctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
	});
	await mctx.addCookies([
		{
			name: "next-auth.session-token",
			value: SESSION_TOKEN,
			domain: "127.0.0.1",
			path: "/",
		},
	]);
	const mpage = await mctx.newPage();
	mpage.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	mpage.on("pageerror", (err) => pageErrors.push(String(err)));
	await mpage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
	await mpage.locator(".grid.grid-cols-7").first().waitFor({ timeout: 30_000 });
	await sleep(600);
	const hScroll = await mpage.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	writeFileSync(join(OUT_DIR, "calendar-mobile.png"), await mpage.screenshot());
	await mctx.close();

	await browser.close();

	// ── Verdicts ──────────────────────────────────────────────────────────────
	const c4RenderOk =
		c4BadgeOk && consoleErrors.length === 0 && pageErrors.length === 0;
	record(
		"C4",
		Boolean(c4RenderOk),
		`status badge "${badgeText}" (expected ${statuses.length}) consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`,
	);
	// The bar's C5 requires the planner name IN the modal (the post was created
// by a planner; the modal must say which). Current code does NOT render it —
// this assertion is the honest FAIL (baseline finding).
const c5ModalOk = modalVisible && modalCaption && plannerNameInModal;
	record(
		"C5",
		Boolean(c5ModalOk),
		`day modal open=${modalVisible} caption=${modalCaption} plannerNameRendered=${plannerNameInModal} (bar: planner name REQUIRED in modal)`,
		{ plannerNameInModal },
	);
	record(
		"C7",
		Boolean(
			weekRenders &&
				navOk &&
				hScroll <= 2 &&
				consoleErrors.length === 0 &&
				pageErrors.length === 0,
		),
		`week=${weekRenders} nav(${title0}→${titleAfterNext}→${titleAfterPrev}) mobileHScroll=${hScroll}px consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`,
		{
			weekRenders,
			navOk,
			hScroll,
			consoleErrors: consoleErrors.slice(0, 5),
			pageErrors: pageErrors.slice(0, 5),
		},
	);
	record(
		"C8",
		Boolean(tzOk),
		`TZ placement: post at 22:00 local → local day ${tzPlacement.localDay} cell cards=${tzPlacement.localCards} (badge ${tzPlacement.localBadge ?? "-"}) utc day ${tzPlacement.utcDay} cell cards=${tzPlacement.utcCards} → trap=${tzOk ? "avoided" : "HIT"} sampleTimes=${JSON.stringify(tzPlacement.sampleTimes)}`,
		{ placement: tzPlacement },
	);
	record(
		"C6-render",
		Boolean(moreChip && consoleErrors.length === 0),
		`40-post burst day: "+N more" chip visible=${moreChip}`,
	);

	writeFileSync(
		join(OUT_DIR, "visual-report.json"),
		JSON.stringify(
			{
				monthName,
				c4BadgeOk,
				modalVisible,
				modalCaption,
				plannerNameInModal,
				weekRenders,
				navOk,
				title0,
				titleAfterNext,
				titleAfterPrev,
				tzPlacement,
				tzOk,
				moreChip,
				hScroll,
				consoleErrors,
				pageErrors,
			},
			null,
			2,
		),
	);
	await prisma.post
		.deleteMany({ where: { id: { startsWith: NS_PREFIX } } })
		.catch(() => {});
	await prisma.planner
		.deleteMany({ where: { id: "cal-vis-planner" } })
		.catch(() => {});
	await prisma.$disconnect();

	const failed = resultsTotal.filter((r) => !r.pass).length;
	process.exit(failed > 0 ? 1 : 0);
}

let resultsTotal = [];
function record(label, pass, line, detail = {}) {
	resultsTotal.push({ scenario: label, pass, line, detail });
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
