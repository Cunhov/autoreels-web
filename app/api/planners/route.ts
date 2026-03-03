import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const planners = await prisma.planner.findMany({
        where: {
            user_id: (session.user as any).id,
        },
        include: {
            channels: true,
        },
        orderBy: {
            created_at: "desc",
        },
    });

    return NextResponse.json(planners);
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { name, config, channel_ids, status } = await req.json();
        const planner = await prisma.planner.create({
            data: {
                name,
                status: status || 'active',
                config: typeof config === 'string' ? config : JSON.stringify(config),
                user_id: (session.user as any).id,
                channels: {
                    connect: channel_ids?.map((id: string) => ({ id })) || [],
                },
            },
        });
        return NextResponse.json(planner);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}
