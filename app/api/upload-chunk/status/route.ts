import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { stat } from "fs/promises";
import { join } from "path";
import { normalizeUploadPath } from "@/lib/upload-path";
import { isLocked } from "@/lib/upload-lock";
import { sweepStaleStaging } from "@/lib/upload-gc";
import { listPartIndices, getUploadsDir } from "@/app/api/upload-chunk/route";

/**
 * GET /api/upload-chunk/status?path=<staging path>
 *
 * Reports which `.part.{i}` files exist for a staged upload so the client can
 * RESUME: it re-sends only the missing chunk indices instead of restarting
 * from chunk 0.
 *
 * Auth: session (uploads are per-user). Response:
 *   { path, chunks: number[], file_size: number, finalizing: boolean }
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const url = new URL(req.url);
        const rawPath = url.searchParams.get("path");
        const path = normalizeUploadPath(userId, rawPath || "");
        if (!path) {
            return NextResponse.json({ error: "Invalid upload path" }, { status: 400 });
        }

        const uploadDir = getUploadsDir();
        const partBase = join(uploadDir, path);
        const chunks = await listPartIndices(partBase);
        const finalizing = await isLocked(partBase);

        // Sum the bytes of the parts that exist (client uses it for progress).
        let fileSize = 0;
        for (const index of chunks) {
            try {
                const partStat = await stat(`${partBase}.part.${index}`);
                fileSize += partStat.size;
            } catch {
                // ignore races (part deleted between listing and stat)
            }
        }

        return NextResponse.json({ path, chunks, file_size: fileSize, finalizing });
    } catch (error: unknown) {
        console.error("Chunk status error:", error);
        return NextResponse.json({ error: "Failed to read upload status" }, { status: 500 });
    } finally {
        // Opportunistic staging GC (debounced 60s, best-effort): the client hits
        // status on every resume — the cheapest place to reclaim crash leftovers
        // and TOCTOU orphans before the next upload to the same path.
        void sweepStaleStaging(getUploadsDir()).catch(() => { });
    }
}
