import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { cleanPathSegment } from "@/lib/upload-path";

// Fields a client may set when creating a content item. Server-owned fields
// (id, user_id, created_at, path) are excluded to prevent mass assignment.
const POST_ALLOWED_FIELDS = [
    "name", "title", "caption", "tags", "type", "size", "duration",
    "parent_id", "url", "thumbnail_url",
] as const;

/** Validate that a stored URL is either our own /api/file/ path or http(s). */
function isSafeStoredUrl(value: string | null | undefined): boolean {
    if (!value) return true;
    if (value.startsWith("/api/file/")) {
        return cleanPathSegment(value.slice("/api/file/".length)) !== null;
    }
    return /^https?:\/\//.test(value);
}

/**
 * Build the Prisma `where` clause from query params.
 * Shared between GET (listing) and the bulk endpoint.
 */
export function buildContentWhere(
    userId: string,
    searchParams: URLSearchParams
): Prisma.ContentItemWhereInput {
    // Treat "null"/"undefined"/"" as "root folder" (frontends may send these)
    const rawParentId = searchParams.get('parent_id');
    const parent_id = (rawParentId && rawParentId !== 'null' && rawParentId !== 'undefined')
        ? rawParentId
        : null;
    const types = searchParams.get('types')?.split(',').filter(Boolean) || undefined;
    const search = searchParams.get('search')?.trim().toLowerCase() || undefined;
    const includeTags = searchParams.get('include_tags')?.split(',').map(t => t.trim()).filter(Boolean) || [];
    const excludeTags = searchParams.get('exclude_tags')?.split(',').map(t => t.trim()).filter(Boolean) || [];
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

    if (includeTags.length > 0 || excludeTags.length > 0) {
        where.AND = where.AND ? [...(Array.isArray(where.AND) ? where.AND : [where.AND])] : [];
        if (Array.isArray(where.AND)) {
            for (const tag of includeTags) {
                where.AND.push({ tags: { contains: tag } });
            }
            for (const tag of excludeTags) {
                where.AND.push({ NOT: { tags: { contains: tag } } });
            }
        }
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
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);

    // Validate limit/offset (NaN would propagate as take:NaN → 500)
    const rawLimit = parseInt(searchParams.get('limit') || '100', 10);
    const rawOffset = parseInt(searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
    const sortBy = searchParams.get('sort_by') || 'name-asc';

    const where = buildContentWhere(userId, searchParams);
    const orderBy =
        sortBy === 'created-desc' ? { created_at: 'desc' as const } :
        sortBy === 'created-asc' ? { created_at: 'asc' as const } :
        sortBy === 'name-desc' ? { name: 'desc' as const } :
        { name: 'asc' as const };

    // Run count + query in parallel for efficiency
    const [totalCount, contentItems] = await Promise.all([
        prisma.contentItem.count({ where }),
        prisma.contentItem.findMany({
            where,
            orderBy,
            take: limit,
            skip: offset,
            include: {
                children: {
                    take: 1,
                    orderBy: { created_at: 'desc' },
                    select: { url: true, type: true, thumbnail_url: true }
                }
            }
        }),
    ]);

    // Post-process to map 'children' to 'thumbnail_url'
    const mappedItems = contentItems.map(item => {
        let thumbnail_url = item.thumbnail_url || null;
        let thumbnail_type = null;

        if (item.type === 'carousel_folder' && item.children && item.children.length > 0) {
            thumbnail_url = item.children[0].thumbnail_url || item.children[0].url;
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
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const data = await req.json();

        // Whitelist: drop any field not in the allowed list (prevents mass assignment)
        const payload: Record<string, unknown> = {};
        for (const field of POST_ALLOWED_FIELDS) {
            if (data[field] !== undefined) payload[field] = data[field];
        }

        // Sanitize name (must not contain path separators / traversal)
        if (payload.name !== undefined) {
            const cleanName = cleanPathSegment(String(payload.name));
            if (cleanName === null || cleanName.includes("/") || cleanName === "." || cleanName === "") {
                return NextResponse.json({ error: "Invalid name" }, { status: 400 });
            }
            payload.name = cleanName;
        }

        // Sanitize URLs (must be our own /api/file/ path or http(s))
        if (!isSafeStoredUrl(payload.url as string) || !isSafeStoredUrl(payload.thumbnail_url as string)) {
            return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
        }

        // Validate parent folder ownership
        if (payload.parent_id && payload.parent_id !== null) {
            const parent = await prisma.contentItem.findFirst({
                where: { id: String(payload.parent_id), user_id: userId },
                select: { id: true },
            });
            if (!parent) {
                return NextResponse.json({ error: "Invalid parent folder" }, { status: 400 });
            }
        }

        // Tags: store as JSON string
        if (payload.tags !== undefined && typeof payload.tags !== "string") {
            payload.tags = JSON.stringify(payload.tags);
        }

        const contentItem = await prisma.contentItem.create({
            data: {
                ...payload,
                user_id: userId,
            } as Prisma.ContentItemUncheckedCreateInput,
        });
        return NextResponse.json(contentItem);
    } catch (error: unknown) {
        console.error('Create content item error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
