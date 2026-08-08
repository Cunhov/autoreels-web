import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { buildContentWhere } from "../route";
import { deleteFileFromDisk, collectItemFiles } from "@/lib/deleteFiles";
import { cleanPathSegment } from "@/lib/upload-path";

// SQLite has a hard limit on bind variables per statement (~999 by default;
// Prisma also materializes the IN list). Keep IN batches well below that.
const IN_BATCH_SIZE = 500;
// Keep rename transactions small to avoid long-lived write locks on SQLite.
const RENAME_BATCH_SIZE = 200;
const MAX_COLLECT_ITEMS = 10_000;

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

interface FileInfo {
    id: string;
    url: string | null;
    thumbnail_url: string | null;
    name: string | null;
    path: string | null;
    type: string;
}

/**
 * Recursively collect all descendants of the given items (any depth) plus the
 * items themselves, with the fields needed for disk cleanup.
 */
async function collectWithDescendants(roots: FileInfo[]): Promise<Array<{ url: string | null; thumbnail_url: string | null; name: string | null; path: string | null }>> {
    const collected: Array<{ url: string | null; thumbnail_url: string | null; name: string | null; path: string | null }> =
        roots.map((r) => ({ url: r.url, thumbnail_url: r.thumbnail_url, name: r.name, path: r.path }));

    let currentLevel = roots.map((r) => r.id);
    let guard = 0;

    while (currentLevel.length > 0 && guard < 20) {
        const level = await prisma.contentItem.findMany({
            where: { parent_id: { in: currentLevel } },
            select: {
                id: true,
                url: true,
                thumbnail_url: true,
                name: true,
                path: true,
            },
        });
        if (level.length === 0) break;

        collected.push(...level.map((c) => ({
            url: c.url ?? null,
            thumbnail_url: c.thumbnail_url ?? null,
            name: c.name ?? null,
            path: c.path ?? null,
        })));

        if (collected.length > MAX_COLLECT_ITEMS) {
            console.warn(`[bulk] Descendant collection exceeded ${MAX_COLLECT_ITEMS} items; truncating.`);
            break;
        }

        currentLevel = level.map((c) => c.id);
        guard++;
    }

    return collected;
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const { action, ids, all, filters, data } = body;
        // action: "delete" | "move" | "rename"
        // ids: string[]           — explicit item IDs (order matters for rename)
        // all: boolean            — select all matching items
        // filters: object         — query-param-like filters when all=true
        // data: object            — payload for move/rename

        if (!action) {
            return NextResponse.json({ error: "Missing action" }, { status: 400 });
        }

        // Resolve the set of target IDs
        let targetIds: string[] = Array.isArray(ids) ? ids.filter(Boolean) : [];

        if (all) {
            // Build a where clause from the filters to find all matching IDs.
            // Order by created_at so "all" operations have a deterministic order.
            const filterParams = new URLSearchParams(filters || {});
            const where = buildContentWhere(userId, filterParams);
            const allItems = await prisma.contentItem.findMany({
                where,
                select: { id: true },
                orderBy: { created_at: "asc" },
            });
            targetIds = allItems.map((item: { id: string }) => item.id);
        }

        if (targetIds.length === 0) {
            return NextResponse.json({ affected: 0 });
        }

        // Security: ensure all IDs belong to this user
        const ownershipWhere = { id: { in: targetIds }, user_id: userId };

        switch (action) {
            case "delete": {
                // Fetch items with their file info
                const itemsToDelete = await prisma.contentItem.findMany({
                    where: ownershipWhere,
                    select: {
                        id: true,
                        url: true,
                        thumbnail_url: true,
                        name: true,
                        path: true,
                        type: true,
                    },
                });

                // Recursively collect every descendant's files (any depth)
                const allItems = await collectWithDescendants(itemsToDelete);

                const diskPaths = allItems.flatMap((item) => collectItemFiles(userId, item));

                // Delete from DB in batches (SQLite bind-variable limit)
                let deleted = 0;
                for (const batch of chunkArray(targetIds, IN_BATCH_SIZE)) {
                    const result = await prisma.contentItem.deleteMany({
                        where: { id: { in: batch }, user_id: userId },
                    });
                    deleted += result.count;
                }

                // Best-effort direct file cleanup
                if (diskPaths.length > 0) {
                    await Promise.allSettled(
                        diskPaths.map((p) => deleteFileFromDisk(p))
                    );
                }

                return NextResponse.json({ affected: deleted });
            }

            case "move": {
                if (!data || data.parent_id === undefined) {
                    return NextResponse.json(
                        { error: "data.parent_id is required for move" },
                        { status: 400 }
                    );
                }

                // Validate destination folder ownership (null → root is allowed)
                const targetParentId = data.parent_id === null ? null : String(data.parent_id);
                if (targetParentId !== null) {
                    const parent = await prisma.contentItem.findFirst({
                        where: { id: targetParentId, user_id: userId },
                        select: { id: true, type: true },
                    });
                    if (!parent) {
                        return NextResponse.json(
                            { error: "Invalid destination folder" },
                            { status: 400 }
                        );
                    }
                    // Destination must be a folder-like item
                    if (parent.type !== "folder" && parent.type !== "carousel_folder") {
                        return NextResponse.json(
                            { error: "Destination is not a folder" },
                            { status: 400 }
                        );
                    }
                }

                let affected = 0;
                for (const batch of chunkArray(targetIds, IN_BATCH_SIZE)) {
                    const result = await prisma.contentItem.updateMany({
                        where: { id: { in: batch }, user_id: userId },
                        data: { parent_id: targetParentId },
                    });
                    affected += result.count;
                }
                return NextResponse.json({ affected });
            }

            case "rename": {
                if (!data || !data.prefix) {
                    return NextResponse.json(
                        { error: "data.prefix is required for rename" },
                        { status: 400 }
                    );
                }

                // Sanitize prefix: must be a single path segment (no "/", no "..")
                const cleanPrefix = cleanPathSegment(String(data.prefix));
                if (cleanPrefix === null || cleanPrefix === "" || cleanPrefix.includes("/") || cleanPrefix === ".") {
                    return NextResponse.json({ error: "Invalid rename prefix" }, { status: 400 });
                }

                // Fetch items, then sort by their position in the received id
                // array so the numeric suffix follows the user's click order.
                const itemsToRename = await prisma.contentItem.findMany({
                    where: ownershipWhere,
                    select: { id: true },
                });

                const position = new Map(targetIds.map((id, i) => [id, i]));
                itemsToRename.sort(
                    (a, b) => (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER)
                );

                // Apply in small transactions (avoids long write locks on SQLite)
                for (const [batchIndex, batch] of chunkArray(itemsToRename, RENAME_BATCH_SIZE).entries()) {
                    const globalStart = batchIndex * RENAME_BATCH_SIZE;
                    await prisma.$transaction(
                        batch.map((item: { id: string }, j: number) =>
                            prisma.contentItem.update({
                                where: { id: item.id },
                                data: {
                                    name: `${cleanPrefix}_${String(globalStart + j + 1).padStart(3, "0")}`,
                                },
                            })
                        )
                    );
                }

                return NextResponse.json({ affected: itemsToRename.length });
            }

            default:
                return NextResponse.json(
                    { error: `Unknown action: ${action}` },
                    { status: 400 }
                );
        }
    } catch (error: unknown) {
        console.error("Bulk operation error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
