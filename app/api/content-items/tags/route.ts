import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";

const SCAN_LIMIT = 5000;
const RESULT_LIMIT = 100;

/**
 * GET /api/content-items/tags?parent_id=&search=
 *
 * Returns the distinct set of tags present in the given scope (folder or the
 * whole library when parent_id is empty). Tags are stored as JSON array
 * strings, so we scan items with non-null tags (capped), parse them in JS and
 * union the results. Used by the library filter panel.
 *
 * Response: { tags: string[] } (sorted, capped at 100)
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const rawParentId = searchParams.get("parent_id");
    const parent_id = (rawParentId && rawParentId !== "null" && rawParentId !== "undefined")
        ? rawParentId
        : null;
    const search = searchParams.get("search")?.trim().toLowerCase() || undefined;

    const items = await prisma.contentItem.findMany({
        where: {
            user_id: userId,
            parent_id,
            tags: { not: null },
        },
        select: { tags: true },
        take: SCAN_LIMIT,
    });

    const tagSet = new Set<string>();
    for (const item of items) {
        if (!item.tags) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(item.tags);
        } catch {
            parsed = String(item.tags).split(",");
        }
        if (!Array.isArray(parsed)) continue;
        for (const t of parsed) {
            const s = String(t).trim();
            if (s) tagSet.add(s);
        }
    }

    let tags = [...tagSet].sort((a, b) => a.localeCompare(b));
    if (search) {
        tags = tags.filter((t) => t.toLowerCase().includes(search));
    }

    return NextResponse.json({ tags: tags.slice(0, RESULT_LIMIT) });
}
