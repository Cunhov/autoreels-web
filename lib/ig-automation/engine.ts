/**
 * lib/ig-automation/engine.ts — pipeline determinístico do evento (spec §5).
 *
 * Ordem: kill switch → canal → echo → dedupe/claim → autor → contato →
 * candidatas → gates → match (primeiro vence) → ações → incremento.
 *
 * Ações sem delay executam inline via `executeAction` (onda 1); ações com
 * delay viram `IgJob` via `enqueueJob`. Throttle do executor re-agenda o job
 * (60s, máx. 3 tentativas, sem marcar o evento como failed).
 *
 * `simulate` reusa os MESMOS gates/matcher/render, sem escrita no banco e sem
 * chamadas Graph (não gera links de clique — URLs originais são mantidas).
 */
import { prisma } from "@/lib/prisma";
import { executeAction } from "@/lib/ig-automation/actions";
import {
	incrementInteractions,
	pauseContact,
	upsertContact,
} from "@/lib/ig-automation/contacts";
import { enqueueJob } from "@/lib/ig-automation/jobs";
import {
	getLimits,
	isCooldownBlocked,
	isDailyLimitReached,
	isRateLimited,
	type IgLimits,
} from "@/lib/ig-automation/limits";
import { bumpStats, logAction } from "@/lib/ig-automation/log";
import { matchSubstance, matchText } from "@/lib/ig-automation/matcher";
import { isQuietNow, normalizeText } from "@/lib/ig-automation/normalize";
import { renderAction } from "@/lib/ig-automation/render";
import type {
	IgActionType,
	IgAutomationActionRow,
	IgGateResult,
	IgInboundEvent,
	IgMatchedAction,
	IgQuietHours,
	IgRenderVars,
	IgSimulationResult,
	IgSubstanceInput,
	IgTrigger,
} from "@/lib/ig-automation/types";

export interface HandleInboundOptions {
	source?: "webhook" | "recovery";
}

export interface IgSimulationInput {
	channelId: string;
	kind: IgTrigger;
	text: string;
	mediaId?: string | null;
	username?: string | null;
	igUserId?: string | null;
}

interface EngineChannel {
	id: string;
	user_id: string;
	username: string | null;
	account_id: string | null;
	access_token: string | null;
	proxy_url: string | null;
	proxy_enabled: boolean | null;
}

interface GateContact {
	id: string;
	ig_user_id: string;
	username: string | null;
	name: string | null;
	interactions_count: number;
	bot_paused_until: Date | null;
}

interface GateAutomation {
	id: string;
	trigger: string;
	keywords: string;
	match_mode: string;
	match_type: string;
	negative_keywords: string | null;
	media_ids: string | null;
	first_interaction_only: boolean;
	cooldown_hours: number | null;
	daily_limit: number | null;
	quiet_hours: string | null;
	settings: string | null;
}

interface GateOptions {
	full?: boolean;
	now?: Date;
	getSubstances?: (() => Promise<IgSubstanceInput[]>) | null;
}

interface GateEvaluation {
	gates: IgGateResult[];
	passed: boolean;
	failedGate: IgGateResult | null;
	vars: IgRenderVars;
}

const PUBLIC_REPLY_DEFAULT_MS = 15_000;
const PUBLIC_REPLY_JITTER_MS = 10_000;
const THROTTLE_RETRY_MS = 60_000;
const MAX_THROTTLE_RETRIES = 3;

const ENGINE_CHANNEL_SELECT = {
	id: true,
	user_id: true,
	username: true,
	account_id: true,
	access_token: true,
	proxy_url: true,
	proxy_enabled: true,
	status: true,
} as const;

function shortError(error: unknown): string {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code !== "") return code;
	}
	if (error instanceof Error && error.name) return error.name;
	return "Error";
}

function isUniqueViolation(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		(error as { code?: unknown }).code === "P2002"
	);
}

function safePayload(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		const json = JSON.stringify(value);
		return typeof json === "string" ? json.slice(0, 20_000) : undefined;
	} catch {
		return undefined;
	}
}

function parseStringList(raw: string | null | undefined): string[] {
	if (typeof raw !== "string" || raw.trim() === "") return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter((item) => item !== "");
	} catch {
		return [];
	}
}

function parseJsonObject(
	raw: string | null | undefined,
): Record<string, unknown> | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		/* JSON inválido = sem configuração */
	}
	return null;
}

function parseQuietHours(raw: string | null | undefined): IgQuietHours | null {
	const parsed = parseJsonObject(raw);
	if (!parsed) return null;
	if (typeof parsed.start !== "string" || typeof parsed.end !== "string") {
		return null;
	}
	return {
		start: parsed.start,
		end: parsed.end,
		tz: typeof parsed.tz === "string" ? parsed.tz : "",
	};
}

function parseMatchType(raw: string): "contains" | "exact" | "starts_with" | "regex" {
	return raw === "exact" || raw === "starts_with" || raw === "regex"
		? raw
		: "contains";
}

function buildVars(event: IgInboundEvent, contact: GateContact | null): IgRenderVars {
	const username = (event.fromUsername ?? contact?.username ?? "").trim();
	const display = (contact?.name ?? "").trim() || username;
	const firstName = display.split(/\s+/)[0] ?? "";
	return { username, first_name: firstName };
}

async function loadSubstances(userId: string): Promise<IgSubstanceInput[]> {
	try {
		return await prisma.igSubstance.findMany({
			where: {
				enabled: true,
				OR: [{ user_id: null }, { user_id: userId }],
			},
			orderBy: { created_at: "asc" },
			select: {
				id: true,
				keyword: true,
				name: true,
				keywords: true,
				description: true,
				action: true,
				dosage: true,
				duration: true,
				url: true,
			},
		});
	} catch (error) {
		console.error(
			"[ig-engine] catálogo de substâncias falhou:",
			shortError(error),
		);
		return [];
	}
}

/**
 * Avalia todos os gates da automação (spec §5.8). Com `full=false` (engine)
 * para no primeiro gate que falhar; com `full=true` (simulador) avalia tudo.
 */
async function evaluateAutomationGates(
	automation: GateAutomation,
	event: IgInboundEvent,
	contact: GateContact | null,
	channel: EngineChannel,
	limits: IgLimits,
	options: GateOptions = {},
): Promise<GateEvaluation> {
	const full = options.full === true;
	const now = options.now ?? new Date();
	const text = typeof event.text === "string" ? event.text : "";
	const gates: IgGateResult[] = [];
	let failedGate: IgGateResult | null = null;
	const vars = buildVars(event, contact);

	const record = (gate: string, passed: boolean, reason?: string): boolean => {
		const result: IgGateResult = { gate, passed };
		if (reason !== undefined) result.reason = reason;
		gates.push(result);
		if (!passed && failedGate === null) failedGate = result;
		return passed || full;
	};

	// trigger
	if (!record("trigger", automation.trigger === event.kind, "gatilho incompatível")) {
		return { gates, passed: false, failedGate, vars };
	}

	// media_ids (vazio/null = qualquer post)
	const mediaIds = parseStringList(automation.media_ids);
	const mediaOk =
		mediaIds.length === 0 ||
		(typeof event.mediaId === "string" && mediaIds.includes(event.mediaId));
	if (!record("media_ids", mediaOk, "post fora da lista")) {
		return { gates, passed: false, failedGate, vars };
	}

	// first_interaction_only
	const firstOk =
		!automation.first_interaction_only ||
		contact === null ||
		contact.interactions_count === 0;
	if (!record("first_interaction_only", firstOk, "não é a primeira interação")) {
		return { gates, passed: false, failedGate, vars };
	}

	// negatives (qualquer negativa que casar derruba o match)
	const negatives = parseStringList(automation.negative_keywords);
	const negativesOk = matchText(text, [], "any", "contains", negatives);
	if (!record("negatives", negativesOk, "contém palavra negativa")) {
		return { gates, passed: false, failedGate, vars };
	}

	// keywords
	const keywords = parseStringList(automation.keywords);
	const keywordsOk = matchText(
		text,
		keywords,
		automation.match_mode === "all" ? "all" : "any",
		parseMatchType(automation.match_type),
	);
	if (!record("keywords", keywordsOk, "sem match de palavra-chave")) {
		return { gates, passed: false, failedGate, vars };
	}

	// substance (só quando settings.substanceCatalog = true)
	const settings = parseJsonObject(automation.settings);
	if (settings?.substanceCatalog === true) {
		const substances = options.getSubstances
			? await options.getSubstances()
			: await loadSubstances(channel.user_id);
		const match = matchSubstance(text, substances);
		if (match) {
			vars["substancia.nome"] = match.nome;
			vars["substancia.descricao"] = match.descricao;
			vars["substancia.acao"] = match.acao;
			vars["substancia.dosagem"] = match.dosagem;
			vars["substancia.duracao"] = match.duracao;
			vars["substancia.url"] = match.url;
		}
		if (!record("substance", match !== null, "sem substância")) {
			return { gates, passed: false, failedGate, vars };
		}
	}

	// quiet_hours
	const quiet = parseQuietHours(automation.quiet_hours);
	const quietActive = isQuietNow(quiet, now);
	if (!record("quiet_hours", !quietActive, "horário de silêncio")) {
		return { gates, passed: false, failedGate, vars };
	}

	// bot_pause
	if (contact === null) {
		record("bot_pause", true, "sem contato");
	} else {
		const paused =
			contact.bot_paused_until !== null &&
			contact.bot_paused_until.getTime() > now.getTime();
		if (!record("bot_pause", !paused, paused ? "contato pausado" : undefined)) {
			return { gates, passed: false, failedGate, vars };
		}
	}

	// cooldown
	const cooldownHours = automation.cooldown_hours ?? limits.cooldownHours;
	if (contact === null) {
		record("cooldown", true, "sem contato");
	} else if (cooldownHours <= 0) {
		record("cooldown", true, "desligado");
	} else {
		const blocked = await isCooldownBlocked(
			automation.id,
			contact.id,
			cooldownHours,
		);
		if (!record("cooldown", !blocked, blocked ? "cooldown ativo" : undefined)) {
			return { gates, passed: false, failedGate, vars };
		}
	}

	// daily_limit
	const dailyLimit = automation.daily_limit ?? limits.dailyLimitPerContact;
	if (contact === null) {
		record("daily_limit", true, "sem contato");
	} else if (dailyLimit <= 0) {
		record("daily_limit", true, "desligado");
	} else {
		const reached = await isDailyLimitReached(
			automation.id,
			contact.id,
			dailyLimit,
		);
		if (
			!record(
				"daily_limit",
				!reached,
				reached ? "limite diário atingido" : undefined,
			)
		) {
			return { gates, passed: false, failedGate, vars };
		}
	}

	// rate_limit (spec §5.8): janela 60s por canal, conta envios reais no DB.
	// Aparece no simulador (full=true); no engine bloqueia com `throttled`.
	let rateLimited = false;
	try {
		rateLimited = await isRateLimited(channel.id, limits.maxSendsPerMinute);
	} catch {
		rateLimited = false; // contagem indisponível não bloqueia
	}
	if (!record("rate_limit", !rateLimited, rateLimited ? "throttled" : undefined)) {
		return { gates, passed: false, failedGate, vars };
	}

	return { gates, passed: failedGate === null, failedGate, vars };
}

/** Delay acumulado (inclui o próprio delay) de cada ação; público ganha default. */
function computeActionOffsets(
	actions: Array<{ type: string; delay_seconds: number }>,
): number[] {
	const offsets: number[] = [];
	let cumulative = 0;
	for (const action of actions) {
		const delaySeconds =
			Number.isFinite(action.delay_seconds) && action.delay_seconds > 0
				? action.delay_seconds
				: 0;
		let ownDelayMs = delaySeconds * 1000;
		if (action.type === "public_comment_reply" && delaySeconds <= 0) {
			ownDelayMs =
				PUBLIC_REPLY_DEFAULT_MS +
				Math.floor(Math.random() * (PUBLIC_REPLY_JITTER_MS + 1));
		}
		cumulative += ownDelayMs;
		offsets.push(cumulative);
	}
	return offsets;
}

function actionTarget(type: string): IgMatchedAction["target"] {
	switch (type) {
		case "public_comment_reply":
			return "comment";
		case "assign_tag":
			return "contact";
		case "start_sequence":
			return "sequence";
		case "outbound_webhook":
			return "webhook";
		default:
			return "dm";
	}
}

/** Simulador: renderiza ações sem `createClickLink` (zero escrita/Graph). */
async function renderSimulatedActions(
	rows: IgAutomationActionRow[],
	vars: IgRenderVars,
): Promise<IgMatchedAction[]> {
	const offsets = computeActionOffsets(rows);
	const result: IgMatchedAction[] = [];
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const rendered = await renderAction(row, vars);
		const action: IgMatchedAction = {
			actionId: row.id,
			type: row.type as IgActionType,
			position: row.position,
			runAtOffsetMs: offsets[index],
			target: actionTarget(row.type),
		};
		if (rendered.text !== undefined) action.renderedText = rendered.text;
		if (rendered.buttons !== undefined) action.buttons = rendered.buttons;
		if (rendered.quickReplies !== undefined) {
			action.quickReplies = rendered.quickReplies;
		}
		result.push(action);
	}
	return result;
}

/** Marca eventos ainda `received` (kill switch/canal) sem sobrescrever replays. */
async function updateReceivedEvent(
	dedupeKey: string,
	data: { status: string; error?: string | null },
): Promise<void> {
	try {
		await prisma.igEvent.updateMany({
			where: { dedupe_key: dedupeKey, status: "received" },
			data: { status: data.status, error: data.error ?? null },
		});
	} catch (error) {
		console.error("[ig-engine] update do evento falhou:", shortError(error));
	}
}

/**
 * Dedupe atômico: só o primeiro chamador consegue `received → matched`.
 * Evento existente em qualquer outro status = já processado/replay.
 */
async function claimEvent(
	event: IgInboundEvent,
	channel: EngineChannel,
): Promise<{ id: string } | null> {
	try {
		const existing = await prisma.igEvent.findUnique({
			where: { dedupe_key: event.dedupeKey },
			select: { id: true, status: true },
		});
		if (existing) {
			if (existing.status !== "received") return null;
			const claimed = await prisma.igEvent.updateMany({
				where: { id: existing.id, status: "received" },
				data: { status: "matched" },
			});
			return claimed.count > 0 ? { id: existing.id } : null;
		}
		const created = await prisma.igEvent.create({
			data: {
				user_id: channel.user_id,
				channel_id: channel.id,
				kind: String(event.kind || "system"),
				dedupe_key: event.dedupeKey,
				ig_event_id: event.igEventId || undefined,
				media_id: event.mediaId || undefined,
				text: typeof event.text === "string" ? event.text : undefined,
				username: event.fromUsername || undefined,
				from_ig_id: event.fromIgId || undefined,
				payload: safePayload(event.raw),
				status: "matched", // claim: engine assume o processamento
				direction: "in",
			},
			select: { id: true },
		});
		return { id: created.id };
	} catch (error) {
		if (isUniqueViolation(error)) return null;
		console.error("[ig-engine] claim do evento falhou:", shortError(error));
		return null;
	}
}

async function finishEvent(
	eventRowId: string,
	data: { status: string; automationId?: string | null; error?: string | null },
): Promise<void> {
	try {
		await prisma.igEvent.updateMany({
			where: { id: eventRowId },
			data: {
				status: data.status,
				automation_id: data.automationId ?? null,
				error: data.error ?? null,
			},
		});
	} catch (error) {
		console.error("[ig-engine] finalização do evento falhou:", shortError(error));
	}
}

/** Echo: pausa o contato (human takeover) e grava/atualiza o evento. */
async function handleEcho(
	event: IgInboundEvent,
	channel: EngineChannel,
	dedupeKey: string,
	limits: IgLimits,
): Promise<void> {
	const existing = await prisma.igEvent.findUnique({
		where: { dedupe_key: dedupeKey },
		select: { id: true, status: true },
	});
	if (existing && existing.status !== "received") {
		// Persistência do webhook já marcou "paused" — replay não estende a pausa.
		return;
	}

	let contactId: string | null = null;
	if (event.fromIgId) {
		try {
			const contact = await upsertContact({
				userId: channel.user_id,
				channelId: channel.id,
				igUserId: event.fromIgId,
				username: event.fromUsername,
				isComment: false,
				at: new Date(),
			});
			contactId = contact.id;
			await pauseContact(contact.id, limits.humanTakeoverPauseHours);
		} catch (error) {
			console.error("[ig-engine] echo: pausa falhou:", shortError(error));
		}
	}

	if (existing) {
		try {
			await prisma.igEvent.updateMany({
				where: { id: existing.id },
				data: {
					kind: "echo",
					status: "paused",
					...(contactId !== null ? { contact_id: contactId } : {}),
				},
			});
		} catch (error) {
			console.error("[ig-engine] echo: update falhou:", shortError(error));
		}
		return;
	}

	try {
		await prisma.igEvent.create({
			data: {
				user_id: channel.user_id,
				channel_id: channel.id,
				kind: "echo",
				dedupe_key: dedupeKey,
				ig_event_id: event.igEventId || undefined,
				media_id: event.mediaId || undefined,
				text: typeof event.text === "string" ? event.text : undefined,
				username: event.fromUsername || undefined,
				from_ig_id: event.fromIgId || undefined,
				payload: safePayload(event.raw),
				status: "paused",
				direction: "in",
				...(contactId !== null ? { contact_id: contactId } : {}),
			},
		});
	} catch (error) {
		if (!isUniqueViolation(error)) {
			console.error("[ig-engine] echo: criação falhou:", shortError(error));
		}
	}
}

/**
 * Re-agenda ação throttled: `runAt=now+60s`, no máximo 3 tentativas
 * (o evento NÃO vira failed por throttle).
 */
async function scheduleThrottleRetry(params: {
	userId: string;
	channelId: string;
	eventId: string;
	automationId: string;
	contactId: string;
	actionId: string;
}): Promise<void> {
	try {
		const candidates = await prisma.igJob.findMany({
			where: {
				channel_id: params.channelId,
				type: "action",
				payload: { contains: params.eventId },
			},
			select: { payload: true },
		});
		const prior = candidates.filter(
			(job) =>
				typeof job.payload === "string" &&
				job.payload.includes(params.actionId),
		).length;
		if (prior >= MAX_THROTTLE_RETRIES) return;

		await enqueueJob({
			userId: params.userId,
			channelId: params.channelId,
			type: "action",
			runAt: new Date(Date.now() + THROTTLE_RETRY_MS),
			payload: {
				eventId: params.eventId,
				automationId: params.automationId,
				contactId: params.contactId,
				actionId: params.actionId,
				retryAttempt: prior + 1,
			},
			maxAttempts: MAX_THROTTLE_RETRIES,
		});
	} catch (error) {
		console.error(
			"[ig-engine] reagendamento de throttled falhou:",
			shortError(error),
		);
	}
}

/**
 * Pipeline completo do evento inbound (spec §5). Nunca lança para fora:
 * falhas internas viram `IgEvent.failed`/`skipped` e logs curtos.
 */
export async function handleInboundEvent(
	event: IgInboundEvent,
	opts: HandleInboundOptions = {},
): Promise<void> {
	const source = opts.source === "recovery" ? "recovery" : "webhook";
	if (!event || typeof event !== "object") return;
	const dedupeKey =
		typeof event.dedupeKey === "string" ? event.dedupeKey.trim() : "";
	const channelIgId =
		typeof event.channelIgId === "string" ? event.channelIgId.trim() : "";
	if (!dedupeKey || !channelIgId) return;

	// Rastreio pós-claim (F-08): em erro, reverte p/ `received` ou mantém
	// `matched` quando ações já foram executadas (não duplica envios).
	let claimedEventRowId: string | null = null;
	let actionsExecuted = false;
	let matchedAutomationId: string | null = null;

	try {
		// 1. kill switch
		const limits = await getLimits();
		if (!limits.enabled) {
			await updateReceivedEvent(dedupeKey, {
				status: "skipped",
				error: "Automações desligadas (kill switch).",
			});
			return;
		}

		// 2. resolver canal
		const channel = await prisma.channel.findFirst({
			where: { platform: "instagram", account_id: channelIgId },
			select: ENGINE_CHANNEL_SELECT,
		});
		if (!channel || channel.status !== "active") {
			await updateReceivedEvent(dedupeKey, {
				status: "skipped",
				error: "Canal inativo ou não encontrado para este evento.",
			});
			return;
		}

		// 3. echo
		if (event.isEcho === true) {
			await handleEcho(event, channel, dedupeKey, limits);
			return;
		}

		// 4. dedupe/claim
		const claimed = await claimEvent(event, channel);
		if (!claimed) return;
		const eventRowId = claimed.id;
		claimedEventRowId = eventRowId;
		const now = new Date();

		// 5. autor
		const fromIgId = typeof event.fromIgId === "string" ? event.fromIgId : "";
		const fromUsername =
			typeof event.fromUsername === "string" ? event.fromUsername : "";
		const isSelf =
			(fromIgId !== "" && fromIgId === channel.account_id) ||
			(fromUsername !== "" &&
				normalizeText(fromUsername) === normalizeText(channel.username ?? ""));
		if (isSelf) {
			await finishEvent(eventRowId, {
				status: "skipped",
				error: "Evento do próprio canal (autor ignorado).",
			});
			return;
		}

		// 6. contato
		let contact: GateContact | null = null;
		if (fromIgId) {
			try {
				const summary = await upsertContact({
					userId: channel.user_id,
					channelId: channel.id,
					igUserId: fromIgId,
					username: fromUsername || null,
					isComment: event.kind === "comment",
					at: now,
				});
				contact = await prisma.igContact.findUnique({
					where: { id: summary.id },
					select: {
						id: true,
						ig_user_id: true,
						username: true,
						name: true,
						interactions_count: true,
						bot_paused_until: true,
					},
				});
				if (contact) {
					await prisma.igEvent.updateMany({
						where: { id: eventRowId },
						data: { contact_id: contact.id },
					});
				}
			} catch (error) {
				console.error(
					`[ig-engine] upsert de contato falhou (${source}):`,
					shortError(error),
				);
			}
		}

		// 7. automações candidatas (prioridade desc, criação asc)
		const automations = await prisma.igAutomation.findMany({
			where: { channel_id: channel.id, enabled: true },
			include: { actions: { orderBy: { position: "asc" } } },
			orderBy: [{ priority: "desc" }, { created_at: "asc" }],
		});

		let substancesCache: IgSubstanceInput[] | null = null;
		const getSubstances = async (): Promise<IgSubstanceInput[]> => {
			if (substancesCache === null) {
				substancesCache = await loadSubstances(channel.user_id);
			}
			return substancesCache;
		};

		// 8/9. gates por automação — o primeiro match vence
		let matched: (typeof automations)[number] | null = null;
		let matchedEvaluation: GateEvaluation | null = null;
		let throttledMatch: {
			automation: (typeof automations)[number];
			evaluation: GateEvaluation;
		} | null = null;
		let pausedBlocked = false;
		const failures: IgGateResult[] = [];

		for (const automation of automations) {
			const evaluation = await evaluateAutomationGates(
				automation,
				event,
				contact,
				channel,
				limits,
				{ now, getSubstances },
			);
			if (evaluation.passed) {
				matched = automation;
				matchedEvaluation = evaluation;
				matchedAutomationId = automation.id;
				break;
			}
			if (evaluation.failedGate) {
				failures.push(evaluation.failedGate);
				if (evaluation.failedGate.gate === "bot_pause") pausedBlocked = true;
				if (
					evaluation.failedGate.gate === "rate_limit" &&
					throttledMatch === null
				) {
					throttledMatch = { automation, evaluation };
				}
				void logAction({
					userId: channel.user_id,
					channelId: channel.id,
					automationId: automation.id,
					contactId: contact?.id ?? null,
					eventId: eventRowId,
					actionType: "gate",
					status: "skipped",
					error: `${evaluation.failedGate.gate}: ${
						evaluation.failedGate.reason ?? "bloqueado"
					}`,
				});
			}
		}

		// Rate limit (spec §5.8): NÃO vira skipped — marca o evento `matched`
		// com error `throttled` e re-agenda a PRIMEIRA ação em +60s (o executor
		// revalida e reagenda; máx 3 tentativas). interaction_count incrementa 1x.
		if (!matched && throttledMatch && !pausedBlocked) {
			const throttledAutomation = throttledMatch.automation;
			matchedAutomationId = throttledAutomation.id;
			await bumpStats(throttledAutomation.id, { matched: 1 });
			try {
				await prisma.igAutomation.updateMany({
					where: { id: throttledAutomation.id },
					data: { last_run_at: now },
				});
			} catch (error) {
				console.error("[ig-engine] last_run_at falhou:", shortError(error));
			}

			const throttleActions = throttledAutomation.actions;
			if (contact && throttleActions.length > 0) {
				const firstAction = throttleActions[0];
				actionsExecuted = true;
				void logAction({
					userId: channel.user_id,
					channelId: channel.id,
					automationId: throttledAutomation.id,
					contactId: contact.id,
					eventId: eventRowId,
					actionType: firstAction.type,
					status: "skipped",
					error: "throttled",
				});
				await scheduleThrottleRetry({
					userId: channel.user_id,
					channelId: channel.id,
					eventId: eventRowId,
					automationId: throttledAutomation.id,
					contactId: contact.id,
					actionId: firstAction.id,
				});
				await incrementInteractions(contact.id);
			}

			await finishEvent(eventRowId, {
				status: "matched",
				automationId: throttledAutomation.id,
				error: "throttled",
			});
			return;
		}

		if (!matched || !matchedEvaluation) {
			const pauseFailure = failures.find(
				(failure) => failure.gate === "bot_pause",
			);
			const primaryFailure =
				pausedBlocked && pauseFailure ? pauseFailure : failures[0];
			const reason =
				automations.length === 0
					? "Nenhuma automação habilitada para este canal."
					: primaryFailure
						? `Nenhuma automação compatível (${
								primaryFailure.gate
							}: ${primaryFailure.reason ?? "bloqueado"}).`
						: "Nenhuma automação compatível.";
			await finishEvent(eventRowId, {
				status: pausedBlocked ? "paused" : "skipped",
				error: reason,
			});
			return;
		}

		// Match registrado (stats + last_run_at)
		await bumpStats(matched.id, { matched: 1 });
		try {
			await prisma.igAutomation.updateMany({
				where: { id: matched.id },
				data: { last_run_at: now },
			});
		} catch (error) {
			console.error("[ig-engine] last_run_at falhou:", shortError(error));
		}

		// 10. ações
		const actions = matched.actions;
		if (actions.length > 0 && !contact) {
			await finishEvent(eventRowId, {
				status: "skipped",
				automationId: matched.id,
				error: "Sem contato (remetente) para executar as ações.",
			});
			return;
		}

		let failure: string | null = null;
		if (contact) {
			actionsExecuted = true;
			const offsets = computeActionOffsets(actions);
			for (let index = 0; index < actions.length; index++) {
				const action = actions[index];
				const offsetMs = offsets[index];
				if (offsetMs <= 0) {
					const result = await executeAction({
						action,
						automation: matched,
						channel,
						contact,
						event: {
							igEventId: event.igEventId,
							kind: event.kind,
							dedupeKey: event.dedupeKey,
							mediaId: event.mediaId ?? null,
						},
						vars: matchedEvaluation.vars,
						limits,
						eventId: eventRowId,
					});
					if (result.skipped && result.reason === "throttled") {
						await scheduleThrottleRetry({
							userId: channel.user_id,
							channelId: channel.id,
							eventId: eventRowId,
							automationId: matched.id,
							contactId: contact.id,
							actionId: action.id,
						});
					} else if (!result.ok) {
						failure = failure ?? (result.error || "Falha ao executar ação.");
					}
				} else {
					try {
						await enqueueJob({
							userId: channel.user_id,
							channelId: channel.id,
							type: "action",
							runAt: new Date(now.getTime() + offsetMs),
							payload: {
								eventId: eventRowId,
								automationId: matched.id,
								contactId: contact.id,
								actionId: action.id,
							},
						});
					} catch (error) {
						failure = failure ?? "Falha ao agendar ação.";
						console.error(
							`[ig-engine] enqueueJob falhou (${source}):`,
							shortError(error),
						);
					}
				}
			}

			// 11. incremento de interações
			await incrementInteractions(contact.id);
		}

		// 12. finalização do evento
		await finishEvent(eventRowId, {
			status: failure ? "failed" : "matched",
			automationId: matched.id,
			error: failure,
		});
	} catch (error) {
		console.error(
			`[ig-engine] handleInboundEvent falhou (${source}):`,
			shortError(error),
		);
		// F-08: erro pós-claim não pode deixar o evento preso em `matched`.
		if (claimedEventRowId !== null) {
			try {
				if (actionsExecuted) {
					// Ações já executadas: mantém `matched` (não duplica envios).
					await prisma.igEvent.updateMany({
						where: { id: claimedEventRowId },
						data: {
							status: "matched",
							error: "processing_error",
							...(matchedAutomationId !== null
								? { automation_id: matchedAutomationId }
								: {}),
						},
					});
				} else {
					// Reverte p/ `received`: recovery reprocessa após 2min.
					await prisma.igEvent.updateMany({
						where: { id: claimedEventRowId, status: "matched" },
						data: { status: "received", error: "processing_error" },
					});
				}
			} catch (revertError) {
				console.error(
					"[ig-engine] reversão do evento falhou:",
					shortError(revertError),
				);
			}
		}
	}
}

/**
 * Simulador (spec §11 / rota POST /api/automations/simulate): mesmos gates,
 * matcher e render do engine, com ZERO escrita no banco e ZERO chamadas Graph
 * (links de clique não são criados; URLs originais permanecem).
 */
export async function simulate(
	input: IgSimulationInput,
	userId: string,
): Promise<IgSimulationResult> {
	const now = new Date();
	const limits = await getLimits();

	const globalGates: IgGateResult[] = [];
	const killSwitchGate: IgGateResult = {
		gate: "kill_switch",
		passed: limits.enabled,
	};
	if (!limits.enabled) killSwitchGate.reason = "automações desligadas";
	globalGates.push(killSwitchGate);

	const channel = await prisma.channel.findFirst({
		where: { id: input.channelId, user_id: userId },
		select: ENGINE_CHANNEL_SELECT,
	});
	if (!channel) {
		return {
			matched: null,
			actions: [],
			gates: [
				...globalGates,
				{ gate: "channel", passed: false, reason: "canal não encontrado" },
			],
			contact: {
				igUserId: input.igUserId ?? undefined,
				username: input.username ?? undefined,
				firstInteraction: true,
			},
		};
	}
	globalGates.push({ gate: "channel", passed: true });

	let contact: GateContact | null = null;
	if (input.igUserId) {
		contact = await prisma.igContact.findFirst({
			where: { channel_id: channel.id, ig_user_id: input.igUserId },
			select: {
				id: true,
				ig_user_id: true,
				username: true,
				name: true,
				interactions_count: true,
				bot_paused_until: true,
			},
		});
	}

	const contactResult = {
		igUserId: contact?.ig_user_id ?? input.igUserId ?? undefined,
		username: contact?.username ?? input.username ?? undefined,
		firstInteraction: !contact || contact.interactions_count === 0,
	};

	const event: IgInboundEvent = {
		channelIgId: channel.account_id ?? "",
		kind: input.kind,
		dedupeKey: `simulate:${Date.now()}`,
		igEventId: "simulate",
		fromIgId: input.igUserId ?? undefined,
		fromUsername: input.username ?? undefined,
		text: typeof input.text === "string" ? input.text : "",
		mediaId: input.mediaId ?? undefined,
		raw: null,
	};

	const automations = await prisma.igAutomation.findMany({
		where: { channel_id: channel.id, enabled: true },
		include: { actions: { orderBy: { position: "asc" } } },
		orderBy: [{ priority: "desc" }, { created_at: "asc" }],
	});

	let substancesCache: IgSubstanceInput[] | null = null;
	const getSubstances = async (): Promise<IgSubstanceInput[]> => {
		if (substancesCache === null) {
			substancesCache = await loadSubstances(userId);
		}
		return substancesCache;
	};

	const gates: IgGateResult[] = [...globalGates];
	for (const automation of automations) {
		const evaluation = await evaluateAutomationGates(
			automation,
			event,
			contact,
			channel,
			limits,
			{ full: true, now, getSubstances },
		);
		if (evaluation.passed) {
			return {
				matched: { automationId: automation.id, name: automation.name },
				actions: await renderSimulatedActions(
					automation.actions,
					evaluation.vars,
				),
				gates: [...gates, ...evaluation.gates],
				contact: contactResult,
			};
		}
		gates.push(...evaluation.gates);
	}

	return {
		matched: null,
		actions: [],
		gates,
		contact: contactResult,
	};
}
