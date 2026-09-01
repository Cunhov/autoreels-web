import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
	requireOwnedYoutubeChannel,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import { getChannelProxyUrl } from "@/lib/proxy";
import { refreshSession, withYoutubeSessionId } from "@/lib/youtube";

/**
 * POST /api/channels/[id]/youtube/refresh
 * Força o refresh de cookies/tokens da sessão remota e atualiza o canal local.
 */
export async function POST(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const guard = await requireOwnedYoutubeChannel(id);
	if (!guard.ok) return guard.response;

	try {
		// M16: refresh da sessão passa pelo proxy do canal (mesmo caminho que o
		// publisher usa para publicar) — um canal atrás de proxy por bloqueio
		// geográfico/BotGuard não pode renovar cookies sem ele.
		const remote = await refreshSession(
			guard.sessionId,
			getChannelProxyUrl(guard.channel),
		);

		await prisma.channel.update({
			where: { id: guard.channel.id },
			data: {
				name:
					guard.channel.name && !guard.channel.name.startsWith("YouTube ")
						? guard.channel.name
						: remote.channel_name || guard.channel.name,
				username: remote.channel_name ?? guard.channel.username,
				settings: withYoutubeSessionId(guard.channel.settings, remote.id),
				status: "active",
				token_refreshed_at: new Date(),
				token_expires_at: null,
			},
		});

		return NextResponse.json({
			ok: true,
			session: {
				id: remote.id,
				status: remote.status,
				channel_name: remote.channel_name,
				last_rotate_at: remote.last_rotate_at,
			},
		});
	} catch (error: unknown) {
		return NextResponse.json(
			{ error: youtubeErrorMessage(error) },
			{ status: 502 },
		);
	}
}
