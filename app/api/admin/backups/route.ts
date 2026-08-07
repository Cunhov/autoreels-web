import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { listBackups, runBackup } from "@/lib/backup";

/**
 * Admin backup management (session-authenticated).
 *
 * GET  /api/admin/backups → { backups: [{ name, size, mtime }] } (newest first)
 * POST /api/admin/backups → { ok, file, skipped? } — create a backup now
 */
export async function GET() {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const backups = await listBackups();
        return NextResponse.json({ backups });
    } catch (error: unknown) {
        console.error("[admin/backups] list failed:", error);
        return NextResponse.json({ error: "Failed to list backups" }, { status: 500 });
    }
}

export async function POST() {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await runBackup();
    if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json(result);
}
