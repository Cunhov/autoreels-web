import { NextResponse } from "next/server";
import {
	requireOwnedYoutubeChannel,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import { getSession, listProducts } from "@/lib/youtube";
import { getChannelProxyUrl } from "@/lib/proxy";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/youtube/products?channelId=&videoId=&query=&suggestions=&limit=...
 * Busca produtos afiliados taggeáveis pela sessão (YouTube Shopping).
 * `videoId` é OPCIONAL (B3): quando ausente, a rota resolve o vídeo alvo na
 * ordem: (1) último Short publicado do canal, (2) sacrifice_video_id da
 * sessão remota (configurado na API externa via POST /api/sessions/{id}/config).
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const guard = await requireOwnedYoutubeChannel(url.searchParams.get("channelId"));
	if (!guard.ok) return guard.response;

	const videoIdParam = (url.searchParams.get("videoId") || "").trim();
	const resolvedVideoId = await resolveVideoIdForProductSearch({
		explicitVideoId: videoIdParam,
		channelId: guard.channel.id,
		sessionId: guard.sessionId,
		proxyUrl: getChannelProxyUrl(guard.channel),
	});
	if (!resolvedVideoId) {
		return NextResponse.json(
			{
				error:
					"Nenhum vídeo disponível para buscar produtos. Publique um Short no canal " +
					"ou configure o vídeo isca da sessão na API (sacrifice_video_id).",
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
			// B3: proxy do canal (Channel.proxy_url, com fallback para
			// settings.proxy_url) — mesma cobertura do publisher (audit-track-api
			// F4-Wide planeja ampliar p/ rotas de gerenciamento); um canal atrás
			// de proxy busca produtos pelo proxy.
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
 * Resolve o videoId alvo da busca de produtos:
 * 1. videoId explícito na query — retrocompat preservada (maior prioridade);
 * 2. ausente → último Short publicado do canal (Post.status="published" com
 *    youtube_video_id preenchido, mais recente por published_at);
 * 3. ausente → sacrifice_video_id da sessão remota (configurado na API externa
 *    via POST /api/sessions/{id}/config — o vídeo isca que a token farm usa);
 * 4. nenhum → null — o caller responde 400 PT-BR claro.
 */
async function resolveVideoIdForProductSearch(opts: {
	explicitVideoId: string;
	channelId: string;
	sessionId: string;
	proxyUrl: string | null;
}): Promise<string | null> {
	const { explicitVideoId, channelId, sessionId, proxyUrl } = opts;
	const videoId = explicitVideoId.trim();
	if (videoId) return videoId;

	const lastPublished = await prisma.post.findFirst({
		where: {
			channel_id: channelId,
			status: "published",
			// publisher grava `short.video_id || null` — nunca string vazia hoje,
			// mas dados legados podem conter "" (id não-11-char = fake); excluir.
			youtube_video_id: { not: null },
			NOT: [{ youtube_video_id: { equals: "" } }],
		},
		orderBy: { published_at: "desc" },
		select: { youtube_video_id: true },
	});
	if (lastPublished?.youtube_video_id) return lastPublished.youtube_video_id;

	// Fallback 3: sacrifice_video_id já configurado na API externa (vídeo isca).
	// Busca a sessão remota direto da API (ex.: o usuário configurou o sacrifício
	// mas ainda não publicou nada pelo app) — mesmo proxy do canal.
	try {
		const session = await getSession(sessionId, proxyUrl);
		const sacrifice = (session?.sacrifice_video_id || "").trim();
		if (sacrifice) return sacrifice;
	} catch {
		// Sessão remota indisponível/timeout — segue sem sacrifício; o caller
		// responde 400 com orientação clara em vez de propagar 502.
	}

	return null;
}
