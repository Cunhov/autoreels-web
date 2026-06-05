import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { fetchInstagramProfile, refreshInstagramToken } from "@/lib/instagram";

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
};

function toSafeChannel(channel: {
    access_token?: string | null;
    token_source?: string | null;
    [key: string]: unknown;
}) {
    const { access_token, ...safeChannel } = channel;
    return {
        ...safeChannel,
        has_token: Boolean(access_token),
        token_source: access_token?.startsWith("token_") ? "redis" : safeChannel.token_source,
    };
}

export async function GET() {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const channels = await prisma.channel.findMany({
        where: {
            user_id: userId,
        },
        select: channelSelect,
        orderBy: {
            created_at: "desc",
        },
    });

    return NextResponse.json(channels.map(toSafeChannel));
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
        let profile: { id: string; username: string; profilePictureUrl: string } | null = null;
        let accessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
        let expiresAt: Date | null = null;
        let refreshedAt: Date | null = null;

        if (tokenSource === "manual" && accessToken) {
            const refreshed = await refreshInstagramToken(accessToken).catch(() => null);
            if (refreshed) {
                accessToken = refreshed.token;
                expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
                refreshedAt = new Date();
            }
            profile = await fetchInstagramProfile(accessToken).catch(() => null);
        }

        const accountId = String(data.account_id || profile?.id || "").trim();
        if (!accountId) {
            return NextResponse.json({ error: "Instagram Account ID is required." }, { status: 400 });
        }

        const channel = await prisma.channel.create({
            data: {
                user_id: userId,
                name: data.name || profile?.username || `Instagram ${accountId}`,
                platform: "instagram",
                account_id: accountId,
                username: profile?.username || data.username || null,
                profile_picture_url: profile?.profilePictureUrl || data.profile_picture_url || null,
                access_token: accessToken || null,
                token_source: tokenSource,
                token_expires_at: expiresAt,
                token_refreshed_at: refreshedAt,
                status: data.status || "active",
            },
            select: channelSelect,
        });
        return NextResponse.json(toSafeChannel(channel));
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
