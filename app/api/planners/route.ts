import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";

const VALID_PLANNER_STATUS = ["active", "paused"];

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

    const [planners, postStats] = await Promise.all([
        prisma.planner.findMany({
            where: {
                user_id: userId,
            },
            include: {
                channels: { select: publicChannelSelect },
            },
            orderBy: {
                created_at: "desc",
            },
        }),
        prisma.post.groupBy({
            by: ["planner_id", "status"],
            where: {
                user_id: userId,
                planner_id: { not: null },
            },
            _count: { _all: true },
        }),
    ]);

    const statsByPlanner: Record<string, { total: number; published: number; failed: number }> = {};
    for (const row of postStats) {
        const plannerId = row.planner_id;
        if (!plannerId) continue;
        if (!statsByPlanner[plannerId]) {
            statsByPlanner[plannerId] = { total: 0, published: 0, failed: 0 };
        }
        const count = row._count._all;
        statsByPlanner[plannerId].total += count;
        if (row.status === "published") statsByPlanner[plannerId].published += count;
        if (row.status === "failed") statsByPlanner[plannerId].failed += count;
    }

    return NextResponse.json(
        planners.map(planner => ({
            ...planner,
            stats: statsByPlanner[planner.id] ?? { total: 0, published: 0, failed: 0 },
        }))
    );
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { name, config, channel_ids, status } = await req.json();

        if (!name || typeof name !== "string" || name.trim().length === 0) {
            return NextResponse.json({ error: "Planner name is required" }, { status: 400 });
        }

        // Restrict status to known values (default: active)
        const safeStatus = VALID_PLANNER_STATUS.includes(status) ? status : "active";

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
                status: safeStatus,
                config: typeof config === 'string' ? config : JSON.stringify(config ?? {}),
                user_id: userId,
                channels: {
                    connect: ownedChannels.map(channel => ({ id: channel.id })),
                },
            },
        });
        return NextResponse.json(planner);
    } catch (error: unknown) {
        console.error('Create planner error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
