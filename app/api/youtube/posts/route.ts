import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
	requireOwnedYoutubeChannel,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import { getChannelProxyUrl } from "@/lib/proxy";
import { deleteCommunityPost } from "@/lib/youtube";

/**
 * DELETE /api/youtube/posts?channelId=&remotePostId=
 * Exclui um post publicado na Comunidade do YouTube via API externa
 * (recurso v1 da spec, §1.4) e limpa o ponteiro local `youtube_post_id`.
 */
export async function DELETE(req: Request) {
	const url = new URL(req.url);
	const guard = await requireOwnedYoutubeChannel(url.searchParams.get("channelId"));
	if (!guard.ok) return guard.response;

	const remotePostId = (url.searchParams.get("remotePostId") || "").trim();
	if (!remotePostId) {
		return NextResponse.json(
			{ error: "remotePostId é obrigatório." },
			{ status: 400 },
		);
	}

	try {
		// M16: exclusão de post da Comunidade via proxy do canal — o post foi
		// publicado pela rede do canal; apagar sem proxy falharia para canais
		// que dependem dele (bloqueio geográfico/BotGuard).
		await deleteCommunityPost(
			guard.sessionId,
			remotePostId,
			getChannelProxyUrl(guard.channel),
		);
		// Best-effort: limpa a referência local ao post remoto excluído.
		await prisma.post.updateMany({
			where: {
				user_id: guard.userId,
				youtube_post_id: remotePostId,
			},
			data: { youtube_post_id: null },
		});
		return NextResponse.json({ ok: true, deleted: remotePostId });
	} catch (error: unknown) {
		return NextResponse.json(
			{ error: youtubeErrorMessage(error) },
			{ status: 502 },
		);
	}
}
