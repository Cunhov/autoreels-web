import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const channels = await prisma.channel.findMany({
        where: {
            user_id: (session.user as any).id,
        },
        orderBy: {
            created_at: "desc",
        },
    });

    return NextResponse.json(channels);
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const data = await req.json();
        const channel = await prisma.channel.create({
            data: {
                ...data,
                user_id: (session.user as any).id,
            },
        });
        return NextResponse.json(channel);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}
