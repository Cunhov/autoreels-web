import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { safeEqual } from "@/lib/secret";
import { resolveAccessToken, getGraphBaseUrl } from "@/lib/instagram";
import { fetchMediaInsights, upsertPostMetric } from "@/app/api/ig-insights";

// ─── Config ────────────────────────────────────────────────────────────────────
const MAX_IG_CALLS = 40;                 // hard cap per run (IG quota: 200/h)
const STALE_MS = 6 * 60 * 60 * 1000;     // refetch posts whose metrics are older than 6h
const LOOKBACK_DAYS = 30;
const BATCH_SIZE = 5;

interface PostRow {
    id: string;
    instagram_media_id: string | null;
    media_type: string | null;
}

async function handler(req: Request) {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
        console.error("[metrics] CRON_SECRET is not set");
        return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
    }
    const provided = req.headers.get("x-cron-auth");
    if (!provided || !safeEqual(provided, expected)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const channels = await prisma.channel.findMany({
        where: { status: "active" },
        select: { id: true, access_token: true, account_id: true },
    });

    let igCalls = 0;
    let postsSynced = 0;
    let channelsProcessed = 0;
    let rateLimited = false;

    for (const channel of channels) {
        if (igCalls >= MAX_IG_CALLS) break;
        channelsProcessed++;

        let token = "";
        try {
            token = channel.access_token ? await resolveAccessToken(channel.access_token) : "";
        } catch {
            token = "";
        }
        if (!token || !channel.account_id) continue;
        const baseUrl = getGraphBaseUrl(token);

        const posts: PostRow[] = await prisma.post.findMany({
            where: {
                channel_id: channel.id,
                status: "published",
                published_at: { gte: since },
            },
            orderBy: { published_at: "desc" },
            take: 50,
            select: { id: true, instagram_media_id: true, media_type: true },
        });
        if (posts.length === 0) continue;

        const metricRows = await prisma.postMetric.findMany({
            where: { post_id: { in: posts.map(p => p.id) } },
            select: { post_id: true, fetched_at: true },
        });
        const fresh = new Map(
            metricRows
                .filter(m => Date.now() - m.fetched_at.getTime() < STALE_MS)
                .map(m => [m.post_id, true])
        );

        for (let i = 0; i < posts.length && igCalls < MAX_IG_CALLS; i += BATCH_SIZE) {
            const batch = posts.slice(i, i + BATCH_SIZE);
            await Promise.all(
                batch.map(async (post) => {
                    if (fresh.has(post.id) || !post.instagram_media_id) return;
                    const res = await fetchMediaInsights(baseUrl, post.instagram_media_id!, token, post.media_type);
                    igCalls += res.igCalls;
                    if (res.kind === "ok") {
                        await upsertPostMetric(post.id, channel.id, res.metrics);
                        postsSynced++;
                    } else if (res.kind === "rate_limit") {
                        rateLimited = true;
                    }
                    // auth errors are silent here (route surfaces them to the user);
                    // the dashboard falls back to a direct fetch if needed
                })
            );
        }
    }

    return NextResponse.json({
        channels_processed: channelsProcessed,
        posts_synced: postsSynced,
        ig_calls: igCalls,
        rate_limited: rateLimited,
        stale_ms: STALE_MS,
    });
}

export async function GET(req: Request) {
    return handler(req);
}

export async function POST(req: Request) {
    return handler(req);
}
