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
import { randomUUID } from "crypto";

const MAX_SIZE = 300 * 1024 * 1024; // 300 MB
const DOWNLOAD_TIMEOUT_MS = 90_000;

// Media extensions → content type
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".3gp", ".mpeg", ".mpg", ".m2ts", ".ts"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".heic", ".heif"]);

import { isHostAllowed } from "@/lib/ssrf-guard";

/**
 * `isHostAllowed` LANÇA quando a resolução DNS falha (pane transitória do
 * resolver) — erro de validação retentável, não um bloqueio. Aqui isso vira
 * `null` para o import-url responder mensagem estável ("tente novamente")
 * em vez de vazar a mensagem crua do resolver ou mascarar como "Invalid
 * redirect target". `false` = host realmente privado/loopback (bloqueio);
 * `true` = publicamente acessível.
 */
async function hostAllowedOrStable(hostname: string): Promise<boolean | null> {
    try {
        return await isHostAllowed(hostname);
    } catch {
        return null;
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
        const hostAllowed = await hostAllowedOrStable(url.hostname);
        if (hostAllowed === false) {
            return NextResponse.json({ error: "URL host is not publicly reachable" }, { status: 400 });
        }
        if (hostAllowed === null) {
            return NextResponse.json(
                { error: "Não foi possível validar o host — tente novamente" },
                { status: 400 },
            );
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
            if (finalUrl.hostname !== url.hostname) {
                const finalAllowed = await hostAllowedOrStable(finalUrl.hostname);
                if (finalAllowed === false) {
                    return NextResponse.json({ error: "Redirected to a blocked host" }, { status: 400 });
                }
                if (finalAllowed === null) {
                    return NextResponse.json(
                        { error: "Não foi possível validar o host de redirecionamento — tente novamente" },
                        { status: 400 },
                    );
                }
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
