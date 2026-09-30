import { prisma } from "@/lib/prisma";
import { generateReply, type IgAiHistoryMessage } from "@/lib/ig-automation/ai";
import { createClickLink } from "@/lib/ig-automation/clicks";
import {
	replyToComment,
	resolveGraphContext,
	sendDM,
	sendPrivateReply,
} from "@/lib/ig-automation/graph";
import { isRateLimited, type IgLimits } from "@/lib/ig-automation/limits";
import { bumpStats, logAction } from "@/lib/ig-automation/log";
import { applyTemplate } from "@/lib/ig-automation/normalize";
import { dispatchOutbound } from "@/lib/ig-automation/outbound";
import { renderAction } from "@/lib/ig-automation/render";
import type {
	IgAutomationActionRow,
	IgAutomationRow,
	IgRenderVars,
	IgRenderedAction,
} from "@/lib/ig-automation/types";

export interface ExecuteActionChannel {
	id: string;
	account_id: string | null;
	username: string | null;
	access_token: string | null;
	proxy_url?: string | null;
	proxy_enabled?: boolean | null;
	user_id: string;
}

export interface ExecuteActionContact {
	id: string;
	ig_user_id: string;
	username?: string | null;
}

export interface ExecuteActionEvent {
	igEventId: string;
	kind: string;
	dedupeKey: string;
	mediaId?: string | null;
}

export interface ExecuteActionParams {
	action: IgAutomationActionRow;
	automation: IgAutomationRow;
	channel: ExecuteActionChannel;
	contact: ExecuteActionContact;
	event: ExecuteActionEvent;
	vars: IgRenderVars;
	limits: IgLimits;
	dryRun?: boolean;
	/** id da row `IgEvent` (dedupe de private_reply); ausente = pula a checagem. */
	eventId?: string | null;
	/**
	 * Override do `automation_id` usado nos logs/stats. Sequências passam
	 * `null` (não existe `IgAutomation` real — evita FK inválida `seq:<id>`).
	 */
	automationIdOverride?: string | null;
}

export interface ExecuteActionResult {
	ok: boolean;
	skipped?: boolean;
	reason?: string;
	error?: string;
}

const SEND_ACTIONS = new Set<string>([
	"public_comment_reply",
	"private_reply",
	"dm_text",
	"dm_buttons",
	"dm_quick_replies",
	"dm_media",
	"ai_reply",
]);

function summarize(value: unknown): string {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return (text ?? "").slice(0, 2000);
	} catch {
		return "";
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error && err.message.trim()) {
		return err.message.trim().slice(0, 500);
	}
	return "Erro inesperado ao executar a ação.";
}

function parseTags(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((tag): tag is string => typeof tag === "string")
			.map((tag) => tag.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function fireLog(params: Parameters<typeof logAction>[0]): void {
	try {
		void logAction(params).catch(() => {});
	} catch {
		/* log é best-effort */
	}
}

function fireBump(automationId: string, delta: { sent?: number; failed?: number }): void {
	try {
		void bumpStats(automationId, delta).catch(() => {});
	} catch {
		/* stats são best-effort */
	}
}

async function loadContactHistory(contactId: string): Promise<IgAiHistoryMessage[]> {
	try {
		const rows = await prisma.igEvent.findMany({
			where: {
				contact_id: contactId,
				kind: { in: ["comment", "dm", "story_reply", "story_mention", "postback"] },
			},
			orderBy: { created_at: "desc" },
			take: 10,
			select: { direction: true, text: true, username: true },
		});
		return rows.reverse().map((row) => ({
			role: row.direction === "out" ? "assistant" : "user",
			username: row.username ?? undefined,
			text: row.text ?? undefined,
		}));
	} catch {
		return [];
	}
}

export async function executeAction(
	params: ExecuteActionParams,
): Promise<ExecuteActionResult> {
	const { action, automation, channel, contact, event, vars, limits } = params;
	const actionType = String(action?.type || "");
	const dryRun = params.dryRun === true || limits?.dryRun === true;
	const eventId =
		typeof params.eventId === "string" && params.eventId.trim() !== ""
			? params.eventId.trim()
			: null;
	// `null` explícito = log sem automation (sequências); ausente = automation real.
	const automationId =
		params.automationIdOverride !== undefined
			? params.automationIdOverride
			: automation?.id ?? null;

	const baseLog = {
		userId: channel.user_id,
		channelId: channel.id,
		automationId,
		contactId: contact.id,
		eventId,
		actionType: actionType || "unknown",
	};

	// FIX-A2: eventos de webhook de saída para envios reais à Graph.
	// Fire-and-forget: nunca bloqueia nem derruba o fluxo da ação.
	const fireOutboundEvent = (
		event: "action.sent" | "action.failed",
		text: string | null,
	): void => {
		if (!SEND_ACTIONS.has(actionType)) return;
		try {
			void dispatchOutbound({
				userId: channel.user_id,
				channelId: channel.id,
				event,
				automationId,
				contact: {
					igUserId: contact.ig_user_id,
					username: contact.username,
				},
				text,
			}).catch(() => {});
		} catch {
			/* webhooks de saída são best-effort */
		}
	};

	const finishFailure = (error: string): ExecuteActionResult => {
		fireLog({ ...baseLog, status: "failed", error: error.slice(0, 500) });
		if (automationId) fireBump(automationId, { failed: 1 });
		fireOutboundEvent("action.failed", error);
		return { ok: false, error };
	};

	const finishSuccess = (
		request?: unknown,
		response?: unknown,
		outboundText?: string | null,
	): ExecuteActionResult => {
		fireLog({
			...baseLog,
			status: "sent",
			request: request === undefined ? null : summarize(request),
			response: response === undefined ? null : summarize(response),
		});
		// Apenas envios reais à Graph inflam `stats_sent`
		// (assign_tag/start_sequence/outbound_webhook não contam).
		if (automationId && SEND_ACTIONS.has(actionType)) {
			fireBump(automationId, { sent: 1 });
		}
		fireOutboundEvent("action.sent", outboundText ?? null);
		return { ok: true };
	};

	// Igual a finishSuccess, mas persiste o log antes de retornar: garante que
	// o dedupe de private_reply enxergue o envio imediatamente depois.
	const finishSuccessPersisted = async (
		request?: unknown,
		response?: unknown,
		outboundText?: string | null,
	): Promise<ExecuteActionResult> => {
		try {
			await logAction({
				...baseLog,
				status: "sent",
				request: request === undefined ? null : summarize(request),
				response: response === undefined ? null : summarize(response),
			});
		} catch {
			/* log é best-effort */
		}
		if (automationId && SEND_ACTIONS.has(actionType)) {
			fireBump(automationId, { sent: 1 });
		}
		fireOutboundEvent("action.sent", outboundText ?? null);
		return { ok: true };
	};

	if (dryRun) {
		fireLog({ ...baseLog, status: "skipped", error: "dry_run" });
		return { ok: true, skipped: true, reason: "dry_run" };
	}

	if (SEND_ACTIONS.has(actionType)) {
		try {
			const limited = await isRateLimited(
				channel.id,
				limits?.maxSendsPerMinute ?? 0,
			);
			if (limited) {
				fireLog({ ...baseLog, status: "skipped", error: "throttled" });
				return { ok: false, skipped: true, reason: "throttled" };
			}
		} catch {
			/* contagem indisponível não bloqueia o envio */
		}
	}

	try {
		switch (actionType) {
			case "public_comment_reply": {
				if (!event.igEventId) {
					return finishFailure("Evento sem id de comentário — não há como responder publicamente.");
				}
				const rendered = await renderMessage(action, vars, channel, contact, automation, event);
				const text = (rendered.text ?? "").trim();
				if (!text) {
					return finishFailure("Ação de resposta pública sem texto configurado.");
				}
				const ctx = await resolveGraphContext(channel);
				const result = await replyToComment(ctx, event.igEventId, text);
				if (!result.ok) {
					return finishFailure(result.error || "Falha ao responder o comentário.");
				}
				return finishSuccess(
					{ endpoint: "replies", commentId: event.igEventId },
					{ status: result.status },
					text,
				);
			}

			case "private_reply": {
				if (!event.igEventId) {
					return finishFailure("Evento sem id de comentário — private reply indisponível.");
				}
				// Só há 1 private reply por comentário (spec §5.1): se já houve envio
				// para este evento, não chama a Graph de novo nem infla stats.
				if (eventId) {
					const alreadySent = await prisma.igActionLog.findFirst({
						where: {
							event_id: eventId,
							action_type: "private_reply",
							status: "sent",
						},
						select: { id: true },
					});
					if (alreadySent) {
						fireLog({
							...baseLog,
							status: "skipped",
							error: "private_reply_ja_enviado",
						});
						return {
							ok: true,
							skipped: true,
							reason: "private_reply_ja_enviado",
						};
					}
				}
				const rendered = await renderMessage(action, vars, channel, contact, automation, event);
				if (!hasContent(rendered)) {
					return finishFailure("Ação de private reply sem texto ou botões válidos.");
				}
				const ctx = await resolveGraphContext(channel);
				const result = await sendPrivateReply(ctx, event.igEventId, {
					text: rendered.text,
					buttons: rendered.buttons,
				});
				if (!result.ok) {
					return finishFailure(result.error || "Falha ao enviar a private reply.");
				}
				return finishSuccessPersisted(
					{
						endpoint: "messages",
						commentId: event.igEventId,
						text: rendered.text,
						buttons: rendered.buttons?.length ?? 0,
					},
					{ status: result.status },
					rendered.text ?? null,
				);
			}

			case "dm_text": {
				const rendered = await renderMessage(action, vars, channel, contact, automation, event);
				const text = (rendered.text ?? "").trim();
				if (!text) return finishFailure("Ação de DM sem texto configurado.");
				if (!contact.ig_user_id) {
					return finishFailure("Contato sem ig_user_id — não há como enviar DM.");
				}
				const ctx = await resolveGraphContext(channel);
				const result = await sendDM(ctx, contact.ig_user_id, { text: rendered.text });
				if (!result.ok) return finishFailure(result.error || "Falha ao enviar a DM.");
				return finishSuccess(
					{ endpoint: "messages", igUserId: contact.ig_user_id, text: rendered.text },
					{ status: result.status },
					rendered.text ?? null,
				);
			}

			case "dm_buttons": {
				const rendered = await renderMessage(action, vars, channel, contact, automation, event);
				if (!hasContent(rendered)) {
					return finishFailure("Ação de botões sem texto ou botões válidos.");
				}
				if (!contact.ig_user_id) {
					return finishFailure("Contato sem ig_user_id — não há como enviar DM.");
				}
				const ctx = await resolveGraphContext(channel);
				const result = await sendDM(ctx, contact.ig_user_id, {
					text: rendered.text,
					buttons: rendered.buttons,
				});
				if (!result.ok) return finishFailure(result.error || "Falha ao enviar a DM com botões.");
				return finishSuccess(
					{
						endpoint: "messages",
						igUserId: contact.ig_user_id,
						text: rendered.text,
						buttons: rendered.buttons?.length ?? 0,
					},
					{ status: result.status },
					rendered.text ?? null,
				);
			}

			case "dm_quick_replies": {
				const rendered = await renderMessage(action, vars, channel, contact, automation, event);
				if (!hasContent(rendered)) {
					return finishFailure("Ação de quick replies sem texto ou opções válidas.");
				}
				if (!contact.ig_user_id) {
					return finishFailure("Contato sem ig_user_id — não há como enviar DM.");
				}
				const ctx = await resolveGraphContext(channel);
				const result = await sendDM(ctx, contact.ig_user_id, {
					text: rendered.text,
					quickReplies: rendered.quickReplies,
				});
				if (!result.ok) {
					return finishFailure(result.error || "Falha ao enviar a DM com quick replies.");
				}
				return finishSuccess(
					{
						endpoint: "messages",
						igUserId: contact.ig_user_id,
						text: rendered.text,
						quickReplies: rendered.quickReplies?.length ?? 0,
					},
					{ status: result.status },
					rendered.text ?? null,
				);
			}

			case "dm_media": {
				const rendered = await renderMessage(action, vars, channel, contact, automation, event);
				const mediaUrl = (action.media_url || "").trim();
				if (!/^https?:\/\//i.test(mediaUrl)) {
					return finishFailure("Ação de mídia sem URL pública (http/https) válida.");
				}
				if (!contact.ig_user_id) {
					return finishFailure("Contato sem ig_user_id — não há como enviar DM.");
				}
				const ctx = await resolveGraphContext(channel);
				const result = await sendDM(ctx, contact.ig_user_id, {
					text: rendered.text,
					mediaUrl,
				});
				if (!result.ok) return finishFailure(result.error || "Falha ao enviar a mídia.");
				return finishSuccess(
					{ endpoint: "messages", igUserId: contact.ig_user_id, mediaUrl },
					{ status: result.status },
					rendered.text ?? null,
				);
			}

			case "ai_reply": {
				const prompt = action.ai_prompt?.trim()
					? applyTemplate(action.ai_prompt, vars)
					: (await renderMessage(action, vars, channel, contact, automation, event)).text ?? "";
				if (!prompt.trim()) {
					return finishFailure("Ação de IA sem prompt configurado.");
				}
				if (event.kind !== "comment" && !contact.ig_user_id) {
					return finishFailure("Contato sem ig_user_id — não há como enviar a resposta de IA.");
				}
				const history = await loadContactHistory(contact.id);
				const text = await generateReply({
					prompt,
					history,
					contact: { username: contact.username ?? undefined },
				});
				if (!text.trim()) return finishFailure("A IA devolveu uma resposta vazia.");
				const ctx = await resolveGraphContext(channel);
				const result =
					event.kind === "comment"
						? await sendPrivateReply(ctx, event.igEventId, { text })
						: await sendDM(ctx, contact.ig_user_id, { text });
				if (!result.ok) return finishFailure(result.error || "Falha ao enviar a resposta de IA.");
				return finishSuccess(
					{ endpoint: event.kind === "comment" ? "private_reply" : "dm", ai: true },
					{ status: result.status },
					text,
				);
			}

			case "assign_tag": {
				const tag = (action.tag || "").trim();
				if (!tag) return finishFailure("Ação de tag sem tag configurada.");
				const current = await prisma.igContact.findUnique({
					where: { id: contact.id },
					select: { tags: true },
				});
				const tags = parseTags(current?.tags ?? null);
				const exists = tags.some(
					(existing) => existing.toLowerCase() === tag.toLowerCase(),
				);
				if (!exists) {
					tags.push(tag);
					await prisma.igContact.update({
						where: { id: contact.id },
						data: { tags: JSON.stringify(tags) },
					});
				}
				return finishSuccess({ tag }, { tags, alreadyPresent: exists });
			}

			case "start_sequence": {
				const sequenceId = (action.sequence_id || "").trim();
				if (!sequenceId) {
					return finishFailure("Ação de sequência sem sequência configurada.");
				}
				const sequence = await prisma.igSequence.findUnique({
					where: { id: sequenceId },
					select: { id: true, enabled: true },
				});
				if (!sequence) {
					return finishFailure("Sequência configurada na ação não existe mais.");
				}
				const existing = await prisma.igSequenceEnrollment.findUnique({
					where: {
						sequence_id_contact_id: {
							sequence_id: sequenceId,
							contact_id: contact.id,
						},
					},
				});
				if (existing) {
					return finishSuccess(
						{ sequenceId },
						{ enrollmentId: existing.id, existing: true, status: existing.status },
					);
				}
				let enrollment: { id: string };
				try {
					enrollment = await prisma.igSequenceEnrollment.create({
						data: {
							sequence_id: sequenceId,
							contact_id: contact.id,
							channel_id: channel.id,
							status: "active",
							current_step: 0,
							next_run_at: new Date(),
						},
						select: { id: true },
					});
				} catch (error) {
					// Corrida no unique (sequence_id, contact_id): idempotente.
					if (
						error !== null &&
						typeof error === "object" &&
						(error as { code?: unknown }).code === "P2002"
					) {
						const raced = await prisma.igSequenceEnrollment.findUnique({
							where: {
								sequence_id_contact_id: {
									sequence_id: sequenceId,
									contact_id: contact.id,
								},
							},
							select: { id: true },
						});
						if (raced) {
							return finishSuccess(
								{ sequenceId },
								{ enrollmentId: raced.id, existing: true, raced: true },
							);
						}
					}
					throw error;
				}
				return finishSuccess(
					{ sequenceId },
					{ enrollmentId: enrollment.id, enrolled: true },
				);
			}

			case "outbound_webhook": {
				const rendered = await renderMessage(action, vars, channel, contact, automation, event);
				const outboundEvent =
					event.kind === "comment" ? "comment.matched" : "dm.matched";
				const outbound = await dispatchOutbound({
					userId: channel.user_id,
					channelId: channel.id,
					event: outboundEvent,
					automationId: automation.id,
					contact: { igUserId: contact.ig_user_id, username: contact.username },
					text: rendered.text,
					mediaId: event.mediaId,
					webhookId: action.webhook_id,
				});
				if (outbound.delivered === 0) {
					if (outbound.failed > 0) {
						return finishFailure("Nenhum webhook de saída entregou a requisição.");
					}
					fireLog({ ...baseLog, status: "skipped", error: "sem_webhook" });
					return { ok: false, skipped: true, reason: "sem_webhook" };
				}
				return finishSuccess(
					{ outboundEvent, webhookId: action.webhook_id ?? null },
					{
						delivered: outbound.delivered,
						failed: outbound.failed,
					},
				);
			}

			default:
				return finishFailure(
					actionType
						? `Tipo de ação não suportado: ${actionType}.`
						: "Ação sem tipo configurado.",
				);
		}
	} catch (err) {
		return finishFailure(errorMessage(err));
	}
}

function hasContent(rendered: IgRenderedAction | null | undefined): boolean {
	if (!rendered) return false;
	if (typeof rendered.text === "string" && rendered.text.trim()) return true;
	if (rendered.buttons && rendered.buttons.length > 0) return true;
	if (rendered.quickReplies && rendered.quickReplies.length > 0) return true;
	return false;
}

async function renderMessage(
	action: IgAutomationActionRow,
	vars: IgRenderVars,
	channel: ExecuteActionChannel,
	contact: ExecuteActionContact,
	automation: IgAutomationRow,
	event: ExecuteActionEvent,
): Promise<IgRenderedAction> {
	return renderAction(action, vars, {
		createClickLink: (targetUrl) =>
			createClickLink({
				userId: channel.user_id,
				channelId: channel.id,
				automationId: automation.id,
				contactId: contact.id,
				targetUrl,
				utm: {
					source: "instagram",
					medium: event.kind === "comment" ? "comment" : "dm",
					campaign: automation.id,
				},
			}),
	});
}
