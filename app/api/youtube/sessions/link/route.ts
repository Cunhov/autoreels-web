import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
	findOtherUserYoutubeChannel,
	forgetYoutubeSessionOwner,
	getAuthenticatedUserId,
	getKnownYoutubeSessionOwners,
	recordYoutubeSessionOwner,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import {
	deleteSession,
	getYoutubeSessionId,
	listSessions,
	withYoutubeSessionId,
} from "@/lib/youtube";
import { getChannelProxyUrl } from "@/lib/proxy";

interface LinkBody {
	sessionId?: string;
	label?: string;
}

/**
 * POST /api/youtube/sessions/link
 * Vincula uma sessão JÁ EXISTENTE na API externa (listada pela aba
 * "Importar sessão") a um Channel local platform="youtube".
 * O sessionId remoto é guardado em Channel.settings (JSON).
 */
export async function POST(req: Request) {
	const userId = await getAuthenticatedUserId();
	if (!userId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: LinkBody;
	try {
		body = (await req.json()) as LinkBody;
	} catch {
		return NextResponse.json({ error: "Corpo inválido." }, { status: 400 });
	}

	const sessionId = String(body?.sessionId || "").trim();
	if (!sessionId) {
		return NextResponse.json(
			{ error: "sessionId é obrigatório." },
			{ status: 400 },
		);
	}

	try {
		// Posse: a sessão reivindicada OU criada por OUTRO usuário não pode ser
		// vinculada (caso contrário qualquer usuário publicaria no canal alheio).
		// O mapa inclui o criador registrado em YoutubeSession, que persiste
		// mesmo depois de o canal local ser excluído.
		const owners = await getKnownYoutubeSessionOwners();
		const owner = owners.get(sessionId);
		if (owner !== undefined && owner !== userId) {
			return NextResponse.json(
				{ error: "Esta sessão já está vinculada a outro usuário." },
				{ status: 409 },
			);
		}

		const sessions = await listSessions();
		const remote = sessions.find((s) => s.id === sessionId);
		if (!remote) {
			return NextResponse.json(
				{ error: "Sessão não encontrada na API externa." },
				{ status: 404 },
			);
		}
		if (!remote.channel_id) {
			return NextResponse.json(
				{
					error:
						"A sessão ainda não tem um canal YouTube associado — aguarde a validação dos cookies ou vincule com novos cookies.",
				},
				{ status: 409 },
			);
		}

		// Um mesmo canal remoto (account_id) só pode pertencer a um usuário.
		const conflict = await findOtherUserYoutubeChannel(remote.channel_id, userId);
		if (conflict) {
			return NextResponse.json(
				{ error: "Este canal do YouTube já está vinculado a outro usuário." },
				{ status: 409 },
			);
		}

		const settings = withYoutubeSessionId(null, remote.id);
		const name =
			String(body?.label || "").trim() ||
			remote.channel_name ||
			`YouTube ${remote.channel_id}`;

		// Um canal por account_id — se já existe, apenas revincula a sessão.
		const existing = await prisma.channel.findFirst({
			where: { user_id: userId, platform: "youtube", account_id: remote.channel_id },
		});
		const oldSessionId = existing ? getYoutubeSessionId(existing.settings) : "";

		const channel = existing
			? await prisma.channel.update({
					where: { id: existing.id },
					data: {
						name,
						username: remote.channel_name ?? existing.username,
						settings,
						status: "active",
						token_source: "youtube_session",
						token_refreshed_at: new Date(),
						token_expires_at: null,
					},
				})
			: await prisma.channel.create({
					data: {
						user_id: userId,
						name,
						platform: "youtube",
						account_id: remote.channel_id,
						username: remote.channel_name,
						status: "active",
						settings,
						token_source: "youtube_session",
						token_refreshed_at: new Date(),
					},
				});

		// Registra a posse da sessão vinculada e limpa a sessão remota ANTERIOR
		// que ficou órfã numa revinculação (best-effort — não bloqueia a resposta).
		await recordYoutubeSessionOwner(remote.id, userId).catch(() => {});
		if (oldSessionId && oldSessionId !== remote.id) {
			// M16: a sessão remota anterior pertence a este canal — excluí-la
			// pela MESMA rede (proxy do canal) usada na publicação.
			await deleteSession(oldSessionId, getChannelProxyUrl(existing)).catch((err: unknown) => {
				console.warn(
					`[YoutubeLink] Falha ao remover sessão remota anterior ${oldSessionId.slice(0, 8)}…:`,
					err instanceof Error ? err.message : err,
				);
			});
			await forgetYoutubeSessionOwner(oldSessionId).catch(() => {});
		}

		return NextResponse.json(
			{
				id: channel.id,
				name: channel.name,
				account_id: channel.account_id,
				username: channel.username,
				session: {
					id: remote.id,
					status: remote.status,
					channel_name: remote.channel_name,
				},
			},
			{ status: 201 },
		);
	} catch (error: unknown) {
		return NextResponse.json(
			{ error: youtubeErrorMessage(error) },
			{ status: 502 },
		);
	}
}
