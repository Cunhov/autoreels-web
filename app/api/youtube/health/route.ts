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

	const baseUrl = process.env.YOUTUBE_API_BASE_URL || "";
	const hasApiKey = Boolean(process.env.YOUTUBE_API_KEY);
	// Mesmo critério do getYoutubeConfig(): só a KEY é obrigatória — o
	// BASE_URL tem default (http://localhost:8000), então não exigimos env
	// explícita para reportar "configurada" (estado mentiroso na UI).
	const configured = hasApiKey;

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
