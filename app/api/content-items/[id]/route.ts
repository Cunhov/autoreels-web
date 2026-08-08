import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { deleteFileFromDisk, collectItemFiles } from "@/lib/deleteFiles";
import { cleanPathSegment } from "@/lib/upload-path";
import { normalizeTags } from "../shared";

// Fields a client may update. Server-owned fields (id, user_id, created_at,
// path) are excluded to prevent mass assignment / arbitrary file deletion.
const PATCH_ALLOWED_FIELDS = [
    "name", "title", "caption", "tags", "type", "size", "duration",
    "parent_id", "thumbnail_url", "url",
] as const;

// Hard safety cap for recursive descendant collection (prevents runaway scans)
const MAX_COLLECT_ITEMS = 10_000;

/**
 * Recursively collect an item plus ALL descendants (any depth) with the
 * fields needed for disk cleanup. Returns [] if the root is missing.
 */
async function collectWithDescendants(
    root: { id: string; url?: string | null; thumbnail_url?: string | null; name?: string | null; path?: string | null }
) {
    const collected: Array<{ url: string | null; thumbnail_url: string | null; name: string | null; path: string | null }> = [
        {
            url: root.url ?? null,
            thumbnail_url: root.thumbnail_url ?? null,
            name: root.name ?? null,
            path: root.path ?? null,
        },
    ];

    let currentLevel: string[] = [root.id];
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
            console.warn(`[cleanup] Descendant collection exceeded ${MAX_COLLECT_ITEMS} items; truncating.`);
            break;
        }

        currentLevel = level.map((c) => c.id);
        guard++;
    }

    return collected;
}

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const item = await prisma.contentItem.findUnique({
            where: { id, user_id: userId },
        });
        if (!item) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
        return NextResponse.json(item);
    } catch (error: unknown) {
        console.error('Get content item error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const data = await req.json();

        // Whitelist: drop any field not in the allowed list (prevents mass assignment)
        const payload: Record<string, unknown> = {};
        for (const field of PATCH_ALLOWED_FIELDS) {
            if (data[field] !== undefined) payload[field] = data[field];
        }

        // Nothing to update (e.g. client sent only server-owned fields)
        if (Object.keys(payload).length === 0) {
            return NextResponse.json({ error: "No fields to update" }, { status: 400 });
        }

        // Sanitize name (must not contain path separators / traversal)
        if (payload.name !== undefined) {
            const cleanName = cleanPathSegment(String(payload.name));
            if (cleanName === null || cleanName.includes("/") || cleanName === "." || cleanName === "") {
                return NextResponse.json({ error: "Invalid name" }, { status: 400 });
            }
            payload.name = cleanName;
        }

        // Validate url (used by "replace original" from the image editor): must
        // be our own /api/file/{userId}/... path, without traversal. Never accept
        // `path` (disk layout is server-owned).
        if (payload.url !== undefined) {
            const url = payload.url as string | null;
            if (url && (!url.startsWith(`/api/file/${userId}/`) || url.includes(".."))) {
                return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
            }
            payload.url = url;
        }

        // Validate size (replacement metadata): non-negative integer
        if (payload.size !== undefined) {
            const size = Number(payload.size);
            if (!Number.isInteger(size) || size < 0) {
                return NextResponse.json({ error: "Invalid size" }, { status: 400 });
            }
            payload.size = size;
        }

        // Sanitize thumbnail_url (must be our own /api/file/ path or http(s))
        if (payload.thumbnail_url !== undefined) {
            const thumb = payload.thumbnail_url as string | null;
            if (thumb && !thumb.startsWith("/api/file/") && !/^https?:\/\//.test(thumb)) {
                return NextResponse.json({ error: "Invalid thumbnail URL" }, { status: 400 });
            }
            if (thumb && thumb.startsWith("/api/file/")) {
                const rest = thumb.slice("/api/file/".length);
                if (cleanPathSegment(rest) === null) {
                    return NextResponse.json({ error: "Invalid thumbnail URL" }, { status: 400 });
                }
            }
        }

        // Validate parent folder ownership (parent_id: null → root is allowed)
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

        const result = await prisma.contentItem.updateMany({
            where: { id, user_id: userId },
            data: payload,
        });

        if (result.count === 0) {
            return NextResponse.json({ error: "Item not found or unauthorized" }, { status: 404 });
        }

        const updatedItem = await prisma.contentItem.findFirst({ where: { id, user_id: userId } });
        return NextResponse.json(updatedItem);
    } catch (error: unknown) {
        console.error('Update content item error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        // Fetch the item first so we can clean up its files
        const item = await prisma.contentItem.findFirst({
            where: { id, user_id: userId },
            select: {
                id: true,
                name: true,
                path: true,
                type: true,
                thumbnail_url: true,
                url: true,
            },
        });

        if (!item) {
            return NextResponse.json({ error: "Item not found or unauthorized" }, { status: 404 });
        }

        // Recursively collect this item + every descendant (any depth)
        const allItems = await collectWithDescendants(item);

        // Resolve every file (URL is the source of truth; legacy fallback to path+name)
        const filesToDelete = allItems.flatMap((c) => collectItemFiles(userId, c));

        // Delete from DB first (cascade handles descendant records)
        await prisma.contentItem.deleteMany({
            where: { id, user_id: userId },
        });

        // Best-effort file cleanup — never let disk failures block the DB delete
        await Promise.allSettled(
            filesToDelete.map((p) => deleteFileFromDisk(p))
        );

        return NextResponse.json({ success: true, files_cleaned: filesToDelete.length });
    } catch (error: unknown) {
        console.error('Delete content item error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
