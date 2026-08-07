import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { mkdir, rename, unlink } from "fs/promises";
import { join, dirname } from "path";
import { normalizeUploadPath } from "@/lib/upload-path";
import type { ReadableStream as NodeReadableStream } from "stream/web";

const MAX_CHUNK_BYTES = 1024 * 1024 * 1024; // 1GB per chunk (defensive ceiling)

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let tempFilePath: string | null = null;

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

        // Defensive size ceiling per chunk
        const contentLength = Number(req.headers.get("content-length") || "0");
        if (Number.isFinite(contentLength) && contentLength > MAX_CHUNK_BYTES) {
            return NextResponse.json({ error: "Chunk too large" }, { status: 413 });
        }

        const path = normalizeUploadPath(userId, rawPath);
        if (!path) {
            return NextResponse.json({ error: "Invalid upload path" }, { status: 400 });
        }

        const uploadDir = join(process.cwd(), "data", "uploads");
        const filePath = join(uploadDir, path);
        tempFilePath = `${filePath}.part`;

        // Ensure subdirectories exist
        await mkdir(dirname(filePath), { recursive: true });

        // Pipe request body stream directly to Temporary chunk file
        if (!req.body) {
            return NextResponse.json({ error: "No request body" }, { status: 400 });
        }

        // Convert Web ReadableStream to Node.js Readable and pipe via chunks
        const { Readable } = await import('stream');
        const { createWriteStream } = await import('fs');
        const { pipeline } = await import('stream/promises');

        const readableStream = Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>);

        // Use append mode for parts > 0 to collect all chunks safely
        const flags = chunkIndex === 0 ? 'w' : 'a';
        const writeStream = createWriteStream(tempFilePath, { flags });

        try {
            await pipeline(readableStream, writeStream);
        } catch (err) {
            // Clean up the partial .part file on failure
            await unlink(tempFilePath).catch(() => { });
            throw err;
        }

        // If this is the last chunk, rename the temporary file to its final destination
        if (chunkIndex === totalChunks - 1) {
            await rename(tempFilePath, filePath);
            return NextResponse.json({ success: true, path, completed: true });
        }

        return NextResponse.json({ success: true, path, completed: false });
    } catch (error: unknown) {
        console.error('Local chunk upload error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
