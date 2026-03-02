import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { join, extname } from "path";

// Simple MIME type map (no external dependencies)
const MIME_TYPES: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".txt": "text/plain",
};

// Serve uploaded files stored in /app/data/uploads (Docker volume)
// Also checks /public/uploads for backwards compatibility
export async function GET(
    req: Request,
    { params }: { params: Promise<{ path: string[] }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { path } = await params;
    const filePath = path.join("/");

    // Security: ensure path doesn't escape the uploads directory
    if (filePath.includes("..")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Try /data/uploads first (new location), then /public/uploads (legacy)
    const candidatePaths = [
        join(process.cwd(), "data", "uploads", filePath),
        join(process.cwd(), "public", "uploads", filePath),
    ];

    for (const candidate of candidatePaths) {
        try {
            const data = await readFile(candidate);
            const ext = extname(filePath).toLowerCase();
            const mimeType = MIME_TYPES[ext] || "application/octet-stream";
            return new Response(data, {
                headers: {
                    "Content-Type": mimeType,
                    "Cache-Control": "private, max-age=86400",
                },
            });
        } catch {
            // File not found at this path, try next
        }
    }

    return NextResponse.json({ error: "File not found" }, { status: 404 });
}
