import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { Prisma } from "@prisma/client";

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const requestedLimit = Number(searchParams.get("limit") || "1000");
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 2000)
        : 1000;

    const where: Prisma.PostWhereInput = { user_id: userId };

    if (status) {
        const statuses = status.split(",").map(item => item.trim()).filter(Boolean);
        if (statuses.length > 0) where.status = { in: statuses };
    }

    if (start || end) {
        where.scheduled_at = {};
        if (start) {
            const startDate = new Date(start);
            if (!Number.isNaN(startDate.getTime())) where.scheduled_at.gte = startDate;
        }
        if (end) {
            const endDate = new Date(end);
            if (!Number.isNaN(endDate.getTime())) where.scheduled_at.lte = endDate;
        }
    }

    const posts = await prisma.post.findMany({
        where,
        orderBy: {
            created_at: "desc",
        },
        take: limit,
    });

    return NextResponse.json(posts);
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const data = await req.json();
        const post = await prisma.post.create({
            data: {
                ...data,
                user_id: userId,
            },
        });
        return NextResponse.json(post);
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
