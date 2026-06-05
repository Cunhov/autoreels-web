import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";

export async function GET() {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [failedPosts, activePlanners] = await Promise.all([
        prisma.post.count({
            where: {
                user_id: userId,
                status: "failed",
            },
        }),
        prisma.planner.count({
            where: {
                user_id: userId,
                status: "active",
            },
        }),
    ]);

    return NextResponse.json({ failedPosts, activePlanners });
}
