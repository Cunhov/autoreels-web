import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { mkdir, rename } from "fs/promises";
import { join, dirname, posix } from "path";
import type { ReadableStream as NodeReadableStream } from "stream/web";

function normalizeUploadPath(userId: string, rawPath: string) {
    const normalized = posix.normalize(rawPath.replace(/\\/g, "/")).replace(/^\/+/, "");
    const withoutUserPrefix = normalized.startsWith(`${userId}/`)
        ? normalized.slice(userId.length + 1)
        : normalized;

    if (!withoutUserPrefix || withoutUserPrefix === "." || withoutUserPrefix.startsWith("../") || withoutUserPrefix.includes("/../")) {
        return null;
    }

    return `${userId}/${withoutUserPrefix}`;
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

        const path = normalizeUploadPath(userId, rawPath);
        if (!path) {
            return NextResponse.json({ error: "Invalid upload path" }, { status: 400 });
        }

        const uploadDir = join(process.cwd(), "data", "uploads");
        const filePath = join(uploadDir, path);
        const tempFilePath = `${filePath}.part`;

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

        await pipeline(readableStream, writeStream);

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
