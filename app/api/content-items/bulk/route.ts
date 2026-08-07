import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { buildContentWhere } from "../route";
import { deleteFileFromDisk, buildDiskPath, extractUploadPathFromUrl } from "@/lib/deleteFiles";
import { cleanPathSegment } from "@/lib/upload-path";

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
        // ids: string[]           — explicit item IDs
        // all: boolean            — select all matching items
        // filters: object         — query-param-like filters when all=true
        // data: object            — payload for move/rename

        if (!action) {
            return NextResponse.json({ error: "Missing action" }, { status: 400 });
        }

        // Resolve the set of target IDs
        let targetIds: string[] = ids || [];

        if (all) {
            // Build a where clause from the filters to find all matching IDs
            const filterParams = new URLSearchParams(filters || {});
            const where = buildContentWhere(userId, filterParams);
            const allItems = await prisma.contentItem.findMany({
                where,
                select: { id: true },
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
                    select: { id: true, name: true, path: true, type: true, thumbnail_url: true },
                });

                // Collect all disk paths to delete
                const diskPaths: string[] = [];

                // Add direct item files (non-folder types)
                for (const item of itemsToDelete) {
                    if (item.type !== "carousel_folder" && item.name) {
                        const diskPath = buildDiskPath(userId, item.path, item.name);
                        if (diskPath) diskPaths.push(diskPath);
                    }
                    const thumb = extractUploadPathFromUrl(item.thumbnail_url);
                    if (thumb) {
                        diskPaths.push(thumb);
                    }
                }

                // Collect children of carousel folders
                const folderIds = itemsToDelete
                    .filter((item: { type: string }) => item.type === "carousel_folder")
                    .map((item: { id: string }) => item.id);

                if (folderIds.length > 0) {
                    const descendants = await prisma.contentItem.findMany({
                        where: { parent_id: { in: folderIds } },
                        select: { name: true, path: true, thumbnail_url: true },
                    });
                    for (const d of descendants) {
                        if (d.name) {
                            const diskPath = buildDiskPath(userId, d.path, d.name);
                            if (diskPath) diskPaths.push(diskPath);
                        }
                        const thumb = extractUploadPathFromUrl(d.thumbnail_url);
                        if (thumb) {
                            diskPaths.push(thumb);
                        }
                    }
                }

                // Delete from DB (cascade handles children records)
                const result = await prisma.contentItem.deleteMany({
                    where: ownershipWhere,
                });

                // Best-effort direct file cleanup
                if (diskPaths.length > 0) {
                    await Promise.allSettled(
                        diskPaths.map((p) => deleteFileFromDisk(p))
                    );
                }

                return NextResponse.json({ affected: result.count });
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
                        select: { id: true },
                    });
                    if (!parent) {
                        return NextResponse.json(
                            { error: "Invalid destination folder" },
                            { status: 400 }
                        );
                    }
                }

                const result = await prisma.contentItem.updateMany({
                    where: ownershipWhere,
                    data: { parent_id: targetParentId },
                });
                return NextResponse.json({ affected: result.count });
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

                // For rename, we need ordering, so fetch items in order
                const itemsToRename = await prisma.contentItem.findMany({
                    where: ownershipWhere,
                    orderBy: { name: "asc" },
                    select: { id: true },
                });

                // Use a transaction for atomicity
                await prisma.$transaction(
                    itemsToRename.map((item: { id: string }, i: number) =>
                        prisma.contentItem.update({
                            where: { id: item.id },
                            data: {
                                name: `${cleanPrefix}_${String(i + 1).padStart(3, "0")}`,
                            },
                        })
                    )
                );

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
