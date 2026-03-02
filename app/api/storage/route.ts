import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { unlink } from "fs/promises";
import { join } from "path";

export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const url = new URL(req.url);
        const path = url.searchParams.get("path");

        if (!path) {
            return NextResponse.json({ error: "No path provided" }, { status: 400 });
        }

        // Security check: ensure path starts with user_id
        const userId = (session.user as any).id;
        if (!path.startsWith(`${userId}/`)) {
            return NextResponse.json({ error: "Permission denied" }, { status: 403 });
        }

        // Try /data/uploads first (new location), then /public/uploads (legacy)
        const candidates = [
            join(process.cwd(), "data", "uploads", path),
            join(process.cwd(), "public", "uploads", path),
        ];

        for (const filePath of candidates) {
            try {
                await unlink(filePath);
                break; // Deleted successfully, stop
            } catch (err: any) {
                if (err.code !== 'ENOENT') {
                    // Real error — not "file not found"
                    throw err;
                }
                // File not found at this path, try next
            }
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('Local delete error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
