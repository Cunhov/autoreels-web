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
        const formData = await req.formData();
        const file = formData.get("file") as File;
        const path = formData.get("path") as string;

        if (!file || !path) {
            return NextResponse.json({ error: "Missing file or path" }, { status: 400 });
        }

        // Security check: ensure path starts with user_id to prevent writing to others' folders
        const userId = (session.user as any).id;
        if (!path.startsWith(`${userId}/`)) {
            return NextResponse.json({ error: "Permission denied" }, { status: 403 });
        }

        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        // Store in /data/uploads (persistent Docker volume at /app/data)
        // This works in standalone Docker where /public is not dynamically served
        const uploadDir = join(process.cwd(), "data", "uploads");
        const filePath = join(uploadDir, path);

        // Ensure subdirectories exist
        await mkdir(dirname(filePath), { recursive: true });

        // Write file
        await writeFile(filePath, buffer);

        // Return /api/file/... URL so files are served via the API route
        return NextResponse.json({ success: true, path });
    } catch (error: any) {
        console.error('Local upload error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
