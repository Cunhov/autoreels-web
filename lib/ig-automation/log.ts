/**
 * lib/ig-automation/log.ts — persistência best-effort de eventos/ações/stats
 * (spec §6.5). Fire-and-forget: NUNCA lança.
 *
 * Segurança: console.error apenas com mensagem curta (código/nome do erro) —
 * jamais payload, request/response ou tokens.
 */
import { prisma } from "@/lib/prisma";
import type { IgStatsDelta } from "@/lib/ig-automation/types";

export interface IgLogEventInput {
	userId: string;
	channelId: string;
	automationId?: string | null;
	contactId?: string | null;
	direction?: string | null;
	kind: string;
	dedupeKey: string;
	igEventId?: string | null;
	mediaId?: string | null;
	text?: string | null;
	username?: string | null;
	fromIgId?: string | null;
	payload?: string | null;
	status?: string | null;
	error?: string | null;
}

export interface IgLogActionInput {
	userId: string;
	channelId: string;
	automationId?: string | null;
	contactId?: string | null;
	eventId?: string | null;
	actionType: string;
	status: string;
	request?: string | null;
	response?: string | null;
	error?: string | null;
}

/** Só código/nome do erro — curto e sem risco de vazar dados. */
function shortError(error: unknown): string {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code !== "") return code;
	}
	if (error instanceof Error) return error.name || "Error";
	return "unknown";
}

/**
 * Grava um IgEvent. `dedupe_key` duplicado (P2002) é silencioso — replay de
 * webhook é esperado. Qualquer outro erro é logado de forma curta.
 */
export async function logEvent(data: IgLogEventInput): Promise<void> {
	try {
		await prisma.igEvent.create({
			data: {
				user_id: data.userId,
				channel_id: data.channelId,
				automation_id: data.automationId ?? undefined,
				contact_id: data.contactId ?? undefined,
				direction: data.direction ?? "in",
				kind: data.kind,
				dedupe_key: data.dedupeKey,
				ig_event_id: data.igEventId ?? undefined,
				media_id: data.mediaId ?? undefined,
				text: data.text ?? undefined,
				username: data.username ?? undefined,
				from_ig_id: data.fromIgId ?? undefined,
				payload: data.payload ?? undefined,
				status: data.status ?? "received",
				error: data.error ?? undefined,
			},
		});
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			(error as { code?: unknown }).code === "P2002"
		) {
			return;
		}
		console.error("[ig-automation] logEvent falhou:", shortError(error));
	}
}

/** Grava um IgActionLog (sent/failed/skipped/pending). Nunca lança. */
export async function logAction(data: IgLogActionInput): Promise<void> {
	try {
		await prisma.igActionLog.create({
			data: {
				user_id: data.userId,
				channel_id: data.channelId,
				automation_id: data.automationId ?? undefined,
				contact_id: data.contactId ?? undefined,
				event_id: data.eventId ?? undefined,
				action_type: data.actionType,
				status: data.status,
				request: data.request ?? undefined,
				response: data.response ?? undefined,
				error: data.error ?? undefined,
			},
		});
	} catch (error) {
		console.error("[ig-automation] logAction falhou:", shortError(error));
	}
}

/** Incrementa contadores da automação (atômico via `increment`). Nunca lança. */
export async function bumpStats(
	automationId: string,
	delta: IgStatsDelta,
): Promise<void> {
	if (!automationId) return;
	const data: {
		stats_matched?: { increment: number };
		stats_sent?: { increment: number };
		stats_failed?: { increment: number };
		stats_clicks?: { increment: number };
	} = {};
	if (typeof delta?.matched === "number" && Number.isFinite(delta.matched)) {
		data.stats_matched = { increment: Math.trunc(delta.matched) };
	}
	if (typeof delta?.sent === "number" && Number.isFinite(delta.sent)) {
		data.stats_sent = { increment: Math.trunc(delta.sent) };
	}
	if (typeof delta?.failed === "number" && Number.isFinite(delta.failed)) {
		data.stats_failed = { increment: Math.trunc(delta.failed) };
	}
	if (typeof delta?.clicks === "number" && Number.isFinite(delta.clicks)) {
		data.stats_clicks = { increment: Math.trunc(delta.clicks) };
	}
	if (Object.keys(data).length === 0) return;
	try {
		await prisma.igAutomation.updateMany({
			where: { id: automationId },
			data,
		});
	} catch (error) {
		console.error("[ig-automation] bumpStats falhou:", shortError(error));
	}
}
