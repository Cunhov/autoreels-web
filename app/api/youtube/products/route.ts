import { NextResponse } from "next/server";
import {
	requireOwnedYoutubeChannel,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import { listProducts } from "@/lib/youtube";
import { getChannelProxyUrl } from "@/lib/proxy";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/youtube/products?channelId=&videoId=&query=&suggestions=&limit=...
 * Busca produtos afiliados taggeáveis pela sessão (YouTube Shopping).
 * `videoId` agora é OPCIONAL (B3/F3): quando ausente, a rota resolve o
 * último Short publicado do canal a partir do Post.youtube_video_id.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const guard = await requireOwnedYoutubeChannel(url.searchParams.get("channelId"));
	if (!guard.ok) return guard.response;

	const videoIdParam = (url.searchParams.get("videoId") || "").trim();
	const resolvedVideoId = await resolveVideoIdForProductSearch(
		videoIdParam,
		guard.channel.id,
	);
	if (!resolvedVideoId) {
		// B3/F3 — sem vídeo explícito e sem nenhum Short publicado no canal:
		// não há vídeo alvo para a tagagem. Erro PT-BR claro. O fluxo de vídeo
		// isca (sacrifice_video_id / POST /api/sessions/{id}/config da API
		// externa) fica para fase futura — documentado em
		// docs/PLANNER_AUDIT_REPORT.md §2 P0-B3, NÃO implementado aqui.
		return NextResponse.json(
			{
				error:
					"Nenhum vídeo publicado para buscar produtos — publique um Short primeiro.",
			},
			{ status: 400 },
		);
	}

	const query = url.searchParams.get("query") || "";
	const suggestions = url.searchParams.get("suggestions") === "true";
	if (!query && !suggestions) {
		return NextResponse.json(
			{ error: "Informe 'query' (busca) ou 'suggestions=true'." },
			{ status: 400 },
		);
	}

	const limitRaw = Number(url.searchParams.get("limit") || 50);
	const limit = Number.isFinite(limitRaw)
		? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
		: 50;
	// sort é repassado à API externa — valores inválidos são rejeitados em vez
	// de silenciosamente ignorados.
	const VALID_SORTS = ["relevance", "price_asc", "price_desc", "commission_desc"] as const;
	type SortValue = (typeof VALID_SORTS)[number];
	const sortRaw = url.searchParams.get("sort") || "relevance";
	if (!VALID_SORTS.includes(sortRaw as SortValue)) {
		return NextResponse.json(
			{ error: `sort inválido (use: ${VALID_SORTS.join(", ")}).` },
			{ status: 400 },
		);
	}
	const sort = sortRaw as SortValue;
	const minCommissionRaw = Number(url.searchParams.get("minCommissionPct"));
	const minCommissionPct =
		Number.isFinite(minCommissionRaw) && minCommissionRaw > 0
			? Math.min(minCommissionRaw, 100)
			: undefined;

	try {
		const products = await listProducts(
			guard.sessionId,
			resolvedVideoId,
			{
				query,
				suggestions,
				title: url.searchParams.get("title") || undefined,
				description: url.searchParams.get("description") || undefined,
				vendors: url.searchParams.get("vendors") || undefined,
				minCommissionPct,
				sort,
				limit,
			},
			// F4: proxy do canal (Channel.proxy_url, com fallback para
			// settings.proxy_url) — mesma cobertura do publisher (audit-track-api
			// F4-Wide); um canal atrás de proxy busca produtos pelo proxy.
			getChannelProxyUrl(guard.channel),
		);
		return NextResponse.json({
			session_id: guard.sessionId,
			video_id: resolvedVideoId,
			count: products.length,
			products,
		});
	} catch (error: unknown) {
		return NextResponse.json(
			{ error: youtubeErrorMessage(error) },
			{ status: 502 },
		);
	}
}

/**
 * Resolve o videoId alvo da busca de produtos (B3/F3):
 * 1. videoId explícito na query — retrocompat preservada (channelId+videoId+
 *    query continua aceito e tem prioridade);
 * 2. ausente → último Short publicado do canal (Post.status="published" com
 *    youtube_video_id preenchido, mais recente por published_at);
 * 3. nenhum → null — o caller responde 400 PT-BR orientando publicar um Short.
 */
async function resolveVideoIdForProductSearch(
	explicitVideoId: string,
	channelId: string,
): Promise<string | null> {
	const videoId = explicitVideoId.trim();
	if (videoId) return videoId;
	const lastPublished = await prisma.post.findFirst({
		where: {
			channel_id: channelId,
			status: "published",
			youtube_video_id: { not: null },
		},
		orderBy: { published_at: "desc" },
		select: { youtube_video_id: true },
	});
	return lastPublished?.youtube_video_id ?? null;
}
