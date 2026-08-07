import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { Prisma } from "@prisma/client";

const VALID_MEDIA_TYPES = ["REELS", "IMAGE", "CAROUSEL", "STORIES", "VIDEO"];

// Fields a client may set when creating a post. Server-owned fields
// (id, user_id, status, created_at, published_at, instagram_*) are excluded.
const POST_ALLOWED_FIELDS = [
    "caption", "media_type", "video_url", "image_url", "thumbnail_url",
    "children_urls", "share_to_feed", "location_id", "collaborators",
    "audio_configuration", "user_tags", "scheduled_at", "channel_id", "planner_id",
] as const;

/** Validate a media URL: our own /api/file/ path or http(s). */
function isSafeMediaUrl(value: string | null | undefined): boolean {
    if (!value) return true;
    if (value.startsWith("/api/file/")) {
        // Reject traversal in the path portion
        return !value.includes("..");
    }
    return /^https?:\/\//.test(value);
}

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const requestedLimit = Number(searchParams.get("limit") || "1000");
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 2000)
        : 1000;

    const where: Prisma.PostWhereInput = { user_id: userId };

    if (status) {
        const statuses = status.split(",").map(item => item.trim()).filter(Boolean);
        if (statuses.length > 0) where.status = { in: statuses };
    }

    if (start || end) {
        where.scheduled_at = {};
        if (start) {
            const startDate = new Date(start);
            if (!Number.isNaN(startDate.getTime())) where.scheduled_at.gte = startDate;
        }
        if (end) {
            const endDate = new Date(end);
            if (!Number.isNaN(endDate.getTime())) where.scheduled_at.lte = endDate;
        }
    }

    const posts = await prisma.post.findMany({
        where,
        orderBy: {
            created_at: "desc",
        },
        take: limit,
    });

    return NextResponse.json(posts);
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const data = await req.json();

        // Whitelist: drop any field not in the allowed list
        const payload: Record<string, unknown> = {};
        for (const field of POST_ALLOWED_FIELDS) {
            if (data[field] !== undefined) payload[field] = data[field];
        }

        // Validate media_type
        if (payload.media_type !== undefined) {
            const mediaType = String(payload.media_type).toUpperCase();
            if (!VALID_MEDIA_TYPES.includes(mediaType)) {
                return NextResponse.json({ error: "Invalid media_type" }, { status: 400 });
            }
            payload.media_type = mediaType;
        }

        // Validate URLs (prevent path traversal in media refs)
        for (const urlField of ["video_url", "image_url", "thumbnail_url"]) {
            if (!isSafeMediaUrl(payload[urlField] as string | null | undefined)) {
                return NextResponse.json({ error: `Invalid ${urlField}` }, { status: 400 });
            }
        }

        // Validate children_urls is well-formed JSON when provided
        if (payload.children_urls !== undefined && payload.children_urls !== null) {
            const raw = String(payload.children_urls);
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) {
                    return NextResponse.json({ error: "children_urls must be a JSON array" }, { status: 400 });
                }
            } catch {
                return NextResponse.json({ error: "children_urls must be valid JSON" }, { status: 400 });
            }
        }

        // Validate scheduled_at (optional date)
        if (payload.scheduled_at !== undefined && payload.scheduled_at !== null) {
            const d = new Date(String(payload.scheduled_at));
            if (Number.isNaN(d.getTime())) {
                return NextResponse.json({ error: "Invalid scheduled_at" }, { status: 400 });
            }
            payload.scheduled_at = d;
        }

        // Validate channel ownership (prevents posting on another user's channel)
        if (payload.channel_id) {
            const channel = await prisma.channel.findFirst({
                where: { id: String(payload.channel_id), user_id: userId },
                select: { id: true },
            });
            if (!channel) {
                return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
            }
        }

        // Validate planner ownership
        if (payload.planner_id) {
            const planner = await prisma.planner.findFirst({
                where: { id: String(payload.planner_id), user_id: userId },
                select: { id: true },
            });
            if (!planner) {
                return NextResponse.json({ error: "Invalid planner" }, { status: 400 });
            }
        }

        const post = await prisma.post.create({
            data: {
                ...payload,
                // Server-owned fields — never trust the client
                user_id: userId,
                status: "pending",
            } as Prisma.PostUncheckedCreateInput,
        });
        return NextResponse.json(post);
    } catch (error: unknown) {
        console.error('Create post error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
