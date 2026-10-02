import type { Prisma } from "@prisma/client";

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

