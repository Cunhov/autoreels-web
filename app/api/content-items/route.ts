import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const parent_id = searchParams.get('parent_id') || null;
    const types = searchParams.get('types')?.split(',') || undefined;

    const contentItems = await prisma.contentItem.findMany({
        where: {
            user_id: (session.user as any).id,
            parent_id: parent_id,
            type: types ? { in: types } : undefined,
        },
        orderBy: {
            name: "asc",
        },
    });

    return NextResponse.json(contentItems);
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const data = await req.json();
        const contentItem = await prisma.contentItem.create({
            data: {
                ...data,
                user_id: (session.user as any).id,
            },
        });
        return NextResponse.json(contentItem);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}
