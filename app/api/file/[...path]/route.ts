import { lstat } from "fs/promises";
import { createReadStream } from "fs";
import { extname, resolve, sep } from "path";
import { Readable } from "stream";

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

function fileStream(path: string, range?: { start: number; end: number }) {
    const stream = range
        ? createReadStream(path, { start: range.start, end: range.end })
        : createReadStream(path);
    return Readable.toWeb(stream) as ReadableStream;
}

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

    if (!filePath || filePath.includes("..") || filePath.startsWith("/") || filePath.includes("\\")) {
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

    const roots = [
        resolve(process.cwd(), "data", "uploads"),
        resolve(process.cwd(), "public", "uploads"),
    ];
    const relativePaths = [filePath, ...(dedupedPath ? [dedupedPath] : [])];
    const candidatePaths = roots.flatMap(root =>
        relativePaths.map(relativePath => {
            const candidate = resolve(root, relativePath);
            return candidate.startsWith(root + sep) ? candidate : null;
        })
    ).filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidatePaths) {
        try {
            // lstat: reject symlinks (defense against a symlink pointing outside
            // the uploads root being dropped into the volume).
            const fileStat = await lstat(candidate);
            if (!fileStat.isFile()) continue;

            const ext = extname(filePath).toLowerCase();
            const mimeType = MIME_TYPES[ext] || "application/octet-stream";
            const etag = `"${fileStat.size}-${Math.floor(fileStat.mtimeMs)}"`;
            const lastModified = new Date(fileStat.mtimeMs).toUTCString();
            const range = req.headers.get("range");
            const baseHeaders = {
                "Content-Type": mimeType,
                "Cache-Control": "public, max-age=604800, immutable",
                "Access-Control-Allow-Origin": "*",
                "Accept-Ranges": "bytes",
                "X-Content-Type-Options": "nosniff",
                "ETag": etag,
                "Last-Modified": lastModified,
            };

            // Conditional request: 304 when the ETag matches.
            if (req.headers.get("if-none-match") === etag) {
                return new Response(null, {
                    status: 304,
                    headers: {
                        "ETag": etag,
                        "Cache-Control": "public, max-age=604800, immutable",
                        "Access-Control-Allow-Origin": "*",
                    },
                });
            }

            if (range) {
                const match = range.match(/^bytes=(\d*)-(\d*)$/);
                if (!match) {
                    return new Response(null, { status: 416, headers: baseHeaders });
                }

                const size = fileStat.size;
                const hasStart = match[1] !== "";
                const hasEnd = match[2] !== "";
                let start: number;
                let end: number;

                if (!hasStart && hasEnd) {
                    // Suffix range: bytes=-N → the LAST N bytes. bytes=-0 → 416.
                    const suffix = Number(match[2]);
                    if (!Number.isInteger(suffix) || suffix <= 0) {
                        return new Response(null, {
                            status: 416,
                            headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
                        });
                    }
                    start = Math.max(size - suffix, 0);
                    end = size - 1;
                } else {
                    start = hasStart ? Number(match[1]) : 0;
                    end = hasEnd ? Math.min(Number(match[2]), size - 1) : size - 1;
                }

                if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
                    return new Response(null, {
                        status: 416,
                        headers: {
                            ...baseHeaders,
                            "Content-Range": `bytes */${size}`,
                        },
                    });
                }

                return new Response(isHead ? null : fileStream(candidate, { start, end }), {
                    status: 206,
                    headers: {
                        ...baseHeaders,
                        "Content-Length": String(end - start + 1),
                        "Content-Range": `bytes ${start}-${end}/${size}`,
                    },
                });
            }

            return new Response(isHead ? null : fileStream(candidate), {
                headers: {
                    ...baseHeaders,
                    "Content-Length": String(fileStat.size),
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
