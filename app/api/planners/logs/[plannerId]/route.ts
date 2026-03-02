import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ plannerId: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { plannerId } = await params;

    try {
        const logs = await prisma.plannerLog.findMany({
            where: {
                planner_id: plannerId,
                planner: {
                    user_id: (session.user as any).id,
                },
            },
            orderBy: {
                created_at: "desc",
            },
            take: 50,
        });

        return NextResponse.json(logs);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}
