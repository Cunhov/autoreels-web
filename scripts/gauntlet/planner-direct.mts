#!/usr/bin/env node
/**
 * Planners gauntlet — DIRECT mode scenarios PL1..PL6.
 *
 * Runs runPlannerOnce (lib/planner-runtime.ts) in-process against the temp DB,
 * so concurrency (PL1 claim race), temporal gates (PL2), config edges (PL3),
 * template rotation (PL4), channel health (PL5) and the post-claim revert
 * (PL6) are exercised deterministically WITHOUT the HTTP layer.
 *
 * Runner: npx --no-install tsx scripts/gauntlet/planner-direct.ts --db <path>
 *
 * Exit code 0 only if every scenario passes.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { runPlannerOnce } from "../../lib/planner-runtime";

const argv = process.argv.slice(2);
const getArg = (key: string) => {
	const i = argv.indexOf(key);
	return i >= 0 ? argv[i + 1] : null;
};
const DB_PATH = getArg("--db");
if (!DB_PATH) {
	console.error("Missing required argument --db");
	process.exit(2);
}

const prisma = new PrismaClient({
	adapter: new PrismaBetterSqlite3({ url: "file:" + DB_PATH }),
});

const resultsTotal: {
	scenario: string;
	pass: boolean;
	line: string;
}[] = [];

/** Safe state parse for harness assertions — never throws. */
function safeState(raw: string | null | undefined): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw || "{}") as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function record(label: string, pass: boolean, line: string) {
	resultsTotal.push({ scenario: label, pass, line });
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Time helpers (planner timezone) ─────────────────────────────────────────
const TZ = "America/Sao_Paulo";
function hhmm(date: Date, tz = TZ): string {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const parts = fmt.formatToParts(date);
	const hh = (parts.find((p) => p.type === "hour")?.value || "00").padStart(
		2,
		"0",
	);
	const mm = (parts.find((p) => p.type === "minute")?.value || "00").padStart(
		2,
		"0",
	);
	return `${hh}:${mm}`;
}
const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

// ── Seeds ───────────────────────────────────────────────────────────────────
async function seedUser() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
}

async function seedChannel(data: {
	id: string;
	status?: string;
	access_token?: string | null;
	token_expires_at?: Date | null;
}) {
	return prisma.channel.create({
		data: {
			id: data.id,
			user_id: "admin",
			platform: "instagram",
			name: `Channel ${data.id}`,
			token_source: "manual",
			account_id: `acct-${data.id}`,
			status: data.status ?? "active",
			access_token: data.access_token ?? null,
			token_expires_at: data.token_expires_at ?? null,
		},
	});
}

function healthyChannel(id: string) {
	return {
		id,
		status: "active",
		access_token: `token-${id}`,
		token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000),
	};
}

interface SeedPlannerOpts {
	id: string;
	config: string;
	status?: string;
	state?: string | null;
	lastRun?: Date | null;
	channelIds: string[];
}

async function seedPlanner(o: SeedPlannerOpts) {
	await prisma.planner.create({
		data: {
			id: o.id,
			user_id: "admin",
			name: o.id,
			config: o.config,
			state: o.state ?? null,
			status: o.status ?? "active",
			last_run: o.lastRun ?? null,
			channels: o.channelIds.length
				? { connect: o.channelIds.map((id) => ({ id })) }
				: undefined,
		},
	});
}

/** Fetch a planner the way the cron does (include channels). */
async function getPlanner(id: string) {
	const p = await prisma.planner.findFirst({
		where: { id },
		include: { channels: true },
	});
	if (!p) throw new Error(`planner ${id} missing`);
	return p;
}

function makeConfig(extra: Record<string, unknown> = {}) {
	return JSON.stringify({
		frequency: { value: 5, unit: "minutes" },
		sort_order: "old_to_new",
		content: [
			{
				type: "config",
				url: "https://example.com/media.mp4",
				media_type: "REELS",
				caption: "base caption",
			},
		],
		...extra,
	});
}

function countPosts(plannerId: string) {
	return prisma.post.count({ where: { planner_id: plannerId } });
}

async function cleanupScenario(ids: {
	posts?: string[];
	planners?: string[];
	channels?: string[];
}) {
	if (ids.planners?.length)
		await prisma.planner.deleteMany({ where: { id: { in: ids.planners } } });
	if (ids.channels?.length)
		await prisma.channel.deleteMany({ where: { id: { in: ids.channels } } });
}

// ── PL1: atomic claim — concurrent runs never double-create ─────────────────
async function scenarioPL1() {
	await seedChannel(healthyChannel("pl1-c1"));
	await seedChannel(healthyChannel("pl1-c2"));
	await seedPlanner({
		id: "pl1",
		config: makeConfig(),
		channelIds: ["pl1-c1", "pl1-c2"],
	});
	const planner = await getPlanner("pl1");
	const now = new Date();

	const [r1, r2] = await Promise.all([
		runPlannerOnce(prisma, planner, now),
		runPlannerOnce(prisma, planner, now),
	]);

	const okCount = [r1, r2].filter((r) => r.ok).length;
	const alreadyRunning = [r1, r2].filter(
		(r) => r.skipped === "already_running",
	).length;
	const posts = await countPosts("pl1");
	const fresh = await getPlanner("pl1");

	const pass =
		okCount === 1 &&
		alreadyRunning === 1 &&
		posts === 2 &&
		fresh.last_run?.getTime() === now.getTime();
	record(
		"PL1",
		pass,
		`ok=${okCount} already_running=${alreadyRunning} posts=${posts} lastRunAdvanced=${fresh.last_run?.getTime() === now.getTime()} (r1=${r1.ok ? "ok" : r1.skipped}, r2=${r2.ok ? "ok" : r2.skipped})`,
	);
	await cleanupScenario({ planners: ["pl1"], channels: ["pl1-c1", "pl1-c2"] });
}

// ── PL2: temporal gates ─────────────────────────────────────────────────────
async function scenarioPL2() {
	await seedChannel(healthyChannel("pl2-c"));
	// (a) due
	await seedPlanner({
		id: "pl2-due-no",
		config: makeConfig(),
		lastRun: new Date(),
		channelIds: ["pl2-c"],
	});
	const dueNo = await runPlannerOnce(
		prisma,
		await getPlanner("pl2-due-no"),
		new Date(),
	);
	const postsDueNo = await countPosts("pl2-due-no");

	await seedPlanner({
		id: "pl2-due-yes",
		config: makeConfig(),
		lastRun: new Date(Date.now() - 10 * 60_000),
		channelIds: ["pl2-c"],
	});
	const dueYes = await runPlannerOnce(
		prisma,
		await getPlanner("pl2-due-yes"),
		new Date(),
	);
	const postsDueYes = await countPosts("pl2-due-yes");

	// (b) start_time
	const futureISO = new Date(Date.now() + 3600_000).toISOString();
	await seedPlanner({
		id: "pl2-start-future",
		config: makeConfig({ start_time: futureISO }),
		channelIds: ["pl2-c"],
	});
	const stFuture = await runPlannerOnce(
		prisma,
		await getPlanner("pl2-start-future"),
		new Date(),
	);
	const postsStFuture = await countPosts("pl2-start-future");

	await seedPlanner({
		id: "pl2-start-past",
		config: makeConfig({
			start_time: new Date(Date.now() - 3600_000).toISOString(),
		}),
		channelIds: ["pl2-c"],
	});
	const stPast = await runPlannerOnce(
		prisma,
		await getPlanner("pl2-start-past"),
		new Date(),
	);
	const postsStPast = await countPosts("pl2-start-past");

	// (c) sleep — window ACTIVE now (computed in the planner TZ)
	await seedPlanner({
		id: "pl2-sleep-active",
		config: makeConfig({
			sleep_schedule: {
				start: hhmm(addMinutes(new Date(), -1)),
				end: hhmm(addMinutes(new Date(), 1)),
			},
		}),
		channelIds: ["pl2-c"],
	});
	const sleepActive = await runPlannerOnce(
		prisma,
		await getPlanner("pl2-sleep-active"),
		new Date(),
	);
	const postsSleepActive = await countPosts("pl2-sleep-active");

	// (c2) sleep — window INACTIVE now (+6h away)
	await seedPlanner({
		id: "pl2-sleep-inactive",
		config: makeConfig({
			sleep_schedule: {
				start: hhmm(addMinutes(new Date(), 6 * 60)),
				end: hhmm(addMinutes(new Date(), 6 * 60 + 1)),
			},
		}),
		channelIds: ["pl2-c"],
	});
	const sleepInactive = await runPlannerOnce(
		prisma,
		await getPlanner("pl2-sleep-inactive"),
		new Date(),
	);
	const postsSleepInactive = await countPosts("pl2-sleep-inactive");

	const pass =
		dueNo.skipped === "not_due" &&
		postsDueNo === 0 &&
		dueYes.ok &&
		postsDueYes === 1 &&
		stFuture.skipped === "start_time" &&
		postsStFuture === 0 &&
		stPast.ok &&
		postsStPast === 1 &&
		sleepActive.skipped === "sleep" &&
		postsSleepActive === 0 &&
		sleepInactive.ok &&
		postsSleepInactive === 1;
	record(
		"PL2",
		pass,
		`due:${dueNo.skipped}/${postsDueNo}→${dueYes.ok}/${postsDueYes} start:${stFuture.skipped}/${postsStFuture}→${stPast.ok}/${postsStPast} sleep:${sleepActive.skipped}/${postsSleepActive}→${sleepInactive.ok}/${postsSleepInactive}`,
	);
	await cleanupScenario({
		planners: [
			"pl2-due-no",
			"pl2-due-yes",
			"pl2-start-future",
			"pl2-start-past",
			"pl2-sleep-active",
			"pl2-sleep-inactive",
		],
		channels: ["pl2-c"],
	});
}

// ── PL3: config edge cases fail cleanly ─────────────────────────────────────
async function scenarioPL3() {
	await seedChannel(healthyChannel("pl3-c"));

	// invalid_config: config that is a JSON array
	await seedPlanner({
		id: "pl3-arr",
		config: JSON.stringify([1, 2]),
		channelIds: ["pl3-c"],
	});
	const rArr = await runPlannerOnce(
		prisma,
		await getPlanner("pl3-arr"),
		new Date(),
	);

	// invalid frequency value 0 → validation catches it first (invalid_config)
	await seedPlanner({
		id: "pl3-freq0",
		config: makeConfig({ frequency: { value: 0, unit: "minutes" } }),
		channelIds: ["pl3-c"],
	});
	const rFreq0 = await runPlannerOnce(
		prisma,
		await getPlanner("pl3-freq0"),
		new Date(),
	);

	// no_channels
	await seedPlanner({ id: "pl3-noch", config: makeConfig(), channelIds: [] });
	const rNoCh = await runPlannerOnce(
		prisma,
		await getPlanner("pl3-noch"),
		new Date(),
	);

	// resolution_failed: library item that does not exist and no url
	await seedPlanner({
		id: "pl3-res",
		config: JSON.stringify({
			frequency: { value: 5, unit: "minutes" },
			content: [{ type: "library_item", id: "pl3-missing-item" }],
		}),
		channelIds: ["pl3-c"],
	});
	const rRes = await runPlannerOnce(
		prisma,
		await getPlanner("pl3-res"),
		new Date(),
	);

	// unknown template placeholder: NOT rejected — post is created with the
	// literal text (finding: placeholders are not validated).
	await seedPlanner({
		id: "pl3-tpl",
		config: makeConfig({
			caption_templates: ["Hello {unknown_var} and {post_title}"],
			caption_rotation: "sequential",
		}),
		channelIds: ["pl3-c"],
	});
	const rTpl = await runPlannerOnce(
		prisma,
		await getPlanner("pl3-tpl"),
		new Date(),
	);
	const tplPost = rTpl.ok
		? await prisma.post.findFirst({ where: { planner_id: "pl3-tpl" } })
		: null;
	const tplCaption = tplPost?.caption || "";

	const pass =
		rArr.skipped === "invalid_config" &&
		rFreq0.skipped === "invalid_config" &&
		rNoCh.skipped === "no_channels" &&
		rRes.skipped === "resolution_failed" &&
		rTpl.ok &&
		// unknown vars must NOT leak literal braces; known vars still resolve
		!tplCaption.includes("{unknown_var}") &&
		!tplCaption.includes("{") &&
		tplCaption.includes("Hello");
	record(
		"PL3",
		Boolean(pass),
		`arr=${rArr.skipped} freq0=${rFreq0.skipped} noCh=${rNoCh.skipped} res=${rRes.skipped} tpl=ok/caption="${tplCaption.slice(0, 40)}" (unknown vars → "", no literal leak)`,
	);

	// {hashtags} must resolve from the selected content's tags (user-reported
	// bug: was hardcoded "" — tags never appeared in captions).
	const tagsItem = await prisma.contentItem.create({
		data: {
			id: "pl3-tags-item",
			user_id: "admin",
			name: "pl3-tags.mp4",
			type: "video",
			url: "/api/file/admin/pl3-tags.mp4",
			tags: JSON.stringify(["fitness", "dicas", "#marketing"]),
		},
	});
	await seedPlanner({
		id: "pl3-hash",
		config: makeConfig({
			content: [
				{
					type: "library",
					id: tagsItem.id,
					url: "https://example.com/pl3-tags.mp4",
					media_type: "REELS",
				},
			],
			caption_templates: ["{hashtags} | {date}"],
			caption_rotation: "sequential",
		}),
		channelIds: ["pl3-c"],
	});
	const rHash = await runPlannerOnce(
		prisma,
		await getPlanner("pl3-hash"),
		new Date(),
	);
	const hashPost = rHash.ok
		? await prisma.post.findFirst({ where: { planner_id: "pl3-hash" } })
		: null;
	const hashCaption = hashPost?.caption || "";
	const hashOk =
		rHash.ok &&
		hashCaption.includes("#fitness") &&
		hashCaption.includes("#dicas") &&
		hashCaption.includes("#marketing") &&
		!hashCaption.includes("{hashtags}") &&
		!hashCaption.includes("{") &&
		/\d{2}\/\d{2}\/\d{4}/.test(hashCaption);

	// rotation "off" + templates → base caption (runtime semantics preserved).
	await seedPlanner({
		id: "pl3-off",
		config: makeConfig({
			caption_templates: ["OFF-template {hashtags}"],
			caption_rotation: "off",
		}),
		channelIds: ["pl3-c"],
	});
	const rOff = await runPlannerOnce(
		prisma,
		await getPlanner("pl3-off"),
		new Date(),
	);
	const offPost = rOff.ok
		? await prisma.post.findFirst({ where: { planner_id: "pl3-off" } })
		: null;
	const offOk = rOff.ok && offPost?.caption === "base caption";
	record(
		"PL3-hashtags",
		Boolean(hashOk && offOk),
		`hashtags="${hashCaption.slice(0, 50)}" offRotationCaption="${offPost?.caption || ""}" (tags → #tags; rotation off keeps base caption)`,
	);
	await cleanupScenario({
		planners: ["pl3-arr", "pl3-freq0", "pl3-noch", "pl3-res", "pl3-tpl", "pl3-hash", "pl3-off"],
		channels: ["pl3-c"],
	});
	await prisma.contentItem
		.deleteMany({ where: { id: "pl3-tags-item" } })
		.catch(() => {});
}

// ── PL4: template rotation + exhaustion ─────────────────────────────────────
async function scenarioPL4() {
	await seedChannel(healthyChannel("pl4-c1"));
	await seedChannel(healthyChannel("pl4-c2"));
	const templates = ["A-first", "B-second", "C-third"];
	const config = makeConfig({
		caption_templates: templates,
		caption_rotation: "sequential",
	});

	// (a) index 2 → template C, state → 3
	await seedPlanner({
		id: "pl4-a",
		config,
		state: JSON.stringify({ template_index: 2 }),
		channelIds: ["pl4-c1"],
	});
	const ra = await runPlannerOnce(
		prisma,
		await getPlanner("pl4-a"),
		new Date(),
	);
	const postA = await prisma.post.findFirst({ where: { planner_id: "pl4-a" } });
	const stateA = safeState((await getPlanner("pl4-a")).state);

	// (b) index 3 (exhausted) → WRAPS to template A (finding), state → 4
	await seedPlanner({
		id: "pl4-b",
		config,
		state: JSON.stringify({ template_index: 3 }),
		channelIds: ["pl4-c1"],
	});
	const rb = await runPlannerOnce(
		prisma,
		await getPlanner("pl4-b"),
		new Date(),
	);
	const postB = await prisma.post.findFirst({ where: { planner_id: "pl4-b" } });
	const stateB = safeState((await getPlanner("pl4-b")).state);

	// (c) 2 channels, index 1 → posts use templates[1] and [2], state → 3
	await seedPlanner({
		id: "pl4-c",
		config,
		state: JSON.stringify({ template_index: 1 }),
		channelIds: ["pl4-c1", "pl4-c2"],
	});
	const rc = await runPlannerOnce(
		prisma,
		await getPlanner("pl4-c"),
		new Date(),
	);
	const postsC = await prisma.post.findMany({
		where: { planner_id: "pl4-c" },
		orderBy: { created_at: "asc" },
	});
	const stateC = safeState((await getPlanner("pl4-c")).state);

	const pass =
		ra.ok &&
		postA?.caption === "C-third" &&
		stateA.template_index === 3 &&
		rb.ok &&
		postB?.caption === "A-first" &&
		stateB.template_index === 4 &&
		rc.ok &&
		postsC.length === 2 &&
		postsC[0].caption === "B-second" &&
		postsC[1].caption === "C-third" &&
		stateC.template_index === 3;
	record(
		"PL4",
		pass,
		`idx2→"${postA?.caption}"(state ${stateA.template_index}) idx3(exhausted)→"${postB?.caption}"(state ${stateB.template_index}, WRAP documented) 2ch→["${postsC[0]?.caption}","${postsC[1]?.caption}"](state ${stateC.template_index})`,
	);
	await cleanupScenario({
		planners: ["pl4-a", "pl4-b", "pl4-c"],
		channels: ["pl4-c1", "pl4-c2"],
	});
}

// ── PL5: channel health filtering ───────────────────────────────────────────
async function scenarioPL5() {
	await seedChannel(healthyChannel("pl5-ok"));
	await seedChannel({
		id: "pl5-off",
		status: "inactive",
		access_token: "token-pl5-off",
	});
	await seedChannel({
		id: "pl5-exp",
		status: "active",
		access_token: "token-pl5-exp",
		token_expires_at: new Date(Date.now() - 3600_000),
	});

	await seedPlanner({
		id: "pl5",
		config: makeConfig({
			caption_templates: ["T {date}"],
			caption_rotation: "sequential",
		}),
		channelIds: ["pl5-ok", "pl5-off", "pl5-exp"],
	});
	const r = await runPlannerOnce(prisma, await getPlanner("pl5"), new Date());
	const posts = await prisma.post.findMany({ where: { planner_id: "pl5" } });
	const state = safeState((await getPlanner("pl5")).state);
	const postedChannelIds = posts.map((p) => p.channel_id);

	// all-blocked case
	await seedPlanner({
		id: "pl5-none",
		config: makeConfig(),
		channelIds: ["pl5-off", "pl5-exp"],
	});
	const rNone = await runPlannerOnce(
		prisma,
		await getPlanner("pl5-none"),
		new Date(),
	);

	const pass =
		r.ok &&
		posts.length === 1 &&
		postedChannelIds[0] === "pl5-ok" &&
		state.template_index === 1 &&
		rNone.skipped === "no_publishable_channels";
	record(
		"PL5",
		pass,
		`ok created=${posts.length} channels=[${postedChannelIds}] template_index=${state.template_index} allBlocked=${rNone.skipped}`,
	);
	await cleanupScenario({
		planners: ["pl5", "pl5-none"],
		channels: ["pl5-ok", "pl5-off", "pl5-exp"],
	});
}

// ── PL6: post-claim failure reverts the claim ───────────────────────────────
async function scenarioPL6() {
	await seedChannel(healthyChannel("pl6-c"));
	const original = new Date(Date.now() - 10 * 60_000); // due
	await seedPlanner({
		id: "pl6",
		config: makeConfig(),
		lastRun: original,
		channelIds: ["pl6-c"],
	});

	// Wrapped client: real delegate everywhere, but $transaction throws once
	// (simulates a DB failure AFTER the atomic claim and BEFORE posts persist).
	let throws = true;
	const wrapped = {
		...prisma,
		$transaction: async (...args: unknown[]) => {
			if (throws) {
				throws = false;
				throw new Error("simulated transaction failure");
			}
			// Passthrough (unreachable in this scenario): first call always throws.
			return (prisma.$transaction as (...a: unknown[]) => Promise<unknown>)(
				...args,
			);
		},
	} as typeof prisma;

	const r1 = await runPlannerOnce(wrapped, await getPlanner("pl6"), new Date());
	const afterFail = await getPlanner("pl6");
	const postsAfterFail = await countPosts("pl6");

	// The revert must restore last_run so the next run is NOT 'already_running'.
	const r2 = await runPlannerOnce(prisma, afterFail, new Date());
	const postsFinal = await countPosts("pl6");

	const pass =
		r1.ok === false &&
		r1.error?.includes("simulated") === true &&
		afterFail.last_run?.getTime() === original.getTime() &&
		postsAfterFail === 0 &&
		r2.ok &&
		postsFinal === 1;
	record(
		"PL6",
		pass,
		`fail=${r1.ok === false}/reverted=${afterFail.last_run?.getTime() === original.getTime()}/postsAfter=${postsAfterFail} nextRun=${r2.ok ? "ok" : r2.skipped}/postsFinal=${postsFinal}`,
	);
	await cleanupScenario({ planners: ["pl6"], channels: ["pl6-c"] });
}

// ── Main ────────────────────────────────────────────────────────────────────
const scenarios: [string, () => Promise<void>][] = [
	["PL1", scenarioPL1],
	["PL2", scenarioPL2],
	["PL3", scenarioPL3],
	["PL4", scenarioPL4],
	["PL5", scenarioPL5],
	["PL6", scenarioPL6],
];

let failed = 0;
await seedUser();
for (const [label, fn] of scenarios) {
	try {
		await fn();
		await sleep(50);
	} catch (err) {
		failed++;
		resultsTotal.push({
			scenario: label,
			pass: false,
			line: `EXCEPTION: ${(err as Error)?.message || String(err)}`,
		});
		console.error(
			`SCENARIO ${label}: EXCEPTION — ${(err as Error)?.stack || err}`,
		);
	}
}
console.log("\n=== SUMMARY (direct) ===");
for (const r of resultsTotal)
	console.log(`${r.scenario}: ${r.pass ? "PASS" : "FAIL"} — ${r.line}`);
const anyPass = resultsTotal.filter((r) => r.pass).length;
await prisma.$disconnect();
process.exit(failed > 0 || anyPass !== resultsTotal.length ? 1 : 0);
