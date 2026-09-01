import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { fetchInstagramProfile, refreshInstagramToken } from "@/lib/instagram";
import { deleteSession, getYoutubeSessionId } from "@/lib/youtube";
import { isValidProxyUrl, maskProxyUrl } from "@/lib/proxy";

const channelSelect = {
    id: true,
    name: true,
    platform: true,
    account_id: true,
    username: true,
    profile_picture_url: true,
    status: true,
    token_source: true,
    token_expires_at: true,
    token_refreshed_at: true,
    created_at: true,
    access_token: true,
    proxy_url: true,
    proxy_enabled: true,
    settings: true,
};

const channelSelectFallback = {
    id: true,
    name: true,
    platform: true,
    account_id: true,
    username: true,
    profile_picture_url: true,
    status: true,
    token_source: true,
    token_expires_at: true,
    token_refreshed_at: true,
    created_at: true,
    access_token: true,
    settings: true,
};

function isMissingProxyColumnError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    return /no such column.*proxy|Unknown.*proxy|proxy_url/i.test(msg);
}

function toSafeChannel(channel: {
    access_token?: string | null;
    token_source?: string | null;
    proxy_url?: string | null;
    proxy_enabled?: boolean | null;
    [key: string]: unknown;
}) {
    const { access_token, proxy_url, proxy_enabled, ...safeChannel } = channel;
    const rest = safeChannel as Record<string, unknown>;
    return {
        ...rest,
        has_token: Boolean(access_token),
        token_source: access_token?.startsWith("token_")
            ? "redis"
            : (rest.token_source as string | undefined),
        has_proxy: Boolean(proxy_url),
        proxy_url_masked: proxy_url ? maskProxyUrl(proxy_url) : null,
        proxy_enabled: proxy_enabled ?? true,
    };
}

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let channel: unknown;
    try {
        channel = await prisma.channel.findUnique({
            where: { id, user_id: userId },
            select: channelSelect,
        });
    } catch (e: unknown) {
        if (isMissingProxyColumnError(e)) {
            console.warn(
                "[channels/[id]] proxy columns missing — falling back without proxy",
            );
            channel = await prisma.channel.findUnique({
                where: { id, user_id: userId },
                select: channelSelectFallback,
            });
        } else throw e;
    }

    if (!channel) {
        return NextResponse.json(
            { error: "Channel not found" },
            { status: 404 },
        );
    }

    return NextResponse.json(
        toSafeChannel(channel as Parameters<typeof toSafeChannel>[0]),
    );
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        // Canais YouTube não suportam edição direta: name/account_id/status são
        // derivados da sessão remota e o account_id é a chave dos checks de
        // posse/conflito — editar via PATCH poderia dessincronizá-los.
        const existing = await prisma.channel.findFirst({
            where: { id, user_id: userId },
            select: { platform: true },
        });
        if (!existing) {
            return NextResponse.json(
                { error: "Channel not found" },
                { status: 404 },
            );
        }
        const data = await req.json();
        // Para YouTube, só permite editar proxy (demais campos são derivados da sessão)
        const isYoutube = existing.platform === "youtube";
        if (isYoutube) {
            const allowedKeys = new Set(["proxy_url", "proxy_enabled"]);
            const hasOnlyProxy = Object.keys(data).every((k) =>
                allowedKeys.has(k),
            );
            if (!hasOnlyProxy) {
                return NextResponse.json(
                    {
                        error: "Canais YouTube só permitem editar o proxy — desconecte e reconecte para alterar outros dados.",
                    },
                    { status: 400 },
                );
            }
        }
        const updateData: Record<string, unknown> = isYoutube
            ? {}
            : {
                  name: data.name,
                  account_id: data.account_id,
                  username: data.username,
                  profile_picture_url: data.profile_picture_url,
                  status: data.status,
                  token_source: data.token_source,
              };
        // Proxy por canal — validação sempre permitida (inclusive YouTube)
        if (data.proxy_url !== undefined) {
            const raw =
                data.proxy_url === null || String(data.proxy_url).trim() === ""
                    ? null
                    : String(data.proxy_url).trim();
            if (raw !== null && !isValidProxyUrl(raw)) {
                return NextResponse.json(
                    {
                        error: "Proxy inválido. Use o formato http://user:pass@host:porta ou http://host:porta",
                    },
                    { status: 400 },
                );
            }
            updateData.proxy_url = raw;
        }
        if (data.proxy_enabled !== undefined) {
            updateData.proxy_enabled = Boolean(data.proxy_enabled);
        }
        // Se for YouTube e só proxy, já temos updateData pronto
        if (isYoutube && Object.keys(updateData).length === 0) {
            return NextResponse.json(
                { error: "Nenhum campo para atualizar." },
                { status: 400 },
            );
        }

        if (typeof data.access_token === "string" && data.access_token.trim()) {
            let accessToken = data.access_token.trim();
            // proxy pode vir do payload ou do canal existente
            let proxyForRefresh: string | null = null;
            if (
                typeof data.proxy_url === "string" &&
                String(data.proxy_url).trim()
            )
                proxyForRefresh = String(data.proxy_url).trim();
            else {
                const ch = await prisma.channel.findUnique({
                    where: { id, user_id: userId },
                    select: { proxy_url: true, proxy_enabled: true },
                });
                if (ch?.proxy_url && ch.proxy_enabled !== false) {
                    const { isValidProxyUrl: _valid } = await import(
                        "@/lib/proxy"
                    );
                    if (_valid(ch.proxy_url)) proxyForRefresh = ch.proxy_url;
                }
            }
            const refreshed = await refreshInstagramToken(
                accessToken,
                proxyForRefresh,
            ).catch(() => null);
            if (refreshed) {
                accessToken = refreshed.token;
                updateData.token_expires_at = new Date(
                    Date.now() + refreshed.expiresIn * 1000,
                );
                updateData.token_refreshed_at = new Date();
            }
            const profile = await fetchInstagramProfile(
                accessToken,
                proxyForRefresh,
            ).catch(() => null);
            if (profile) {
                updateData.account_id = data.account_id || profile.id;
                updateData.username = profile.username || null;
                updateData.profile_picture_url =
                    profile.profilePictureUrl || null;
                updateData.name = data.name || profile.username || data.name;
            }
            updateData.access_token = accessToken;
        }

        const channel = await prisma.channel.update({
            where: {
                id,
                user_id: userId,
            },
            data: updateData,
            select: channelSelect,
        });
        return NextResponse.json(toSafeChannel(channel));
    } catch (error: unknown) {
        return NextResponse.json(
            { error: getErrorMessage(error) },
            { status: 400 },
        );
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        // Canal YouTube: opção "excluir também a sessão na API externa"
        // (?deleteRemoteSession=true, default false). Best-effort — a exclusão
        // local do canal nunca depende da API externa responder.
        // Mesmo sem excluir a sessão remota, ela NÃO fica exposta a outros
        // usuários: o criador registrado em YoutubeSession persiste após a
        // exclusão do canal (tombstone) e continua filtrando a listagem e
        // bloqueando a vinculação por terceiros.
        const url = new URL(req.url);
        if (url.searchParams.get("deleteRemoteSession") === "true") {
            const channel = await prisma.channel.findFirst({
                where: { id, user_id: userId },
            });
            const sessionId =
                channel?.platform === "youtube"
                    ? getYoutubeSessionId(channel.settings)
                    : "";
            if (sessionId) {
                await deleteSession(sessionId).catch((err: unknown) => {
                    console.warn(
                        `[Channels] Falha ao excluir sessão remota do YouTube ${sessionId.slice(0, 8)}…:`,
                        err instanceof Error ? err.message : err,
                    );
                });
            }
        }

        await prisma.channel.delete({
            where: {
                id,
                user_id: userId,
            },
        });
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json(
            { error: getErrorMessage(error) },
            { status: 400 },
        );
    }
}
