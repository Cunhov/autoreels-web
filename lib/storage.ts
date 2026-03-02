/**
 * Generates a URL for files stored in the data/uploads directory (Docker volume).
 * Files are served via /api/file/ route, which reads from process.cwd()/data/uploads.
 */
export function getPublicUrl(path: string): string {
    // Files are served via the /api/file/ API route (works in Next.js standalone Docker)
    // Example: path "user123/video.mp4" -> "/api/file/user123/video.mp4"
    if (!path) return '';
    return `/api/file/${path}`;
}

