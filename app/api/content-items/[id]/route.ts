import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
    _req: Request,
    { params }: { params: { id: string } }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = params;

    try {
        const item = await prisma.contentItem.findUnique({
            where: { id, user_id: (session.user as any).id },
        });
        if (!item) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
        return NextResponse.json(item);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}

export async function PATCH(
    req: Request,
    { params }: { params: { id: string } }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = params;
    const userId = (session.user as any).id;

    try {
        const data = await req.json();
        const result = await prisma.contentItem.updateMany({
            where: { id, user_id: userId },
            data,
        });

        if (result.count === 0) {
            return NextResponse.json({ error: "Item not found or unauthorized" }, { status: 404 });
        }

        const updatedItem = await prisma.contentItem.findFirst({ where: { id, user_id: userId } });
        return NextResponse.json(updatedItem);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: { id: string } }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = params;
    const userId = (session.user as any).id;

    try {
        const result = await prisma.contentItem.deleteMany({
            where: { id, user_id: userId },
        });

        if (result.count === 0) {
            return NextResponse.json({ error: "Item not found or unauthorized" }, { status: 404 });
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}
