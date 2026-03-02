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

        // Delete from local filesystem
        const filePath = join(process.cwd(), "public", "uploads", path);

        try {
            await unlink(filePath);
        } catch (err: any) {
            // If file doesn't exist, we still consider it "deleted" from our perspective
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('Local delete error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
