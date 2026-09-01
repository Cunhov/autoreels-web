import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { parseYoutubeOptions, VALID_YOUTUBE_TYPES } from "@/lib/youtube-post-options";
import { escapeHtml, safeJsonParse, CAPTION_MAX, DESCRIPTION_MAX, PINNED_MAX, YT_TITLE_MAX } from "@/lib/sanitize";

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

        // BK-16 safeJsonParse + BK-07 sanitização children_urls
        if (payload.children_urls !== undefined && payload.children_urls !== null) {
            const raw = String(payload.children_urls);
            const parsed = safeJsonParse<unknown>(raw, null as unknown);
            if (parsed === null) {
                return NextResponse.json({ error: "children_urls must be valid JSON" }, { status: 400 });
            }
            if (!Array.isArray(parsed)) {
                return NextResponse.json({ error: "children_urls must be a JSON array" }, { status: 400 });
            }
        }

        // M10: carrossel exige 2..10 mídias — a API do Instagram rejeita
        // carrossel com 1 item de forma DEFINITIVA (post passava wizard+runtime
        // e falhava para sempre no publisher; o runtime só errava com 0 filhos).
        // Valida server-side na origem, com erro PT-BR claro.
        if (payload.media_type === "CAROUSEL") {
            let carouselCount = 0;
            if (payload.children_urls) {
                const children = safeJsonParse<{ url?: unknown }[]>(
                    String(payload.children_urls),
                    [] as { url?: unknown }[],
                );
                if (Array.isArray(children)) {
                    carouselCount = children.filter((c) => Boolean(c?.url)).length;
                }
            }
            if (carouselCount < 2 || carouselCount > 10) {
                return NextResponse.json(
                    {
                        error: `Carrossel exige entre 2 e 10 mídias (recebido: ${carouselCount}). Selecione uma pasta com 2 a 10 itens ou envie mais arquivos.`,
                    },
                    { status: 400 },
                );
            }
        }

        // BK-10 validar scheduled_at com Date.parse + isNaN + min=agora
        if (payload.scheduled_at !== undefined && payload.scheduled_at !== null) {
            const raw = String(payload.scheduled_at);
            if (!/(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
                return NextResponse.json(
                    { error: "scheduled_at must be an ISO date with explicit offset (e.g. ...Z or ...+03:00)" },
                    { status: 400 }
                );
            }
            const ts = Date.parse(raw);
            if (Number.isNaN(ts)) {
                return NextResponse.json({ error: "Invalid scheduled_at" }, { status: 400 });
            }
            const d = new Date(ts);
            if (Number.isNaN(d.getTime())) {
                return NextResponse.json({ error: "Invalid scheduled_at" }, { status: 400 });
            }
            if (d.getTime() < Date.now() - 60_000) {
                return NextResponse.json({ error: "scheduled_at must be in the future" }, { status: 400 });
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
        // BK-19 padronizar youtube_options para null
        if (payload.youtube_options !== undefined) {
            try {
                const normalized = parseYoutubeOptions(payload.youtube_options);
                payload.youtube_options = normalized; // null se vazio
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : "youtube_options inválido";
                return NextResponse.json({ error: message }, { status: 400 });
            }
        } else {
            payload.youtube_options = null;
        }
        // BK-07/BK-14 sanitizar caption/title/tags com maxLength e escape HTML
        if (payload.caption !== undefined && payload.caption !== null) {
            let cap = String(payload.caption);
            if (cap.length > CAPTION_MAX) cap = cap.slice(0, CAPTION_MAX);
            if (cap.includes("<") || cap.includes(">")) cap = escapeHtml(cap);
            payload.caption = cap;
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
                // essa checagem o post falharia tarde, no cron. Mesma resolução do
                // PATCH e do publisher: options.title || caption.
                let shortTitle = "";
                if (payload.youtube_options) {
                    const opts = safeJsonParse<{title?: unknown}>(String(payload.youtube_options), {} as any);
                    shortTitle = typeof (opts as any).title === "string" ? (opts as any).title.trim() : "";
                }
                if (!shortTitle) shortTitle = String(payload.caption ?? "").trim();
                if (!shortTitle) {
                    return NextResponse.json(
                        { error: "Short do YouTube exige um título (youtube_options.title ou caption)" },
                        { status: 400 },
                    );
                }
            }
            if (payload.youtube_type === "community") {
                // O texto é obrigatório na API externa (POST /api/post e
                // /api/post/upload exigem `message`) — sem essa checagem o post
                // falharia tarde, no cron.
                if (!String(payload.caption ?? "").trim()) {
                    return NextResponse.json(
                        { error: "Post na Comunidade exige texto (caption)" },
                        { status: 400 },
                    );
                }
                let imageCount = 0;
                let childCount = 0;
                let allChildrenVideos = false;
                if (payload.children_urls) {
                    const children = safeJsonParse<{url?: string; type?: string}[]>(String(payload.children_urls), []) as any;
                    if (Array.isArray(children)) {
                        childCount = (children as any).filter((c: any) => c?.url).length;
                        allChildrenVideos =
                            childCount > 0 &&
                            (children as any).every((c: any) => !c?.url || c.type === "video");
                        imageCount = (children as any).filter((c: any) => c?.url && c.type !== "video").length;
                    }
                } else if (payload.image_url) {
                    imageCount = 1;
                }
                // Carrossel só-de-vídeos para a Comunidade: a API externa não
                // suporta vídeos e o publisher falharia DEFINITIVAMENTE a cada
                // ciclo com "não suporta vídeos" (post criado mas nunca
                // publicado) — a API é o guardião e deve rejeitar o estado na
                // origem, como já faz com Short sem título/texto.
                if (allChildrenVideos) {
                    return NextResponse.json(
                        { error: "Post na Comunidade do YouTube não suporta vídeos — o conteúdo selecionado contém apenas vídeos" },
                        { status: 400 },
                    );
                }
                // Imagens são OPCIONAIS na Comunidade: sem elas o post é só texto
                // (a API aceita via POST /api/post com image_urls opcional).
                // A API externa aceita no máximo 10 imagens.
                if (imageCount > 10) {
                    return NextResponse.json(
                        { error: "Post na Comunidade aceita no máximo 10 imagens" },
                        { status: 400 },
                    );
                }
            }
        }

        // BK-05: Idempotency — evita duplicacao por duplo clique / retry
        // Chave vem de header X-Idempotency-Key ou body idempotencyKey/_idempotencyKey
        const idempotencyKey = (req.headers.get("x-idempotency-key") || (data as Record<string,unknown>)["idempotencyKey"] || (data as Record<string,unknown>)["_idempotencyKey"]) as string | undefined;
        if (idempotencyKey) {
            const appKey = `idempotency:${userId}:${String(idempotencyKey).slice(0,128)}`;
            try {
                const existingMapping = await prisma.appConfig.findUnique({ where: { key: appKey } });
                if (existingMapping?.value) {
                    try {
                        const mappedId = JSON.parse(existingMapping.value) as { postId?: string; expiresAt?: number };
                        if (mappedId?.postId && (!mappedId.expiresAt || mappedId.expiresAt > Date.now())) {
                            const existingPost = await prisma.post.findFirst({ where: { id: mappedId.postId, user_id: userId } });
                            if (existingPost) return NextResponse.json(existingPost);
                        }
                    } catch {}
                }
            } catch {}
            const post = await prisma.post.create({
                data: {
                    ...payload,
                    // Server-owned fields — never trust the client
                    user_id: userId,
                    status: "pending",
                } as Prisma.PostUncheckedCreateInput,
            });
            // guarda mapping 24h (debounce 800ms + retry)
            try {
                await prisma.appConfig.upsert({
                    where: { key: appKey },
                    create: { key: appKey, value: JSON.stringify({ postId: post.id, expiresAt: Date.now() + 24*60*60*1000 }) },
                    update: { value: JSON.stringify({ postId: post.id, expiresAt: Date.now() + 24*60*60*1000 }) },
                });
            } catch {}
            return NextResponse.json(post);
        }

        // Fallback dedup: mesmo usuario/canal/caption/video_url nos ultimos 10s → retorna existente
        try {
            const dedupWhere: Record<string, unknown> = { user_id: userId, created_at: { gte: new Date(Date.now() - 10_000) } };
            if (payload.channel_id) dedupWhere.channel_id = payload.channel_id;
            if (payload.caption) dedupWhere.caption = payload.caption;
            // video/image children como sinal fraco — so aplica se existir midia
            const mediaSignal = (payload.video_url || payload.image_url || payload.children_urls || null) as string | null;
            // se tem midia, inclui no filtro dedup; se nao, dedup so por canal+caption ja evita duplo clique de post texto
            const existingRecent = await prisma.post.findFirst({
                where: dedupWhere as never,
                orderBy: { created_at: "desc" },
            });
            if (existingRecent) {
                const existingMedia = (existingRecent.video_url || existingRecent.image_url || existingRecent.children_urls || null) as string | null;
                if (mediaSignal === existingMedia) {
                    return NextResponse.json(existingRecent);
                }
            }
        } catch {}

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
