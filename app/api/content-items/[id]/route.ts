import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { deleteFileFromDisk, buildDiskPath, extractUploadPathFromUrl } from "@/lib/deleteFiles";
import { cleanPathSegment } from "@/lib/upload-path";

// Fields a client may update. Server-owned fields (id, user_id, created_at,
// path) are excluded to prevent mass assignment / arbitrary file deletion.
const PATCH_ALLOWED_FIELDS = [
    "name", "title", "caption", "tags", "type", "size", "duration",
    "parent_id", "thumbnail_url",
] as const;

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

        // Sanitize name (must not contain path separators / traversal)
        if (payload.name !== undefined) {
            const cleanName = cleanPathSegment(String(payload.name));
            if (cleanName === null || cleanName.includes("/") || cleanName === "." || cleanName === "") {
                return NextResponse.json({ error: "Invalid name" }, { status: 400 });
            }
            payload.name = cleanName;
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

        // Tags: store as JSON string
        if (payload.tags !== undefined && typeof payload.tags !== "string") {
            payload.tags = JSON.stringify(payload.tags);
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
        // Fetch the item first so we can clean up its file
        const item = await prisma.contentItem.findFirst({
            where: { id, user_id: userId },
            select: { id: true, name: true, path: true, type: true, thumbnail_url: true },
        });

        if (!item) {
            return NextResponse.json({ error: "Item not found or unauthorized" }, { status: 404 });
        }

        // Collect all files to delete
        const filesToDelete: string[] = [];

        // If the item itself has a file (non-folder types)
        if (item.type !== "carousel_folder" && item.name) {
            const diskPath = buildDiskPath(userId, item.path, item.name);
            if (diskPath) filesToDelete.push(diskPath);
        }
        const itemThumb = extractUploadPathFromUrl(item.thumbnail_url);
        if (itemThumb) {
            filesToDelete.push(itemThumb);
        }

        // If it's a carousel folder, also collect children's files
        if (item.type === "carousel_folder") {
            const children = await prisma.contentItem.findMany({
                where: { parent_id: item.id },
                select: { name: true, path: true, thumbnail_url: true },
            });
            for (const child of children) {
                if (child.name) {
                    const diskPath = buildDiskPath(userId, child.path, child.name);
                    if (diskPath) filesToDelete.push(diskPath);
                }
                const childThumb = extractUploadPathFromUrl(child.thumbnail_url);
                if (childThumb) {
                    filesToDelete.push(childThumb);
                }
            }
        }

        // Delete from DB (cascade handles children records)
        await prisma.contentItem.deleteMany({
            where: { id, user_id: userId },
        });

        // Best-effort file cleanup
        await Promise.allSettled(
            filesToDelete.map((p) => deleteFileFromDisk(p))
        );

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('Delete content item error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
