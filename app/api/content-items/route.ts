import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { cleanPathSegment } from "@/lib/upload-path";
import { normalizeTags } from "./shared";
import { escapeHtml, sanitizeCaption } from "@/lib/sanitize";

// Fields a client may set when creating a content item. Server-owned fields
// (id, user_id, created_at, path) are excluded to prevent mass assignment.
const POST_ALLOWED_FIELDS = [
    "name", "title", "caption", "caption_youtube", "caption_instagram",
    "youtube_products",
    "tags", "type", "size", "duration",
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
    // Accept both `types` (list) and singular `type` (pickers send this)
    const typesParam = searchParams.get('types') ?? searchParams.get('type');
    const types = typesParam?.split(',').filter(Boolean) || undefined;
    const search = searchParams.get('search')?.trim().toLowerCase() || undefined;
    const includeTags = searchParams.get('include_tags')?.split(',').map(t => t.trim()).filter(Boolean) || [];
    const excludeTags = searchParams.get('exclude_tags')?.split(',').map(t => t.trim()).filter(Boolean) || [];

    // Numeric filters — ignore non-finite values (NaN would poison the where)
    const parseNum = (raw: string | null): number | undefined => {
        if (raw === null || raw === '') return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
    };
    const sizeMin = parseNum(searchParams.get('size_min'));
    const sizeMax = parseNum(searchParams.get('size_max'));
    const durationMin = parseNum(searchParams.get('duration_min'));
    const durationMax = parseNum(searchParams.get('duration_max'));

    const where: Prisma.ContentItemWhereInput = {
        user_id: userId,
        parent_id: parent_id,
        type: types ? { in: types } : undefined,
    };

    // Server-side search (name, title, caption — NOT tags: tags have their own filter)
    if (search) {
        where.OR = [
            { name: { contains: search } },
            { title: { contains: search } },
            { caption: { contains: search } },
        ];
    }

    // Tag filters: match the serialized JSON token (e.g. `"cat"`) instead of a
    // raw substring, so `cat` never matches `category`. Tags are always stored
    // as a JSON array string (see normalizeTags), so the quoted token is exact.
    if (includeTags.length > 0 || excludeTags.length > 0) {
        where.AND = where.AND ? [...(Array.isArray(where.AND) ? where.AND : [where.AND])] : [];
        if (Array.isArray(where.AND)) {
            for (const tag of includeTags) {
                where.AND.push({ tags: { contains: JSON.stringify(tag) } });
            }
            for (const tag of excludeTags) {
                where.AND.push({ NOT: { tags: { contains: JSON.stringify(tag) } } });
            }
        }
    }

    // Size filter
    if (sizeMin !== undefined || sizeMax !== undefined) {
        where.size = {
            ...(sizeMin !== undefined ? { gte: sizeMin } : {}),
            ...(sizeMax !== undefined ? { lte: sizeMax } : {}),
        } as Prisma.IntNullableFilter;
    }

    // Duration filter
    if (durationMin !== undefined || durationMax !== undefined) {
        where.duration = {
            ...(durationMin !== undefined ? { gte: durationMin } : {}),
            ...(durationMax !== undefined ? { lte: durationMax } : {}),
        } as Prisma.FloatNullableFilter;
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
    const mappedItems = contentItems.map(({ children, ...rest }) => {
        let thumbnail_url = rest.thumbnail_url || null;
        let thumbnail_type = null;

        if (rest.type === 'carousel_folder' && children && children.length > 0) {
            thumbnail_url = children[0].thumbnail_url || children[0].url;
            thumbnail_type = children[0].type;
        }

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

        // BK-11 trim check antes de salvar — rejeita só espaços
        if (payload.name !== undefined) {
            const rawName = String(payload.name);
            if (!rawName.trim()) {
                return NextResponse.json({ error: "Invalid name" }, { status: 400 });
            }
            const cleanName = cleanPathSegment(rawName.trim());
            if (cleanName === null || cleanName.includes("/") || cleanName === "." || cleanName === "") {
                return NextResponse.json({ error: "Invalid name" }, { status: 400 });
            }
            payload.name = escapeHtml(cleanName).slice(0, 200);
        }
        // BK-07/BK-14 caption sanitização + limite 2200 (espelhada pelas
        // captions por plataforma caption_youtube/caption_instagram — F4).
        // sanitizeCaption faz trim + slice(CAPTION_MAX) + escape `<`/`>`.
        if (payload.caption !== undefined && payload.caption !== null) {
            payload.caption = sanitizeCaption(payload.caption);
        }
        if (payload.caption_youtube !== undefined && payload.caption_youtube !== null) {
            payload.caption_youtube = sanitizeCaption(payload.caption_youtube);
        }
        if (payload.caption_instagram !== undefined && payload.caption_instagram !== null) {
            payload.caption_instagram = sanitizeCaption(payload.caption_instagram);
        }
        // Produtos afiliados por vídeo (decisão do dono): CSV de NOMES no item
        // (ex.: "Cadeira Gamer, Mousepad"). Nomes NÃO passam por escapeHtml
        // (não é texto de post — é termo do catálogo YouTube Shopping). Aplica
        // trim + limite de segurança. Vírgula separa itens (nomes com vírgula
        // não são suportados — mesma regra do formato legado do planner).
        if (payload.youtube_products !== undefined && payload.youtube_products !== null) {
            let p = String(payload.youtube_products).trim();
            if (p.length > 5000) p = p.slice(0, 5000);
            payload.youtube_products = p || null;
        }
        if (payload.title !== undefined && payload.title !== null) {
            let t = String(payload.title).trim();
            if (!t) return NextResponse.json({ error: "Invalid title" }, { status: 400 });
            if (t.length > 200) t = t.slice(0, 200);
            if (t.includes("<") || t.includes(">")) t = escapeHtml(t);
            payload.title = t;
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

        // Tags: always store as a JSON array string (normalized)
        if (payload.tags !== undefined) {
            payload.tags = normalizeTags(payload.tags);
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
