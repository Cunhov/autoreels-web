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

    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const contentItems = await prisma.contentItem.findMany({
        where: {
            user_id: (session.user as any).id,
            parent_id: parent_id,
            type: types ? { in: types } : undefined,
        },
        orderBy: {
            name: "asc",
        },
        take: limit,
        skip: offset,
        // Include the first child if this is a folder so we have a thumbnail without an extra request
        include: {
            children: {
                take: 1,
                orderBy: { created_at: 'desc' },
                select: { url: true, type: true }
            }
        }
    });

    // Post-process to map 'children' to 'thumbnail_url' to match frontend expectations
    const mappedItems = contentItems.map(item => {
        let thumbnail_url = null;
        let thumbnail_type = null;

        if (item.type === 'carousel_folder' && item.children && item.children.length > 0) {
            thumbnail_url = item.children[0].url;
            thumbnail_type = item.children[0].type;
        }

        const { children, ...rest } = item;
        return {
            ...rest,
            thumbnail_url,
            thumbnail_type
        };
    });

    return NextResponse.json(mappedItems);

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
