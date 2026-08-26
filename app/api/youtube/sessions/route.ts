import { NextResponse } from "next/server";
import {
	getAuthenticatedUserId,
	getKnownYoutubeSessionOwners,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import { listSessions } from "@/lib/youtube";

/**
 * GET /api/youtube/sessions
 * Proxy de GET /api/session da API externa — usado pela aba
 * "Importar sessão" do modal de canais YouTube.
 */
export async function GET() {
	const userId = await getAuthenticatedUserId();
	if (!userId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	try {
		// Só expõe sessões sem dono conhecido ou criadas/reivindicadas pelo
		// próprio usuário. O dono considera tanto os Channels existentes quanto
		// o criador registrado em YoutubeSession — sessões "órfãs" (ex.: canal
		// local excluído sem excluir a sessão remota) permanecem visíveis apenas
		// para quem as criou, nunca para outros usuários.
		const [owners, all] = await Promise.all([
			getKnownYoutubeSessionOwners(),
			listSessions(),
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
