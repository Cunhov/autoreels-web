#!/usr/bin/env node
/**
 * Planners gauntlet — HTTP/integration scenario PL7 (fix-planners + cron tick).
 *
 * Drives the RUNNING standalone app (see planner-run.sh):
 *   1. Seed a broken planner: status 'error' + double-stringified config.
 *   2. GET /api/admin/fix-planners (dry-run) → diagnosis flags it.
 *   3. GET /api/admin/fix-planners?fix=true → status fixed to active, config unwrapped.
 *   4. POST /api/cron/publisher (Phase 0) with a permissive IG mock → the fixed
 *      planner runs and creates posts.
 * PL8 (wizard) lives in planner-visual.mjs; PL1-PL6 (direct) in planner-direct.mts.
 *
 * Usage:
 *   node planner-scenarios.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --cron-secret <CRON_SECRET> --mock-state <file> --mock-calls <file>
 *        --server-log <log> --out <dir>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { encode } from "next-auth/jwt";
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
const CRON_SECRET = getArg("--cron-secret");
const MOCK_STATE = getArg("--mock-state");
const MOCK_CALLS = getArg("--mock-calls");
const SERVER_LOG = getArg("--server-log");
const OUT_DIR = getArg("--out");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--cron-secret", CRON_SECRET],
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

const resultsTotal = [];

function record(label, pass, line, detail = {}) {
	resultsTotal.push({ scenario: label, pass, line, detail });
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
}

async function req(path, { method = "GET", headers = {} } = {}) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: {
			"x-admin-secret": CRON_SECRET,
			"x-cron-auth": CRON_SECRET,
			...headers,
		},
	});
	let json = null;
	try {
		json = await res.json();
	} catch {
		/* non-JSON */
	}
	return { status: res.status, ok: res.ok, json };
}

function writeMockRules(rules) {
	writeFileSync(MOCK_STATE, JSON.stringify({ rules, consumed: {} }));
}

function logTail() {
	if (!existsSync(SERVER_LOG)) return "";
	return readFileSync(SERVER_LOG, "utf8");
}

const SESSION_COOKIE = `next-auth.session-token=${await encode({
	token: { sub: "admin" },
	secret: SECRET,
	maxAge: 3600,
})}`;

// PL8-API — the planner WIZARD's default payload must be accepted.
// The wizard always sends `start_time: ""` when "Start When?" is left empty;
// the server currently rejects it with "start_time deve ser uma data ISO válida"
// (findings: the DEFAULT wizard flow can neither create nor edit a planner).
async function scenarioPL8Api() {
	const wizardPayload = {
		name: "pl8-api-probe",
		channel_ids: [],
		config: {
			frequency: { value: 5, unit: "minutes" },
			timezone: "America/Sao_Paulo",
			start_time: "",
			sleep_schedule: null,
			sort_order: "random_loop",
			caption_templates: [],
			caption_rotation: "off",
			content: [],
		},
	};
	const res = await fetch(`${BASE}/api/planners`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: SESSION_COOKIE },
		body: JSON.stringify(wizardPayload),
	});
	let json = null;
	try {
		json = await res.json();
	} catch {
		/* non-JSON */
	}
	const detail = json?.details || [];
	const pass = res.status === 200 && !!json?.id; // the wizard payload must be accepted
	record(
		"PL8-API",
		pass,
		`wizard default payload (start_time:"") → HTTP ${res.status} ${res.status === 400 ? `details=${JSON.stringify(detail)}` : "accepted"} — pre-fix this FAILS: the wizard cannot save without an explicit start time`,
		{ status: res.status, detail },
	);
	if (pass) {
		await prisma.planner.deleteMany({ where: { id: json.id } }).catch(() => {});
	}
}

async function seedUser() {
	await prisma.user.upsert({
		where: { id: "admin" },
		update: {},
		create: { id: "admin", email: "admin@test.local", name: "admin" },
	});
}

// ── PL7: fix-planners regression guard ──────────────────────────────────────
async function scenarioPL7() {
	await prisma.channel.create({
		data: {
			id: "pl7-c",
			user_id: "admin",
			platform: "instagram",
			name: "PL7 Channel",
			token_source: "manual",
			account_id: "acct-pl7",
			status: "active",
			access_token: "token-pl7", // token_* → refresh query skips it
			token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000),
		},
	});
	const validConfig = {
		frequency: { value: 5, unit: "minutes" },
		sort_order: "old_to_new",
		content: [
			{
				type: "config",
				url: "https://example.com/pl7.mp4",
				media_type: "REELS",
				caption: "pl7 caption",
			},
		],
	};
	await prisma.planner.create({
		data: {
			id: "pl7",
			user_id: "admin",
			name: "PL7 Broken",
			status: "error", // broken status the fixer must reset to active
			config: JSON.stringify(JSON.stringify(validConfig)), // double-stringified
			channels: { connect: [{ id: "pl7-c" }] },
		},
	});

	// (1) dry-run diagnosis
	const dry = await req("/api/admin/fix-planners");
	const dryPl7 = (dry.json?.planners || []).find((p) => p.id === "pl7");
	const dryOk =
		dry.status === 200 &&
		dry.json?.total >= 1 &&
		dry.json?.by_status?.other >= 1 &&
		dryPl7?.is_double_stringified === true;

	// (2) apply the fix
	const fix = await req("/api/admin/fix-planners?fix=true");
	const fixedCount =
		typeof fix.json?.fixed_count === "number" ? fix.json.fixed_count : 0;

	// (3) verify the planner is fixed
	const fixedPlanner = await prisma.planner.findFirst({ where: { id: "pl7" } });
	const configNow = JSON.parse(fixedPlanner.config || "{}");
	const configIsObject =
		configNow && typeof configNow === "object" && !Array.isArray(configNow);
	const fixedOk =
		fixedPlanner.status === "active" &&
		configIsObject &&
		configNow.frequency?.value === 5;

	// (4) permissive IG mock + one cron tick → Phase 0 must run the planner
	writeMockRules([
		{
			match: "media_publish",
			method: "POST",
			responses: [{ body: { id: "ig-pub-pl7" } }],
		},
		{
			match: "/media",
			method: "POST",
			responses: [{ body: { id: "ig-media-pl7" } }],
		},
		{
			match: "fields=status_code",
			method: "GET",
			responses: [{ body: { status_code: "FINISHED" } }],
		},
		{
			matchRegex: "refresh_access_token|oauth/access_token",
			responses: [{ body: { access_token: "IGtok", expires_in: 7776000 } }],
		},
	]);
	const tick = await fetch(`${BASE}/api/cron/publisher`, {
		method: "POST",
		headers: { "x-cron-auth": CRON_SECRET },
	}).then(async (r) => ({
		status: r.status,
		json: await r.json().catch(() => null),
	}));
	const posts = await prisma.post.findMany({ where: { planner_id: "pl7" } });
	const pl7After = await prisma.planner.findFirst({ where: { id: "pl7" } });
	const tickOk =
		tick.status === 200 && posts.length >= 1 && !!pl7After.last_run;

	// (5) no accidental real-IG calls, no ChannelRefresh spam, no crashes
	const log = logTail();
	const unmatched = (log.match(/UNMATCHED_MOCK/g) || []).length;
	const refreshSpam = (log.match(/\[ChannelRefresh\]/g) || []).length;
	const crashes = (log.match(/Unhandled|TypeError/g) || []).length;
	const cleanLogOk = unmatched === 0 && refreshSpam === 0 && crashes === 0;

	const pass =
		dryOk && fix.ok && fixedCount >= 1 && fixedOk && tickOk && cleanLogOk;
	record(
		"PL7",
		pass,
		`dry=${dry.status}/flagged=${dryPl7?.is_double_stringified} fix=${fix.status}/count=${fixedCount} fixedStatus=${fixedPlanner.status}/configObject=${configIsObject} tick=${tick.status}/posts=${posts.length}/lastRun=${!!pl7After.last_run} unmatched=${unmatched} refreshLines=${refreshSpam} crashes=${crashes}`,
		{
			dryOk,
			fixedCount,
			posts: posts.length,
			unmatched,
			refreshSpam,
			crashes,
		},
	);
	await prisma.post.deleteMany({ where: { planner_id: "pl7" } });
	await prisma.planner.deleteMany({ where: { id: "pl7" } });
	await prisma.channel.deleteMany({ where: { id: "pl7-c" } });
}

// ── PL8b: wizard "Preview next run" must use the SAME caption semantics as the
// runtime — unknown {placeholder} → '' (commit 66adae3 stripped them in the
// runtime but the preview route kept them LITERAL: visible inconsistency).
async function scenarioPL8bPreview() {
	await prisma.planner.create({
		data: {
			id: "pl8b",
			user_id: "admin",
			name: "PL8b Preview",
			status: "active",
			config: JSON.stringify({
				frequency: { value: 5, unit: "minutes" },
				timezone: "America/Sao_Paulo",
				sort_order: "random_loop",
				start_time: "",
				sleep_schedule: null,
				caption_templates: ["Hello {unknown_var} and {date}!"],
				caption_rotation: "sequential",
				content: [
					{
						type: "config",
						url: "https://example.com/pl8b.mp4",
						media_type: "REELS",
						caption: "base",
					},
				],
			}),
			state: null,
		},
	});
	const res = await fetch(`${BASE}/api/planners/pl8b/preview`, {
		headers: { Cookie: SESSION_COOKIE },
	});
	let json = null;
	try {
		json = await res.json();
	} catch {
		/* non-JSON */
	}
	const caption = json?.runtime?.caption ?? "";
	const noBracesLeft = !caption.includes("{") && !caption.includes("}");
	const knownResolved = caption.startsWith("Hello  and ");
	const pass =
		res.status === 200 && noBracesLeft && knownResolved;
	record(
		"PL8b",
		pass,
		`preview caption="${caption}" → 200=${res.status === 200} bracesStripped=${noBracesLeft} knownResolved=${knownResolved} — pre-fix the preview kept {unknown_var} LITERAL while the runtime stripped it`,
		{ status: res.status, caption },
	);
	await prisma.planner.deleteMany({ where: { id: "pl8b" } }).catch(() => {});
}

// ── PL3b: sleep start == end is a never-sleeping window (isSleepingNow is
// always false) — the server must reject it like the wizard does (pre-fix this
// rule existed only client-side).
async function scenarioPL3bSleep() {
	const payload = {
		name: "pl3b-sleep-probe",
		channel_ids: [],
		config: {
			frequency: { value: 5, unit: "minutes" },
			timezone: "America/Sao_Paulo",
			start_time: "",
			sleep_schedule: { start: "10:00", end: "10:00" },
			sort_order: "random_loop",
			caption_templates: [],
			caption_rotation: "off",
			content: [],
		},
	};
	const res = await fetch(`${BASE}/api/planners`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: SESSION_COOKIE },
		body: JSON.stringify(payload),
	});
	let json = null;
	try {
		json = await res.json();
	} catch {
		/* non-JSON */
	}
	const details = Array.isArray(json?.details) ? json.details : [];
	const rejected =
		res.status === 400 &&
		details.includes("Sleep start and end must be different times.");
	const pass = rejected;
	record(
		"PL3b",
		pass,
		`sleep start==end → HTTP ${res.status} details=${JSON.stringify(details)} — pre-fix the server accepted the never-sleeping window (wizard-only check)`,
		{ status: res.status, details },
	);
}

// ── Main ────────────────────────────────────────────────────────────────────
await seedUser();
try {
	await scenarioPL7();
} catch (err) {
	resultsTotal.push({
		scenario: "PL7",
		pass: false,
		line: `EXCEPTION: ${err?.message || String(err)}`,
	});
	console.error(`SCENARIO PL7: EXCEPTION — ${err?.stack || err}`);
}
try {
	await scenarioPL8Api();
} catch (err) {
	resultsTotal.push({
		scenario: "PL8-API",
		pass: false,
		line: `EXCEPTION: ${err?.message || String(err)}`,
	});
	console.error(`SCENARIO PL8-API: EXCEPTION — ${err?.stack || err}`);
}
try {
	await scenarioPL8bPreview();
} catch (err) {
	resultsTotal.push({
		scenario: "PL8b",
		pass: false,
		line: `EXCEPTION: ${err?.message || String(err)}`,
	});
	console.error(`SCENARIO PL8b: EXCEPTION — ${err?.stack || err}`);
}
try {
	await scenarioPL3bSleep();
} catch (err) {
	resultsTotal.push({
		scenario: "PL3b",
		pass: false,
		line: `EXCEPTION: ${err?.message || String(err)}`,
	});
	console.error(`SCENARIO PL3b: EXCEPTION — ${err?.stack || err}`);
}
console.log("\n=== SUMMARY (scenarios) ===");
for (const r of resultsTotal)
	console.log(`${r.scenario}: ${r.pass ? "PASS" : "FAIL"} — ${r.line}`);
const anyPass = resultsTotal.filter((r) => r.pass).length;
await prisma.$disconnect();
process.exit(anyPass !== resultsTotal.length ? 1 : 0);
