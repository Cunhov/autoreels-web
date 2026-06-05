import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";

const publicChannelSelect = {
    id: true,
    name: true,
    platform: true,
    account_id: true,
    username: true,
    profile_picture_url: true,
    status: true,
};

export async function GET() {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const planners = await prisma.planner.findMany({
        where: {
            user_id: userId,
        },
        include: {
            channels: { select: publicChannelSelect },
        },
        orderBy: {
            created_at: "desc",
        },
    });

    return NextResponse.json(planners);
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { name, config, channel_ids, status } = await req.json();
        const safeChannelIds = Array.isArray(channel_ids) ? channel_ids : [];
        const ownedChannels = safeChannelIds.length > 0
            ? await prisma.channel.findMany({
                where: { id: { in: safeChannelIds }, user_id: userId },
                select: { id: true },
            })
            : [];
        const planner = await prisma.planner.create({
            data: {
                name,
                status: status || 'active',
                config: typeof config === 'string' ? config : JSON.stringify(config),
                user_id: userId,
                channels: {
                    connect: ownedChannels.map(channel => ({ id: channel.id })),
                },
            },
        });
        return NextResponse.json(planner);
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
