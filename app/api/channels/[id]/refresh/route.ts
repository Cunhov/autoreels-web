import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { refreshInstagramToken } from "@/lib/instagram";
import { prisma } from "@/lib/prisma";

export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    try {
        const channel = await prisma.channel.findUnique({ where: { id, user_id: userId } });
        if (!channel?.access_token) {
            return NextResponse.json({ error: "Channel has no token." }, { status: 400 });
        }
        if (channel.access_token.startsWith("token_")) {
            return NextResponse.json({ error: "Redis-backed channels cannot be refreshed here." }, { status: 400 });
        }

        const refreshed = await refreshInstagramToken(channel.access_token);
        const updated = await prisma.channel.update({
            where: { id, user_id: userId },
            data: {
                access_token: refreshed.token,
                token_source: channel.token_source || "manual",
                token_expires_at: new Date(Date.now() + refreshed.expiresIn * 1000),
                token_refreshed_at: new Date(),
            },
            select: {
                id: true,
                token_expires_at: true,
                token_refreshed_at: true,
                token_source: true,
            },
        });

        return NextResponse.json({ success: true, channel: updated });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
