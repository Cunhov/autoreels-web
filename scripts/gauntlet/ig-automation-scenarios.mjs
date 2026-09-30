#!/usr/bin/env node
/**
 * IG Automation gauntlet scenario runner — G1..G15 (spec docs/IG_AUTOMATION_SPEC.md §15)
 * + G16..G19 (regressões dos fixes do crítico: echo do bot, SSRF outbound, simulador
 * com draft, throttle multi-ação + outbound action.sent/sequence.step).
 *
 * Drives a RUNNING standalone app (see ig-boot.sh) whose Instagram Graph + OpenRouter
 * calls are intercepted by scripts/gauntlet/fetch-mock.mjs (preload). NO product fixes:
 * all setup is done by seeding the DB directly (better-sqlite3, same pattern as
 * publisher-scenarios.mjs) plus authenticated API calls with a minted NextAuth JWT.
 *
 * Time simulation: `run_at`/`next_run_at` are edited in the DB (better-sqlite3) and
 * `POST /api/cron/automation` (x-cron-auth) drains jobs/enrollments — no long sleeps.
 *
 * G12 is two-branch: with `--openrouter-key` the mocked OpenRouter reply is asserted;
 * without it (second boot phase) the no-key failure path is asserted.
 *
 * Usage:
 *    node ig-automation-scenarios.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --ig-secret <INSTAGRAM_CLIENT_SECRET>
 *        --verify-token <META_WEBHOOK_VERIFY_TOKEN> --cron-secret <CRON_SECRET>
 *        --ig-client-id <INSTAGRAM_CLIENT_ID> --mock-state <state.json>
 *        --mock-calls <calls.jsonl> --server-log <server.log> --out <dir>
 *        [--public-base <url>] [--openrouter-key <key>] [--scenarios G1,G2,...]
 *
 * Exit code 0 only if every selected scenario passes. Any call to a mocked host that
 * does not match a rule (kind "unmatched") fails the scenario with UNMATCHED_MOCK.
 */
import {
	appendFileSync,
	writeFileSync,
	readFileSync,
	existsSync,
	renameSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { encode } from "next-auth/jwt";

// ── Config ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (key) => {
	const i = argv.indexOf(key);
	return i >= 0 ? argv[i + 1] : null;
};
const BASE = getArg("--base");
const DB_PATH = getArg("--db");
const SECRET = getArg("--secret");
const IG_SECRET = getArg("--ig-secret");
const VERIFY_TOKEN = getArg("--verify-token");
const CRON_SECRET = getArg("--cron-secret");
const MOCK_STATE = getArg("--mock-state");
const MOCK_CALLS = getArg("--mock-calls");
const SERVER_LOG = getArg("--server-log");
const OUT_DIR = getArg("--out");
const PUBLIC_BASE = (getArg("--public-base") || BASE || "").replace(/\/+$/, "");
const OPENROUTER_KEY = getArg("--openrouter-key");
const SCENARIOS_ARG = getArg("--scenarios");
// G16(a): `message.app_id` que o produto compara com INSTAGRAM_CLIENT_ID (env do servidor).
const IG_CLIENT_ID = getArg("--ig-client-id");

for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--ig-secret", IG_SECRET],
	["--verify-token", VERIFY_TOKEN],
	["--cron-secret", CRON_SECRET],
	["--ig-client-id", IG_CLIENT_ID],
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
mkdirSync(OUT_DIR, { recursive: true });

const prisma = new PrismaClient({
	adapter: new PrismaBetterSqlite3({ url: "file:" + DB_PATH }),
});
const ADMIN_COOKIE = `next-auth.session-token=${await encode({
	token: { sub: "admin" },
	secret: SECRET,
	maxAge: 3600,
})}`;
const USER2_COOKIE = `next-auth.session-token=${await encode({
	token: { sub: "user2" },
	secret: SECRET,
	maxAge: 3600,
})}`;

// ── Small helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeState(rules) {
	const consumed = {};
	rules.forEach((_, i) => (consumed[i] = 0));
	const tmp = `${MOCK_STATE}.tmp`;
	writeFileSync(tmp, JSON.stringify({ rules, consumed }));
	renameSync(tmp, MOCK_STATE);
}

function readCallsRaw() {
	if (!existsSync(MOCK_CALLS)) return [];
	return readFileSync(MOCK_CALLS, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

// The calls file is shared by all scenarios AND both boot phases: each scenario
// appends a marker ({kind:"scenario",name}) and reads are scoped after it, so the
// persisted evidence covers the whole run.
let callsMark = { lineIndex: -1, name: null };

function markScenario(name) {
	const all = readCallsRaw();
	appendFileSync(
		MOCK_CALLS,
		JSON.stringify({ ts: Date.now(), kind: "scenario", name }) + "\n",
	);
	callsMark = { lineIndex: all.length, name };
}

function readCalls() {
	const all = readCallsRaw();
	if (callsMark.lineIndex < 0) return all;
	return all.slice(callsMark.lineIndex + 1);
}

function countCalls({ kind, method, urlIncludes, urlRegex, status } = {}) {
	return readCalls().filter((call) => {
		if (kind && call.kind !== kind) return false;
		if (method && call.method !== method) return false;
		if (urlIncludes && !call.url.includes(urlIncludes)) return false;
		if (urlRegex && !new RegExp(urlRegex).test(call.url)) return false;
		if (status !== undefined && call.status !== status) return false;
		return true;
	}).length;
}

function lastCall(filter = {}) {
	const matching = readCalls().filter((call) => {
		if (filter.kind && call.kind !== filter.kind) return false;
		if (filter.method && call.method !== filter.method) return false;
		if (filter.urlIncludes && !call.url.includes(filter.urlIncludes)) return false;
		if (filter.status !== undefined && call.status !== filter.status) return false;
		return true;
	});
	return matching.length > 0 ? matching[matching.length - 1] : null;
}

function parseBody(call) {
	if (!call || typeof call.body !== "string" || call.body === "") return null;
	try {
		return JSON.parse(call.body);
	} catch {
		return null;
	}
}

function hmacHex(secret, data) {
	return createHmac("sha256", secret).update(data).digest("hex");
}

async function waitFor(fn, { timeoutMs = 8000, intervalMs = 60, label = "" } = {}) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			if (await fn()) return true;
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}
	if (lastError) {
		console.error(`  waitFor timeout (${label}): ${lastError.message}`);
	} else {
		console.error(`  waitFor timeout: ${label}`);
	}
	return false;
}

let results = [];

function record(label, pass, line, detail = {}) {
	const unmatched = countCalls({ kind: "unmatched" });
	if (unmatched > 0) {
		pass = false;
		line += ` | UNMATCHED_MOCK=${unmatched}`;
	}
	results.push({ scenario: label, pass, line, detail });
	try {
		writeFileSync(
			join(OUT_DIR, `calls-${label}.jsonl`),
			readCalls()
				.map((call) => JSON.stringify(call))
				.join("\n"),
		);
	} catch {
		/* non-fatal: summary remains the source of truth */
	}
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
	if (!pass) {
		// Diagnóstico acionável no summary.txt do boot (stdout+stderr capturados).
		try {
			console.error(`  detail ${label}: ${JSON.stringify(detail).slice(0, 900)}`);
		} catch {
			/* detail não-serializável não derruba o runner */
		}
	}
}

async function req(
	path,
	{
		method = "GET",
		body,
		cookie = ADMIN_COOKIE,
		headers = {},
		redirect = "follow",
		timeoutMs = 60_000,
	} = {},
) {
	const finalHeaders = {
		...(body !== undefined ? { "content-type": "application/json" } : {}),
		...headers,
	};
	if (cookie) finalHeaders.Cookie = cookie;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${BASE}${path}`, {
			method,
			headers: finalHeaders,
			body,
			redirect,
			signal: controller.signal,
		});
		const text = await res.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* non-JSON body */
		}
		return {
			status: res.status,
			ok: res.ok,
			json,
			text,
			location: res.headers.get("location") || "",
		};
	} finally {
		clearTimeout(timer);
	}
}

// ── Webhook payloads / signatures ───────────────────────────────────────────

function signRaw(rawBody) {
	return `sha256=${hmacHex(IG_SECRET, rawBody)}`;
}

function commentBody(accountId, { commentId, fromId, username, text, mediaId }) {
	return {
		object: "instagram",
		entry: [
			{
				id: accountId,
				time: Date.now(),
				changes: [
					{
						field: "comments",
						value: {
							id: commentId,
							text,
							from: { id: fromId, username },
							media: { id: mediaId },
						},
					},
				],
			},
		],
	};
}

function dmBody(accountId, { mid, fromId, username, text, isEcho = false }) {
	const message = { mid, text };
	if (isEcho) message.is_echo = true;
	return {
		object: "instagram",
		entry: [
			{
				id: accountId,
				time: Date.now(),
				messaging: [
					{
						sender: { id: fromId, username },
						recipient: { id: accountId },
						timestamp: Date.now(),
						message,
					},
				],
			},
		],
	};
}

/**
 * Echo de mensagem: `sender` é a conta business; o contato é o `recipient`
 * (parser atual usa o recipient quando difere do canal). `appId` replica
 * `message.app_id` (nosso app) e `senderId` permite payloads invertidos.
 */
function echoBody(
	accountId,
	{ mid, contactId, contactUsername, appId, text, senderId },
) {
	const message = { mid, text, is_echo: true };
	if (appId) message.app_id = appId;
	return {
		object: "instagram",
		entry: [
			{
				id: accountId,
				time: Date.now(),
				messaging: [
					{
						sender: { id: senderId ?? accountId, username: "gauntlet_bot" },
						recipient: { id: contactId, username: contactUsername },
						timestamp: Date.now(),
						message,
					},
				],
			},
		],
	};
}

async function postWebhook(body, { signature } = {}) {
	const raw = JSON.stringify(body);
	const sig = signature === undefined ? signRaw(raw) : signature;
	const headers = { "content-type": "application/json" };
	if (sig) headers["x-hub-signature-256"] = sig;
	const res = await fetch(`${BASE}/api/webhooks/instagram`, {
		method: "POST",
		headers,
		body: raw,
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* plain text response */
	}
	return { status: res.status, json, text };
}

async function cronTick() {
	const res = await fetch(`${BASE}/api/cron/automation`, {
		method: "POST",
		headers: { "x-cron-auth": CRON_SECRET },
		signal: AbortSignal.timeout(120_000),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* non-JSON */
	}
	return { status: res.status, json, text };
}

// ── Mock rules / seeds ──────────────────────────────────────────────────────

function rule(urlSub, responses, method = "POST", extra = {}) {
	return {
		...(urlSub ? { match: urlSub } : {}),
		...(method ? { method } : {}),
		responses,
		...extra,
	};
}

const okId = (id, extra = {}) => ({ status: 200, body: { id, ...extra } });

/**
 * Webhook de saída: host público com DNS válido (o guard SSRF do produto resolve
 * DNS antes do fetch; `mock-webhook.invalid` não resolve e é bloqueado). O
 * fetch-mock intercepta `example.org` como `kind:"notify"` (body+headers).
 */
const OUTBOUND_WEBHOOK_URL = "https://example.org/hook";

async function seedUser(id) {
	await prisma.user.upsert({
		where: { id },
		update: {},
		create: { id, email: `${id}@test.local`, name: id },
	});
}

async function seedChannel({
	id,
	accountId,
	username,
	userId = "admin",
	token = "IGGauntletToken",
}) {
	await prisma.channel.create({
		data: {
			id,
			user_id: userId,
			name: `chan-${id}`,
			platform: "instagram",
			access_token: token,
			token_source: "manual",
			token_refreshed_at: new Date(Date.now() - 60_000),
			token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000),
			account_id: accountId,
			username,
			status: "active",
		},
	});
}

async function seedAutomation({
	id,
	channelId,
	userId = "admin",
	name,
	priority = 0,
	trigger = "dm",
	keywords = [],
	matchMode = "any",
	matchType = "contains",
	negativeKeywords = null,
	mediaIds = null,
	firstInteractionOnly = false,
	cooldownHours = null,
	dailyLimit = null,
	quietHours = null,
	settings = null,
	enabled = true,
	actions = [],
}) {
	await prisma.igAutomation.create({
		data: {
			id,
			user_id: userId,
			channel_id: channelId,
			name,
			enabled,
			priority,
			trigger,
			keywords: JSON.stringify(keywords),
			match_mode: matchMode,
			match_type: matchType,
			negative_keywords:
				negativeKeywords === null ? null : JSON.stringify(negativeKeywords),
			media_ids: mediaIds === null ? null : JSON.stringify(mediaIds),
			first_interaction_only: firstInteractionOnly,
			cooldown_hours: cooldownHours,
			daily_limit: dailyLimit,
			quiet_hours: quietHours === null ? null : JSON.stringify(quietHours),
			settings: settings === null ? null : JSON.stringify(settings),
		},
	});
	let position = 0;
	for (const action of actions) {
		await prisma.igAutomationAction.create({
			data: {
				id: action.id,
				automation_id: id,
				position: action.position ?? position,
				type: action.type,
				delay_seconds: action.delaySeconds ?? 0,
				text_variants: action.text ? JSON.stringify(action.text) : null,
				buttons: action.buttons ? JSON.stringify(action.buttons) : null,
				quick_replies: action.quickReplies
					? JSON.stringify(action.quickReplies)
					: null,
				media_url: action.mediaUrl ?? null,
				tag: action.tag ?? null,
				sequence_id: action.sequenceId ?? null,
				webhook_id: action.webhookId ?? null,
				ai_prompt: action.aiPrompt ?? null,
				config: action.config ? JSON.stringify(action.config) : null,
			},
		});
		position++;
	}
}

async function cleanupChannel(channelId) {
	if (!channelId) return;
	try {
		const automations = await prisma.igAutomation.findMany({
			where: { channel_id: channelId },
			select: { id: true },
		});
		const automationIds = automations.map((automation) => automation.id);
		await prisma.igJob.deleteMany({ where: { channel_id: channelId } });
		await prisma.igActionLog.deleteMany({ where: { channel_id: channelId } });
		await prisma.igEvent.deleteMany({ where: { channel_id: channelId } });
		await prisma.igSequenceEnrollment.deleteMany({
			where: { channel_id: channelId },
		});
		if (automationIds.length > 0) {
			await prisma.igAutomationAction.deleteMany({
				where: { automation_id: { in: automationIds } },
			});
		}
		await prisma.igSequence.deleteMany({ where: { channel_id: channelId } });
		if (automationIds.length > 0) {
			await prisma.igAutomation.deleteMany({
				where: { id: { in: automationIds } },
			});
		}
		await prisma.igContact.deleteMany({ where: { channel_id: channelId } });
		await prisma.igChannelState.deleteMany({ where: { channel_id: channelId } });
		await prisma.igClick.deleteMany({ where: { channel_id: channelId } });
		await prisma.channel.deleteMany({ where: { id: channelId } });
	} catch (error) {
		console.error(`  cleanup ${channelId} falhou: ${error?.message || error}`);
	}
}

const getEvent = (dedupeKey) =>
	prisma.igEvent.findUnique({ where: { dedupe_key: dedupeKey } });
const getContact = (channelId, igUserId) =>
	prisma.igContact.findUnique({
		where: { channel_id_ig_user_id: { channel_id: channelId, ig_user_id: igUserId } },
	});

// ── G1 — GET verify ok/inválido ─────────────────────────────────────────────
async function scenarioG1() {
	const challenge = "gauntlet-challenge-123";
	const ok = await fetch(
		`${BASE}/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
			VERIFY_TOKEN,
		)}&hub.challenge=${challenge}`,
	);
	const okBody = await ok.text();
	const badToken = await fetch(
		`${BASE}/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=x`,
	);
	const noMode = await fetch(
		`${BASE}/api/webhooks/instagram?hub.challenge=x&hub.verify_token=${encodeURIComponent(
			VERIFY_TOKEN,
		)}`,
	);
	const pass =
		ok.status === 200 &&
		okBody === challenge &&
		badToken.status === 403 &&
		noMode.status === 403;
	record(
		"G1",
		pass,
		`ok=${ok.status}/"${okBody.slice(0, 24)}" tokenErrado=${badToken.status} semMode=${noMode.status}`,
	);
}

// ── G2 — assinatura inválida → 401 e zero IgEvent ───────────────────────────
async function scenarioG2() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g2",
			accountId: "acct-g2",
			username: "gauntlet_g2",
		});
		const before = await prisma.igEvent.count();
		const body = commentBody("acct-g2", {
			commentId: "cmp-g2-1",
			fromId: "u-g2",
			username: "user_g2",
			text: "oi",
			mediaId: "media-g2",
		});
		const badSig = await postWebhook(body, {
			signature: `sha256=${"ab".repeat(32)}`,
		});
		const noSig = await fetch(`${BASE}/api/webhooks/instagram`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const after = await prisma.igEvent.count();
		const pass =
			badSig.status === 401 && noSig.status === 401 && after === before;
		record(
			"G2",
			pass,
			`assinaturaInvalida=${badSig.status} semAssinatura=${noSig.status} events=${before}→${after}`,
			{ errorBad: badSig.json?.error, errorNone: noSig.status },
		);
	} finally {
		await cleanupChannel("ig-chan-g2");
	}
}

// ── G3 — comentário válido → private reply + job do reply público; replay ───
async function scenarioG3() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g3",
			accountId: "acct-g3",
			username: "gauntlet_g3",
		});
		await seedAutomation({
			id: "auto-g3",
			channelId: "ig-chan-g3",
			name: "G3 comentário",
			trigger: "comment",
			keywords: ["quero"],
			actions: [
				{
					id: "act-g3-private",
					type: "private_reply",
					position: 0,
					text: ["Oi! Te chamei no direct."],
				},
				{
					id: "act-g3-public",
					type: "public_comment_reply",
					position: 1,
					delaySeconds: 5,
					text: ["Respondi no seu direct 🚀"],
				},
			],
		});
		writeState([
			rule("acct-g3/messages", [okId("mid-g3-private")], "POST"),
			rule("cmp-g3-1/replies", [okId("mid-g3-public")], "POST"),
		]);
		const body = commentBody("acct-g3", {
			commentId: "cmp-g3-1",
			fromId: "u-g3",
			username: "user_g3",
			text: "quero o link",
			mediaId: "media-g3",
		});
		const first = await postWebhook(body);
		const processed = await waitFor(
			async () => {
				const logs = await prisma.igActionLog.count({
					where: {
						channel_id: "ig-chan-g3",
						action_type: "private_reply",
						status: "sent",
					},
				});
				const jobs = await prisma.igJob.count({
					where: { channel_id: "ig-chan-g3" },
				});
				return logs >= 1 && jobs >= 1;
			},
			{ label: "private reply sent + job enfileirado" },
		);
		const privateCalls = countCalls({
			method: "POST",
			urlIncludes: "acct-g3/messages",
		});
		const replyCalls = countCalls({
			method: "POST",
			urlIncludes: "cmp-g3-1/replies",
		});
		const eventRow = await getEvent("comment:cmp-g3-1");
		const jobs = await prisma.igJob.findMany({
			where: { channel_id: "ig-chan-g3" },
		});
		const job = jobs[0];
		const privateCall = lastCall({
			method: "POST",
			urlIncludes: "acct-g3/messages",
		});
		const privateBody = parseBody(privateCall);
		// Delay de 5s agendado a partir do processamento do evento (privateCall.ts é o
		// relógio do engine) + job ainda no futuro: imune à latência do polling.
		const jobDeltaMs = privateCall
			? job.run_at.getTime() - privateCall.ts
			: -1;
		const step1 =
			first.status === 200 &&
			first.json?.stored === 1 &&
			processed &&
			eventRow?.status === "matched" &&
			eventRow?.automation_id === "auto-g3" &&
			privateCalls === 1 &&
			replyCalls === 0 &&
			jobs.length === 1 &&
			job.type === "action" &&
			jobDeltaMs >= 4000 &&
			job.run_at.getTime() > Date.now() + 500 &&
			job.payload.includes("act-g3-public") &&
			privateBody?.recipient?.comment_id === "cmp-g3-1";

		const callsBeforeReplay = readCalls().length;
		const replay = await postWebhook(body);
		await sleep(700);
		const eventCount = await prisma.igEvent.count({
			where: { dedupe_key: "comment:cmp-g3-1" },
		});
		const jobsAfterReplay = await prisma.igJob.count({
			where: { channel_id: "ig-chan-g3" },
		});
		const step2 =
			replay.status === 200 &&
			replay.json?.duplicates === 1 &&
			replay.json?.stored === 0 &&
			eventCount === 1 &&
			jobsAfterReplay === 1 &&
			readCalls().length === callsBeforeReplay;

		await prisma.igJob.updateMany({
			where: { channel_id: "ig-chan-g3", status: "pending" },
			data: { run_at: new Date(Date.now() - 1000) },
		});
		const cron = await cronTick();
		const delivered = await waitFor(
			() =>
				countCalls({ method: "POST", urlIncludes: "cmp-g3-1/replies" }) === 1,
			{ label: "reply público entregue" },
		);
		const replyBody = parseBody(
			lastCall({ method: "POST", urlIncludes: "cmp-g3-1/replies" }),
		);
		const jobDone = await prisma.igJob.count({
			where: { channel_id: "ig-chan-g3", status: "done" },
		});
		const step3 =
			cron.status === 200 &&
			delivered &&
			jobDone === 1 &&
			typeof replyBody?.message === "string" &&
			replyBody.message.includes("Respondi no seu direct");

		record(
			"G3",
			step1 && step2 && step3,
			`stored=${first.json?.stored} private=${privateCalls} job=${jobs.length} jobDelta=${jobDeltaMs}ms replayDup=${replay.json?.duplicates} replyCalls=${replyCalls} jobDone=${jobDone}`,
			{
				step1,
				step2,
				step3,
				firstStatus: first.status,
				firstStored: first.json?.stored,
				privateCommentId: privateBody?.recipient?.comment_id,
				eventStatus: eventRow?.status,
				eventAutomation: eventRow?.automation_id,
				jobType: job?.type,
				jobPayloadHasAction: job?.payload?.includes("act-g3-public"),
				jobRunAtDeltaMs: jobDeltaMs,
				jobRunAtInFutureMs: job ? job.run_at.getTime() - Date.now() : null,
				callsBeforeReplay,
				callsAfterReplay: readCalls().length,
				replayReceived: replay.json?.received,
				replayStored: replay.json?.stored,
				replayDuplicates: replay.json?.duplicates,
				eventCount,
				jobsAfterReplay,
				cronStatus: cron.status,
				delivered,
				jobDone,
				replyMessage: replyBody?.message,
			},
		);
	} finally {
		await cleanupChannel("ig-chan-g3");
	}
}

// ── G4 — DM keyword / echo pausa 24h / DM na pausa ──────────────────────────
async function scenarioG4() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g4",
			accountId: "acct-g4",
			username: "gauntlet_g4",
		});
		await seedAutomation({
			id: "auto-g4",
			channelId: "ig-chan-g4",
			name: "G4 dm",
			trigger: "dm",
			keywords: ["oi"],
			actions: [
				{
					id: "act-g4-dm",
					type: "dm_text",
					position: 0,
					text: ["Olá {username}!"],
				},
			],
		});
		writeState([rule("acct-g4/messages", [okId("mid-g4-1")], "POST")]);

		const dm1 = await postWebhook(
			dmBody("acct-g4", {
				mid: "mid-g4-1",
				fromId: "u-g4",
				username: "user_g4",
				text: "oi",
			}),
		);
		const sent1 = await waitFor(
			async () => {
				const contact = await getContact("ig-chan-g4", "u-g4");
				return (
					countCalls({ method: "POST", urlIncludes: "acct-g4/messages" }) >= 1 &&
					contact?.interactions_count === 1
				);
			},
			{ label: "DM 1 entregue" },
		);
		const contactAfterDm = await getContact("ig-chan-g4", "u-g4");

		const echo = await postWebhook(
			dmBody("acct-g4", {
				mid: "echo-g4-1",
				fromId: "u-g4",
				username: "user_g4",
				text: "resposta humana",
				isEcho: true,
			}),
		);
		const paused = await waitFor(
			async () => {
				const contact = await getContact("ig-chan-g4", "u-g4");
				return (
					contact?.bot_paused_until !== null &&
					contact.bot_paused_until.getTime() > Date.now() + 23 * 3600_000
				);
			},
			{ label: "contato pausado pelo echo" },
		);
		const echoEvent = await getEvent("message:echo-g4-1");
		const contactPaused = await getContact("ig-chan-g4", "u-g4");
		const callsAfterEcho = countCalls({
			urlIncludes: "acct-g4/messages",
		});

		const dm2 = await postWebhook(
			dmBody("acct-g4", {
				mid: "mid-g4-2",
				fromId: "u-g4",
				username: "user_g4",
				text: "oi de novo",
			}),
		);
		const blocked = await waitFor(
			async () => {
				const event = await getEvent("message:mid-g4-2");
				return event !== null && ["paused", "skipped"].includes(event.status);
			},
			{ label: "DM durante pausa sem envio" },
		);
		const event2 = await getEvent("message:mid-g4-2");
		const totalCalls = countCalls({ urlIncludes: "acct-g4/messages" });

		const pass =
			dm1.status === 200 &&
			sent1 &&
			contactAfterDm?.interactions_count === 1 &&
			echo.status === 200 &&
			echoEvent?.kind === "echo" &&
			echoEvent?.status === "paused" &&
			paused &&
			callsAfterEcho === 1 &&
			dm2.status === 200 &&
			blocked &&
			totalCalls === 1 &&
			(event2?.error || "").includes("bot_pause") &&
			(event2?.status === "paused" || event2?.status === "skipped");
		record(
			"G4",
			pass,
			`dm1Calls=${sent1} interactions=${contactAfterDm?.interactions_count} echo=${echoEvent?.status} pausedUntil=${contactPaused?.bot_paused_until?.toISOString()} dm2=${event2?.status} totalCalls=${totalCalls}`,
			{ error2: event2?.error },
		);
	} finally {
		await cleanupChannel("ig-chan-g4");
	}
}

// ── G5 — cooldown 24h ───────────────────────────────────────────────────────
async function scenarioG5() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g5",
			accountId: "acct-g5",
			username: "gauntlet_g5",
		});
		await seedAutomation({
			id: "auto-g5",
			channelId: "ig-chan-g5",
			name: "G5 cooldown",
			trigger: "dm",
			keywords: ["preco"],
			actions: [
				{
					id: "act-g5-dm",
					type: "dm_text",
					position: 0,
					text: ["Preço: R$ 10"],
				},
			],
		});
		writeState([
			rule("acct-g5/messages", [
				okId("mid-g5-1"),
				{ status: 200, body: { id: "mid-g5-never" } },
			]),
		]);

		await postWebhook(
			dmBody("acct-g5", {
				mid: "mid-g5-1",
				fromId: "u-g5",
				username: "user_g5",
				text: "qual o preco?",
			}),
		);
		const firstSent = await waitFor(
			async () =>
				(await prisma.igActionLog.count({
					where: { channel_id: "ig-chan-g5", status: "sent" },
				})) >= 1,
			{ label: "primeiro envio" },
		);
		const callsAfterFirst = countCalls({
			method: "POST",
			urlIncludes: "acct-g5/messages",
		});

		await postWebhook(
			dmBody("acct-g5", {
				mid: "mid-g5-2",
				fromId: "u-g5",
				username: "user_g5",
				text: "e o preco de novo?",
			}),
		);
		const blocked = await waitFor(
			async () => {
				const event = await getEvent("message:mid-g5-2");
				return event !== null && event.status === "skipped";
			},
			{ label: "segundo evento bloqueado no cooldown" },
		);
		const event2 = await getEvent("message:mid-g5-2");
		const callsAfterSecond = countCalls({
			method: "POST",
			urlIncludes: "acct-g5/messages",
		});
		const pass =
			firstSent &&
			callsAfterFirst === 1 &&
			blocked &&
			callsAfterSecond === 1 &&
			(event2?.error || "").includes("cooldown");
		record(
			"G5",
			pass,
			`calls=${callsAfterFirst}→${callsAfterSecond} evento2=${event2?.status}/${event2?.error?.slice(0, 60)}`,
		);
	} finally {
		await cleanupChannel("ig-chan-g5");
	}
}

// ── G6 — quiet hours ────────────────────────────────────────────────────────
function quietWindowAroundNow() {
	const now = new Date();
	const hours = now.getUTCHours();
	const minutes = now.getUTCMinutes();
	const fmt = (h) => {
		const wrapped = ((h % 24) + 24) % 24;
		return `${String(wrapped).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
	};
	return { start: fmt(hours - 2), end: fmt(hours + 2), tz: "UTC" };
}

async function scenarioG6() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g6",
			accountId: "acct-g6",
			username: "gauntlet_g6",
		});
		const quiet = quietWindowAroundNow();
		await seedAutomation({
			id: "auto-g6",
			channelId: "ig-chan-g6",
			name: "G6 quiet",
			trigger: "dm",
			keywords: ["oi"],
			quietHours: quiet,
			actions: [
				{
					id: "act-g6-dm",
					type: "dm_text",
					position: 0,
					text: ["não deveria enviar"],
				},
			],
		});
		writeState([rule("acct-g6/messages", [okId("mid-g6")], "POST")]);

		await postWebhook(
			dmBody("acct-g6", {
				mid: "mid-g6-1",
				fromId: "u-g6",
				username: "user_g6",
				text: "oi",
			}),
		);
		const blocked = await waitFor(
			async () => {
				const event = await getEvent("message:mid-g6-1");
				return event !== null && event.status === "skipped";
			},
			{ label: "evento bloqueado no quiet hours" },
		);
		const event = await getEvent("message:mid-g6-1");
		const calls = countCalls({ urlIncludes: "acct-g6/messages" });
		const jobs = await prisma.igJob.count({ where: { channel_id: "ig-chan-g6" } });
		const pass =
			blocked &&
			calls === 0 &&
			jobs === 0 &&
			(event?.error || "").includes("quiet_hours");
		record(
			"G6",
			pass,
			`janela=${quiet.start}-${quiet.end} ${quiet.tz} status=${event?.status} calls=${calls} jobs=${jobs}`,
			{ error: event?.error },
		);
	} finally {
		await cleanupChannel("ig-chan-g6");
	}
}

// ── G7 — media_ids + first_interaction_only ─────────────────────────────────
async function scenarioG7() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g7",
			accountId: "acct-g7",
			username: "gauntlet_g7",
		});
		await seedAutomation({
			id: "auto-g7-media",
			channelId: "ig-chan-g7",
			name: "G7 media",
			priority: 10,
			trigger: "comment",
			keywords: [],
			mediaIds: ["media-a"],
			actions: [
				{
					id: "act-g7-a",
					type: "private_reply",
					position: 0,
					text: ["A ok"],
				},
			],
		});
		await seedAutomation({
			id: "auto-g7-first",
			channelId: "ig-chan-g7",
			name: "G7 primeira interação",
			priority: 5,
			trigger: "comment",
			keywords: [],
			firstInteractionOnly: true,
			actions: [
				{
					id: "act-g7-b",
					type: "private_reply",
					position: 0,
					text: ["B ok"],
				},
			],
		});
		writeState([
			rule("acct-g7/messages", [
				okId("mid-g7-b"),
				okId("mid-g7-c"),
				okId("mid-g7-a"),
			]),
		]);

		// 1) media-b + contato novo → só a automação de primeira interação casa
		await postWebhook(
			commentBody("acct-g7", {
				commentId: "cmp-g7-1",
				fromId: "u-g7a",
				username: "user_g7a",
				text: "oi",
				mediaId: "media-b",
			}),
		);
		const firstSent = await waitFor(
			async () => {
				const contact = await getContact("ig-chan-g7", "u-g7a");
				return (
					(await prisma.igActionLog.count({
						where: {
							channel_id: "ig-chan-g7",
							automation_id: "auto-g7-first",
							status: "sent",
						},
					})) >= 1 && contact?.interactions_count === 1
				);
			},
			{ label: "primeira interação entregue" },
		);
		const event1 = await getEvent("comment:cmp-g7-1");

		// 2) mesma pessoa de novo → first_interaction_only bloqueia (media-gate falha de novo)
		await postWebhook(
			commentBody("acct-g7", {
				commentId: "cmp-g7-2",
				fromId: "u-g7a",
				username: "user_g7a",
				text: "oi de novo",
				mediaId: "media-b",
			}),
		);
		const firstBlocked = await waitFor(
			async () => {
				const event = await getEvent("comment:cmp-g7-2");
				return event !== null && event.status === "skipped";
			},
			{ label: "segunda interação bloqueada" },
		);
		let gateLog = null;
		await waitFor(
			async () => {
				gateLog = await prisma.igActionLog.findFirst({
					where: {
						channel_id: "ig-chan-g7",
						automation_id: "auto-g7-first",
						action_type: "gate",
						status: "skipped",
					},
					orderBy: { created_at: "desc" },
				});
				return (gateLog?.error || "").includes("first_interaction_only");
			},
			{ label: "gate log first_interaction_only" },
		);

		// 3) post da lista (media-a) + contato novo → automação de media_ids casa
		await postWebhook(
			commentBody("acct-g7", {
				commentId: "cmp-g7-3",
				fromId: "u-g7b",
				username: "user_g7b",
				text: "oi",
				mediaId: "media-a",
			}),
		);
		const mediaSent = await waitFor(
			async () =>
				(await prisma.igActionLog.count({
					where: {
						channel_id: "ig-chan-g7",
						automation_id: "auto-g7-media",
						status: "sent",
					},
				})) >= 1,
			{ label: "post da lista entregue" },
		);
		const totalCalls = countCalls({
			method: "POST",
			urlIncludes: "acct-g7/messages",
		});
		const bodies = readCalls()
			.filter(
				(call) =>
					call.method === "POST" && call.url.includes("acct-g7/messages"),
			)
			.map((call) => call.body);
		const bSent = bodies.some((body) => body.includes("B ok"));
		const aSent = bodies.some((body) => body.includes("A ok"));

		const pass =
			firstSent &&
			event1?.automation_id === "auto-g7-first" &&
			firstBlocked &&
			(gateLog?.error || "").includes("first_interaction_only") &&
			mediaSent &&
			totalCalls === 2 &&
			bSent &&
			aSent;
		record(
			"G7",
			pass,
			`evento1=${event1?.automation_id} evento2=${firstBlocked ? "skipped" : "?"} gate="${gateLog?.error}" evento3=${mediaSent ? "media-ok" : "?"} sends=${totalCalls} (B=${bSent}, A=${aSent})`,
		);
	} finally {
		await cleanupChannel("ig-chan-g7");
	}
}

// ── G8 — substância renderizada do catálogo ─────────────────────────────────
async function scenarioG8() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g8",
			accountId: "acct-g8",
			username: "gauntlet_g8",
		});
		await prisma.igSubstance.create({
			data: {
				id: "sub-g8",
				user_id: null,
				keyword: "creatina",
				name: "Creatina",
				keywords: JSON.stringify(["creapure"]),
				description: "aminoácido",
				action: "força",
				dosage: "5g",
				duration: "30 dias",
				url: "https://url.test/creatina",
			},
		});
		await seedAutomation({
			id: "auto-g8",
			channelId: "ig-chan-g8",
			name: "G8 substância",
			trigger: "comment",
			keywords: [],
			settings: { substanceCatalog: true },
			actions: [
				{
					id: "act-g8-private",
					type: "private_reply",
					position: 0,
					text: [
						"{substancia.nome} — {substancia.dosagem} — {substancia.url}",
					],
				},
			],
		});
		writeState([rule("acct-g8/messages", [okId("mid-g8")], "POST")]);

		await postWebhook(
			commentBody("acct-g8", {
				commentId: "cmp-g8-1",
				fromId: "u-g8",
				username: "user_g8",
				text: "quero creatina",
				mediaId: "media-g8",
			}),
		);
		const delivered = await waitFor(
			() =>
				countCalls({ method: "POST", urlIncludes: "acct-g8/messages" }) >= 1,
			{ label: "private reply com substância" },
		);
		const body = parseBody(
			lastCall({ method: "POST", urlIncludes: "acct-g8/messages" }),
		);
		const text = body?.message?.text || "";
		const expected = "Creatina — 5g — https://url.test/creatina";
		const pass = delivered && text === expected;
		record("G8", pass, `texto="${text}"`, { expected });
	} finally {
		await prisma.igSubstance.deleteMany({ where: { id: "sub-g8" } });
		await cleanupChannel("ig-chan-g8");
	}
}

// ── G9 — sequência: enrollment + passo quando due ───────────────────────────
async function scenarioG9() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g9",
			accountId: "acct-g9",
			username: "gauntlet_g9",
		});
		await prisma.igSequence.create({
			data: {
				id: "seq-g9",
				user_id: "admin",
				channel_id: "ig-chan-g9",
				name: "G9 sequência",
				steps: JSON.stringify([
					{ delay_seconds: 0, type: "dm_text", text_variants: ["Passo 1"] },
					{ delay_seconds: 3600, type: "dm_text", text_variants: ["Passo 2"] },
				]),
			},
		});
		await seedAutomation({
			id: "auto-g9",
			channelId: "ig-chan-g9",
			name: "G9 start sequence",
			trigger: "dm",
			keywords: ["sequencia"],
			actions: [
				{
					id: "act-g9-seq",
					type: "start_sequence",
					position: 0,
					sequenceId: "seq-g9",
				},
			],
		});
		writeState([
			rule("acct-g9/messages", [
				okId("mid-g9-p1"),
				{ status: 200, body: { id: "mid-g9-p2" } },
			]),
		]);

		await postWebhook(
			dmBody("acct-g9", {
				mid: "mid-g9-1",
				fromId: "u-g9",
				username: "user_g9",
				text: "quero sequencia",
			}),
		);
		const enrolled = await waitFor(
			async () =>
				(await prisma.igSequenceEnrollment.count({
					where: { sequence_id: "seq-g9" },
				})) >= 1,
			{ label: "enrollment criado" },
		);
		const enrollment = await prisma.igSequenceEnrollment.findFirst({
			where: { sequence_id: "seq-g9" },
		});
		const step0 =
			enrolled &&
			enrollment?.status === "active" &&
			enrollment?.current_step === 0 &&
			enrollment?.next_run_at !== null &&
			enrollment.next_run_at.getTime() <= Date.now() + 2000 &&
			countCalls({ urlIncludes: "acct-g9/messages" }) === 0;

		const cron1 = await cronTick();
		const step1Delivered = await waitFor(
			async () => {
				const row = await prisma.igSequenceEnrollment.findFirst({
					where: { sequence_id: "seq-g9" },
				});
				return (
					row?.current_step === 1 &&
					countCalls({ method: "POST", urlIncludes: "acct-g9/messages" }) === 1
				);
			},
			{ label: "passo 1 entregue" },
		);
		const afterStep1 = await prisma.igSequenceEnrollment.findFirst({
			where: { sequence_id: "seq-g9" },
		});
		const body1 = parseBody(
			lastCall({ method: "POST", urlIncludes: "acct-g9/messages" }),
		);
		const step1 =
			cron1.status === 200 &&
			step1Delivered &&
			body1?.message?.text === "Passo 1" &&
			afterStep1?.status === "active" &&
			afterStep1.next_run_at.getTime() > Date.now() + 3500_000;

		// passo 2 NÃO é entregue antes de vencer
		const cron2 = await cronTick();
		await sleep(400);
		const callsBeforeAdvance = countCalls({
			method: "POST",
			urlIncludes: "acct-g9/messages",
		});
		const step2NotEarly = cron2.status === 200 && callsBeforeAdvance === 1;

		// avança o relógio do enrollment e drena de novo
		await prisma.igSequenceEnrollment.updateMany({
			where: { sequence_id: "seq-g9" },
			data: { next_run_at: new Date(Date.now() - 1000) },
		});
		const cron3 = await cronTick();
		const step2Delivered = await waitFor(
			async () => {
				const row = await prisma.igSequenceEnrollment.findFirst({
					where: { sequence_id: "seq-g9" },
				});
				return (
					row?.status === "done" &&
					countCalls({ method: "POST", urlIncludes: "acct-g9/messages" }) === 2
				);
			},
			{ label: "passo 2 entregue e enrollment done" },
		);
		const body2 = parseBody(
			lastCall({ method: "POST", urlIncludes: "acct-g9/messages" }),
		);
		const finalRow = await prisma.igSequenceEnrollment.findFirst({
			where: { sequence_id: "seq-g9" },
		});
		const step2 =
			cron3.status === 200 &&
			step2Delivered &&
			finalRow?.status === "done" &&
			body2?.message?.text === "Passo 2";

		const pass = step0 && step1 && step2NotEarly && step2;
		record(
			"G9",
			pass,
			`enrollment=${enrollment?.status}/step${enrollment?.current_step} cron1=${step1Delivered ? "ok" : "?"} noEarly=${step2NotEarly} final=${finalRow?.status} calls=${countCalls({ urlIncludes: "acct-g9/messages" })}`,
			{ step0, step1, step2NotEarly, step2, cron2: cron2.json },
		);
	} finally {
		await cleanupChannel("ig-chan-g9");
	}
}

// ── G10 — /r/[slug] 302 + UTM + contador ────────────────────────────────────
async function scenarioG10() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g10",
			accountId: "acct-g10",
			username: "gauntlet_g10",
		});
		await seedAutomation({
			id: "auto-g10",
			channelId: "ig-chan-g10",
			name: "G10 link",
			trigger: "dm",
			keywords: ["link"],
			actions: [
				{
					id: "act-g10-dm",
					type: "dm_buttons",
					position: 0,
					text: ["Confira:"],
					buttons: [
						{
							type: "web_url",
							title: "Abrir",
							url: "https://target.test/landing?x=1",
						},
					],
				},
			],
		});
		writeState([rule("acct-g10/messages", [okId("mid-g10")], "POST")]);

		await postWebhook(
			dmBody("acct-g10", {
				mid: "mid-g10-1",
				fromId: "u-g10",
				username: "user_g10",
				text: "manda o link",
			}),
		);
		const delivered = await waitFor(
			() =>
				countCalls({ method: "POST", urlIncludes: "acct-g10/messages" }) >= 1,
			{ label: "DM com botão" },
		);
		const callBody = parseBody(
			lastCall({ method: "POST", urlIncludes: "acct-g10/messages" }),
		);
		const trackedUrl =
			callBody?.message?.attachment?.payload?.buttons?.[0]?.url || "";
		const click = await prisma.igClick.findFirst({
			where: { automation_id: "auto-g10" },
		});
		const trackedOk =
			click !== null &&
			trackedUrl === `${PUBLIC_BASE}/r/${click.slug}` &&
			click.target_url === "https://target.test/landing?x=1" &&
			click.utm_source === "instagram" &&
			click.utm_medium === "dm" &&
			click.utm_campaign === "auto-g10";

		let redirectStatus = 0;
		let location = "";
		let clickAfter = click;
		if (click) {
			const res = await fetch(`${BASE}/r/${click.slug}`, {
				redirect: "manual",
			});
			redirectStatus = res.status;
			location = res.headers.get("location") || "";
			await waitFor(
				async () => {
					clickAfter = await prisma.igClick.findUnique({
						where: { id: click.id },
					});
					return clickAfter?.clicks === 1;
				},
				{ label: "contador de clique" },
			);
		}
		const automation = await prisma.igAutomation.findUnique({
			where: { id: "auto-g10" },
		});
		let locationOk = false;
		if (location) {
			const parsed = new URL(location);
			locationOk =
				parsed.origin + parsed.pathname ===
					"https://target.test/landing" &&
				parsed.searchParams.get("x") === "1" &&
				parsed.searchParams.get("utm_source") === "instagram" &&
				parsed.searchParams.get("utm_medium") === "dm" &&
				parsed.searchParams.get("utm_campaign") === "auto-g10";
		}
		const pass =
			delivered &&
			trackedOk &&
			redirectStatus === 302 &&
			locationOk &&
			clickAfter?.clicks === 1 &&
			clickAfter?.last_click_at !== null &&
			automation?.stats_clicks === 1;
		record(
			"G10",
			pass,
			`tracked=${trackedOk} status=${redirectStatus} location="${location.slice(0, 90)}" clicks=${clickAfter?.clicks} stats=${automation?.stats_clicks}`,
			{ trackedUrl, location },
		);
	} finally {
		await cleanupChannel("ig-chan-g10");
	}
}

// ── G11 — outbound webhook assinado ─────────────────────────────────────────
async function scenarioG11() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g11",
			accountId: "acct-g11",
			username: "gauntlet_g11",
		});
		const webhookSecret = "whsec-gauntlet";
		await prisma.igOutboundWebhook.create({
			data: {
				id: "wh-g11",
				user_id: "admin",
				channel_id: null,
				name: "G11 outbound",
				url: OUTBOUND_WEBHOOK_URL,
				secret: webhookSecret,
				events: JSON.stringify(["comment.matched"]),
				enabled: true,
			},
		});
		await seedAutomation({
			id: "auto-g11",
			channelId: "ig-chan-g11",
			name: "G11 webhook",
			trigger: "comment",
			keywords: ["webhook"],
			actions: [
				{
					id: "act-g11-wh",
					type: "outbound_webhook",
					position: 0,
					webhookId: "wh-g11",
					text: ["webhook ok {username}"],
				},
			],
		});
		writeState([]);

		await postWebhook(
			commentBody("acct-g11", {
				commentId: "cmp-g11-1",
				fromId: "u-g11",
				username: "user_g11",
				text: "dispara webhook",
				mediaId: "media-g11",
			}),
		);
		const delivered = await waitFor(
			() => countCalls({ kind: "notify" }) >= 1,
			{ label: "webhook de saída" },
		);
		const notify = lastCall({ kind: "notify" });
		const payload = parseBody(notify);
		const expectedSignature = `sha256=${hmacHex(webhookSecret, notify?.body || "")}`;
		const signatureOk =
			notify?.headers?.["x-autoreels-signature"] === expectedSignature;
		const eventHeaderOk =
			notify?.headers?.["x-autoreels-event"] === "comment.matched";
		const payloadOk =
			payload?.event === "comment.matched" &&
			payload?.automationId === "auto-g11" &&
			payload?.channelId === "ig-chan-g11" &&
			payload?.contact?.igUserId === "u-g11" &&
			payload?.text === "webhook ok user_g11" &&
			payload?.mediaId === "media-g11" &&
			typeof payload?.ts === "string";
		const logSent = await waitFor(
			async () =>
				(await prisma.igActionLog.count({
					where: {
						channel_id: "ig-chan-g11",
						action_type: "outbound_webhook",
						status: "sent",
					},
				})) >= 1,
			{ label: "log outbound sent" },
		);
		const pass =
			delivered &&
			signatureOk &&
			eventHeaderOk &&
			payloadOk &&
			logSent &&
			notify.method === "POST";
		record(
			"G11",
			pass,
			`notify=${delivered} sig=${signatureOk} eventHeader=${eventHeaderOk} payload=${payloadOk} log=${logSent}`,
			{ payload, sig: notify?.headers?.["x-autoreels-signature"], expectedSignature },
		);
	} finally {
		await prisma.igOutboundWebhook.deleteMany({ where: { id: "wh-g11" } });
		await cleanupChannel("ig-chan-g11");
	}
}

// ── G12 — IA (OpenRouter mockado) / sem chave → failed claro ────────────────
async function scenarioG12() {
	if (OPENROUTER_KEY) {
		return scenarioG12WithKey();
	}
	return scenarioG12WithoutKey();
}

async function scenarioG12WithKey() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g12",
			accountId: "acct-g12",
			username: "gauntlet_g12",
		});
		await seedAutomation({
			id: "auto-g12",
			channelId: "ig-chan-g12",
			name: "G12 IA com chave",
			trigger: "dm",
			keywords: ["ia"],
			actions: [
				{
					id: "act-g12-ai",
					type: "ai_reply",
					position: 0,
					aiPrompt: "responda ao cliente",
				},
			],
		});
		writeState([
			rule("openrouter.ai", [
				{
					status: 200,
					body: {
						choices: [{ message: { content: "Olá do mock IA" } }],
					},
				},
			]),
			rule("acct-g12/messages", [okId("mid-g12")], "POST"),
		]);

		await postWebhook(
			dmBody("acct-g12", {
				mid: "mid-g12-1",
				fromId: "u-g12",
				username: "user_g12",
				text: "aciona ia",
			}),
		);
		const aiCalled = await waitFor(
			() =>
				countCalls({ method: "POST", urlIncludes: "openrouter.ai" }) >= 1,
			{ label: "chamada ao OpenRouter mockado" },
		);
		const dmDelivered = await waitFor(
			() =>
				countCalls({ method: "POST", urlIncludes: "acct-g12/messages" }) >= 1,
			{ label: "DM com o texto da IA" },
		);
		const openrouterCall = lastCall({
			method: "POST",
			urlIncludes: "openrouter.ai",
		});
		const body = parseBody(
			lastCall({ method: "POST", urlIncludes: "acct-g12/messages" }),
		);
		const logSent = await waitFor(
			async () =>
				(await prisma.igActionLog.count({
					where: {
						channel_id: "ig-chan-g12",
						action_type: "ai_reply",
						status: "sent",
					},
				})) >= 1,
			{ label: "log ai_reply sent" },
		);
		const pass =
			aiCalled &&
			dmDelivered &&
			logSent &&
			openrouterCall?.status === 200 &&
			body?.message?.text === "Olá do mock IA";
		record(
			"G12",
			pass,
			`(com chave) openrouter=${aiCalled ? 1 : 0} dmTexto="${body?.message?.text}" log=${logSent}`,
			{ openrouterBody: openrouterCall?.body?.slice(0, 160) },
		);
	} finally {
		await cleanupChannel("ig-chan-g12");
	}
}

async function scenarioG12WithoutKey() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g12b",
			accountId: "acct-g12b",
			username: "gauntlet_g12b",
		});
		await seedAutomation({
			id: "auto-g12b",
			channelId: "ig-chan-g12b",
			name: "G12 IA sem chave",
			trigger: "dm",
			keywords: ["ia"],
			actions: [
				{
					id: "act-g12b-ai",
					type: "ai_reply",
					position: 0,
					aiPrompt: "responda ao cliente",
				},
			],
		});
		writeState([rule("acct-g12b/messages", [okId("mid-g12b")], "POST")]);

		await postWebhook(
			dmBody("acct-g12b", {
				mid: "mid-g12b-1",
				fromId: "u-g12b",
				username: "user_g12b",
				text: "aciona ia",
			}),
		);
		// Erro de configuração é PERMANENTE (`isPermanentActionError` inclui
		// "não configurad"/"nao configurad"): o evento termina `failed` com o
		// motivo claro e NÃO há job de retry (bar G12).
		let failedLog = null;
		let event = null;
		const settled = await waitFor(
			async () => {
				failedLog = await prisma.igActionLog.findFirst({
					where: {
						channel_id: "ig-chan-g12b",
						action_type: "ai_reply",
						status: "failed",
					},
					orderBy: { created_at: "desc" },
				});
				event = await getEvent("message:mid-g12b-1");
				return failedLog !== null && event?.status === "failed";
			},
			{ label: "evento failed sem chave" },
		);
		const retryJob = await prisma.igJob.findFirst({
			where: { channel_id: "ig-chan-g12b", type: "action" },
		});
		const openrouterCalls = countCalls({
			method: "POST",
			urlIncludes: "openrouter.ai",
		});
		const dmCalls = countCalls({
			method: "POST",
			urlIncludes: "acct-g12b/messages",
		});
		const pass =
			settled &&
			(event?.error || "").includes("OPENROUTER_API_KEY") &&
			(failedLog?.error || "").includes("OPENROUTER_API_KEY") &&
			retryJob === null &&
			openrouterCalls === 0 &&
			dmCalls === 0;
		record(
			"G12",
			pass,
			`(sem chave) evento=${event?.status} log="${failedLog?.error?.slice(0, 64)}" retryJob=${retryJob ? "SIM" : "nao"} openrouterCalls=${openrouterCalls} dmCalls=${dmCalls}`,
			{
				eventStatus: event?.status,
				eventError: event?.error?.slice(0, 120),
				retryJob: retryJob?.payload?.slice(0, 120) ?? null,
			},
		);
	} finally {
		await cleanupChannel("ig-chan-g12b");
	}
}

// ── G13 — subscription /me/subscribed_apps + estado persistido ──────────────
async function scenarioG13() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g13",
			accountId: "acct-g13",
			username: "gauntlet_g13",
		});
		writeState([
			rule("me/subscribed_apps", [{ status: 200, body: { success: true } }], "POST"),
			rule(
				"me/subscribed_apps",
				[
					{
						status: 200,
						body: {
							data: [
								{
									subscribed_fields: [
										"comments",
										"messages",
										"messaging_postbacks",
									],
								},
							],
						},
					},
				],
				"GET",
			),
		]);

		const res = await req("/api/ig/webhook-status", {
			method: "POST",
			body: JSON.stringify({ channelId: "ig-chan-g13" }),
		});
		const postCall = lastCall({
			method: "POST",
			urlIncludes: "me/subscribed_apps",
		});
		const expectedQuery =
			"subscribed_fields=comments%2Cmessages%2Cmessaging_postbacks";
		const state = await prisma.igChannelState.findUnique({
			where: { channel_id: "ig-chan-g13" },
		});
		const stateFields = state?.subscribed_fields
			? JSON.parse(state.subscribed_fields)
			: [];
		const fields = Array.isArray(res.json?.fields) ? res.json.fields : [];
		const pass =
			res.status === 200 &&
			res.json?.status === "ok" &&
			fields.includes("comments") &&
			fields.includes("messages") &&
			fields.includes("messaging_postbacks") &&
			postCall !== null &&
			postCall.method === "POST" &&
			postCall.url.includes(expectedQuery) &&
			state?.status === "ok" &&
			stateFields.includes("comments") &&
			stateFields.includes("messages") &&
			stateFields.includes("messaging_postbacks");
		record(
			"G13",
			pass,
			`status=${res.json?.status} fields=[${fields.join(",")}] postQuery=${postCall?.url?.includes(expectedQuery) ? "ok" : "?"} state=${state?.status}`,
			{ postUrl: postCall?.url, stateFields },
		);
	} finally {
		await cleanupChannel("ig-chan-g13");
	}
}

// ── G14 — auth 401 sem sessão + scoping entre users ─────────────────────────
async function scenarioG14() {
	try {
		await seedUser("admin");
		await seedUser("user2");
		await seedChannel({
			id: "ig-chan-g14-admin",
			accountId: "acct-g14-admin",
			username: "gauntlet_g14_admin",
		});
		await seedAutomation({
			id: "auto-g14-admin",
			channelId: "ig-chan-g14-admin",
			name: "G14 admin",
			trigger: "dm",
			keywords: ["x"],
			actions: [
				{ id: "act-g14-admin", type: "dm_text", position: 0, text: ["x"] },
			],
		});
		const adminContact = await prisma.igContact.create({
			data: {
				id: "contact-g14-admin",
				user_id: "admin",
				channel_id: "ig-chan-g14-admin",
				ig_user_id: "u-g14-admin",
				username: "user_g14_admin",
			},
		});
		await seedChannel({
			id: "ig-chan-g14-user2",
			accountId: "acct-g14-user2",
			username: "gauntlet_g14_user2",
			userId: "user2",
		});
		await seedAutomation({
			id: "auto-g14-user2",
			channelId: "ig-chan-g14-user2",
			userId: "user2",
			name: "G14 user2",
			trigger: "dm",
			keywords: ["x"],
			actions: [
				{ id: "act-g14-user2", type: "dm_text", position: 0, text: ["x"] },
			],
		});
		await prisma.igContact.create({
			data: {
				id: "contact-g14-user2",
				user_id: "user2",
				channel_id: "ig-chan-g14-user2",
				ig_user_id: "u-g14-user2",
				username: "user_g14_user2",
			},
		});

		// (a) sem sessão → 401
		const unauth = await Promise.all([
			req("/api/automations", { cookie: null }),
			req("/api/ig/contacts", { cookie: null }),
			req("/api/ig/settings", { cookie: null }),
			req("/api/ig/webhook-status", { cookie: null }),
			req("/api/ig/webhook-status", {
				cookie: null,
				method: "POST",
				body: JSON.stringify({ channelId: "ig-chan-g14-admin" }),
			}),
		]);
		const all401 = unauth.every((res) => res.status === 401);

		// (b) scoping do user2
		const listU2 = await req("/api/automations", { cookie: USER2_COOKIE });
		const automationsU2 = listU2.json?.automations || [];
		const noAdminAutomation = automationsU2.every(
			(automation) =>
				automation.channel_id !== "ig-chan-g14-admin" &&
				automation.id !== "auto-g14-admin",
		);
		const hasOwnAutomation = automationsU2.some(
			(automation) => automation.id === "auto-g14-user2",
		);

		const adminChannelList = await req(
			"/api/automations?channelId=ig-chan-g14-admin",
			{ cookie: USER2_COOKIE },
		);
		const adminChannelListOk =
			adminChannelList.status === 200 &&
			(adminChannelList.json?.automations || []).length === 0;

		const adminContacts = await req(
			"/api/ig/contacts?channelId=ig-chan-g14-admin",
			{ cookie: USER2_COOKIE },
		);
		const adminContactsOk =
			adminContacts.status === 200 &&
			(adminContacts.json?.items || []).length === 0;

		const patchOther = await req(
			`/api/ig/contacts/${adminContact.id}`,
			{
				cookie: USER2_COOKIE,
				method: "PATCH",
				body: JSON.stringify({ notes: "user2 tentou" }),
			},
		);
		const resubOther = await req("/api/ig/webhook-status", {
			cookie: USER2_COOKIE,
			method: "POST",
			body: JSON.stringify({ channelId: "ig-chan-g14-admin" }),
		});

		const pass =
			all401 &&
			listU2.status === 200 &&
			hasOwnAutomation &&
			noAdminAutomation &&
			adminChannelListOk &&
			adminContactsOk &&
			patchOther.status === 404 &&
			resubOther.status === 404;
		record(
			"G14",
			pass,
			`semSessao=${unauth.map((res) => res.status).join("/")} u2=${automationsU2.length} own=${hasOwnAutomation} patchOutro=${patchOther.status} resubOutro=${resubOther.status}`,
			{ adminChannelList: adminChannelList.status, adminContacts: adminContacts.status },
		);
	} finally {
		await cleanupChannel("ig-chan-g14-admin");
		await cleanupChannel("ig-chan-g14-user2");
	}
}

// ── G15 — rate limit 30/min (rebaixado p/ 2) → excedente reagendado ─────────
async function scenarioG15() {
	let previousConfig = null;
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g15",
			accountId: "acct-g15",
			username: "gauntlet_g15",
		});
		await seedAutomation({
			id: "auto-g15",
			channelId: "ig-chan-g15",
			name: "G15 rate",
			trigger: "dm",
			keywords: ["rate"],
			actions: [
				{
					id: "act-g15-dm",
					type: "dm_text",
					position: 0,
					text: ["ok"],
				},
			],
		});
		previousConfig = await prisma.appConfig.findUnique({
			where: { key: "ig_max_sends_per_minute" },
		});
		const put = await req("/api/ig/settings", {
			method: "PUT",
			body: JSON.stringify({ maxSendsPerMinute: 2 }),
		});
		writeState([
			rule("acct-g15/messages", [
				okId("mid-g15-1"),
				okId("mid-g15-2"),
				okId("mid-g15-3"),
			]),
		]);

		const sendDm = async (index) => {
			await postWebhook(
				dmBody("acct-g15", {
					mid: `mid-g15-${index}`,
					fromId: `u-g15-${index}`,
					username: `user_g15_${index}`,
					text: "rate limit",
				}),
			);
		};

		await sendDm(1);
		const sent1 = await waitFor(
			async () =>
				(await prisma.igActionLog.count({
					where: { channel_id: "ig-chan-g15", status: "sent" },
				})) >= 1,
			{ label: "envio 1" },
		);
		await sendDm(2);
		const sent2 = await waitFor(
			async () =>
				(await prisma.igActionLog.count({
					where: { channel_id: "ig-chan-g15", status: "sent" },
				})) >= 2,
			{ label: "envio 2" },
		);
		await sendDm(3);
		const throttled = await waitFor(
			async () =>
				(await prisma.igActionLog.count({
					where: {
						channel_id: "ig-chan-g15",
						status: "skipped",
						error: "throttled",
					},
				})) >= 1,
			{ label: "envio 3 throttled" },
		);
		let retryJob = null;
		await waitFor(
			async () => {
				const jobs = await prisma.igJob.findMany({
					where: { channel_id: "ig-chan-g15", type: "action" },
				});
				retryJob = jobs.find((job) => job.payload.includes("retryAttempt"));
				return retryJob !== undefined && retryJob !== null;
			},
			{ label: "job de retry reagendado" },
		);
		const messagesCalls = countCalls({
			method: "POST",
			urlIncludes: "acct-g15/messages",
		});
		const pass =
			put.status === 200 &&
			put.json?.limits?.maxSendsPerMinute === 2 &&
			sent1 &&
			sent2 &&
			throttled &&
			messagesCalls === 2 &&
			retryJob !== null &&
			retryJob.status === "pending" &&
			retryJob.run_at.getTime() > Date.now() + 50_000;
		record(
			"G15",
			pass,
			`put=${put.status} enviados=${messagesCalls} throttled=${throttled} retryJob=${retryJob ? `+${Math.round((retryJob.run_at.getTime() - Date.now()) / 1000)}s/${retryJob.status}` : "nenhum"}`,
		);
	} finally {
		if (previousConfig) {
			await prisma.appConfig.upsert({
				where: { key: "ig_max_sends_per_minute" },
				create: { key: "ig_max_sends_per_minute", value: previousConfig.value },
				update: { value: previousConfig.value },
			});
		} else {
			await prisma.appConfig.deleteMany({
				where: { key: "ig_max_sends_per_minute" },
			});
		}
		await cleanupChannel("ig-chan-g15");
	}
}

// ── G16 — echo do próprio bot vs echo humano ────────────────────────────────
async function scenarioG16() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g16",
			accountId: "acct-g16",
			username: "gauntlet_g16",
		});
		await seedAutomation({
			id: "auto-g16",
			channelId: "ig-chan-g16",
			name: "G16 dm",
			trigger: "dm",
			keywords: ["oi"],
			actions: [
				{
					id: "act-g16-dm",
					type: "dm_text",
					position: 0,
					text: ["Olá {username}!"],
				},
			],
		});
		await prisma.igContact.create({
			data: {
				id: "contact-g16",
				user_id: "admin",
				channel_id: "ig-chan-g16",
				ig_user_id: "u-g16",
				username: "user_g16",
			},
		});
		writeState([rule("acct-g16/messages", [okId("mid-g16")], "POST")]);

		// (a) echo com app_id == INSTAGRAM_CLIENT_ID (mensagem da própria API) → ignorado
		const a = await postWebhook(
			echoBody("acct-g16", {
				mid: "echo-g16a-1",
				contactId: "u-g16",
				contactUsername: "user_g16",
				appId: IG_CLIENT_ID,
				text: "enviado pela API",
			}),
		);
		const evA = await waitFor(
			async () => {
				const row = await getEvent("message:echo-g16a-1");
				return row !== null && row.status === "skipped";
			},
			{ label: "echo do bot (app_id) ignorado" },
		);
		const eventA = await getEvent("message:echo-g16a-1");
		const contactAfterA = await getContact("ig-chan-g16", "u-g16");

		// (b) echo sem app_id, mas com mid igual a um message_id de IgActionLog sent → ignorado
		await prisma.igActionLog.create({
			data: {
				user_id: "admin",
				channel_id: "ig-chan-g16",
				contact_id: "contact-g16",
				action_type: "dm_text",
				status: "sent",
				response: JSON.stringify({ message_id: "mid-g16b-sent" }),
			},
		});
		const b = await postWebhook(
			echoBody("acct-g16", {
				mid: "mid-g16b-sent",
				contactId: "u-g16",
				contactUsername: "user_g16",
				text: "enviado pela API (via log)",
			}),
		);
		const evB = await waitFor(
			async () => {
				const row = await getEvent("message:mid-g16b-sent");
				return row !== null && row.status === "skipped";
			},
			{ label: "echo do bot (mid no log) ignorado" },
		);
		const eventB = await getEvent("message:mid-g16b-sent");
		const contactAfterB = await getContact("ig-chan-g16", "u-g16");

		// (c) echo humano (sem app_id, mid desconhecido, recipient = contato) → pausa 24h
		const c = await postWebhook(
			echoBody("acct-g16", {
				mid: "echo-g16c-1",
				contactId: "u-g16",
				contactUsername: "user_g16",
				text: "resposta humana",
			}),
		);
		const evC = await waitFor(
			async () => {
				const row = await getEvent("message:echo-g16c-1");
				const contact = await getContact("ig-chan-g16", "u-g16");
				return (
					row?.status === "paused" &&
					contact?.bot_paused_until !== null &&
					contact.bot_paused_until.getTime() > Date.now() + 23 * 3600_000
				);
			},
			{ label: "echo humano pausa 24h" },
		);
		const eventC = await getEvent("message:echo-g16c-1");
		const contactC = await getContact("ig-chan-g16", "u-g16");

		// DM durante a pausa → bloqueado sem Graph
		await postWebhook(
			dmBody("acct-g16", {
				mid: "mid-g16-dm",
				fromId: "u-g16",
				username: "user_g16",
				text: "oi",
			}),
		);
		const dmBlocked = await waitFor(
			async () => {
				const row = await getEvent("message:mid-g16-dm");
				return row !== null && ["paused", "skipped"].includes(row.status);
			},
			{ label: "DM pós-pausa bloqueado" },
		);
		const dmEvent = await getEvent("message:mid-g16-dm");
		const calls = countCalls({
			method: "POST",
			urlIncludes: "acct-g16/messages",
		});

		const pass =
			a.status === 200 &&
			evA &&
			eventA?.kind === "echo" &&
			eventA?.status === "skipped" &&
			eventA?.error === "echo_do_bot" &&
			contactAfterA?.bot_paused_until === null &&
			b.status === 200 &&
			evB &&
			eventB?.kind === "echo" &&
			eventB?.status === "skipped" &&
			eventB?.error === "echo_do_bot" &&
			contactAfterB?.bot_paused_until === null &&
			c.status === 200 &&
			evC &&
			eventC?.status === "paused" &&
			eventC?.contact_id === "contact-g16" &&
			dmBlocked &&
			(dmEvent?.error || "").includes("bot_pause") &&
			calls === 0;
		record(
			"G16",
			pass,
			`a=${eventA?.status}/${eventA?.error} pausedA=${contactAfterA?.bot_paused_until === null ? "nao" : "SIM"} b=${eventB?.status}/${eventB?.error} pausedB=${contactAfterB?.bot_paused_until === null ? "nao" : "SIM"} c=${eventC?.status} pausedUntil=${contactC?.bot_paused_until?.toISOString()} dm=${dmEvent?.status} calls=${calls}`,
			{ dmError: dmEvent?.error },
		);
	} finally {
		await cleanupChannel("ig-chan-g16");
	}
}

// ── G17 — SSRF no webhook de saída ──────────────────────────────────────────
const SSRF_METADATA_URL = "http://169.254.169.254/latest/meta-data";

async function scenarioG17() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g17",
			accountId: "acct-g17",
			username: "gauntlet_g17",
		});

		// (a) API rejeita URL de metadata (validação síncrona, sem DNS)
		const created = await req("/api/ig/outbound-webhooks", {
			method: "POST",
			body: JSON.stringify({
				name: "G17 metadata",
				url: SSRF_METADATA_URL,
				events: ["action.sent"],
			}),
		});
		const apiBlocked =
			created.status === 400 &&
			(created.json?.error || "").includes("URL não permitida");

		// (b) bypass do API (inserção direta no DB) ainda é bloqueado no dispatch
		await prisma.igOutboundWebhook.create({
			data: {
				id: "wh-g17",
				user_id: "admin",
				channel_id: null,
				name: "G17 ssrf",
				url: SSRF_METADATA_URL,
				secret: "whsec-g17",
				events: JSON.stringify(["comment.matched"]),
				enabled: true,
			},
		});
		await seedAutomation({
			id: "auto-g17",
			channelId: "ig-chan-g17",
			name: "G17 outbound",
			trigger: "comment",
			keywords: ["ssrf"],
			actions: [
				{
					id: "act-g17-wh",
					type: "outbound_webhook",
					position: 0,
					webhookId: "wh-g17",
					text: ["ssrf"],
				},
			],
		});
		writeState([]);
		await postWebhook(
			commentBody("acct-g17", {
				commentId: "cmp-g17-1",
				fromId: "u-g17",
				username: "user_g17",
				text: "dispara ssrf",
				mediaId: "media-g17",
			}),
		);
		// Dois logs failed podem existir: o do dispatch (erro SSRF) e o da ação
		// ("Nenhum webhook de saída entregou..."), criado depois — filtra pelo erro.
		let failedLog = null;
		const blockedLog = await waitFor(
			async () => {
				failedLog = await prisma.igActionLog.findFirst({
					where: {
						channel_id: "ig-chan-g17",
						action_type: "outbound_webhook",
						status: "failed",
						error: { contains: "URL bloqueada (SSRF)" },
					},
					orderBy: { created_at: "desc" },
				});
				return failedLog !== null;
			},
			{ label: "dispatch SSRF bloqueado" },
		);
		const calls = readCalls().length;
		const metadataCalls = countCalls({ urlIncludes: "169.254" });
		const pass =
			apiBlocked && blockedLog && calls === 0 && metadataCalls === 0;
		record(
			"G17",
			pass,
			`api=${created.status}/${created.json?.error} dispatchLog="${failedLog?.error?.slice(0, 40)}" calls=${calls} metadataCalls=${metadataCalls}`,
		);
	} finally {
		await prisma.igOutboundWebhook.deleteMany({ where: { id: "wh-g17" } });
		await cleanupChannel("ig-chan-g17");
	}
}

// ── G18 — simulador com rascunho (draft) ────────────────────────────────────
async function scenarioG18() {
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g18",
			accountId: "acct-g18",
			username: "gauntlet_g18",
		});
		await seedAutomation({
			id: "auto-g18",
			channelId: "ig-chan-g18",
			name: "G18 persistida",
			trigger: "dm",
			keywords: ["oi"],
			actions: [
				{ id: "act-g18", type: "dm_text", position: 0, text: ["Persistida"] },
			],
		});
		const eventsBefore = await prisma.igEvent.count();
		const jobsBefore = await prisma.igJob.count();

		// (a) rascunho que casa tem prioridade e id sintético "draft"
		const withDraft = await req("/api/automations/simulate", {
			method: "POST",
			body: JSON.stringify({
				channelId: "ig-chan-g18",
				kind: "dm",
				text: "quero teste",
				draft: {
					trigger: "dm",
					keywords: ["quero"],
					actions: [
						{ type: "dm_text", textVariants: ["Resposta do rascunho"] },
					],
				},
			}),
		});
		const draftMatched =
			withDraft.status === 200 &&
			withDraft.json?.matched?.automationId === "draft" &&
			withDraft.json?.actions?.[0]?.renderedText === "Resposta do rascunho";

		// (b) rascunho inválido → 400 (mesmo schema do CRUD)
		const invalid = await req("/api/automations/simulate", {
			method: "POST",
			body: JSON.stringify({
				channelId: "ig-chan-g18",
				kind: "dm",
				text: "x",
				draft: { trigger: "nope" },
			}),
		});
		const invalidRejected =
			invalid.status === 400 &&
			(invalid.json?.error || "").includes("Rascunho inválido");

		// (c) rascunho que não casa cai na automação persistida
		const fallback = await req("/api/automations/simulate", {
			method: "POST",
			body: JSON.stringify({
				channelId: "ig-chan-g18",
				kind: "dm",
				text: "oi",
				draft: {
					trigger: "dm",
					keywords: ["zzz"],
					actions: [{ type: "dm_text", textVariants: ["Nunca"] }],
				},
			}),
		});
		const fallbackOk =
			fallback.status === 200 &&
			fallback.json?.matched?.automationId === "auto-g18";

		const eventsAfter = await prisma.igEvent.count();
		const jobsAfter = await prisma.igJob.count();
		const pass =
			draftMatched &&
			invalidRejected &&
			fallbackOk &&
			eventsAfter === eventsBefore &&
			jobsAfter === jobsBefore;
		record(
			"G18",
			pass,
			`draft=${withDraft.json?.matched?.automationId}/${withDraft.json?.actions?.[0]?.renderedText} invalid=${invalid.status} fallback=${fallback.json?.matched?.automationId} efeitos=${eventsAfter - eventsBefore}/${jobsAfter - jobsBefore}`,
			{ invalidError: invalid.json?.error },
		);
	} finally {
		await cleanupChannel("ig-chan-g18");
	}
}

// ── G19 — throttle multi-ação + outbound action.sent / sequence.step ────────
async function scenarioG19() {
	let previousConfig = null;
	try {
		await seedUser("admin");
		await seedChannel({
			id: "ig-chan-g19",
			accountId: "acct-g19",
			username: "gauntlet_g19",
		});
		const whSecret = "whsec-g19";
		await prisma.igOutboundWebhook.create({
			data: {
				id: "wh-g19",
				user_id: "admin",
				channel_id: null,
				name: "G19 outbound",
				url: OUTBOUND_WEBHOOK_URL,
				secret: whSecret,
				events: JSON.stringify(["action.sent", "sequence.step"]),
				enabled: true,
			},
		});
		await seedAutomation({
			id: "auto-g19",
			channelId: "ig-chan-g19",
			name: "G19 throttle",
			trigger: "comment",
			keywords: ["rate19"],
			actions: [
				{
					id: "act-g19-private",
					type: "private_reply",
					position: 0,
					text: ["PR g19"],
				},
				{
					id: "act-g19-public",
					type: "public_comment_reply",
					position: 1,
					delaySeconds: 10,
					text: ["PUB g19"],
				},
				{
					id: "act-g19-tag",
					type: "assign_tag",
					position: 2,
					delaySeconds: 5,
					tag: "vip19",
				},
			],
		});
		previousConfig = await prisma.appConfig.findUnique({
			where: { key: "ig_max_sends_per_minute" },
		});
		const put = await req("/api/ig/settings", {
			method: "PUT",
			body: JSON.stringify({ maxSendsPerMinute: 1 }),
		});
		// Envio recente no canal estoura o limite sem contar cooldown (sem automation/contact).
		await prisma.igActionLog.create({
			data: {
				user_id: "admin",
				channel_id: "ig-chan-g19",
				action_type: "dm_text",
				status: "sent",
			},
		});
		writeState([
			rule(
				"acct-g19/messages",
				[okId("mid-g19-private"), okId("mid-g19-seq")],
				"POST",
			),
			rule("cmp-g19-1/replies", [okId("mid-g19-public")], "POST"),
		]);

		const t0 = Date.now();
		await postWebhook(
			commentBody("acct-g19", {
				commentId: "cmp-g19-1",
				fromId: "u-g19",
				username: "user_g19",
				text: "quero rate19",
				mediaId: "media-g19",
			}),
		);
		const threeJobs = await waitFor(
			async () => {
				const jobs = await prisma.igJob.findMany({
					where: { channel_id: "ig-chan-g19", type: "action" },
				});
				return jobs.length === 3;
			},
			{ label: "3 jobs de throttle enfileirados" },
		);
		const throttledLogs = await waitFor(
			async () =>
				(await prisma.igActionLog.count({
					where: {
						channel_id: "ig-chan-g19",
						status: "skipped",
						error: "throttled",
					},
				})) >= 3,
			{ label: "3 logs throttled" },
		);
		const event = await getEvent("comment:cmp-g19-1");
		const jobs = await prisma.igJob.findMany({
			where: { channel_id: "ig-chan-g19", type: "action" },
			orderBy: { run_at: "asc" },
		});
		const actionIds = jobs.map((job) => {
			try {
				return JSON.parse(job.payload).actionId;
			} catch {
				return null;
			}
		});
		const deltas = jobs.map((job) => job.run_at.getTime() - t0);
		const increasing = deltas.every((delta, i) => i === 0 || delta > deltas[i - 1]);
		const offsetsOk =
			Math.abs(deltas[0] - 60_000) < 5_000 &&
			Math.abs(deltas[1] - 70_000) < 6_000 &&
			Math.abs(deltas[2] - 75_000) < 6_000;
		const step1 =
			put.status === 200 &&
			put.json?.limits?.maxSendsPerMinute === 1 &&
			threeJobs &&
			throttledLogs &&
			event?.status === "matched" &&
			event?.error === "throttled" &&
			actionIds.join(",") ===
				"act-g19-private,act-g19-public,act-g19-tag" &&
			increasing &&
			offsetsOk;

		// Drena os 3 jobs (limite normalizado) → private + public enviam; tag aplica.
		const put2 = await req("/api/ig/settings", {
			method: "PUT",
			body: JSON.stringify({ maxSendsPerMinute: 30 }),
		});
		await prisma.igJob.updateMany({
			where: { channel_id: "ig-chan-g19", status: "pending" },
			data: { run_at: new Date(Date.now() - 1000) },
		});
		const cron = await cronTick();
		const delivered = await waitFor(
			async () =>
				countCalls({ method: "POST", urlIncludes: "acct-g19/messages" }) === 1 &&
				countCalls({ method: "POST", urlIncludes: "cmp-g19-1/replies" }) === 1,
			{ label: "private+public entregues" },
		);
		const contact = await getContact("ig-chan-g19", "u-g19");
		const tagged =
			contact !== null &&
			JSON.parse(contact.tags || "[]").includes("vip19");

		const notifies = () =>
			readCalls().filter((call) => call.kind === "notify");
		const actionSent = await waitFor(
			() =>
				notifies().filter(
					(call) => call.headers?.["x-autoreels-event"] === "action.sent",
				).length >= 2,
			{ label: "outbound action.sent (private+public)" },
		);
		const sentCall = notifies().find(
			(call) => call.headers?.["x-autoreels-event"] === "action.sent",
		);
		const sentPayload = parseBody(sentCall);
		const sentSigOk =
			sentCall?.headers?.["x-autoreels-signature"] ===
			`sha256=${hmacHex(whSecret, sentCall?.body || "")}`;
		const sentPayloadOk =
			sentPayload?.event === "action.sent" &&
			sentPayload?.automationId === "auto-g19" &&
			sentPayload?.channelId === "ig-chan-g19" &&
			sentPayload?.contact?.igUserId === "u-g19" &&
			typeof sentPayload?.text === "string" &&
			sentPayload.text.trim() !== "";

		// Passo de sequência → outbound sequence.step
		await prisma.igSequence.create({
			data: {
				id: "seq-g19",
				user_id: "admin",
				channel_id: "ig-chan-g19",
				name: "G19 sequência",
				steps: JSON.stringify([
					{ delay_seconds: 0, type: "dm_text", text_variants: ["Seq g19"] },
				]),
			},
		});
		const seqContact = await prisma.igContact.create({
			data: {
				user_id: "admin",
				channel_id: "ig-chan-g19",
				ig_user_id: "u-g19-seq",
				username: "user_g19_seq",
			},
		});
		await prisma.igSequenceEnrollment.create({
			data: {
				sequence_id: "seq-g19",
				contact_id: seqContact.id,
				channel_id: "ig-chan-g19",
				status: "active",
				current_step: 0,
				next_run_at: new Date(Date.now() - 1000),
			},
		});
		const cron2 = await cronTick();
		const seqDelivered = await waitFor(
			() =>
				countCalls({ method: "POST", urlIncludes: "acct-g19/messages" }) === 2,
			{ label: "passo da sequência entregue" },
		);
		const stepNotifySeen = await waitFor(
			() =>
				notifies().some(
					(call) => call.headers?.["x-autoreels-event"] === "sequence.step",
				),
			{ label: "outbound sequence.step" },
		);
		const stepCall = notifies().find(
			(call) => call.headers?.["x-autoreels-event"] === "sequence.step",
		);
		const stepPayload = parseBody(stepCall);
		const stepSigOk =
			stepCall?.headers?.["x-autoreels-signature"] ===
			`sha256=${hmacHex(whSecret, stepCall?.body || "")}`;
		const stepPayloadOk =
			stepPayload?.event === "sequence.step" &&
			stepPayload?.channelId === "ig-chan-g19" &&
			stepPayload?.contact?.igUserId === "u-g19-seq";

		const pass =
			step1 &&
			put2.status === 200 &&
			cron.status === 200 &&
			delivered &&
			tagged &&
			actionSent &&
			sentSigOk &&
			sentPayloadOk &&
			cron2.status === 200 &&
			seqDelivered &&
			stepNotifySeen &&
			stepSigOk &&
			stepPayloadOk;
		record(
			"G19",
			pass,
			`jobs=${jobs.length} deltas=[${deltas.map((d) => Math.round(d / 1000)).join(",")}]s actions=${actionIds.join("|")} throttledLogs=${throttledLogs} entregues=${delivered} tag=${tagged} action.sent=${actionSent}/${sentSigOk} sequence.step=${stepNotifySeen}/${stepSigOk}`,
			{
				step1,
				deltas,
				actionIds,
				eventStatus: event?.status,
				eventError: event?.error,
				sentPayload,
				stepPayload,
			},
		);
	} finally {
		if (previousConfig) {
			await prisma.appConfig.upsert({
				where: { key: "ig_max_sends_per_minute" },
				create: {
					key: "ig_max_sends_per_minute",
					value: previousConfig.value,
				},
				update: { value: previousConfig.value },
			});
		} else {
			await prisma.appConfig.deleteMany({
				where: { key: "ig_max_sends_per_minute" },
			});
		}
		await prisma.igOutboundWebhook.deleteMany({ where: { id: "wh-g19" } });
		await cleanupChannel("ig-chan-g19");
	}
}

// ── Runner ──────────────────────────────────────────────────────────────────

const REGISTRY = {
	G1: scenarioG1,
	G2: scenarioG2,
	G3: scenarioG3,
	G4: scenarioG4,
	G5: scenarioG5,
	G6: scenarioG6,
	G7: scenarioG7,
	G8: scenarioG8,
	G9: scenarioG9,
	G10: scenarioG10,
	G11: scenarioG11,
	G12: scenarioG12,
	G13: scenarioG13,
	G14: scenarioG14,
	G15: scenarioG15,
	G16: scenarioG16,
	G17: scenarioG17,
	G18: scenarioG18,
	G19: scenarioG19,
};
const ALL = Object.keys(REGISTRY);

async function main() {
	const selected = SCENARIOS_ARG
		? SCENARIOS_ARG.split(",")
				.map((label) => label.trim())
				.filter(Boolean)
		: ALL;
	for (const label of selected) {
		if (!REGISTRY[label]) {
			console.error(`Cenário desconhecido: ${label}`);
			process.exit(2);
		}
	}
	for (const label of selected) {
		markScenario(label);
		try {
			await REGISTRY[label]();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			record(label, false, `exceção: ${detail}`);
		}
	}

	const lines = [];
	lines.push("label | verdict | detail");
	lines.push("--- | --- | ---");
	for (const result of results) {
		lines.push(
			`${result.scenario} | ${result.pass ? "PASS" : "FAIL"} | ${result.line}`,
		);
	}
	const failed = results.filter((result) => !result.pass);
	lines.push("");
	lines.push(
		`TOTAL: ${results.length} cenários, ${results.length - failed.length} PASS, ${failed.length} FAIL (G12 modo: ${OPENROUTER_KEY ? "com chave" : "sem chave"})`,
	);
	const summary = lines.join("\n") + "\n";
	writeFileSync(join(OUT_DIR, "summary.txt"), summary);
	console.log("\n" + summary);

	if (failed.length > 0) process.exit(1);
}

main()
	.catch(async (error) => {
		console.error("❌ erro inesperado no runner:", error);
		process.exit(1);
	})
	.finally(async () => {
		await prisma.$disconnect().catch(() => {});
	});
