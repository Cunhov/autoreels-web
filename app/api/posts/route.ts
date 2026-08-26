import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { parseYoutubeOptions, VALID_YOUTUBE_TYPES } from "@/lib/youtube-post-options";

const VALID_MEDIA_TYPES = ["REELS", "IMAGE", "CAROUSEL", "STORIES", "VIDEO"];

// Fields a client may set when creating a post. Server-owned fields
// (id, user_id, status, created_at, published_at, instagram_*) are excluded.
const POST_ALLOWED_FIELDS = [
    "caption", "media_type", "video_url", "image_url", "thumbnail_url",
    "children_urls", "share_to_feed", "location_id", "collaborators",
    "audio_configuration", "user_tags", "scheduled_at", "channel_id", "planner_id",
    // YouTube
    "youtube_type", "youtube_options",
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
    const channelId = searchParams.get("channel_id");
    const plannerId = searchParams.get("planner_id");
    const mediaType = searchParams.get("media_type");
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const requestedLimit = Number(searchParams.get("limit") || "1000");
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 2000)
        : 1000;
    const requestedOffset = Number(searchParams.get("offset") || "0");
    const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0
        ? Math.floor(requestedOffset)
        : 0;

    const where: Prisma.PostWhereInput = { user_id: userId };

    if (status) {
        const statuses = status.split(",").map(item => item.trim()).filter(Boolean);
        if (statuses.length > 0) where.status = { in: statuses };
    }

    if (channelId) {
        const ids = channelId.split(",").map(item => item.trim()).filter(Boolean);
        if (ids.length > 0) where.channel_id = { in: ids };
    }

    if (plannerId) {
        const ids = plannerId.split(",").map(item => item.trim()).filter(Boolean);
        if (ids.length > 0) where.planner_id = { in: ids };
    }

    if (mediaType) {
        const types = mediaType.split(",").map(item => item.trim().toUpperCase()).filter(Boolean);
        if (types.length > 0) where.media_type = { in: types };
    }

    if (start || end) {
        // Invalid dates are a client error — return 400 instead of silently
        // ignoring the filter (which would return the whole post history).
        const startDate = start ? new Date(start) : null;
        const endDate = end ? new Date(end) : null;
        if (
            (startDate && Number.isNaN(startDate.getTime())) ||
            (endDate && Number.isNaN(endDate.getTime()))
        ) {
            return NextResponse.json(
                { error: "start and end must be valid ISO dates" },
                { status: 400 }
            );
        }
        where.scheduled_at = {};
        if (startDate) where.scheduled_at.gte = startDate;
        if (endDate) where.scheduled_at.lte = endDate;
    }

    const posts = await prisma.post.findMany({
        where,
        orderBy: {
            created_at: "desc",
        },
        skip: offset,
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

        // Validate scheduled_at (optional date, ISO with explicit offset)
        if (payload.scheduled_at !== undefined && payload.scheduled_at !== null) {
            const raw = String(payload.scheduled_at);
            if (!/(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
                return NextResponse.json(
                    { error: "scheduled_at must be an ISO date with explicit offset (e.g. ...Z or ...+03:00)" },
                    { status: 400 }
                );
            }
            const d = new Date(raw);
            if (Number.isNaN(d.getTime())) {
                return NextResponse.json({ error: "Invalid scheduled_at" }, { status: 400 });
            }
            payload.scheduled_at = d;
        }

        // ── Campos YouTube ──
        if (payload.youtube_type !== undefined && payload.youtube_type !== null) {
            const ytType = String(payload.youtube_type).toLowerCase();
            if (!VALID_YOUTUBE_TYPES.includes(ytType)) {
                return NextResponse.json({ error: "youtube_type inválido (use short ou community)" }, { status: 400 });
            }
            payload.youtube_type = ytType;
        } else if (payload.youtube_type === null) {
            payload.youtube_type = null;
        }
        if (payload.youtube_options !== undefined) {
            try {
                payload.youtube_options = parseYoutubeOptions(payload.youtube_options);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : "youtube_options inválido";
                return NextResponse.json({ error: message }, { status: 400 });
            }
        }

        // Validate channel ownership (prevents posting on another user's channel)
        let targetPlatform: string | null = null;
        if (payload.channel_id) {
            const channel = await prisma.channel.findFirst({
                where: { id: String(payload.channel_id), user_id: userId },
                select: { id: true, platform: true },
            });
            if (!channel) {
                return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
            }
            targetPlatform = channel.platform;
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

        // ── Validação cruzada YouTube: a API é o guardião (falhas tarde no cron
        // deixariam posts failed permanentes com dados inconsistentes). ──
        if (payload.youtube_type) {
            if (!payload.channel_id || targetPlatform !== "youtube") {
                return NextResponse.json(
                    { error: "youtube_type só é válido em posts de canal YouTube" },
                    { status: 400 },
                );
            }
            if (payload.youtube_type === "short") {
                if (!payload.video_url) {
                    return NextResponse.json(
                        { error: "Short do YouTube exige video_url" },
                        { status: 400 },
                    );
                }
                // O título é obrigatório na API externa (POST /api/shorts) — sem
                // essa checagem o post falharia tarde, no cron.
                let shortTitle = "";
                if (payload.youtube_options) {
                    try {
                        const opts = JSON.parse(String(payload.youtube_options)) as {
                            title?: unknown;
                        };
                        shortTitle = typeof opts.title === "string" ? opts.title.trim() : "";
                    } catch {
                        /* já normalizado acima — defensivo */
                    }
                }
                if (!shortTitle) {
                    return NextResponse.json(
                        { error: "Short do YouTube exige um título (youtube_options.title)" },
                        { status: 400 },
                    );
                }
            }
            if (payload.youtube_type === "community") {
                // O texto é obrigatório na API externa (POST /api/post/upload exige
                // `message`) — sem essa checagem o post falharia tarde, no cron.
                if (!String(payload.caption ?? "").trim()) {
                    return NextResponse.json(
                        { error: "Post na Comunidade exige texto (caption)" },
                        { status: 400 },
                    );
                }
                let imageCount = 0;
                if (payload.children_urls) {
                    try {
                        const children = JSON.parse(String(payload.children_urls)) as {
                            url?: string;
                            type?: string;
                        }[];
                        imageCount = Array.isArray(children)
                            ? children.filter((c) => c?.url && c.type !== "video").length
                            : 0;
                    } catch {
                        /* já validado acima — defensivo */
                    }
                }
                if (!imageCount && payload.image_url) imageCount = 1;
                if (imageCount < 1) {
                    return NextResponse.json(
                        { error: "Post na Comunidade exige ao menos 1 imagem (children_urls ou image_url)" },
                        { status: 400 },
                    );
                }
                // A API externa (POST /api/post/upload) aceita no máximo 10 imagens.
                if (imageCount > 10) {
                    return NextResponse.json(
                        { error: "Post na Comunidade aceita no máximo 10 imagens" },
                        { status: 400 },
                    );
                }
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
