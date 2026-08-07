import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";
import {
    resolveAccessToken,
    getGraphBaseUrl,
    GRAPH_API_VERSION,
    fetchWithTimeout,
} from "@/lib/instagram";

// ─── Cache (in-memory, 5 min) ────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_WINDOW_MS = 5 * 60 * 1000;

interface CacheEntry {
    expiresAt: number;
    data: unknown;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(channelId: string, from: string, to: string): string {
    const window = Math.floor(Date.now() / CACHE_WINDOW_MS);
    return `${channelId}:${from}:${to}:${window}`;
}

// ─── Instagram helpers ────────────────────────────────────────────────────────

/** Metric sets, in order of preference. IG rejects metrics not supported by a
 *  media type (e.g. `reach` doesn't exist for IMAGE/CAROUSEL), so we degrade
 *  gracefully: full set → no reach → likes/comments/impressions only. */
const METRIC_SETS = [
    "likes,comments,impressions,reach,saved,shares",
    "likes,comments,impressions,saved,shares",
    "likes,comments,impressions",
];

async function fetchMediaMeta(baseUrl: string, mediaId: string, token: string) {
    try {
        const url = `${baseUrl}/${GRAPH_API_VERSION}/${mediaId}?fields=timestamp,caption,media_type,permalink&access_token=${encodeURIComponent(token)}`;
        const res = await fetchWithTimeout(url, {}, 15_000);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || data.error) return null;
        return data;
    } catch {
        return null;
    }
}

async function fetchInsights(baseUrl: string, mediaId: string, token: string): Promise<Record<string, number>> {
    for (const metricSet of METRIC_SETS) {
        try {
            const url = `${baseUrl}/${GRAPH_API_VERSION}/${mediaId}/insights?metric=${metricSet}&access_token=${encodeURIComponent(token)}`;
            const res = await fetchWithTimeout(url, {}, 15_000);
            if (!res.ok) continue;
            const data = await res.json();
            if (!data || data.error || !Array.isArray(data.data)) continue;
            const metrics: Record<string, number> = {};
            for (const entry of data.data) {
                const name = entry?.name as string;
                if (!name) continue;
                const values = Array.isArray(entry?.values) ? entry.values : [];
                const total = values.reduce((acc: number, v: unknown) => {
                    const num = Number(typeof v === "object" && v !== null ? (v as { value?: unknown }).value ?? v : v);
                    return acc + (Number.isFinite(num) ? num : 0);
                }, 0);
                metrics[name.toLowerCase()] = total;
            }
            if (Object.keys(metrics).length > 0) return metrics;
        } catch {
            // try the next (smaller) metric set
        }
    }
    return {};
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
        select: { id: true, name: true, access_token: true, account_id: true },
    });
    if (!channel) {
        return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const daysParam = Number(searchParams.get("days") || "30");
    const days = Number.isFinite(daysParam)
        ? Math.min(Math.max(Math.floor(daysParam), 1), 90)
        : 30;

    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    const to = toParam ? new Date(toParam) : new Date();
    const from = fromParam ? new Date(fromParam) : new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return NextResponse.json({ error: "Invalid from/to" }, { status: 400 });
    }

    const ck = cacheKey(channel.id, from.toISOString(), to.toISOString());
    const cached = cache.get(ck);
    if (cached && cached.expiresAt > Date.now()) {
        return NextResponse.json(cached.data);
    }

    let token: string;
    try {
        token = channel.access_token ? await resolveAccessToken(channel.access_token) : "";
    } catch {
        return NextResponse.json(
            { error: "Token resolution failed", detail: "Please re-connect the channel." },
            { status: 400 }
        );
    }
    if (!token || !channel.account_id) {
        return NextResponse.json({ error: "Channel has no access token" }, { status: 400 });
    }

    const posts = await prisma.post.findMany({
        where: {
            channel_id: channel.id,
            status: "published",
            published_at: { gte: from, lte: to },
        },
        orderBy: { published_at: "desc" },
        take: 100,
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

    const baseUrl = getGraphBaseUrl(token);
    const totals = { likes: 0, comments: 0, reach: 0, impressions: 0, saved: 0, shares: 0, posts_analyzed: 0 };
    const resultPosts: unknown[] = [];

    for (const post of posts) {
        const mediaId = post.instagram_media_id;
        const entry: {
            id: string;
            instagram_media_id: string | null;
            permalink: string | null;
            caption: string | null;
            media_type: string | null;
            published_at: Date | null;
            video_url: string | null;
            image_url: string | null;
            thumbnail_url: string | null;
            metrics: Record<string, number>;
        } = {
            id: post.id,
            instagram_media_id: mediaId || null,
            permalink: null,
            caption: post.caption || null,
            media_type: post.media_type || null,
            published_at: post.published_at,
            video_url: post.video_url,
            image_url: post.image_url,
            thumbnail_url: post.thumbnail_url,
            metrics: { likes: 0, comments: 0, reach: 0, impressions: 0, saved: 0, shares: 0 },
        };

        if (mediaId) {
            const meta = await fetchMediaMeta(baseUrl, mediaId, token);
            if (meta) {
                entry.permalink = meta.permalink || null;
                if (!entry.media_type) entry.media_type = meta.media_type || null;
                if (!entry.caption) entry.caption = meta.caption || null;
            }
            const metrics = await fetchInsights(baseUrl, mediaId, token);
            let anyMetric = false;
            for (const k of ["likes", "comments", "reach", "impressions", "saved", "shares"]) {
                const v = metrics[k] || 0;
                entry.metrics[k] = v;
                totals[k as keyof typeof totals] += v;
                if (v > 0) anyMetric = true;
            }
            if (anyMetric) totals.posts_analyzed++;
        }
        resultPosts.push(entry);
    }

    const payload = {
        channel_id: channel.id,
        channel_name: channel.name,
        days,
        from: from.toISOString(),
        to: to.toISOString(),
        fetched_at: new Date().toISOString(),
        totals,
        posts: resultPosts,
    };

    // Store + bound the cache size
    cache.set(ck, { expiresAt: Date.now() + CACHE_TTL_MS, data: payload });
    if (cache.size > 50) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
        if (oldest) cache.delete(oldest[0]);
    }

    return NextResponse.json(payload);
}
