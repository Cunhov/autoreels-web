#!/usr/bin/env node
/**
 * Planners gauntlet — DIRECT mode scenarios for the "edit selection + caption
 * tags" module (S3direct / S4direct).
 *
 * Runs runPlannerOnce (lib/planner-runtime.ts) in-process against the temp DB
 * and asserts that caption template tags NEVER leak literally into the created
 * Post.caption — with rotation OFF (the lane where the preview route uses
 * resolvePlannerRuntime's ad-hoc 2-variable replace).
 *
 *   S3direct: library item WITHOUT caption → Post.caption must contain no "{",
 *             {date} must be resolved (dd/mm/yyyy), {unknown_var} must be gone.
 *   S4direct: library item WITH caption "MinhaLegenda" → Post.caption must
 *             contain "A MinhaLegenda B".
 *
 * Runner: npx --no-install tsx scripts/gauntlet/planner-edit-direct.mts \
 *           --db <path> --out <report.json>
 *
 * Exit code 0 only if every scenario passes.
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { runPlannerOnce } from "../../lib/planner-runtime";

const argv = process.argv.slice(2);
const getArg = (key: string) => {
	const i = argv.indexOf(key);
	return i >= 0 ? argv[i + 1] : null;
};
const DB_PATH = getArg("--db");
const OUT_PATH = getArg("--out") || "planner-edit-direct-report.json";
if (!DB_PATH) {
	console.error("Missing required argument --db");
	process.exit(2);
}

const prisma = new PrismaClient({
	adapter: new PrismaBetterSqlite3({ url: "file:" + DB_PATH }),
});

const TPL = "A {post_caption} B {date} C {unknown_var}";
const DATE_RE = /\d{2}\/\d{2}\/\d{4}/;

async function seedBase() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
	await prisma.channel.upsert({
		where: { id: "pledit-c" },
		update: {},
		create: {
			id: "pledit-c",
			user_id: "admin",
			platform: "instagram",
			name: "Edit Direct Channel",
			token_source: "manual",
			account_id: "acct-pledit-direct",
			status: "active",
			access_token: "token-pledit",
			token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000),
		},
	});
}

async function seedScenario(id: string, itemId: string, itemCaption: string | null) {
	await prisma.contentItem.create({
		data: {
			id: itemId,
			user_id: "admin",
			name: `${itemId}.mp4`,
			type: "video",
			url: "/api/file/admin/sel-thumb.png",
			thumbnail_url: "/api/file/admin/sel-thumb.png",
			size: 100,
			...(itemCaption === null ? {} : { caption: itemCaption }),
		},
	});
	await prisma.planner.create({
		data: {
			id,
			user_id: "admin",
			name: id,
			status: "active",
			last_run: null,
			config: JSON.stringify({
				frequency: { value: 5, unit: "minutes" },
				timezone: "America/Sao_Paulo",
				sort_order: "old_to_new",
				caption_templates: [TPL],
				caption_rotation: "off",
				content: [
					{
						type: "library_item",
						id: itemId,
						url: "https://example.com/pledit.mp4",
						media_type: "REELS",
						// The wizard stores the user's typed caption on EACH content
						// entry ({post_caption}/{date}/... live here at publish time).
						caption: TPL,
					},
				],
			}),
			channels: { connect: [{ id: "pledit-c" }] },
		},
	});
}

async function main() {
	const report: Record<string, unknown> = {};
	let allPass = true;

	await seedBase();

	// ── S3direct: item WITHOUT caption ────────────────────────────────────────
	await seedScenario("pledit-nocap", "pledit-nocap-item", null);
	const rNocap = await runPlannerOnce(
		prisma,
		await prisma.planner.findFirst({ where: { id: "pledit-nocap" }, include: { channels: true } }),
		new Date(),
	);
	const nocapPost = rNocap.ok
		? await prisma.post.findFirst({ where: { planner_id: "pledit-nocap" } })
		: null;
	const nocapCaption = nocapPost?.caption ?? "";
	const s3pass = Boolean(
		rNocap.ok &&
			nocapPost &&
			!nocapCaption.includes("{") &&
			DATE_RE.test(nocapCaption),
	);
	report.S3direct = {
		pass: s3pass,
		ok: rNocap.ok === true,
		skipped: (rNocap as { skipped?: string }).skipped ?? null,
		errors: (rNocap as { errors?: string[] }).errors ?? [],
		caption: nocapCaption.slice(0, 120),
		dateResolved: DATE_RE.test(nocapCaption),
		noLiteralBraces: !nocapCaption.includes("{"),
	};
	allPass = allPass && s3pass;
	console.log(
		`SCENARIO S3direct: ${s3pass ? "PASS" : "FAIL"} — caption="${nocapCaption.slice(0, 60)}" (no "{" allowed; {date} must resolve)`,
	);

	// ── S4direct: item WITH caption "MinhaLegenda" ────────────────────────────
	// The wizard stores the user's fallback in caption_fallback; the item's own
	// caption is what {post_caption} resolves to.
	await seedScenario("pledit-cap", "pledit-cap-item", "MinhaLegenda");
	const rCap = await runPlannerOnce(
		prisma,
		await prisma.planner.findFirst({ where: { id: "pledit-cap" }, include: { channels: true } }),
		new Date(),
	);
	const capPost = rCap.ok
		? await prisma.post.findFirst({ where: { planner_id: "pledit-cap" } })
		: null;
	const capCaption = capPost?.caption ?? "";
	const s4pass = Boolean(rCap.ok && capPost && capCaption.includes("A MinhaLegenda B"));
	report.S4direct = {
		pass: s4pass,
		ok: rCap.ok === true,
		caption: capCaption.slice(0, 120),
		containsResolved: capCaption.includes("A MinhaLegenda B"),
	};
	allPass = allPass && s4pass;
	console.log(
		`SCENARIO S4direct: ${s4pass ? "PASS" : "FAIL"} — caption="${capCaption.slice(0, 60)}" (must contain "A MinhaLegenda B")`,
	);

	writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

	await prisma.post
		.deleteMany({ where: { planner_id: { in: ["pledit-nocap", "pledit-cap"] } } })
		.catch(() => {});
	await prisma.planner
		.deleteMany({ where: { id: { in: ["pledit-nocap", "pledit-cap"] } } })
		.catch(() => {});
	await prisma.contentItem
		.deleteMany({ where: { id: { in: ["pledit-nocap-item", "pledit-cap-item"] } } })
		.catch(() => {});
	await prisma.channel.deleteMany({ where: { id: "pledit-c" } }).catch(() => {});
	await prisma.$disconnect();

	process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
	console.error("FATAL:", err?.stack || err);
	writeFileSync(
		OUT_PATH,
		JSON.stringify({ fatal: String(err?.stack || err) }, null, 2),
	);
	await prisma.$disconnect().catch(() => {});
	process.exit(2);
});
