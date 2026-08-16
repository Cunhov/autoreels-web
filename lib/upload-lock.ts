import { open, stat, unlink } from "fs/promises";

/**
 * Finalize lock for a staged upload path.
 *
 * Guarantees that only ONE `/api/upload-chunk/complete` consumes a given part
 * set at a time, and that cancels (DELETE) / chunk POSTs never touch parts
 * while a finalize is running (they get 409). Two layers:
 *
 *   1. In-process Map — the app is a single-process monolith, so concurrent
 *      requests in the same process are excluded fast without touching disk.
 *   2. Lock file `{partBase}.finalizing.lock` created with `open(path, "wx")`
 *      (atomic create) — covers the cross-process / multi-replica case and
 *      survives in-process races that slip past the Map check.
 *
 * A lock file older than STALE_LOCK_MS is assumed to be a crash leftover and
 * is reclaimed (removed + retried once). Lock files never match the
 * `{basename}.part.` prefix, so `listPartIndices` ignores them.
 */

const LOCK_SUFFIX = ".finalizing.lock";
const STALE_LOCK_MS = 10 * 60 * 1000; // 10 minutes

export interface FinalizeLock {
    /** True while this process still holds the lock. */
    readonly held: boolean;
    /** Release the lock (in-process entry + lock file). Safe to call twice. */
    release(): Promise<void>;
}

const inProcess = new Map<string, { owner: string; startedAt: number }>();

function lockPath(partBase: string): string {
    return `${partBase}${LOCK_SUFFIX}`;
}

/**
 * True when a fresh (non-stale) finalize lock exists for `partBase`.
 * Used by chunk POST / DELETE / status to refuse touching parts mid-finalize.
 */
export async function isLocked(partBase: string): Promise<boolean> {
    if (inProcess.has(partBase)) return true;
    try {
        const st = await stat(lockPath(partBase));
        return Date.now() - st.mtimeMs < STALE_LOCK_MS;
    } catch {
        return false;
    }
}

/**
 * Acquire the finalize lock for `partBase`.
 *
 * Returns the lock when acquired, or `null` when another finalize currently
 * holds it (fresh lock file). A stale lock file (crash leftover) is removed
 * and the acquire is retried once before giving up.
 */
export async function acquireFinalizeLock(partBase: string): Promise<FinalizeLock | null> {
    if (inProcess.has(partBase)) return null;

    const path = lockPath(partBase);
    let acquired = false;

    for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
        try {
            const handle = await open(path, "wx");
            try {
                await handle.writeFile(`${process.pid} ${Date.now()}\n`);
            } finally {
                await handle.close();
            }
            acquired = true;
        } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code !== "EEXIST") throw err;

            // Lock file already exists — reclaim it only if it is stale.
            try {
                const st = await stat(path);
                if (Date.now() - st.mtimeMs >= STALE_LOCK_MS) {
                    await unlink(path).catch(() => {});
                    continue; // retry once after removing the stale lock
                }
            } catch {
                continue; // lock file vanished between open and stat → retry once
            }
            return null; // fresh lock held by another finalize
        }
    }

    if (!acquired) return null;

    inProcess.set(partBase, { owner: `${process.pid}:${Date.now()}`, startedAt: Date.now() });

    let released = false;
    return {
        get held(): boolean {
            return !released;
        },
        async release(): Promise<void> {
            if (released) return;
            released = true;
            inProcess.delete(partBase);
            await unlink(path).catch(() => {});
        },
    };
}
