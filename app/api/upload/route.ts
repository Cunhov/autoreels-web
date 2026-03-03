import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
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

                // Security check
                const userId = (session.user as any).id;
                if (!path.startsWith(`${userId}/`)) {
                    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
                }

                const bytes = await file.arrayBuffer();
                const uploadDir = join(process.cwd(), "data", "uploads");
                const filePath = join(uploadDir, path);
                await mkdir(dirname(filePath), { recursive: true });
                await writeFile(filePath, Buffer.from(bytes));

                return NextResponse.json({ success: true, path });
            } catch (e: any) {
                return NextResponse.json({ error: "Failed to process form data" }, { status: 400 });
            }
        }

        // --- NEW STREAMING UPLOAD PATH (no memory buffering) ---

        // Security check
        const userId = (session.user as any).id;
        if (!path.startsWith(`${userId}/`)) {
            return NextResponse.json({ error: "Permission denied" }, { status: 403 });
        }

        const uploadDir = join(process.cwd(), "data", "uploads");
        const filePath = join(uploadDir, path);
        await mkdir(dirname(filePath), { recursive: true });

        // Pipe request body stream directly to file
        if (!req.body) {
            return NextResponse.json({ error: "No request body" }, { status: 400 });
        }

        // Convert Web ReadableStream to Node.js Readable
        const { Readable } = await import('stream');
        const { createWriteStream } = await import('fs');
        const { pipeline } = await import('stream/promises');

        const readableStream = Readable.fromWeb(req.body as any);
        const writeStream = createWriteStream(filePath);

        await pipeline(readableStream, writeStream);

        return NextResponse.json({ success: true, path });
    } catch (error: any) {
        console.error('Local upload error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
