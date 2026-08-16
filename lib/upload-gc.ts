import { readdir, stat, unlink, rm, readFile } from "fs/promises";
import { join } from "path";
import { isLocked } from "@/lib/upload-lock";

/**
 * Staging garbage collection for upload parts.
 *
 * Production has two ways to leave litter behind:
 *
 *   - a process crash mid-finalize strands `<uploadDir>/.finalizing/<uuid>/`
 *     (parts already renamed out of the staging path, no one cleans them);
 *   - a chunk POST / DELETE that read `isLocked=false` before the finalize lock
 *     existed and landed its write after the owner's cleanup+release leaves an
 *     orphan `*.part.{i}` that no future finalize can consume (every complete
 *     for that path would 409 "Incomplete upload" forever).
 *
 * The sweep is opportunistic (debounced to once per 60s), best-effort (never
 * throws) and conservative: the client aborts a chunk fetch after 60s and never
 * leaves a live part untouched longer than ~90s, so a part older than 15 minutes
 * cannot belong to a live upload; a `.finalizing` dir older than 10 minutes whose
 * owning lock is stale can only be a crash leftover.
 */

const SWEEP_MIN_INTERVAL_MS = 60_000; // debounce: at most once per minute
const STALE_FINALIZE_DIR_MS = 10 * 60 * 1000; // crash leftovers
const STALE_ORPHAN_PART_MS = 15 * 60 * 1000; // safely above any live upload

const PART_FILE_RE = /\.part\.\d+$/;

let lastSweepAt = 0;

/**
 * Strip the `.part.{i}` suffix to recover the staging base path, then ask the
 * lock module whether that staging path currently holds a fresh finalize lock.
 * A protected part (a finalize may be consuming it right now) is never swept.
 */
async function isPartProtected(partFilePath: string): Promise<boolean> {
    const partBase = partFilePath.replace(PART_FILE_RE, "");
    return isLocked(partBase);
}

/** Remove `.finalizing/<uuid>` dirs that are stale crash leftovers. */
async function sweepFinalizeDirs(uploadDir: string): Promise<void> {
    const finalizingRoot = join(uploadDir, ".finalizing");
    let entries;
    try {
        entries = await readdir(finalizingRoot, { withFileTypes: true });
    } catch {
        return; // no .finalizing dir exists at all
    }

    const cutoff = Date.now() - STALE_FINALIZE_DIR_MS;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(finalizingRoot, entry.name);
        let st;
        try {
            st = await stat(dirPath);
        } catch {
            continue; // vanished while listing
        }
        if (st.mtimeMs > cutoff) continue; // recent consume — finalize likely active

        // Precise guard: the finalize writes a `source` marker with the owning
        // staging path. If that path holds a FRESH lock, the finalize is still
        // running (a very slow concat) — keep its parts.
        const partBase = await readFile(join(dirPath, "source"), "utf8").catch(() => null);
        if (partBase && (await isLocked(partBase.trim()))) continue;

        await rm(dirPath, { recursive: true, force: true }).catch(() => { });
    }
}

/** Remove orphan `*.part.{i}` files older than 15 minutes. */
async function sweepOrphanParts(uploadDir: string): Promise<void> {
    const cutoff = Date.now() - STALE_ORPHAN_PART_MS;
    const stack: string[] = [uploadDir];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue; // dir vanished — nothing to sweep here
        }
        for (const entry of entries) {
            if (entry.name === ".finalizing") continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.isFile() || !PART_FILE_RE.test(entry.name)) continue;

            let st;
            try {
                st = await stat(full);
            } catch {
                continue; // raced with a delete
            }
            if (st.mtimeMs > cutoff) continue; // fresh — possibly a live upload
            if (await isPartProtected(full)) continue; // finalize may be consuming it

            await unlink(full).catch(() => { });
        }
    }
}

/**
 * Sweep stale staging artifacts. Debounced to once per 60s; never throws.
 * Wire opportunistically (status endpoint, first chunk of an upload) — the
 * debounce makes repeated call sites free.
 */
export async function sweepStaleStaging(uploadDir: string): Promise<void> {
    const now = Date.now();
    if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
    lastSweepAt = now;
    try {
        await sweepFinalizeDirs(uploadDir);
        await sweepOrphanParts(uploadDir);
    } catch {
        // best-effort by contract: a failed sweep must never break an upload
    }
}
