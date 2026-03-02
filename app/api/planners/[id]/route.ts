import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const data = await req.json();
        const { channel_ids, config, ...rest } = data;

        const planner = await prisma.planner.update({
            where: { id, user_id: (session.user as any).id },
            data: {
                ...rest,
                config: config ? (typeof config === 'string' ? config : JSON.stringify(config)) : undefined,
                channels: channel_ids ? {
                    set: channel_ids.map((cid: string) => ({ id: cid })),
                } : undefined,
            },
        });

        return NextResponse.json(planner);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        await prisma.planner.delete({
            where: { id, user_id: (session.user as any).id },
        });
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}
