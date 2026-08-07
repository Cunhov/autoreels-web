import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { writeFile, mkdir, unlink } from "fs/promises";
import { join, dirname } from "path";
import { normalizeUploadPath } from "@/lib/upload-path";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import type { ReadableStream as NodeReadableStream } from "stream/web";

const MAX_SIMPLE_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const url = new URL(req.url);
        let path = url.searchParams.get("path");

        // If no 'path' query param, try to parse as multipart form data (legacy support)
        if (!path) {
            try {
                const formData = await req.formData();
                const file = formData.get("file") as File;
                path = formData.get("path") as string;

                if (!file || !path) {
                    return NextResponse.json({ error: "Missing file or path" }, { status: 400 });
                }
                if (file.size > MAX_SIMPLE_UPLOAD_BYTES) {
                    return NextResponse.json({ error: "File too large (max 500MB)" }, { status: 413 });
                }

                // Security check: normalize + reject traversal ("..", absolute paths)
                const safePath = normalizeUploadPath(userId, path);
                if (!safePath) {
                    return NextResponse.json({ error: "Invalid upload path" }, { status: 403 });
                }

                const bytes = await file.arrayBuffer();
                const uploadDir = join(process.cwd(), "data", "uploads");
                const filePath = join(uploadDir, safePath);
                await mkdir(dirname(filePath), { recursive: true });
                await writeFile(filePath, Buffer.from(bytes));

                return NextResponse.json({ success: true, path: safePath });
            } catch {
                return NextResponse.json({ error: "Failed to process form data" }, { status: 400 });
            }
        }

        // --- NEW STREAMING UPLOAD PATH (no memory buffering) ---

        // Reject oversized uploads before streaming
        const contentLength = Number(req.headers.get("content-length") || "0");
        if (Number.isFinite(contentLength) && contentLength > MAX_SIMPLE_UPLOAD_BYTES) {
            return NextResponse.json({ error: "File too large (max 500MB)" }, { status: 413 });
        }

        // Security check: normalize + reject traversal
        const safePath = normalizeUploadPath(userId, path);
        if (!safePath) {
            return NextResponse.json({ error: "Invalid upload path" }, { status: 403 });
        }

        const uploadDir = join(process.cwd(), "data", "uploads");
        const filePath = join(uploadDir, safePath);
        await mkdir(dirname(filePath), { recursive: true });

        // Pipe request body stream directly to file
        if (!req.body) {
            return NextResponse.json({ error: "No request body" }, { status: 400 });
        }

        // Convert Web ReadableStream to Node.js Readable
        const { Readable } = await import('stream');
        const { createWriteStream } = await import('fs');
        const { pipeline } = await import('stream/promises');

        const readableStream = Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>);
        const writeStream = createWriteStream(filePath);

        try {
            await pipeline(readableStream, writeStream);
        } catch (err) {
            // Clean up partial file on failure
            await unlink(filePath).catch(() => { });
            throw err;
        }

        return NextResponse.json({ success: true, path: safePath });
    } catch (error: unknown) {
        console.error('Local upload error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
