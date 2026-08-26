import { NextResponse } from "next/server";
import {
	requireOwnedYoutubeChannel,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import { listProducts } from "@/lib/youtube";

/**
 * GET /api/youtube/products?channelId=&videoId=&query=&suggestions=&limit=...
 * Busca produtos afiliados taggeáveis pela sessão (YouTube Shopping).
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const guard = await requireOwnedYoutubeChannel(url.searchParams.get("channelId"));
	if (!guard.ok) return guard.response;

	const videoId = (url.searchParams.get("videoId") || "").trim();
	if (!videoId) {
		return NextResponse.json(
			{ error: "videoId é obrigatório (vídeo alvo da tagagem)." },
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
		const products = await listProducts(guard.sessionId, videoId, {
			query,
			suggestions,
			title: url.searchParams.get("title") || undefined,
			description: url.searchParams.get("description") || undefined,
			vendors: url.searchParams.get("vendors") || undefined,
			minCommissionPct,
			sort,
			limit,
		});
		return NextResponse.json({
			session_id: guard.sessionId,
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
