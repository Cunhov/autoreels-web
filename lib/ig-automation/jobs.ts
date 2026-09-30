/**
 * lib/ig-automation/jobs.ts — fila de jobs da automação (spec §9).
 *
 * - `enqueueJob`: grava um IgJob `pending` (payload serializado em JSON).
 * - `processDueJobs`: reclaim de jobs `running` travados (> 2min), claim
 *   atômico por `updateMany({where:{id,status:"pending"}})`, executa via
 *   `runJob` e faz backoff de 60s (máx `max_attempts`).
 * - `runJob`: reconstrói o contexto do job (ação/automação/canal/contato/
 *   evento) e chama o executor da onda 1 (`executeAction`), ou delega passos
 *   de sequência para `./sequences`. Exportado para reuso.
 * - `processStaleEvents`: reprocessa eventos `received` > 2min via engine.
 *
 * Segurança: nada de token/segredo em logs — apenas nome/código de erro.
 */
import type { IgJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
	executeAction,
	type ExecuteActionChannel,
	type ExecuteActionContact,
} from "@/lib/ig-automation/actions";
import { handleInboundEvent } from "@/lib/ig-automation/engine";
import { getLimits } from "@/lib/ig-automation/limits";
import { matchSubstance } from "@/lib/ig-automation/matcher";
import { executeSequenceStep } from "@/lib/ig-automation/sequences";
import type {
	IgInboundEvent,
	IgRenderVars,
	IgTrigger,
} from "@/lib/ig-automation/types";

export type IgJobType =
	| "action"
	| "sequence_step"
	| "ai_reply"
	| "outbound_webhook";

export interface EnqueueJobData {
	userId: string;
	channelId?: string | null;
	type: IgJobType;
	runAt: Date;
	payload: unknown;
	maxAttempts?: number;
}

export interface ProcessSummary {
	processed: number;
	failed: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;
const STALE_LOCK_MS = 2 * 60_000;
const STALE_EVENT_MS = 2 * 60_000;

function shortError(error: unknown): string {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code !== "") return code;
	}
	if (error instanceof Error && error.name) return error.name;
	return "Error";
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) {
		return error.message.trim().slice(0, 500);
	}
	return "Erro inesperado no job.";
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
	if (typeof raw !== "string" || raw.trim() === "") return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		/* payload inválido cai no objeto vazio */
	}
	return {};
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function firstNameOf(contact: {
	name?: string | null;
	username?: string | null;
}): string {
	const source = (contact.name ?? "").trim() || (contact.username ?? "").trim();
	if (!source) return "";
	return source.split(/\s+/)[0] ?? "";
}

/** `enqueueJob` — aceita payload desconhecido e serializa em JSON. */
export async function enqueueJob(data: EnqueueJobData): Promise<string> {
	const maxAttempts =
		typeof data.maxAttempts === "number" &&
		Number.isFinite(data.maxAttempts) &&
		data.maxAttempts > 0
			? Math.trunc(data.maxAttempts)
			: DEFAULT_MAX_ATTEMPTS;
	const runAt = data.runAt instanceof Date ? data.runAt : new Date(data.runAt);
	const created = await prisma.igJob.create({
		data: {
			user_id: data.userId,
			channel_id: data.channelId ?? null,
			type: data.type,
			run_at: runAt,
			payload: JSON.stringify(data.payload ?? {}),
			status: "pending",
			max_attempts: maxAttempts,
		},
		select: { id: true },
	});
	return created.id;
}

/** Devolve jobs `running` com lock expirado (> 2min) para `pending`. */
async function reclaimStaleJobs(): Promise<void> {
	try {
		await prisma.igJob.updateMany({
			where: {
				status: "running",
				locked_at: { lt: new Date(Date.now() - STALE_LOCK_MS) },
			},
			data: { status: "pending", locked_at: null },
		});
	} catch (error) {
		console.error("[ig-automation] reclaimStaleJobs falhou:", shortError(error));
	}
}

/* -------------------------------------------------------------------------- */
/* Execução                                                                    */
/* -------------------------------------------------------------------------- */

function buildVarsBase(contact: {
	username?: string | null;
	name?: string | null;
}): IgRenderVars {
	return {
		username: contact.username ?? "",
		first_name: firstNameOf(contact),
	};
}

/**
 * Injeta `{substancia.*}` quando a automação usa catálogo (`settings.substanceCatalog`)
 * e o texto do evento casa com um item ativo (global ou do usuário).
 */
async function buildVarsWithSubstance(
	settingsRaw: string | null,
	userId: string,
	contact: { username?: string | null; name?: string | null },
	eventText: string | null,
): Promise<IgRenderVars> {
	const vars = buildVarsBase(contact);
	const settings = parseJsonObject(settingsRaw);
	if (settings.substanceCatalog !== true) return vars;
	const text = (eventText ?? "").trim();
	if (!text) return vars;
	try {
		const substances = await prisma.igSubstance.findMany({
			where: {
				enabled: true,
				OR: [{ user_id: null }, { user_id: userId }],
			},
			orderBy: { created_at: "asc" },
		});
		const match = matchSubstance(text, substances);
		if (!match) return vars;
		vars["substancia.nome"] = match.nome;
		vars["substancia.descricao"] = match.descricao;
		vars["substancia.acao"] = match.acao;
		vars["substancia.dosagem"] = match.dosagem;
		vars["substancia.duracao"] = match.duracao;
		vars["substancia.url"] = match.url;
	} catch (error) {
		console.error("[ig-automation] vars de substância falharam:", shortError(error));
	}
	return vars;
}

/**
 * Executa um job. Lança em falha — `processDueJobs` decide retry/failed.
 * Exportado para reuso (ex.: testes/gauntlet e sequências).
 */
export async function runJob(job: IgJob): Promise<void> {
	const payload = parseJsonObject(job.payload);

	if (job.type === "action") {
		await runActionJob(payload);
		return;
	}

	if (job.type === "sequence_step") {
		const enrollmentId =
			asString(payload.enrollmentId) || asString(payload.enrollment_id);
		if (!enrollmentId) {
			throw new Error("Job de sequência sem enrollmentId no payload.");
		}
		const result = await executeSequenceStep(enrollmentId);
		if (!result.ok && !result.done) {
			throw new Error(result.error || "Falha ao executar o passo da sequência.");
		}
		return;
	}

	throw new Error(
		job.type
			? `Tipo de job não suportado: ${job.type}.`
			: "Job sem tipo configurado.",
	);
}

async function runActionJob(payload: Record<string, unknown>): Promise<void> {
	const eventId = asString(payload.eventId) || asString(payload.event_id);
	const automationId =
		asString(payload.automationId) || asString(payload.automation_id);
	const contactId = asString(payload.contactId) || asString(payload.contact_id);
	const actionId = asString(payload.actionId) || asString(payload.action_id);
	if (!eventId || !automationId || !contactId || !actionId) {
		throw new Error(
			"Job de ação com payload incompleto (eventId/automationId/contactId/actionId).",
		);
	}

	const [action, automation, contact, eventRow] = await Promise.all([
		prisma.igAutomationAction.findUnique({ where: { id: actionId } }),
		prisma.igAutomation.findUnique({ where: { id: automationId } }),
		prisma.igContact.findUnique({ where: { id: contactId } }),
		prisma.igEvent.findUnique({ where: { id: eventId } }),
	]);
	if (!action) throw new Error("Ação do job não existe mais.");
	if (!automation) throw new Error("Automação do job não existe mais.");
	if (!contact) throw new Error("Contato do job não existe mais.");
	if (!eventRow) throw new Error("Evento do job não existe mais.");

	const channel = await prisma.channel.findUnique({
		where: { id: automation.channel_id },
		select: {
			id: true,
			user_id: true,
			account_id: true,
			username: true,
			access_token: true,
			proxy_url: true,
			proxy_enabled: true,
		},
	});
	if (!channel) throw new Error("Canal do job não existe mais.");

	const limits = await getLimits();
	const vars = await buildVarsWithSubstance(
		automation.settings,
		automation.user_id,
		contact,
		eventRow.text,
	);

	const result = await executeAction({
		action,
		automation,
		channel: channel as ExecuteActionChannel,
		contact: contact as ExecuteActionContact,
		event: {
			igEventId: eventRow.ig_event_id ?? "",
			kind: eventRow.kind,
			dedupeKey: eventRow.dedupe_key,
			mediaId: eventRow.media_id,
		},
		vars,
		limits,
		// FIX-M4: propaga o id da row `IgEvent` para o dedupe de private_reply.
		eventId: eventRow.id,
	});
	if (!result.ok) {
		throw new Error(
			result.error || result.reason || "Falha ao executar a ação agendada.",
		);
	}
}

/**
 * Processa jobs vencidos. Claim atômico: só executa quem conseguir trocar
 * `pending → running` (protege contra múltiplos workers/pods).
 */
export async function processDueJobs(limit = 25): Promise<ProcessSummary> {
	await reclaimStaleJobs();

	const due = await prisma.igJob.findMany({
		where: { status: "pending", run_at: { lte: new Date() } },
		orderBy: { run_at: "asc" },
		take: limit,
	});

	let processed = 0;
	let failed = 0;

	for (const job of due) {
		const claimed = await prisma.igJob.updateMany({
			where: { id: job.id, status: "pending" },
			data: { status: "running", locked_at: new Date() },
		});
		if (claimed.count === 0) continue;

		try {
			await runJob(job);
			await prisma.igJob.updateMany({
				where: { id: job.id, status: "running" },
				data: { status: "done", locked_at: null },
			});
			processed++;
		} catch (error) {
			failed++;
			const attempts = (job.attempts ?? 0) + 1;
			const maxAttempts =
				job.max_attempts && job.max_attempts > 0
					? job.max_attempts
					: DEFAULT_MAX_ATTEMPTS;
			const terminal = attempts >= maxAttempts;
			try {
				await prisma.igJob.updateMany({
					where: { id: job.id, status: "running" },
					data: {
						status: terminal ? "failed" : "pending",
						attempts,
						locked_at: null,
						last_error: errorMessage(error),
						...(terminal
							? {}
							: { run_at: new Date(Date.now() + RETRY_DELAY_MS) }),
					},
				});
			} catch (updateError) {
				console.error(
					"[ig-automation] atualização de job falhou:",
					shortError(updateError),
				);
			}
		}
	}

	return { processed, failed };
}

/* -------------------------------------------------------------------------- */
/* Eventos órfãos                                                              */
/* -------------------------------------------------------------------------- */

function toInboundEvent(
	event: {
		kind: string;
		dedupe_key: string;
		ig_event_id: string | null;
		from_ig_id: string | null;
		username: string | null;
		text: string | null;
		media_id: string | null;
		payload: string | null;
	},
	channelIgId: string,
): IgInboundEvent {
	let raw: unknown = {};
	if (event.payload) {
		try {
			raw = JSON.parse(event.payload) as unknown;
		} catch {
			raw = {};
		}
	}
	return {
		channelIgId,
		kind: event.kind as IgTrigger,
		dedupeKey: event.dedupe_key,
		igEventId: event.ig_event_id ?? "",
		fromIgId: event.from_ig_id ?? undefined,
		fromUsername: event.username ?? undefined,
		text: event.text ?? undefined,
		mediaId: event.media_id ?? undefined,
		raw,
		isEcho: false,
	};
}

/**
 * Reprocessa `IgEvent` presos em `received` por mais de 2min (kind != echo).
 * A recuperação é idempotente (dedupe_key único no engine). Em erro, o evento
 * permanece `received` para nova tentativa na próxima execução.
 */
export async function processStaleEvents(limit = 25): Promise<ProcessSummary> {
	const cutoff = new Date(Date.now() - STALE_EVENT_MS);
	const events = await prisma.igEvent.findMany({
		where: {
			status: "received",
			created_at: { lt: cutoff },
			kind: { not: "echo" },
		},
		orderBy: { created_at: "asc" },
		take: limit,
		include: { channel: { select: { account_id: true } } },
	});

	let processed = 0;
	let failed = 0;

	for (const event of events) {
		try {
			await handleInboundEvent(
				toInboundEvent(event, event.channel?.account_id ?? ""),
				{ source: "recovery" },
			);
			processed++;
		} catch (error) {
			failed++;
			console.error(
				"[ig-automation] processStaleEvents falhou:",
				shortError(error),
			);
		}
	}

	return { processed, failed };
}
