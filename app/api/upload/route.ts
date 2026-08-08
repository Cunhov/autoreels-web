import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { mkdir, unlink, rename, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { normalizeUploadPath, safeMediaExtension } from "@/lib/upload-path";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { Readable, PassThrough } from "stream";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";

const MAX_SIMPLE_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB
// Multipart fallback buffers the whole file in memory (file.arrayBuffer) — only
// allow small files on that path; anything bigger must go through the streaming
// path or /api/upload-chunk.
const MAX_MULTIPART_MEMORY_BYTES = 10 * 1024 * 1024; // 10MB

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const requestedPath = url.searchParams.get("path");

    // ── Legacy multipart path (small files only, e.g. client-generated thumbnails) ──
    if (!requestedPath) {
        try {
            const formData = await req.formData();
            const file = formData.get("file") as File;
            const path = formData.get("path") as string;

            if (!file || !path) {
                return NextResponse.json({ error: "Missing file or path" }, { status: 400 });
            }
            if (file.size > MAX_MULTIPART_MEMORY_BYTES) {
                return NextResponse.json(
                    { error: "Multipart uploads are limited to 10MB — use the chunked endpoint for larger files" },
                    { status: 413 }
                );
            }

            // Security check: normalize + reject traversal ("..", absolute paths)
            const safePath = normalizeUploadPath(userId, path);
            if (!safePath) {
                return NextResponse.json({ error: "Invalid upload path" }, { status: 403 });
            }

            // Server-generated UUID name (unpredictable public URL)
            const ext = safeMediaExtension(file.name) || safeMediaExtension(path) || "bin";
            const uuidName = `${randomUUID()}.${ext}`;
            const finalPath = `${userId}/${uuidName}`;
            const uploadDir = join(process.cwd(), "data", "uploads");
            const diskFinal = join(uploadDir, finalPath);
            const diskPart = `${diskFinal}.part`;
            await mkdir(dirname(diskFinal), { recursive: true });

            const bytes = Buffer.from(await file.arrayBuffer());
            await writeFile(diskPart, bytes);
            await rename(diskPart, diskFinal);

            return NextResponse.json({
                success: true,
                path: finalPath,
                url: `/api/file/${finalPath}`,
            });
        } catch {
            return NextResponse.json({ error: "Failed to process form data" }, { status: 400 });
        }
    }

    // ── Streaming path (no memory buffering) ──────────────────────────────────
    try {
        // Reject oversized uploads before streaming (when Content-Length is present)
        const contentLength = Number(req.headers.get("content-length") || "0");
        if (Number.isFinite(contentLength) && contentLength > MAX_SIMPLE_UPLOAD_BYTES) {
            return NextResponse.json({ error: "File too large (max 500MB)" }, { status: 413 });
        }

        // Security check: normalize + reject traversal
        const safePath = normalizeUploadPath(userId, requestedPath);
        if (!safePath) {
            return NextResponse.json({ error: "Invalid upload path" }, { status: 403 });
        }

        // Server-generated UUID name for the final file (staged under .part first)
        const ext = safeMediaExtension(safePath) || "bin";
        const uuidName = `${randomUUID()}.${ext}`;
        const finalPath = `${userId}/${uuidName}`;
        const uploadDir = join(process.cwd(), "data", "uploads");
        const diskFinal = join(uploadDir, finalPath);
        const diskPart = `${diskFinal}.part`;
        await mkdir(dirname(diskFinal), { recursive: true });

        if (!req.body) {
            return NextResponse.json({ error: "No request body" }, { status: 400 });
        }

        const readableStream = Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>);

        // Count bytes mid-stream and enforce the cap even with chunked transfer.
        let written = 0;
        let tooLarge = false;
        const counter = new PassThrough();
        counter.on("data", (chunk: Buffer) => {
            written += chunk.length;
            if (written > MAX_SIMPLE_UPLOAD_BYTES && !tooLarge) {
                tooLarge = true;
                counter.destroy(new Error("TOO_LARGE"));
            }
        });

        const writeStream = createWriteStream(diskPart, { flags: "w" });
        try {
            await pipeline(readableStream, counter, writeStream);
        } catch (err) {
            await unlink(diskPart).catch(() => { });
            if (tooLarge) {
                return NextResponse.json({ error: "File too large (max 500MB)" }, { status: 413 });
            }
            throw err;
        }

        await rename(diskPart, diskFinal);

        return NextResponse.json({
            success: true,
            path: finalPath,
            url: `/api/file/${finalPath}`,
        });
    } catch (error: unknown) {
        console.error("Local upload error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
