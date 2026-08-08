import { unlink } from "fs/promises";
import { join } from "path";
import { isSafeRelativePath } from "@/lib/upload-path";

/**
 * Best-effort delete of a file from disk.
 * Tries data/uploads first, then public/uploads (legacy).
 * Silently ignores ENOENT. Refuses unsafe paths (traversal) outright.
 *
 * @param relativePath - path relative to uploads root, e.g. "userId/admin/video.mp4"
 */
export async function deleteFileFromDisk(relativePath: string): Promise<void> {
    if (!isSafeRelativePath(relativePath)) {
        console.error(`[cleanup] Refusing unsafe delete path: ${relativePath}`);
        return;
    }

    const candidates = [
        join(process.cwd(), "data", "uploads", relativePath),
        join(process.cwd(), "public", "uploads", relativePath),
    ];

    for (const filePath of candidates) {
        try {
            await unlink(filePath);
            console.log(`[cleanup] Deleted: ${filePath}`);
            return; // done
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException | null)?.code;
            if (code !== "ENOENT") {
                console.error(`[cleanup] Failed to delete ${filePath}:`, err);
            }
            // ENOENT = file not there, try next candidate
        }
    }
}

export function extractUploadPathFromUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const marker = "/api/file/";
    const index = url.indexOf(marker);
    if (index === -1) return null;

    try {
        const rawPath = url.slice(index + marker.length);
        const cleaned = decodeURIComponent(rawPath).replace(/^\/+/, "");
        return isSafeRelativePath(cleaned) ? cleaned : null;
    } catch {
        return null;
    }
}

/**
 * Minimal shape of a content item needed to resolve its files on disk.
 */
export interface ItemFileInfo {
    url?: string | null;
    thumbnail_url?: string | null;
    path?: string | null;
    name?: string | null;
}

/**
 * Resolve every disk-relative path that a content item owns (main file +
 * thumbnail). The stored URL is the source of truth (new uploads use UUID
 * filenames); for legacy items without a URL we fall back to path+name.
 *
 * @param userId - owner id (used by the path+name fallback)
 * @param item - item file metadata
 */
export function collectItemFiles(userId: string, item: ItemFileInfo): string[] {
    const files: string[] = [];

    // URL is the primary source (survives renames, UUID-based).
    const fromUrl = extractUploadPathFromUrl(item.url ?? null);
    if (fromUrl) {
        files.push(fromUrl);
    } else if (item.name) {
        // Legacy item without a url — reconstruct from path+name.
        const diskPath = buildDiskPath(userId, item.path ?? null, item.name ?? "");
        if (diskPath) files.push(diskPath);
    }

    const thumb = extractUploadPathFromUrl(item.thumbnail_url ?? null);
    if (thumb) {
        files.push(thumb);
    }

    return files;
}

/**
 * Build the disk-relative path for a content item.
 * DB stores: path = folderPath (e.g. "admin"), name = filename (e.g. "video.mp4")
 * Disk path: {userId}/{folderPath}/{filename}
 *
 * Returns "" for unsafe inputs (traversal) so callers can skip the delete.
 */
export function buildDiskPath(userId: string, folderPath: string | null, filename: string): string {
    const raw = folderPath
        ? `${userId}/${folderPath}/${filename}`.replace(/\/+/g, "/")
        : `${userId}/${filename}`;
    return isSafeRelativePath(raw) ? raw : "";
}
