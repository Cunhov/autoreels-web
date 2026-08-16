import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { normalizeUploadPath } from "@/lib/upload-path";
import { mkdir, stat, unlink } from "fs/promises";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { isFfmpegAvailable, extractFrame, getVideoDurationSec } from "@/lib/ffmpeg";

const DEFAULT_FRAME_TIME = 0.5; // seconds

interface ThumbnailBody {
    item_id?: unknown;
    path?: unknown;
    time?: unknown;
}

/**
 * POST /api/video/thumbnail — extract a frame from a video and set it as the
 * item's thumbnail_url (requires ffmpeg on the host).
 *
 * Body: { item_id: string, path: string, time?: number }  (time in seconds, default 0.5)
 * Returns the updated content item.
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: ThumbnailBody;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const itemId = String(body.item_id ?? "");
    if (!itemId) {
        return NextResponse.json({ error: "item_id is required" }, { status: 400 });
    }

    let time = Number(body.time ?? DEFAULT_FRAME_TIME);
    if (!Number.isFinite(time)) time = DEFAULT_FRAME_TIME;
    if (time < 0) time = 0;

    if (!isFfmpegAvailable()) {
        return NextResponse.json({ error: "ffmpeg não disponível neste servidor" }, { status: 501 });
    }

    try {
        // Item must belong to the session user
        const item = await prisma.contentItem.findFirst({
            where: { id: itemId, user_id: userId },
        });
        if (!item) {
            return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }

        // Validate the video path belongs to the user and exists on disk
        const safePath = normalizeUploadPath(userId, String(body.path ?? ""));
        if (!safePath) {
            return NextResponse.json({ error: "Invalid video path" }, { status: 403 });
        }
        const uploadsRoot = join(process.cwd(), "data", "uploads");
        const inputPath = join(uploadsRoot, safePath);
        let inputStat;
        try {
            inputStat = await stat(inputPath);
        } catch {
            return NextResponse.json({ error: "Video file not found" }, { status: 404 });
        }
        if (!inputStat.isFile()) {
            return NextResponse.json({ error: "Video file not found" }, { status: 404 });
        }

        let realDuration: number;
        try {
            realDuration = await getVideoDurationSec(inputPath);
        } catch (probeError: unknown) {
            // ffprobe rejected the source — image/HEIC fed to the video thumbnail
            // route, or corrupt bytes. 4xx-class (bad media), not a server fault.
            console.error("[video/thumbnail] ffprobe rejected source:", probeError);
            return NextResponse.json({ error: "Unsupported or corrupt media" }, { status: 400 });
        }
        // Clamp time so we never seek past the end (leave a tiny margin)
        const safeTime = Math.min(time, Math.max(realDuration - 0.1, 0));

        const uuid = randomUUID();
        const outName = `thumb-${uuid}.jpg`;
        const outRelPath = `${userId}/${outName}`;
        const outPath = join(uploadsRoot, outRelPath);
        await mkdir(dirname(outPath), { recursive: true });

        try {
            await extractFrame(inputPath, outPath, safeTime);
        } catch (frameError: unknown) {
            console.error("[video/thumbnail] ffmpeg rejected source:", frameError);
            await unlink(outPath).catch(() => { });
            return NextResponse.json({ error: "Unsupported or corrupt media" }, { status: 400 });
        }

        const thumbUrl = `/api/file/${outRelPath}`;
        const updatedItem = await prisma.contentItem.update({
            where: { id: item.id },
            data: { thumbnail_url: thumbUrl },
        });

        return NextResponse.json(updatedItem);
    } catch (error: unknown) {
        console.error("[video/thumbnail] error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
