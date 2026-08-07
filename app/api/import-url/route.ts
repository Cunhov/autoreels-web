import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { cleanPathSegment } from "@/lib/upload-path";
import { createWriteStream } from "fs";
import { unlink, mkdir } from "fs/promises";
import { join, extname, basename } from "path";
import { pipeline } from "stream/promises";
import { Readable, PassThrough } from "stream";
import { lookup } from "dns/promises";
import { randomUUID } from "crypto";

const MAX_SIZE = 300 * 1024 * 1024; // 300 MB
const DOWNLOAD_TIMEOUT_MS = 90_000;

// Media extensions → content type
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".3gp", ".mpeg", ".mpg", ".m2ts", ".ts"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".heic", ".heif"]);

/**
 * SSRF guard — reject loopback / link-local / private / reserved addresses.
 * Returns true when the address is NOT reachable from outside (blocked).
 */
function isBlockedAddress(ip: string): boolean {
    const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, ""); // strip IPv4-mapped prefix
    if (normalized === "" || normalized === "::" || normalized === "::1" || normalized === "0.0.0.0") return true;
    // IPv6 link-local / unique-local / loopback / unspecified
    if (normalized.includes(":")) {
        if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
        return false; // other IPv6 — allow (public ranges)
    }
    // IPv4
    const parts = normalized.split(".").map(Number);
    if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // 127.0.0.0/8 (loopback)
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 169 && b === 254) return true;         // 169.254.0.0/16 (link-local)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    return false;
}

/** Reject private/loopback hostnames up-front (fast path, before DNS). */
function isBlockedHostname(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (
        h === "localhost" ||
        h === "localhost.localdomain" ||
        h.endsWith(".local") ||
        h.endsWith(".internal") ||
        h.endsWith(".home.arpa")
    ) return true;
    // IP-literal hostnames
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isBlockedAddress(h);
    if (h.includes(":")) return isBlockedAddress(h);
    // Private ranges as bare hostnames (e.g. http://10.0.0.1/x)
    if (
        /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
        /^169\.254\./.test(h) || /^0\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    ) return true;
    return false;
}

/**
 * Validate that a host is publicly reachable (SSRF guard).
 * - Rejects private/loopback hostnames and IP literals.
 * - Resolves DNS and rejects if ANY resolved address is private/loopback.
 * Returns false when the host must be blocked (or DNS fails).
 */
async function isHostAllowed(hostname: string): Promise<boolean> {
    if (isBlockedHostname(hostname)) return false;

    const literal = hostname.replace(/^\[|\]$/g, "");
    // Pure IP literal — validated above by isBlockedHostname; nothing more to resolve
    if (/^\d+\.\d+\.\d+\.\d+$/.test(literal) || literal.includes(":")) return true;

    try {
        const addresses = await lookup(hostname, { all: true });
        if (addresses.length === 0) return false;
        return addresses.every(({ address }) => !isBlockedAddress(address));
    } catch {
        return false; // DNS failure → block
    }
}

/** Infer media type from a file extension. */
function typeFromExtension(ext: string): "video" | "image" | null {
    if (VIDEO_EXTS.has(ext)) return "video";
    if (IMAGE_EXTS.has(ext)) return "image";
    return null;
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json().catch(() => null);
        const rawUrl = body?.url;
        const requestedName = body?.name;
        const parentId = body?.parent_id ?? null;

        if (typeof rawUrl !== "string" || !rawUrl.trim()) {
            return NextResponse.json({ error: "Missing url" }, { status: 400 });
        }

        let url: URL;
        try {
            url = new URL(rawUrl);
        } catch {
            return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return NextResponse.json({ error: "Only http(s) URLs are supported" }, { status: 400 });
        }
        if (url.username || url.password) {
            return NextResponse.json({ error: "URL must not contain credentials" }, { status: 400 });
        }

        // SSRF guard (before any network I/O)
        if (!(await isHostAllowed(url.hostname))) {
            return NextResponse.json({ error: "URL host is not publicly reachable" }, { status: 400 });
        }

        // Parent folder ownership (prevent attaching to another user's folder)
        if (parentId) {
            const parent = await prisma.contentItem.findFirst({
                where: { id: String(parentId), user_id: userId },
                select: { id: true },
            });
            if (!parent) {
                return NextResponse.json({ error: "Invalid parent folder" }, { status: 400 });
            }
        }

        // Determine media type from extension (URL path or user-provided name)
        const cleanName = requestedName ? cleanPathSegment(String(requestedName)) : null;
        const safeName = cleanName && !cleanName.includes("/") && cleanName !== "." ? cleanName : null;
        const extFromUrl = extname(url.pathname).toLowerCase();
        const extFromName = safeName ? extname(safeName).toLowerCase() : "";
        const ext = extFromUrl || extFromName;
        const type = typeFromExtension(ext);
        if (!type) {
            return NextResponse.json({ error: "Unsupported media type (expected video or image URL)" }, { status: 400 });
        }

        // Download with timeout
        let res: Response;
        try {
            res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        } catch (error: unknown) {
            console.error("Import URL download error:", error);
            return NextResponse.json({ error: "Failed to download URL" }, { status: 400 });
        }
        if (!res.ok || !res.body) {
            return NextResponse.json({ error: `Download failed (HTTP ${res.status})` }, { status: 400 });
        }

        // Re-validate the final URL after redirects (defense against redirect-to-private SSRF)
        try {
            const finalUrl = new URL(res.url);
            if (finalUrl.hostname !== url.hostname && !(await isHostAllowed(finalUrl.hostname))) {
                return NextResponse.json({ error: "Redirected to a blocked host" }, { status: 400 });
            }
        } catch {
            return NextResponse.json({ error: "Invalid redirect target" }, { status: 400 });
        }

        // Content-Type sanity check (trust extension when octet-stream)
        const contentType = (res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
        if (contentType && contentType !== "application/octet-stream" && !contentType.startsWith("video/") && !contentType.startsWith("image/")) {
            return NextResponse.json({ error: "Unsupported media type" }, { status: 400 });
        }

        // Size limit (via Content-Length when present)
        const contentLength = Number(res.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_SIZE) {
            return NextResponse.json({ error: "File too large (max 300 MB)" }, { status: 413 });
        }

        // Build destination path: data/uploads/{userId}/{uuid}-{safeName}
        const baseName = safeName || basename(url.pathname) || `media${ext}`;
        const fileName = `${randomUUID()}-${baseName}`;
        const relativePath = `${userId}/${fileName}`;
        const uploadDir = join(process.cwd(), "data", "uploads", userId);
        await mkdir(uploadDir, { recursive: true });
        const filePath = join(uploadDir, fileName);

        // Stream to disk, counting bytes and enforcing the cap mid-stream
        let written = 0;
        let tooLarge = false;
        const counter = new PassThrough();
        counter.on("data", (chunk: Buffer) => {
            written += chunk.length;
            if (written > MAX_SIZE && !tooLarge) {
                tooLarge = true;
                counter.destroy(new Error("TOO_LARGE"));
            }
        });

        try {
            await pipeline(
                Readable.fromWeb(res.body as import("stream/web").ReadableStream),
                counter,
                createWriteStream(filePath)
            );
        } catch (error: unknown) {
            await unlink(filePath).catch(() => { });
            if (tooLarge) {
                return NextResponse.json({ error: "File too large (max 300 MB)" }, { status: 413 });
            }
            console.error("Import URL stream error:", error);
            return NextResponse.json({ error: "Download failed" }, { status: 400 });
        }

        if (written === 0) {
            await unlink(filePath).catch(() => { });
            return NextResponse.json({ error: "Downloaded file is empty" }, { status: 400 });
        }

        // Persist as a content item
        const item = await prisma.contentItem.create({
            data: {
                user_id: userId,
                name: baseName,
                type,
                url: `/api/file/${relativePath}`,
                path: relativePath,
                size: written,
                parent_id: parentId || null,
            },
        });

        return NextResponse.json(item, { status: 201 });
    } catch (error: unknown) {
        console.error("Import URL error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
