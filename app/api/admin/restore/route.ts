import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { restoreBackup } from "@/lib/backup";

/**
 * Restore a backup over the live SQLite DB (session-authenticated).
 *
 * POST /api/admin/restore  body: { filename: "backup-20260101.db" }
 *
 * Flow:
 *  1. Validates the filename + integrity of the backup file.
 *  2. Keeps an emergency copy of the current DB (<db>.pre-restore).
 *  3. Copies the backup over the live DB.
 *  4. Responds { ok: true, restarted: true } and then exits the process so the
 *     container (restart: always) boots with the restored database. In dev the
 *     restart is skipped (logged) to avoid killing the dev server.
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: { filename?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const filename = typeof body.filename === "string" ? body.filename : "";
    if (!filename) {
        return NextResponse.json({ error: "filename is required" }, { status: 400 });
    }

    const result = await restoreBackup(filename);
    if (!result.ok) {
        const status = result.code === "not-found" ? 404
            : result.code === "invalid" ? 400
                : result.code === "corrupt" ? 422
                    : 500;
        return NextResponse.json({ error: result.error }, { status });
    }

    // Respond first, then trigger the restart so the container comes back
    // with the restored database. Never exit before the response is sent.
    const restarted = process.env.NODE_ENV !== "development";
    if (restarted) {
        setTimeout(() => {
            console.log("[restore] Database restored. Restarting app...");
            process.exit(0);
        }, 1500);
    } else {
        console.log("[restore] Database restored. (Restart skipped in dev — restart manually.)");
    }

    return NextResponse.json({ ok: true, restarted });
}
