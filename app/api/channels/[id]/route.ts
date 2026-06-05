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

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const channel = await prisma.channel.findUnique({
        where: {
            id,
            user_id: userId,
        },
        select: channelSelect,
    });

    if (!channel) {
        return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    return NextResponse.json(toSafeChannel(channel));
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const data = await req.json();
        const updateData: Record<string, unknown> = {
            name: data.name,
            account_id: data.account_id,
            username: data.username,
            profile_picture_url: data.profile_picture_url,
            status: data.status,
            token_source: data.token_source,
        };

        if (typeof data.access_token === "string" && data.access_token.trim()) {
            let accessToken = data.access_token.trim();
            const refreshed = await refreshInstagramToken(accessToken).catch(() => null);
            if (refreshed) {
                accessToken = refreshed.token;
                updateData.token_expires_at = new Date(Date.now() + refreshed.expiresIn * 1000);
                updateData.token_refreshed_at = new Date();
            }
            const profile = await fetchInstagramProfile(accessToken).catch(() => null);
            if (profile) {
                updateData.account_id = data.account_id || profile.id;
                updateData.username = profile.username || null;
                updateData.profile_picture_url = profile.profilePictureUrl || null;
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
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        await prisma.channel.delete({
            where: {
                id,
                user_id: userId,
            },
        });
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
