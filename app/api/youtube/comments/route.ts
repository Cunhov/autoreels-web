import { NextResponse } from "next/server";
import {
	requireOwnedYoutubeChannel,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import {
	commentAction,
	createComment,
	createPinnedComment,
	listComments,
} from "@/lib/youtube";

/**
 * GET /api/youtube/comments?channelId=&videoId=&limit=20
 * Lista os comentários de um vídeo/Short publicado pelo canal.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const guard = await requireOwnedYoutubeChannel(url.searchParams.get("channelId"));
	if (!guard.ok) return guard.response;

	const videoId = (url.searchParams.get("videoId") || "").trim();
	if (!videoId) {
		return NextResponse.json(
			{ error: "videoId é obrigatório." },
			{ status: 400 },
		);
	}
	const limitRaw = Number(url.searchParams.get("limit") || 20);
	const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 20;

	try {
		const comments = await listComments(videoId, guard.sessionId, limit);
		return NextResponse.json({ video_id: videoId, count: comments.length, comments });
	} catch (error: unknown) {
		return NextResponse.json(
			{ error: youtubeErrorMessage(error) },
			{ status: 502 },
		);
	}
}

interface CommentActionBody {
	channelId?: string;
	videoId?: string;
	// Criar comentário
	text?: string;
	// Ação em comentário existente
	commentId?: string;
	action?: "like" | "heart" | "pin";
	// Comentário fixado (fluxo completo)
	pinned?: boolean;
	like?: boolean;
	heart?: boolean;
}

/**
 * POST /api/youtube/comments — três operações, diferenciadas pelo corpo:
 *  1. { channelId, videoId, text }                          → cria comentário
 *  2. { channelId, videoId, commentId, action }             → like | heart | pin
 *  3. { channelId, videoId, text, pinned: true, like?, heart? } → comentário fixado
 */
export async function POST(req: Request) {
	let body: CommentActionBody;
	try {
		body = (await req.json()) as CommentActionBody;
	} catch {
		return NextResponse.json({ error: "Corpo inválido." }, { status: 400 });
	}

	const guard = await requireOwnedYoutubeChannel(body?.channelId);
	if (!guard.ok) return guard.response;

	const videoId = String(body?.videoId || "").trim();
	if (!videoId) {
		return NextResponse.json({ error: "videoId é obrigatório." }, { status: 400 });
	}
	const sessionId = guard.sessionId;

	try {
		if (body.action) {
			if (!body.commentId) {
				return NextResponse.json(
					{ error: "commentId é obrigatório para ações." },
					{ status: 400 },
				);
			}
			if (!["like", "heart", "pin"].includes(body.action)) {
				return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
			}
			await commentAction(videoId, sessionId, body.commentId, body.action);
			return NextResponse.json({
				ok: true,
				video_id: videoId,
				comment_id: body.commentId,
				action: body.action,
			});
		}

		const text = String(body?.text || "").trim();
		if (!text) {
			return NextResponse.json(
				{ error: "O texto do comentário não pode ficar vazio." },
				{ status: 400 },
			);
		}
		// Evita erro bruto da API externa/YouTube para textos muito longos.
		if (text.length > 10000) {
			return NextResponse.json(
				{ error: "O comentário excede o limite de 10.000 caracteres." },
				{ status: 400 },
			);
		}

		if (body.pinned) {
			const result = await createPinnedComment(videoId, sessionId, text, {
				like: Boolean(body.like),
				heart: body.heart !== false,
			});
			return NextResponse.json({ ok: true, pinned: true, result }, { status: 201 });
		}

		const created = await createComment(videoId, sessionId, text);
		return NextResponse.json({ ok: true, ...created }, { status: 201 });
	} catch (error: unknown) {
		return NextResponse.json(
			{ error: youtubeErrorMessage(error) },
			{ status: 502 },
		);
	}
}
