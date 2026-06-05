import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const data = await req.json();
        const { channel_ids, config, ...rest } = data;
        const safeChannelIds = Array.isArray(channel_ids) ? channel_ids : [];
        const ownedChannels = safeChannelIds.length > 0
            ? await prisma.channel.findMany({
                where: { id: { in: safeChannelIds }, user_id: userId },
                select: { id: true },
            })
            : [];

        const planner = await prisma.planner.update({
            where: { id, user_id: userId },
            data: {
                ...rest,
                config: config ? (typeof config === 'string' ? config : JSON.stringify(config)) : undefined,
                channels: channel_ids ? {
                    set: ownedChannels.map(channel => ({ id: channel.id })),
                } : undefined,
            },
        });

        return NextResponse.json(planner);
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        await prisma.planner.delete({
            where: { id, user_id: userId },
        });
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
