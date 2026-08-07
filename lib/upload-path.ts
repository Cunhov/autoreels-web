import { posix } from "path";

/**
 * Reject raw paths containing ".." path segments, backslashes, or that are
 * absolute. `posix.normalize` collapses ".." which can hide traversal
 * intent, so we inspect the RAW input first (defense in depth).
 */
function hasTraversal(rawPath: string): boolean {
    if (rawPath.includes("\\")) return true;
    if (rawPath.startsWith("/")) return true;
    // Split on "/" and check for ".." segments anywhere
    return rawPath.split("/").includes("..");
}

/**
 * Normalize and validate an upload path.
 *
 * Accepts both "userId/..." prefixed paths and bare "folder/file" paths;
 * the returned path is always relative to the uploads root and prefixed with
 * the user id (e.g. "admin/video.mp4").
 *
 * Returns null for unsafe paths (traversal with "..", absolute paths,
 * backslashes, empty paths).
 */
export function normalizeUploadPath(userId: string, rawPath: string): string | null {
    if (!rawPath || typeof rawPath !== "string") return null;
    if (hasTraversal(rawPath)) return null;

    const normalized = posix.normalize(rawPath.replace(/\\/g, "/")).replace(/^\/+/, "");
    const withoutUserPrefix = normalized.startsWith(`${userId}/`)
        ? normalized.slice(userId.length + 1)
        : normalized;

    if (!withoutUserPrefix || withoutUserPrefix === "." || withoutUserPrefix.startsWith("../") || withoutUserPrefix.includes("/../")) {
        return null;
    }
    return `${userId}/${withoutUserPrefix}`;
}

/**
 * Clean a single path segment (folder name or file name).
 * Returns "" for empty input, null for unsafe values, the cleaned segment otherwise.
 */
export function cleanPathSegment(value: string | null | undefined): string | null {
    if (!value) return "";
    if (hasTraversal(value)) return null;

    const normalized = posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "");
    if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
        return null;
    }
    return normalized;
}

/**
 * Validate that a disk-relative path (e.g. "admin/video.mp4") is safe to
 * unlink: no absolute paths, no backslashes, no ".." segments.
 */
export function isSafeRelativePath(relativePath: string): boolean {
    if (!relativePath || typeof relativePath !== "string") return false;
    if (hasTraversal(relativePath)) return false;
    const normalized = posix.normalize(relativePath.replace(/\\/g, "/"));
    if (normalized === "." || normalized === "..") return false;
    if (normalized.startsWith("../") || normalized.includes("/../")) return false;
    return true;
}
