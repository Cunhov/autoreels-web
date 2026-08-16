import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { mkdir, unlink, readdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { normalizeUploadPath } from "@/lib/upload-path";
import { sweepStaleStaging } from "@/lib/upload-gc";
import { isLocked } from "@/lib/upload-lock";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { Readable, PassThrough } from "stream";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

const MAX_CHUNK_BYTES = 1024 * 1024 * 1024; // 1GB per chunk (defensive ceiling)
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB total file ceiling (declared via x-file-size)

function getUploadsDir(): string {
    return join(process.cwd(), "data", "uploads");
}

/** List part indices (`.part.{i}`) present for a staging path. */
async function listPartIndices(partBase: string): Promise<number[]> {
    const dir = dirname(partBase);
    const prefix = `${basename(partBase)}.part.`;
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return [];
    }
    const indices: number[] = [];
    for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        const indexStr = entry.slice(prefix.length);
        const index = Number(indexStr);
        if (Number.isInteger(index) && index >= 0) indices.push(index);
    }
    return indices.sort((a, b) => a - b);
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const chunkIndex = parseInt(req.headers.get("x-chunk-index") || "0");
        const totalChunks = parseInt(req.headers.get("x-total-chunks") || "1");
        const rawPath = req.headers.get("x-file-name");

        if (!rawPath) {
            return NextResponse.json({ error: "Missing x-file-name header" }, { status: 400 });
        }

        // Validate numeric chunk metadata (NaN → 400, not silent breakage)
        if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) ||
            chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks) {
            return NextResponse.json({ error: "Invalid chunk index or total" }, { status: 400 });
        }

        // x-file-size: required on the first chunk, validated for consistency when present.
        // Lets the server (a) reject oversized files early and (b) verify integrity at complete.
        const declaredSizeRaw = req.headers.get("x-file-size");
        if (chunkIndex === 0 && !declaredSizeRaw) {
            return NextResponse.json({ error: "Missing x-file-size header on first chunk" }, { status: 400 });
        }
        if (declaredSizeRaw) {
            const declaredSize = Number(declaredSizeRaw);
            if (!Number.isInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_FILE_SIZE) {
                return NextResponse.json({ error: "Invalid x-file-size" }, { status: 400 });
            }
        }

        // Defensive size ceiling per chunk (via Content-Length when present)
        const contentLength = Number(req.headers.get("content-length") || "0");
        if (Number.isFinite(contentLength) && contentLength > MAX_CHUNK_BYTES) {
            return NextResponse.json({ error: "Chunk too large" }, { status: 413 });
        }

        const path = normalizeUploadPath(userId, rawPath);
        if (!path) {
            return NextResponse.json({ error: "Invalid upload path" }, { status: 400 });
        }

        const uploadDir = getUploadsDir();
        const partBase = join(uploadDir, path);

        // A finalize is consuming these parts right now — do NOT write into it.
        // The client treats this 409 as "skip to complete" (idempotent replay).
        if (await isLocked(partBase)) {
            return NextResponse.json({ error: "Finalize in progress", finalizing: true }, { status: 409 });
        }

        // Idempotent per-chunk file: {path}.part.{i}. Re-sending the same chunk
        // overwrites it (flag 'w'), making retries safe. Concatenation happens in
        // /api/upload-chunk/complete — the last chunk does NOT rename anymore.
        const partFilePath = join(uploadDir, `${path}.part.${chunkIndex}`);
        await mkdir(dirname(partFilePath), { recursive: true });

        if (!req.body) {
            return NextResponse.json({ error: "No request body" }, { status: 400 });
        }

        const readableStream = Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>);

        // Count bytes mid-stream and enforce the per-chunk ceiling even when
        // Content-Length is missing/spoofed (chunked transfer).
        let written = 0;
        let tooLarge = false;
        const counter = new PassThrough();
        counter.on("data", (chunk: Buffer) => {
            written += chunk.length;
            if (written > MAX_CHUNK_BYTES && !tooLarge) {
                tooLarge = true;
                counter.destroy(new Error("CHUNK_TOO_LARGE"));
            }
        });

        const writeStream = createWriteStream(partFilePath, { flags: "w" });
        try {
            await pipeline(readableStream, counter, writeStream);
        } catch (err) {
            await unlink(partFilePath).catch(() => { });
            if (tooLarge) {
                return NextResponse.json({ error: "Chunk too large" }, { status: 413 });
            }
            throw err;
        }

        // Success: the part is staged under {path}.part.{chunkIndex}.
        // 'completed' is only meaningful after /api/upload-chunk/complete runs.
        if (chunkIndex === 0) {
            // Opportunistic staging GC (debounced 60s, best-effort): a fresh
            // upload is the natural moment to reclaim orphaned parts left by a
            // cancelled/failed predecessor on the same path.
            void sweepStaleStaging(getUploadsDir()).catch(() => { });
        }
        return NextResponse.json({ success: true, path, chunkIndex, completed: false });
    } catch (error: unknown) {
        console.error("Local chunk upload error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

/**
 * Cancel a staged upload: remove ALL `.part.{i}` files for the given path.
 * Used by the client when an upload is cancelled/aborted. Does not touch any
 * final file — those are only created by /api/upload-chunk/complete.
 */
export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const url = new URL(req.url);
        const rawPath = url.searchParams.get("path");
        const path = normalizeUploadPath(userId, rawPath || "");
        if (!path) {
            return NextResponse.json({ error: "Invalid upload path" }, { status: 400 });
        }

        const uploadDir = getUploadsDir();
        const partBase = join(uploadDir, path);

        // A finalize owns the parts now — cancelling would delete files the
        // finalize is concatenating. The finalize cleans up after itself.
        if (await isLocked(partBase)) {
            return NextResponse.json({ error: "Finalize in progress", finalizing: true }, { status: 409 });
        }

        const indices = await listPartIndices(partBase);
        let removed = 0;
        for (const index of indices) {
            await unlink(`${partBase}.part.${index}`).catch(() => { });
            removed++;
        }

        return NextResponse.json({ ok: true, removed });
    } catch (error: unknown) {
        console.error("Cancel chunk upload error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

// Re-exported for the status route to avoid duplicating the discovery logic.
export { listPartIndices, getUploadsDir };
