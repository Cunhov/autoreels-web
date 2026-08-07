import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { unlink } from "fs/promises";
import { join } from "path";
import { normalizeUploadPath } from "@/lib/upload-path";
import { getErrorMessage, getSessionUserId } from "@/lib/api";

export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const url = new URL(req.url);
        const path = url.searchParams.get("path");

        if (!path) {
            return NextResponse.json({ error: "No path provided" }, { status: 400 });
        }

        // Security check: normalize + reject traversal ("..", absolute paths).
        // Accepts both "userId/..." prefixed and bare "folder/file" paths.
        const safePath = normalizeUploadPath(userId, path);
        if (!safePath) {
            return NextResponse.json({ error: "Permission denied" }, { status: 403 });
        }

        // Try /data/uploads first (new location), then /public/uploads (legacy)
        const candidates = [
            join(process.cwd(), "data", "uploads", safePath),
            join(process.cwd(), "public", "uploads", safePath),
        ];

        for (const filePath of candidates) {
            try {
                await unlink(filePath);
                break; // Deleted successfully, stop
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
                    // Real error — not "file not found"
                    throw err;
                }
                // File not found at this path, try next
            }
        }

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('Local delete error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
