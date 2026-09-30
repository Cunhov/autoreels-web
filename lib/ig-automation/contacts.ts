/**
 * lib/ig-automation/contacts.ts — operações de contato usadas pelo
 * engine/webhook (spec §5.3/§5.6/§5.11).
 *
 * Regras:
 * - upsert por `(channel_id, ig_user_id)`; NUNCA zera campos existentes;
 *   `username`/`last_message_at`/`last_comment_at` só são tocados quando
 *   vierem preenchidos (`at` explícito para os timestamps).
 * - `incrementInteractions`/`pauseContact`/`resumeContact` nunca lançam
 *   (best-effort, erro apenas logado de forma curta, sem dados sensíveis).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface UpsertContactParams {
	userId: string;
	channelId: string;
	igUserId: string;
	username?: string | null;
	isComment?: boolean;
	at?: Date | null;
}

export interface IgContactSummary {
	id: string;
	ig_user_id: string;
	username: string | null;
	interactions_count: number;
	bot_paused_until: Date | null;
}

function shortError(error: unknown): string {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code !== "") return code;
	}
	if (error instanceof Error && error.name) return error.name;
	return "Error";
}

function clean(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function validDate(value: unknown): Date | null {
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	return null;
}

/**
 * Cria/atualiza o contato pelo par `(channel_id, ig_user_id)`.
 * - `username`: atualizado apenas quando vier não vazio.
 * - `at`: quando informado, atualiza `last_comment_at` (isComment) ou
 *   `last_message_at`; quando ausente, os campos ficam intocados.
 */
export async function upsertContact(
	params: UpsertContactParams,
): Promise<IgContactSummary> {
	const channelId = clean(params.channelId);
	const igUserId = clean(params.igUserId);
	const userId = clean(params.userId);
	if (!channelId) throw new Error("Canal é obrigatório para salvar o contato.");
	if (!igUserId) {
		throw new Error("ID do usuário do Instagram é obrigatório para salvar o contato.");
	}
	if (!userId) throw new Error("Usuário é obrigatório para salvar o contato.");

	const username = clean(params.username) || null;
	const at = validDate(params.at);

	const update: Prisma.IgContactUncheckedUpdateInput = {};
	if (username !== null) update.username = username;
	if (at !== null) {
		if (params.isComment === true) update.last_comment_at = at;
		else update.last_message_at = at;
	}

	const create: Prisma.IgContactUncheckedCreateInput = {
		user_id: userId,
		channel_id: channelId,
		ig_user_id: igUserId,
		username,
	};
	if (at !== null) {
		if (params.isComment === true) create.last_comment_at = at;
		else create.last_message_at = at;
	}

	return prisma.igContact.upsert({
		where: {
			channel_id_ig_user_id: { channel_id: channelId, ig_user_id: igUserId },
		},
		create,
		update,
		select: {
			id: true,
			ig_user_id: true,
			username: true,
			interactions_count: true,
			bot_paused_until: true,
		},
	});
}

/** Incrementa `interactions_count` (nunca lança). */
export async function incrementInteractions(contactId: string): Promise<void> {
	const id = clean(contactId);
	if (!id) return;
	try {
		await prisma.igContact.updateMany({
			where: { id },
			data: { interactions_count: { increment: 1 } },
		});
	} catch (error) {
		console.error(
			"[ig-automation] incrementInteractions falhou:",
			shortError(error),
		);
	}
}

/**
 * Pausa o bot para o contato por `hours` horas (usado pelo echo/human takeover
 * e pelo endpoint de pausa manual). `hours <= 0`/inválido pausa até agora.
 */
export async function pauseContact(
	contactId: string,
	hours: number,
): Promise<void> {
	const id = clean(contactId);
	if (!id) return;
	const safeHours =
		typeof hours === "number" && Number.isFinite(hours) && hours > 0
			? hours
			: 0;
	const until = new Date(Date.now() + safeHours * 3_600_000);
	if (Number.isNaN(until.getTime())) return;
	try {
		await prisma.igContact.updateMany({
			where: { id },
			data: { bot_paused_until: until },
		});
	} catch (error) {
		console.error("[ig-automation] pauseContact falhou:", shortError(error));
	}
}

/** Retoma o bot para o contato (bot_paused_until = null). Nunca lança. */
export async function resumeContact(contactId: string): Promise<void> {
	const id = clean(contactId);
	if (!id) return;
	try {
		await prisma.igContact.updateMany({
			where: { id },
			data: { bot_paused_until: null },
		});
	} catch (error) {
		console.error("[ig-automation] resumeContact falhou:", shortError(error));
	}
}
