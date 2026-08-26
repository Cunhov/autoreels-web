import { NextResponse } from "next/server";
import { getHealth } from "@/lib/youtube";
import {
	getAuthenticatedUserId,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";

/**
 * GET /api/youtube/health
 * Status da integração para a tela de Ajustes: informa se as env vars estão
 * configuradas (sem vazar segredos) e faz ping em /api/health da API externa.
 */
export async function GET() {
	const userId = await getAuthenticatedUserId();
	if (!userId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	// Mesma normalização do getYoutubeConfig() (lib/youtube.ts): corta a barra
	// final E faz trim de espaços do env bruto antes do Boolean. Em
	// YOUTUBE_API_BASE_URL="/" o env cru é truthy mas a base normalizada é
	// vazia; em YOUTUBE_API_BASE_URL="  " o trim(z) também zera — sem isto a
	// health reportaria configured:true e o getHealth() lançaria logo em
	// seguida, divergindo da Settings (que fala com getYoutubeConfig).
	const baseUrl = (process.env.YOUTUBE_API_BASE_URL || "").trim().replace(/\/$/, "");
	const hasApiKey = Boolean((process.env.YOUTUBE_API_KEY || "").trim());
	// Mesmo critério do getYoutubeConfig(): AS DUAS envs são obrigatórias —
	// sem BASE_URL o app tentaria localhost:8000 dentro do container, então
	// reportar "configurada" só com a KEY seria estado mentiroso na UI.
	const configured = Boolean(baseUrl) && hasApiKey;

	if (!configured) {
		return NextResponse.json({
			configured: false,
			base_url_configured: Boolean(baseUrl),
			api_key_configured: hasApiKey,
		});
	}

	try {
		const health = await getHealth();
		return NextResponse.json({
			configured: true,
			base_url_configured: true,
			api_key_configured: true,
			ok: health.ok,
			sessions_active: health.sessions_active,
			db_connected: health.db_connected,
			version: health.version,
		});
	} catch (error: unknown) {
		return NextResponse.json(
			{
				configured: true,
				base_url_configured: true,
				api_key_configured: true,
				ok: false,
				error: youtubeErrorMessage(error),
			},
			{ status: 502 },
		);
	}
}
