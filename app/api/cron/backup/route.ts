import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/secret";
import { runBackup } from "@/lib/backup";

/**
 * Backup the SQLite database via `VACUUM INTO`.
 * Authenticated with the `x-cron-auth` header (same secret as the publisher cron).
 *
 * - Creates data/backups/backup-YYYYMMDD.db (idempotent per day).
 * - Prunes old backups, keeping the 7 most recent.
 *
 * GET and POST both trigger a backup (GET for convenience in cron schedulers).
 * Shared logic lives in lib/backup.ts (also used by the admin UI routes).
 */

function isAuthorized(req: Request): boolean {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
        console.error("[backup] CRON_SECRET is not set");
        return false;
    }
    const provided = req.headers.get("x-cron-auth");
    return Boolean(provided) && safeEqual(provided as string, expected);
}

export async function GET(req: Request) {
    if (!isAuthorized(req)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await runBackup();
    if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json(result);
}

export async function POST(req: Request) {
    if (!isAuthorized(req)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await runBackup();
    if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json(result);
}
