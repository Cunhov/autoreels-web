import { NextResponse } from "next/server";
import { mkdir, readdir, unlink } from "fs/promises";
import { join } from "path";
import { safeEqual } from "@/lib/secret";

/**
 * Backup the SQLite database via `VACUUM INTO`.
 * Authenticated with the `x-cron-auth` header (same secret as the publisher cron).
 *
 * - Creates data/backups/backup-YYYYMMDD.db (idempotent per day).
 * - Prunes old backups, keeping the 7 most recent.
 *
 * GET and POST both trigger a backup (GET for convenience in cron schedulers).
 */
const KEEP_BACKUPS = 7;

function isAuthorized(req: Request): boolean {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
        console.error("[backup] CRON_SECRET is not set");
        return false;
    }
    const provided = req.headers.get("x-cron-auth");
    return Boolean(provided) && safeEqual(provided as string, expected);
}

function getDbPath(): string | null {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return null;
    // Prisma SQLite URLs look like "file:/app/data/prod.db" or "file:./prisma/dev.db"
    return dbUrl.replace(/^file:/, "");
}

async function runBackup(): Promise<{ ok: boolean; file?: string; skipped?: boolean; error?: string }> {
    const dbPath = getDbPath();
    if (!dbPath) {
        return { ok: false, error: "DATABASE_URL is not set" };
    }

    const backupsDir = join(process.cwd(), "data", "backups");
    await mkdir(backupsDir, { recursive: true });

    const now = new Date();
    const dateStr = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
    ].join("");
    const targetFile = join(backupsDir, `backup-${dateStr}.db`);

    // Idempotent: skip if today's backup already exists
    try {
        await import("fs/promises").then(({ access }) => access(targetFile));
        return { ok: true, file: targetFile, skipped: true };
    } catch {
        // not exists — proceed
    }

    try {
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(dbPath, { readonly: true });
        try {
            db.exec(`VACUUM INTO '${targetFile.replace(/'/g, "''")}'`);
        } finally {
            db.close();
        }
    } catch (error: unknown) {
        console.error("[backup] VACUUM INTO failed:", error);
        return { ok: false, error: "Backup failed" };
    }

    // Prune old backups, keep the 7 most recent
    try {
        const entries = await readdir(backupsDir);
        const backups = entries
            .filter(f => f.startsWith("backup-") && f.endsWith(".db"))
            .sort()
            .reverse();
        for (const old of backups.slice(KEEP_BACKUPS)) {
            await unlink(join(backupsDir, old)).catch(() => { });
        }
    } catch (error: unknown) {
        console.error("[backup] Prune failed:", error);
    }

    return { ok: true, file: targetFile };
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
