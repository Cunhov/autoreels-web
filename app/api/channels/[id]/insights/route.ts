import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";
import { resolveAccessToken, getGraphBaseUrl } from "@/lib/instagram";
import {
    fetchMediaInsights,
    upsertPostMetric,
    totalsFromMetrics,
    EMPTY_METRICS,
    type IgMetrics,
} from "@/app/api/ig-insights";

// ─── Cache (in-memory, 5-min buckets; key has NO milliseconds) ────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_WINDOW_MS = 5 * 60 * 1000;
const MAX_POSTS = 50; // IG quota is 200 calls/h; worst case here is ~100 calls

interface CacheEntry {
    expiresAt: number;
    data: unknown;
}

const cache = new Map<string, CacheEntry>();

/** 5-minute bucket key — stable within the bucket, so the cache actually hits. */
export function cacheKey(channelId: string, from: string, to: string): string {
    const window = Math.floor(Date.now() / CACHE_WINDOW_MS);
    return `${channelId}:${from}:${to}:${window}`;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const channel = await prisma.channel.findUnique({
        where: { id, user_id: userId },
        select: { id: true, name: true, access_token: true, account_id: true, platform: true },
    });
    if (!channel) {
        return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    // S2-analytics: métricas são exclusivas do Instagram (Graph API). Canal
    // TikTok/YouTube guarda o token em settings (API própria) e acess_token fica
    // vazio — antes caía em "Channel has no access token" (erro enganoso, em
    // inglês, sugerindo reconectar um canal que está conectado). Resposta PT-BR
    // clara; o painel tem empty-states dedicados para essas plataformas.
    if ((channel.platform || "").toLowerCase() !== "instagram") {
        const label = (channel.platform || "desconhecido").toLowerCase();
        return NextResponse.json(
            {
                error: `Métricas do Instagram não se aplicam a um canal ${label}.`,
                detail: "As métricas de audiência para esta plataforma ainda não são suportadas pelo painel.",
            },
            { status: 400 },
        );
    }

    const { searchParams } = new URL(req.url);
    const daysParam = Number(searchParams.get("days") || "30");
    const days = Number.isFinite(daysParam)
        ? Math.min(Math.max(Math.floor(daysParam), 1), 90)
        : 30;
    const force = searchParams.get("force") === "1" || searchParams.get("force") === "true";

    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    const to = toParam ? new Date(toParam) : new Date();
    const from = fromParam ? new Date(fromParam) : new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return NextResponse.json({ error: "Invalid from/to" }, { status: 400 });
    }

    // 1. Cache (bucket-stable) — bypassed with ?force=1
    const ck = cacheKey(channel.id, from.toISOString(), to.toISOString());
    if (!force) {
        const cached = cache.get(ck);
        if (cached && cached.expiresAt > Date.now()) {
            return NextResponse.json(cached.data);
        }
    }

    // 2. Published posts in the window (take MAX_POSTS+1 to detect `has_more`)
    const posts = await prisma.post.findMany({
        where: {
            channel_id: channel.id,
            status: "published",
            published_at: { gte: from, lte: to },
        },
        orderBy: { published_at: "desc" },
        take: MAX_POSTS + 1,
        select: {
            id: true,
            instagram_media_id: true,
            caption: true,
            media_type: true,
            published_at: true,
            video_url: true,
            image_url: true,
            thumbnail_url: true,
        },
    });
    const hasMore = posts.length > MAX_POSTS;
    const windowPosts = posts.slice(0, MAX_POSTS);

    // 3. Primary path: PostMetric rows from the DB (zero IG calls)
    if (!force) {
        const dbResult = await payloadFromDb(channel, days, from, to, windowPosts);
        if (dbResult) {
            const payload = { ...dbResult, has_more: hasMore, source: "db" };
            setCache(ck, payload);
            return NextResponse.json(payload);
        }
    }

    // 4. Fallback: direct IG fetch (batched), persisting into PostMetric
    let token: string;
    try {
        token = channel.access_token ? await resolveAccessToken(channel.access_token) : "";
    } catch {
        return NextResponse.json(
            { error: "Token resolution failed", detail: "Please re-connect the channel in /channels." },
            { status: 400 }
        );
    }
    if (!token || !channel.account_id) {
        return NextResponse.json(
            { error: "Channel has no access token", detail: "Re-connect the channel in /channels." },
            { status: 400 }
        );
    }
    if (force) {
        // Invalidate the DB coverage shortcut for this window — refetch everything
        await prisma.postMetric.deleteMany({
            where: { post_id: { in: windowPosts.map(p => p.id) } },
        });
    }
    const baseUrl = getGraphBaseUrl(token);

    const entries: PostEntry[] = [];
    const errors: { post_id: string; message: string }[] = [];
    const igCalls = { count: 0 };

    // Batches of 5 — bounded parallelism, stops on quota/auth errors
    for (let i = 0; i < windowPosts.length; i += 5) {
        const batch = windowPosts.slice(i, i + 5);
        const results = await Promise.all(batch.map(post => fetchPostEntry(baseUrl, post, token, igCalls)));
        for (const r of results) {
            if (r.entry) entries.push(r.entry);
            if (r.error) errors.push(r.error);
            if (r.extraErrors) errors.push(...r.extraErrors);
            if (r.fatal) {
                if (r.fatal === "auth") {
                    return NextResponse.json(
                        { error: "auth", detail: "Token do canal expirado — reconecte o canal em /channels." },
                        { status: 401 }
                    );
                }
                if (r.fatal === "rate_limit") {
                    return NextResponse.json(
                        { error: "rate_limit", detail: "Limite da API do Instagram atingido — tente em alguns minutos." },
                        { status: 429 }
                    );
                }
            }
        }
    }

    // Total failure: NO post produced usable metrics. A 200-with-zeros would
    // render a broken channel/media as genuine zero engagement in analytics —
    // surface the IG error as a 4xx so the analytics page shows the failure.
    if (entries.length === 0 && errors.length > 0) {
        return NextResponse.json(
            { error: errors[0].message, errors },
            { status: 400 }
        );
    }

    const totals = totalsFromMetrics(entries);
    const payload = {
        channel_id: channel.id,
        channel_name: channel.name,
        days,
        from: from.toISOString(),
        to: to.toISOString(),
        fetched_at: new Date().toISOString(),
        totals,
        posts: entries,
        has_more: hasMore,
        source: "ig" as const,
        ...(errors.length > 0 ? { errors } : {}),
    };
    setCache(ck, payload);
    return NextResponse.json(payload);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function setCache(key: string, data: unknown) {
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data });
    if (cache.size > 50) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
        if (oldest) cache.delete(oldest[0]);
    }
}

interface DbPost {
    id: string;
    instagram_media_id: string | null;
    caption: string | null;
    media_type: string | null;
    published_at: Date | null;
    video_url: string | null;
    image_url: string | null;
    thumbnail_url: string | null;
}

interface PostEntry {
    id: string;
    instagram_media_id: string | null;
    permalink: string | null;
    caption: string | null;
    media_type: string | null;
    published_at: Date | null;
    video_url: string | null;
    image_url: string | null;
    thumbnail_url: string | null;
    metrics: IgMetrics;
}

function entryFromDbPost(post: DbPost, metrics: IgMetrics): PostEntry {
    return {
        id: post.id,
        instagram_media_id: post.instagram_media_id,
        permalink: null,
        caption: post.caption,
        media_type: post.media_type,
        published_at: post.published_at,
        video_url: post.video_url,
        image_url: post.image_url,
        thumbnail_url: post.thumbnail_url,
        metrics,
    };
}

/** Build the payload from PostMetric rows when coverage >= 50% of the window. */
async function payloadFromDb(
    channel: { id: string; name: string },
    days: number,
    from: Date,
    to: Date,
    windowPosts: DbPost[]
): Promise<Omit<ReturnType<typeof makePayload>, "has_more" | "source"> | null> {
    if (windowPosts.length === 0) return null;
    const rows = await prisma.postMetric.findMany({
        where: { post_id: { in: windowPosts.map(p => p.id) } },
    });
    if (rows.length === 0) return null;
    const coverage = rows.length / windowPosts.length;
    if (coverage < 0.5) return null;

    const byPost = new Map(rows.map(r => [r.post_id, r]));
    const entries = windowPosts.map(p => {
        const row = byPost.get(p.id);
        return entryFromDbPost(p, row
            ? {
                likes: row.likes, comments: row.comments, plays: row.plays,
                reach: row.reach, impressions: row.impressions, saved: row.saved, shares: row.shares,
            }
            : { ...EMPTY_METRICS });
    });
    const totals = totalsFromMetrics(entries);
    const fetchedAt = rows.reduce((max, r) => (r.fetched_at > max ? r.fetched_at : max), rows[0].fetched_at);
    return makePayload(channel, days, from, to, entries, totals, fetchedAt);
}

function makePayload(
    channel: { id: string; name: string },
    days: number,
    from: Date,
    to: Date,
    posts: PostEntry[],
    totals: ReturnType<typeof totalsFromMetrics>,
    fetchedAt: Date
) {
    return {
        channel_id: channel.id,
        channel_name: channel.name,
        days,
        from: from.toISOString(),
        to: to.toISOString(),
        fetched_at: fetchedAt.toISOString(),
        totals,
        posts,
    };
}

async function fetchPostEntry(
    baseUrl: string,
    post: DbPost,
    token: string,
    igCalls: { count: number }
): Promise<{ entry?: PostEntry; error?: { post_id: string; message: string }; extraErrors?: { post_id: string; message: string }[]; fatal?: "auth" | "rate_limit" }> {
    if (!post.instagram_media_id) {
        return { error: { post_id: post.id, message: "Sem instagram_media_id — não é possível buscar métricas" } };
    }
    const res = await fetchMediaInsights(baseUrl, post.instagram_media_id, token, post.media_type);
    igCalls.count += res.igCalls;
    if (res.kind === "auth") {
        return { fatal: "auth" };
    }
    if (res.kind === "rate_limit") {
        return { fatal: "rate_limit" };
    }
    if (res.kind === "error") {
        return { error: { post_id: post.id, message: res.message } };
    }
    // Partial result: usable metrics exist, but some metric-set attempts failed —
    // surface those alongside the data so partial failures are never silent.
    const extraErrors = res.errors?.length
        ? res.errors.map(message => ({ post_id: post.id, message }))
        : undefined;
    await upsertPostMetric(post.id, null, res.metrics).catch(() => { /* non-fatal */ });
    const entry = entryFromDbPost(post, res.metrics);
    entry.permalink = res.meta?.permalink || null;
    if (!entry.media_type && res.meta?.media_type) entry.media_type = res.meta.media_type;
    if (!entry.caption && res.meta?.caption) entry.caption = res.meta.caption;
    return extraErrors ? { entry, extraErrors } : { entry };
}
