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
export async function OPTIONS() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
    });
}

export async function HEAD(
    req: Request,
    { params }: { params: Promise<{ path: string[] }> }
) {
    return handleFileRequest(req, params, true);
}

export async function GET(
    req: Request,
    { params }: { params: Promise<{ path: string[] }> }
) {
    return handleFileRequest(req, params, false);
}

async function handleFileRequest(
    req: Request,
    paramsPromise: Promise<{ path: string[] }>,
    isHead: boolean
) {
    const { path } = await paramsPromise;
    const filePath = path.join("/");

    // Security: ensure path doesn't escape the uploads directory
    if (filePath.includes("..")) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Try /data/uploads first (new location), then /public/uploads (legacy)
    // Also try collapsing duplicate leading path segment for old records
    // e.g. "admin/admin/file.mp4" → also try "admin/file.mp4"
    const parts = filePath.split("/");
    const dedupedPath = parts.length >= 2 && parts[0] === parts[1]
        ? parts.slice(1).join("/")
        : null;

    const candidatePaths = [
        join(process.cwd(), "data", "uploads", filePath),
        ...(dedupedPath ? [join(process.cwd(), "data", "uploads", dedupedPath)] : []),
        join(process.cwd(), "public", "uploads", filePath),
        ...(dedupedPath ? [join(process.cwd(), "public", "uploads", dedupedPath)] : []),
    ];

    for (const candidate of candidatePaths) {
        try {
            const data = await readFile(candidate);
            const ext = extname(filePath).toLowerCase();
            const mimeType = MIME_TYPES[ext] || "application/octet-stream";

            return new Response(isHead ? null : data, {
                headers: {
                    "Content-Type": mimeType,
                    "Content-Length": data.length.toString(),
                    "Cache-Control": "public, max-age=86400, must-revalidate",
                    "Access-Control-Allow-Origin": "*",
                    "Accept-Ranges": "bytes",
                    "X-Content-Type-Options": "nosniff"
                },
            });
        } catch {
            // File not found at this path, try next
        }
    }

    return new Response(JSON.stringify({ error: "File not found" }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
    });
}
