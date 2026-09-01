import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
	findOtherUserYoutubeChannel,
	forgetYoutubeSessionOwner,
	getAuthenticatedUserId,
	recordYoutubeSessionOwner,
	youtubeErrorMessage,
} from "@/lib/youtube-channel";
import { isValidProxyUrl } from "@/lib/proxy";
import {
	createSession,
	deleteSession,
	getYoutubeSessionId,
	withYoutubeSessionId,
} from "@/lib/youtube";

const REQUIRED_COOKIES = [
	"LOGIN_INFO",
	"__Secure-3PAPISID",
	"__Secure-3PSID",
	"__Secure-3PSIDTS",
] as const;

interface ConnectBody {
	cookies?: Record<string, string>;
	label?: string;
	proxy_url?: string;
	proxy_enabled?: boolean;
}

/**
 * POST /api/youtube/connect
 * Recebe os 4 cookies + label opcional, registra a sessão na API externa
 * (POST /api/session) e cria/atualiza o Channel local platform="youtube".
 * O sessionId remoto é guardado em Channel.settings (JSON); os cookies
 * NUNCA são persistidos no banco do app.
 */
export async function POST(req: Request) {
	const userId = await getAuthenticatedUserId();
	if (!userId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: ConnectBody;
	try {
		body = (await req.json()) as ConnectBody;
	} catch {
		return NextResponse.json({ error: "Corpo inválido." }, { status: 400 });
	}

	const cookies: Record<string, string> = {};
	for (const key of REQUIRED_COOKIES) {
		const value = String(body?.cookies?.[key] || "").trim();
		if (!value) {
			return NextResponse.json(
				{ error: `Preencha todos os campos de cookie (faltando: ${key}).` },
				{ status: 400 },
			);
		}
		cookies[key] = value;
	}
	const label = String(body?.label || "").trim();
	let proxyUrl: string | null = null;
	if (body?.proxy_url !== undefined && body.proxy_url !== null && String(body.proxy_url).trim() !== "") {
		const raw = String(body.proxy_url).trim();
		if (!isValidProxyUrl(raw)) {
			return NextResponse.json({ error: "Proxy inválido. Use http://user:pass@host:porta" }, { status: 400 });
		}
		proxyUrl = raw;
	}
	const proxyEnabled = body?.proxy_enabled !== undefined ? Boolean(body.proxy_enabled) : true;

	// Sessão recém-criada na API externa. Enquanto o Channel local não for
	// gravado, ela é uma sessão "órfã" (sem dono no app) — qualquer falha
	// nesse intervalo precisa removê-la para não virar sessão vinculável.
	let pendingRemoteId = "";
	const cleanupPendingRemote = async () => {
		if (!pendingRemoteId) return;
		const id = pendingRemoteId;
		pendingRemoteId = "";
		await deleteSession(id).catch((err: unknown) => {
			console.warn(
				`[YoutubeConnect] Falha ao remover sessão remota órfã ${id.slice(0, 8)}…:`,
				err instanceof Error ? err.message : err,
			);
		});
		await forgetYoutubeSessionOwner(id).catch(() => {});
	};

	try {
		// A API externa valida os cookies e devolve channel_id/channel_name.
		const remote = await createSession(cookies, label);
		pendingRemoteId = remote.id;
		// Posse é obrigatória: sem o registro, a sessão ficaria "sem dono" e
		// apareceria na listagem de TODOS os usuários (podendo ser vinculada por
		// outro usuário). Falha aqui é fatal — remove a sessão remota órfã.
		try {
			await recordYoutubeSessionOwner(remote.id, userId);
		} catch (err: unknown) {
			console.warn(
				`[YoutubeConnect] Falha ao registrar posse da sessão ${remote.id.slice(0, 8)}…:`,
				err instanceof Error ? err.message : err,
			);
			await cleanupPendingRemote();
			return NextResponse.json(
				{
					error:
						"Não foi possível registrar a posse da sessão. Tente novamente.",
				},
				{ status: 502 },
			);
		}

		if (!remote.channel_id) {
			await cleanupPendingRemote();
			return NextResponse.json(
				{
					error:
						"A sessão foi criada, mas a API não retornou o ID do canal. Tente novamente com cookies atualizados.",
				},
				{ status: 502 },
			);
		}

		// Um mesmo canal remoto (account_id) só pode pertencer a um usuário.
		const conflict = await findOtherUserYoutubeChannel(remote.channel_id, userId);
		if (conflict) {
			await cleanupPendingRemote();
			return NextResponse.json(
				{ error: "Este canal do YouTube já está vinculado a outro usuário." },
				{ status: 409 },
			);
		}

		const settings = withYoutubeSessionId(null, remote.id);
		const name =
			label ||
			remote.channel_name ||
			`YouTube ${remote.channel_id}`;

		// Um canal por account_id (único global user_id+account_id no schema).
		// Se já existe, apenas revincula a nova sessão.
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
						proxy_url: proxyUrl,
						proxy_enabled: proxyEnabled,
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
						proxy_url: proxyUrl,
						proxy_enabled: proxyEnabled,
					},
				});

		// Canal gravado — a nova sessão tem dono. Remove a sessão remota ANTERIOR
		// que ficou órfã numa reconexão (best-effort).
		pendingRemoteId = "";
		if (oldSessionId && oldSessionId !== remote.id) {
			await deleteSession(oldSessionId).catch((err: unknown) => {
				console.warn(
					`[YoutubeConnect] Falha ao remover sessão remota anterior ${oldSessionId.slice(0, 8)}…:`,
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
		await cleanupPendingRemote();
		return NextResponse.json(
			{ error: youtubeErrorMessage(error) },
			{ status: 502 },
		);
	}
}
