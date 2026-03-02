/**
 * Generates a local public URL for files stored in the public/uploads directory.
 * This replaces Supabase Storage URLs for a 100% local "plug n play" experience.
 */
export function getPublicUrl(path: string): string {
    // Since files are in public/uploads, we return the relative path from the root
    // Example: path "user123/video.mp4" -> "/uploads/user123/video.mp4"
    if (!path) return '';
    return `/uploads/${path}`;
}
