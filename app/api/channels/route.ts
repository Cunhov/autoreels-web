import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { fetchInstagramProfile, refreshInstagramToken } from "@/lib/instagram";
import { escapeHtml } from "@/lib/sanitize";
import { isValidProxyUrl, maskProxyUrl } from "@/lib/proxy";

const channelSelect = {
    // proxy não exposto cru ao client — somente has_proxy/masked no toSafeChannel
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

export async function GET() {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let channels: unknown[];
    try {
        channels = await prisma.channel.findMany({
            where: { user_id: userId },
            select: channelSelect,
            orderBy: { created_at: "desc" },
        });
    } catch (e: unknown) {
        if (isMissingProxyColumnError(e)) {
            console.warn(
                "[channels] proxy columns missing in DB — falling back without proxy (rode a migration 0008)",
            );
            channels = await prisma.channel.findMany({
                where: { user_id: userId },
                select: channelSelectFallback,
                orderBy: { created_at: "desc" },
            });
        } else throw e;
    }

    return NextResponse.json(
        (channels as Parameters<typeof toSafeChannel>[0][]).map(toSafeChannel),
    );
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const data = await req.json();
        const tokenSource = data.token_source || "manual";
        let profile: {
            id: string;
            username: string;
            profilePictureUrl: string;
        } | null = null;
        let accessToken =
            typeof data.access_token === "string"
                ? data.access_token.trim()
                : "";
        let expiresAt: Date | null = null;
        let refreshedAt: Date | null = null;

        if (tokenSource === "manual" && accessToken) {
            const proxyForToken =
                typeof data.proxy_url === "string"
                    ? String(data.proxy_url).trim() || null
                    : null;
            const refreshed = await refreshInstagramToken(
                accessToken,
                proxyForToken,
            ).catch(() => null);
            if (refreshed) {
                accessToken = refreshed.token;
                expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
                refreshedAt = new Date();
            }
            profile = await fetchInstagramProfile(
                accessToken,
                proxyForToken,
            ).catch(() => null);
        }

        const accountId = String(data.account_id || profile?.id || "").trim();
        if (!accountId) {
            return NextResponse.json(
                { error: "Instagram Account ID is required." },
                { status: 400 },
            );
        }
        // BK-11/BK-18 validar nome não é só espaços, limite 80 e regex
        if (
            data.name !== undefined &&
            typeof data.name === "string" &&
            !data.name.trim()
        ) {
            return NextResponse.json(
                { error: "Channel name cannot be empty or whitespace" },
                { status: 400 },
            );
        }
        const channelName = data.name
            ? escapeHtml(String(data.name).trim().slice(0, 80))
            : profile?.username
              ? escapeHtml(profile.username.slice(0, 80))
              : `Instagram ${accountId}`;

        // Proxy por canal (opcional): valida formato http(s)://user:pass@host:porta
        let proxyUrl: string | null = null;
        if (
            data.proxy_url !== undefined &&
            data.proxy_url !== null &&
            String(data.proxy_url).trim() !== ""
        ) {
            const rawProxy = String(data.proxy_url).trim();
            if (!isValidProxyUrl(rawProxy)) {
                return NextResponse.json(
                    {
                        error: "Proxy inválido. Use o formato http://user:pass@host:porta ou http://host:porta",
                    },
                    { status: 400 },
                );
            }
            proxyUrl = rawProxy;
        }

        let channel: unknown;
        try {
            channel = await prisma.channel.create({
                data: {
                    user_id: userId,
                    name: channelName,
                    platform: "instagram",
                    account_id: accountId,
                    username: profile?.username || data.username || null,
                    profile_picture_url:
                        profile?.profilePictureUrl ||
                        data.profile_picture_url ||
                        null,
                    access_token: accessToken || null,
                    token_source: tokenSource,
                    token_expires_at: expiresAt,
                    token_refreshed_at: refreshedAt,
                    status: data.status || "active",
                    proxy_url: proxyUrl,
                    proxy_enabled:
                        data.proxy_enabled !== undefined
                            ? Boolean(data.proxy_enabled)
                            : true,
                },
                select: channelSelect,
            });
        } catch (e: unknown) {
            if (isMissingProxyColumnError(e) && proxyUrl !== null) {
                console.warn(
                    "[channels] proxy columns missing — creating channel without proxy",
                );
                channel = await prisma.channel.create({
                    data: {
                        user_id: userId,
                        name: channelName,
                        platform: "instagram",
                        account_id: accountId,
                        username: profile?.username || data.username || null,
                        profile_picture_url:
                            profile?.profilePictureUrl ||
                            data.profile_picture_url ||
                            null,
                        access_token: accessToken || null,
                        token_source: tokenSource,
                        token_expires_at: expiresAt,
                        token_refreshed_at: refreshedAt,
                        status: data.status || "active",
                    },
                    select: channelSelectFallback,
                });
            } else if (isMissingProxyColumnError(e)) {
                channel = await prisma.channel.create({
                    data: {
                        user_id: userId,
                        name: channelName,
                        platform: "instagram",
                        account_id: accountId,
                        username: profile?.username || data.username || null,
                        profile_picture_url:
                            profile?.profilePictureUrl ||
                            data.profile_picture_url ||
                            null,
                        access_token: accessToken || null,
                        token_source: tokenSource,
                        token_expires_at: expiresAt,
                        token_refreshed_at: refreshedAt,
                        status: data.status || "active",
                    },
                    select: channelSelectFallback,
                });
            } else throw e;
        }
        return NextResponse.json(
            toSafeChannel(channel as Parameters<typeof toSafeChannel>[0]),
        );
    } catch (error: unknown) {
        return NextResponse.json(
            { error: getErrorMessage(error) },
            { status: 400 },
        );
    }
}
