import { unlink } from "fs/promises";
import { join } from "path";

/**
 * Best-effort delete of a file from disk.
 * Tries data/uploads first, then public/uploads (legacy).
 * Silently ignores ENOENT.
 *
 * @param relativePath - path relative to uploads root, e.g. "userId/admin/video.mp4"
 */
export async function deleteFileFromDisk(relativePath: string): Promise<void> {
    const candidates = [
        join(process.cwd(), "data", "uploads", relativePath),
        join(process.cwd(), "public", "uploads", relativePath),
    ];

    for (const filePath of candidates) {
        try {
            await unlink(filePath);
            console.log(`[cleanup] Deleted: ${filePath}`);
            return; // done
        } catch (err: any) {
            if (err.code !== "ENOENT") {
                console.error(`[cleanup] Failed to delete ${filePath}:`, err.message);
            }
            // ENOENT = file not there, try next candidate
        }
    }
}

/**
 * Build the disk-relative path for a content item.
 * DB stores: path = folderPath (e.g. "admin"), name = filename (e.g. "video.mp4")
 * Disk path: {userId}/{folderPath}/{filename}
 */
export function buildDiskPath(userId: string, folderPath: string | null, filename: string): string {
    if (folderPath) {
        return `${userId}/${folderPath}/${filename}`.replace(/\/+/g, "/");
    }
    return `${userId}/${filename}`;
}
