import { NextResponse } from "next/server";
import {
	getAuthenticatedUserId,
	getKnownYoutubeSessionOwners,
	requireOwnedYoutubeChannel,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import { getChannelProxyUrl } from "@/lib/proxy";
import { listSessions } from "@/lib/youtube";

/**
 * GET /api/youtube/sessions?channelId=…
 * Proxy de GET /api/session da API externa — usado pela aba
 * "Importar sessão" do modal de canais YouTube.
 * `channelId` é OPCIONAL (M16): quando presente, a listagem roda pelo proxy
 * do canal (um canal atrás de proxy pode não enxergar a API direto). Sem
 * channelId o comportamento é o anterior — chamada direta (a listagem cobra
 * TODAS as sessões da API, sem canal único).
 */
export async function GET(req: Request) {
	const userId = await getAuthenticatedUserId();
	if (!userId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	// Resolve proxy apenas quando o caller estreita a listagem a um canal.
	let proxy: string | null = null;
	const channelId = new URL(req.url).searchParams.get("channelId");
	if (channelId) {
		const guard = await requireOwnedYoutubeChannel(channelId);
		if (!guard.ok) return guard.response;
		proxy = getChannelProxyUrl(guard.channel);
	}

	try {
		// Só expõe sessões sem dono conhecido ou criadas/reivindicadas pelo
		// próprio usuário. O dono considera tanto os Channels existentes quanto
		// o criador registrado em YoutubeSession — sessões "órfãs" (ex.: canal
		// local excluído sem excluir a sessão remota) permanecem visíveis apenas
		// para quem as criou, nunca para outros usuários.
		const [owners, all] = await Promise.all([
			getKnownYoutubeSessionOwners(),
			listSessions(proxy),
		]);
		const sessions = all.filter((s) => {
			const owner = owners.get(s.id);
			return owner === undefined || owner === userId;
		});
		return NextResponse.json({ sessions });
	} catch (error: unknown) {
		return NextResponse.json(
			{ error: youtubeErrorMessage(error) },
			{ status: 502 },
		);
	}
}
