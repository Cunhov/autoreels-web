import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { normalizeUploadPath } from "@/lib/upload-path";
import { mkdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { isFfmpegAvailable, trimVideo, getVideoDurationSec } from "@/lib/ffmpeg";

const MIN_CUT_SECONDS = 1;
const MAX_CUT_SECONDS = 600; // 10 minutes

interface TrimBody {
    path?: unknown;
    start?: unknown;
    end?: unknown;
}

/**
 * POST /api/video/trim — server-side video cut (requires ffmpeg on the host).
 *
 * Body: { path: string, start: number, end: number }  (seconds)
 * Creates a NEW content item ("video") with the trimmed clip and returns it.
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: TrimBody;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const start = Number(body.start);
    const end = Number(body.end);
    if (
        !Number.isFinite(start) || !Number.isFinite(end) ||
        start < 0 || end <= start
    ) {
        return NextResponse.json({ error: "start and end must be valid seconds with end > start" }, { status: 400 });
    }
    const durationSec = end - start;
    if (durationSec < MIN_CUT_SECONDS || durationSec > MAX_CUT_SECONDS) {
        return NextResponse.json(
            { error: `Cut must be between ${MIN_CUT_SECONDS}s and ${MAX_CUT_SECONDS}s` },
            { status: 400 }
        );
    }

    if (!isFfmpegAvailable()) {
        return NextResponse.json({ error: "ffmpeg não disponível neste servidor" }, { status: 501 });
    }

    try {
        // Validate the input path belongs to the user and exists on disk
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

        const realDuration = await getVideoDurationSec(inputPath);
        if (start >= realDuration) {
            return NextResponse.json({ error: "start is beyond the video duration" }, { status: 400 });
        }
        // Clamp end to the real duration (never cut past the end of the file)
        const clampedEnd = Math.min(end, realDuration);
        const cutDuration = clampedEnd - start;

        const uuid = randomUUID();
        const outName = `trim-${uuid}.mp4`;
        const outRelPath = `${userId}/${outName}`;
        const outPath = join(uploadsRoot, outRelPath);
        await mkdir(dirname(outPath), { recursive: true });

        await trimVideo(inputPath, outPath, start, cutDuration);

        const outStat = await stat(outPath);
        const item = await prisma.contentItem.create({
            data: {
                user_id: userId,
                type: "video",
                url: `/api/file/${outRelPath}`,
                path: null, // file lives at {userId}/{name}; buildDiskPath handles this
                name: outName,
                size: outStat.size,
                duration: Math.round(cutDuration * 10) / 10,
            },
        });

        return NextResponse.json(item, { status: 201 });
    } catch (error: unknown) {
        console.error("[video/trim] error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
