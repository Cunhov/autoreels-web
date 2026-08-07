import { access, copyFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { join, resolve, sep } from "path";

/**
 * SQLite backup & restore helpers (VACUUM INTO).
 *
 * - Backups are written to data/backups/backup-YYYYMMDD.db (idempotent per day)
 *   and pruned, keeping the 7 most recent.
 * - Restore validates the backup name, guards against path traversal, runs an
 *   integrity check and keeps an emergency copy of the live DB (prod.db.pre-restore)
 *   before overwriting.
 */

const KEEP_BACKUPS = 7;

export interface BackupEntry {
    name: string;
    size: number;
    mtime: string; // ISO timestamp
}

export interface BackupResult {
    ok: boolean;
    file?: string;
    skipped?: boolean;
    error?: string;
}

export interface RestoreResult {
    ok: boolean;
    error?: string;
    code?: "invalid" | "not-found" | "corrupt" | "db-error";
}

/** Resolve the SQLite file path from DATABASE_URL (e.g. "file:/app/data/prod.db"). */
export function getDbPath(): string | null {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return null;
    return dbUrl.replace(/^file:/, "");
}

export function getBackupsDir(): string {
    return join(process.cwd(), "data", "backups");
}

/** List existing backups, newest first. */
export async function listBackups(): Promise<BackupEntry[]> {
    const backupsDir = getBackupsDir();
    await mkdir(backupsDir, { recursive: true });

    const entries = await readdir(backupsDir);
    const backups: BackupEntry[] = [];

    for (const name of entries) {
        if (!name.startsWith("backup-") || !name.endsWith(".db")) continue;
        try {
            const info = await stat(join(backupsDir, name));
            if (!info.isFile()) continue;
            backups.push({
                name,
                size: info.size,
                mtime: info.mtime.toISOString(),
            });
        } catch {
            // Ignore entries that vanish mid-listing
        }
    }

    backups.sort((a, b) => (a.name < b.name ? 1 : -1));
    return backups;
}

/** Create a daily backup (idempotent per day) and prune old ones. */
export async function runBackup(): Promise<BackupResult> {
    const dbPath = getDbPath();
    if (!dbPath) {
        return { ok: false, error: "DATABASE_URL is not set" };
    }

    const backupsDir = getBackupsDir();
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
        await access(targetFile);
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

/** Validate a backup filename (strict — no path separators, no traversal). */
export function isValidBackupName(filename: string): boolean {
    return /^backup-\d{8}\.db$/.test(filename);
}

/**
 * Restore a backup over the live DB.
 * - Validates the filename and that it resolves inside the backups dir.
 * - Runs PRAGMA integrity_check on the backup before touching anything.
 * - Keeps an emergency copy of the current DB at <dbPath>.pre-restore.
 */
export async function restoreBackup(filename: string): Promise<RestoreResult> {
    if (!isValidBackupName(filename)) {
        return { ok: false, error: "Invalid backup name", code: "invalid" };
    }

    const dbPath = getDbPath();
    if (!dbPath) {
        return { ok: false, error: "DATABASE_URL is not set", code: "db-error" };
    }

    const backupsDir = getBackupsDir();
    const backupPath = join(backupsDir, filename);

    // Path-traversal guard (belt & suspenders on top of the regex):
    // the resolved path must stay inside the backups directory.
    if (!resolve(backupPath).startsWith(resolve(backupsDir) + sep)) {
        return { ok: false, error: "Invalid backup name", code: "invalid" };
    }

    try {
        await access(backupPath);
    } catch {
        return { ok: false, error: "Backup not found", code: "not-found" };
    }

    // Integrity check before touching the live DB
    try {
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(backupPath, { readonly: true });
        try {
            const result = db.pragma("integrity_check", { simple: true }) as unknown;
            if (result !== "ok") {
                return { ok: false, error: "Backup failed integrity check", code: "corrupt" };
            }
        } finally {
            db.close();
        }
    } catch (error: unknown) {
        console.error("[restore] integrity check failed:", error);
        return { ok: false, error: "Cannot read backup file", code: "corrupt" };
    }

    try {
        // Emergency copy of the current DB before overwriting
        await copyFile(dbPath, `${dbPath}.pre-restore`).catch(() => {
            console.error("[restore] could not create emergency copy — continuing anyway");
        });
        await copyFile(backupPath, dbPath);
    } catch (error: unknown) {
        console.error("[restore] copy failed:", error);
        return { ok: false, error: "Restore failed", code: "db-error" };
    }

    return { ok: true };
}
