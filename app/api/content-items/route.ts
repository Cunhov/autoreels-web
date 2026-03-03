import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/**
 * Build the Prisma `where` clause from query params.
 * Shared between GET (listing) and the bulk endpoint.
 */
export function buildContentWhere(
    userId: string,
    searchParams: URLSearchParams
): Prisma.ContentItemWhereInput {
    const parent_id = searchParams.get('parent_id') || null;
    const types = searchParams.get('types')?.split(',').filter(Boolean) || undefined;
    const search = searchParams.get('search')?.trim().toLowerCase() || undefined;
    const sizeMin = searchParams.get('size_min') ? parseInt(searchParams.get('size_min')!, 10) : undefined;
    const sizeMax = searchParams.get('size_max') ? parseInt(searchParams.get('size_max')!, 10) : undefined;
    const durationMin = searchParams.get('duration_min') ? parseFloat(searchParams.get('duration_min')!) : undefined;
    const durationMax = searchParams.get('duration_max') ? parseFloat(searchParams.get('duration_max')!) : undefined;

    const where: Prisma.ContentItemWhereInput = {
        user_id: userId,
        parent_id: parent_id,
        type: types ? { in: types } : undefined,
    };

    // Server-side search (name, title, caption — tags stored as JSON string)
    if (search) {
        where.OR = [
            { name: { contains: search } },
            { title: { contains: search } },
            { caption: { contains: search } },
            { tags: { contains: search } },
        ];
    }

    // Size filter
    if (sizeMin !== undefined || sizeMax !== undefined) {
        where.size = {};
        if (sizeMin !== undefined) (where.size as any).gte = sizeMin;
        if (sizeMax !== undefined) (where.size as any).lte = sizeMax;
    }

    // Duration filter
    if (durationMin !== undefined || durationMax !== undefined) {
        where.duration = {};
        if (durationMin !== undefined) (where.duration as any).gte = durationMin;
        if (durationMax !== undefined) (where.duration as any).lte = durationMax;
    }

    return where;
}

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const userId = (session.user as any).id;

    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 500);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const where = buildContentWhere(userId, searchParams);

    // Run count + query in parallel for efficiency
    const [totalCount, contentItems] = await Promise.all([
        prisma.contentItem.count({ where }),
        prisma.contentItem.findMany({
            where,
            orderBy: { name: "asc" },
            take: limit,
            skip: offset,
            include: {
                children: {
                    take: 1,
                    orderBy: { created_at: 'desc' },
                    select: { url: true, type: true }
                }
            }
        }),
    ]);

    // Post-process to map 'children' to 'thumbnail_url'
    const mappedItems = contentItems.map(item => {
        let thumbnail_url = null;
        let thumbnail_type = null;

        if (item.type === 'carousel_folder' && item.children && item.children.length > 0) {
            thumbnail_url = item.children[0].url;
            thumbnail_type = item.children[0].type;
        }

        const { children, ...rest } = item;
        return { ...rest, thumbnail_url, thumbnail_type };
    });

    return NextResponse.json({
        items: mappedItems,
        totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount,
    });
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
