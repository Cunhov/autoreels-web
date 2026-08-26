/**
 * Helpers server-side compartilhados pelas rotas /api/youtube/*:
 * autenticação NextAuth + verificação de posse do canal YouTube +
 * leitura do sessionId da sessão remota armazenado em Channel.settings.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Channel } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";
import { getYoutubeSessionId } from "@/lib/youtube";

export async function getAuthenticatedUserId(): Promise<string | null | undefined> {
	const session = await getServerSession(authOptions);
	return getSessionUserId(session);
}

export type YoutubeChannelResult =
	| { ok: true; userId: string; channel: Channel; sessionId: string }
	| { ok: false; response: NextResponse };

/**
 * Valida que o canal existe, pertence ao user logado e é um canal YouTube
 * com sessão vinculada. Retorna resposta pronta em caso de falha.
 */
export async function requireOwnedYoutubeChannel(
	channelId: string | null | undefined,
): Promise<YoutubeChannelResult> {
	const userId = await getAuthenticatedUserId();
	if (!userId) {
		return {
			ok: false,
			response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
		};
	}
	if (!channelId) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "channelId é obrigatório." },
				{ status: 400 },
			),
		};
	}
	const channel = await prisma.channel.findFirst({
		where: { id: channelId, user_id: userId },
	});
	if (!channel) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "Canal não encontrado." },
				{ status: 404 },
			),
		};
	}
	if (channel.platform !== "youtube") {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "Este canal não é do YouTube." },
				{ status: 400 },
			),
		};
	}
	const sessionId = getYoutubeSessionId(channel.settings);
	if (!sessionId) {
		return {
			ok: false,
			response: NextResponse.json(
				{
					error:
						"Canal YouTube sem sessão vinculada — reconecte-o em Canais.",
				},
				{ status: 400 },
			),
		};
	}
	return { ok: true, userId, channel, sessionId };
}

/**
 * Mapa de sessões remotas já reivindicadas por algum usuário do app:
 * sessionId remoto → user_id dono. Baseado nos Channels platform="youtube"
 * existentes (settings.sessionId). Usado para não expor sessões de outros
 * usuários na listagem/importação e impedir vincular sessão alheia.
 */
export async function getClaimedYoutubeSessions(): Promise<Map<string, string>> {
	const channels = await prisma.channel.findMany({
		where: { platform: "youtube" },
		select: { user_id: true, settings: true },
	});
	const claimed = new Map<string, string>();
	for (const ch of channels) {
		const sid = getYoutubeSessionId(ch.settings);
		if (sid && !claimed.has(sid)) claimed.set(sid, ch.user_id);
	}
	return claimed;
}

/** Registra (ou atualiza) o criador de uma sessão remota no banco local. */
export function recordYoutubeSessionOwner(
	remoteId: string,
	userId: string,
): Promise<unknown> {
	return prisma.youtubeSession.upsert({
		where: { remote_id: remoteId },
		update: {},
		create: { remote_id: remoteId, created_by_user_id: userId },
	});
}

/** Remove o registro de criador (quando a sessão remota é deletada). */
export function forgetYoutubeSessionOwner(remoteId: string): Promise<unknown> {
	return prisma.youtubeSession.deleteMany({ where: { remote_id: remoteId } });
}

/**
 * Mapa completo remote_id → user_id conhecido: união das sessões reivindicadas
 * via Channel + os criadores registrados em YoutubeSession (persiste mesmo
 * após a exclusão do canal local — evita "sessões órfãs" vinculáveis).
 */
export async function getKnownYoutubeSessionOwners(): Promise<Map<string, string>> {
	const [claimed, owned] = await Promise.all([
		getClaimedYoutubeSessions(),
		prisma.youtubeSession.findMany({
			select: { remote_id: true, created_by_user_id: true },
		}),
	]);
	for (const row of owned) {
		if (!claimed.has(row.remote_id)) {
			claimed.set(row.remote_id, row.created_by_user_id);
		}
	}
	return claimed;
}

/**
 * Retorna o Channel de OUTRO usuário já vinculado ao mesmo canal remoto
 * (account_id = channel_id do YouTube) — usados para recusar vinculação
 * duplicada de um mesmo canal entre usuários distintos.
 */
export function findOtherUserYoutubeChannel(accountId: string, userId: string) {
	return prisma.channel.findFirst({
		where: {
			platform: "youtube",
			account_id: accountId,
			NOT: { user_id: userId },
		},
		select: { id: true, user_id: true },
	});
}

/** Mensagem amigável a partir de um erro desconhecido. */
export function youtubeErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error ?? "Erro inesperado na integração YouTube.");
}
