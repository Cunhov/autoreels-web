/**
 * lib/first-comment.ts — F4: primeiro comentário do Short (YouTube).
 *
 * Decisão do dono: o campo first_comment vive no ContentItem (library);
 * buildPostData faz o SNAPSHOT para a row do Post (Post.first_comment).
 * Este módulo orquestra a publicação do comentário DEPOIS do Short — extraído
 * do publisher (app/api/cron/publisher/route.ts) para ser testável sem subir
 * o servidor, mesmo padrão do lib/publisher-race-guard.ts (route files do
 * Next só exportam métodos HTTP; exportar helpers quebra `next build`).
 *
 * Contrato (spec F4):
 *   - chamado APÓS o Short ser publicado com sucesso (youtube_video_id gravado);
 *   - falha de comentário NUNCA falha o post nem re-tenta: loga warning PT-BR
 *     e segue — o status/failed_reason do Post não mudam (este módulo não tem
 *     acesso a escrita de Post por construção);
 *   - texto vazio / Short sem video_id remoto / canal sem sessão → SKIP com
 *     warning (nenhuma chamada à API é feita);
 *   - o proxy do canal é SEMPRE repassado (getChannelProxyUrl).
 */
import { createComment } from "@/lib/youtube";

export type FirstCommentLogLevel = "info" | "warning" | "error";

export type FirstCommentLogger = (
	message: string,
	level?: FirstCommentLogLevel,
) => void | Promise<void>;

export interface PublishYoutubeFirstCommentInput {
	/** id do Post (apenas para log/instrumentação). */
	postId: string;
	/** id do planner (apenas para log/instrumentação). */
	plannerId: string;
	/** video_id remoto do Short publicado (Post.youtube_video_id). */
	videoId: string | null | undefined;
	/** sessão do canal YouTube (getYoutubeSessionId(channel.settings)). */
	sessionId: string;
	/** texto do primeiro comentário (Post.first_comment). */
	text: string | null | undefined;
	/** proxy do canal — SEMPRE repassado (M16). */
	proxyUrl?: string | null;
	/** injetor de log (publisher passa logPlanner(plannerId, msg, level)). */
	log?: FirstCommentLogger;
}

/**
 * Publica o primeiro comentário no Short já publicado. Retorna true quando o
 * comentário foi criado; false em qualquer outro desfecho (nunca lança — a
 * falha do comentário não pode derrubar o desfecho `published` do post).
 */
export async function publishYoutubeFirstComment(
	input: PublishYoutubeFirstCommentInput,
): Promise<boolean> {
	const { postId, plannerId, videoId, sessionId, proxyUrl } = input;
	const text = (input.text || "").trim();
	const prefix = `[YouTube] Post ${postId}`;
	const log =
		input.log ||
		((_message: string, _level?: FirstCommentLogLevel) => {
			/* default no-op — publisher injeta logPlanner */
		});

	if (!text) {
		await log(
			`${prefix}: primeiro comentário ignorado — texto vazio no post`,
			"warning",
		);
		return false;
	}
	if (!videoId) {
		await log(
			`${prefix}: primeiro comentário ignorado — Short sem video_id remoto`,
			"warning",
		);
		return false;
	}
	if (!sessionId) {
		await log(
			`${prefix}: primeiro comentário ignorado — canal sem sessão vinculada`,
			"warning",
		);
		return false;
	}

	try {
		await createComment(videoId, sessionId, text, proxyUrl ?? null);
		await log(
			`${prefix}: primeiro comentário publicado no Short (video ${videoId})`,
			"info",
		);
		return true;
	} catch (e) {
		const detail =
			e instanceof Error ? e.message : String(e ?? "Unknown error");
		// F4: falha de comentário NUNCA falha o post nem altera failed_reason.
		await log(
			`${prefix}: primeiro comentário FALHOU (isso NÃO afeta a publicação do Short): ${detail}`,
			"warning",
		);
		return false;
	}
}