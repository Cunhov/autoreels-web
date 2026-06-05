import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { resolveAccessToken } from "@/lib/instagram";
import { prisma } from "@/lib/prisma";

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const channel = await prisma.channel.findUnique({
        where: { id, user_id: userId },
        select: {
            access_token: true,
            token_source: true,
            token_expires_at: true,
            token_refreshed_at: true,
        },
    });

    if (!channel?.access_token) {
        return NextResponse.json({ error: "Token not found." }, { status: 404 });
    }

    const token = await resolveAccessToken(channel.access_token);
    return NextResponse.json({
        token,
        token_source: channel.token_source,
        token_expires_at: channel.token_expires_at,
        token_refreshed_at: channel.token_refreshed_at,
    });
}
