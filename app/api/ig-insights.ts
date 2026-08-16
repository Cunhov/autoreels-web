import { prisma } from "@/lib/prisma";
import { fetchWithTimeout, GRAPH_API_VERSION } from "@/lib/instagram";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IgMetrics {
    likes: number;
    comments: number;
    plays: number;
    reach: number;
    impressions: number;
    saved: number;
    shares: number;
}

export const EMPTY_METRICS: IgMetrics = {
    likes: 0, comments: 0, plays: 0, reach: 0, impressions: 0, saved: 0, shares: 0,
};

export type IgResult =
    | { kind: "ok"; meta: { permalink?: string | null; media_type?: string | null; caption?: string | null } | null; metrics: IgMetrics; igCalls: number; errors?: string[] }
    | { kind: "auth"; message: string; igCalls: number }
    | { kind: "rate_limit"; message: string; igCalls: number }
    | { kind: "error"; message: string; igCalls: number };

// ─── Metric sets per media type ───────────────────────────────────────────────
// Instagram rejects metrics not supported by the media type. Each entry is an
// ordered fallback: we try the full set first, then progressively smaller ones.
const REELS_SETS: string[][] = [
    ["likes", "comments", "plays", "reach", "saved", "shares", "total_interactions"],
    ["likes", "comments", "plays", "saved", "shares"],
    ["likes", "comments", "plays"],
];

const IMAGE_SETS: string[][] = [
    ["impressions", "reach", "saved"],
    ["impressions", "saved"],
    ["impressions"],
];

const STORIES_SETS: string[][] = [
    ["impressions", "reach", "replies", "taps_forward"],
    ["impressions", "reach"],
    ["impressions"],
];

const VIDEO_SETS: string[][] = [
    ["impressions", "reach", "saved", "plays"],
    ["impressions", "reach", "plays"],
    ["impressions", "plays"],
];

export function metricSetsForType(mediaType?: string | null): string[][] {
    switch ((mediaType || "").toUpperCase()) {
        case "REELS": return REELS_SETS;
        case "IMAGE": return IMAGE_SETS;
        case "CAROUSEL": return IMAGE_SETS;
        case "STORIES": return STORIES_SETS;
        case "VIDEO": return VIDEO_SETS;
        default: return REELS_SETS;
    }
}

// ─── Error classification ──────────────────────────────────────────────────────

export function isAuthError(err: unknown): boolean {
    const e = (err ?? {}) as { code?: unknown; message?: unknown };
    const code = Number(e.code);
    const msg = String(e.message || "").toLowerCase();
    return (
        code === 190 ||                    // OAuthException: invalid/expired token
        code === 10 ||                     // generic permission error
        msg.includes("session has expired") ||
        msg.includes("not authorized") ||
        msg.includes("invalid token") ||
        msg.includes("oauth") ||
        msg.includes("access token")
    );
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

/** Sum the `values[].value` entries of an IG insights response into IgMetrics. */
export function parseInsightsData(data: unknown): IgMetrics {
    const metrics: IgMetrics = { ...EMPTY_METRICS };
    if (!Array.isArray(data)) return metrics;
    for (const entry of data) {
        const name = String((entry as { name?: unknown })?.name || "").toLowerCase();
        if (!(name in metrics)) continue; // ignore total_interactions, replies, taps_*, exits…
        const values = Array.isArray((entry as { values?: unknown })?.values)
            ? ((entry as { values: unknown[] }).values)
            : [];
        const total = values.reduce<number>((acc, v) => {
            const num = Number(
                typeof v === "object" && v !== null ? (v as { value?: unknown }).value ?? v : v
            );
            return acc + (Number.isFinite(num) ? num : 0);
        }, 0);
        metrics[name as keyof IgMetrics] = total;
    }
    return metrics;
}

// ─── IG fetch (meta + insights) ───────────────────────────────────────────────

export async function fetchMediaInsights(
    baseUrl: string,
    mediaId: string,
    token: string,
    mediaType?: string | null
): Promise<IgResult> {
    let igCalls = 0;

    // 1. Media meta (permalink, media_type, caption)
    let meta: { permalink?: string; media_type?: string; caption?: string } | null = null;
    try {
        const res = await fetchWithTimeout(
            `${baseUrl}/${GRAPH_API_VERSION}/${mediaId}?fields=timestamp,caption,media_type,permalink&access_token=${encodeURIComponent(token)}`,
            {},
            15_000
        );
        igCalls++;
        if (res.status === 429) return { kind: "rate_limit", message: "Instagram rate limit reached", igCalls };
        if (res.ok) {
            const d = await res.json();
            if (d?.error) {
                if (isAuthError(d.error)) return { kind: "auth", message: String(d.error.message || "Invalid token"), igCalls };
            } else {
                meta = {
                    permalink: d?.permalink || undefined,
                    media_type: d?.media_type || undefined,
                    caption: d?.caption || undefined,
                };
            }
        }
    } catch {
        // meta failure is non-fatal — insights may still work
    }

    // 2. Insights with per-media-type metric sets (ordered fallbacks)
    let metrics: IgMetrics = { ...EMPTY_METRICS };
    let fallbackCandidate: IgMetrics | null = null;
    // Errors from failed set attempts. NON-fatal when at least one set returned
    // usable data (partial result — surfaced alongside the data); fatal when NO
    // set produced anything (silent zeros are a lie: a broken media post would
    // otherwise render as genuine zero engagement in analytics).
    const insightErrors: string[] = [];
    for (const set of metricSetsForType(mediaType)) {
        try {
            const url = `${baseUrl}/${GRAPH_API_VERSION}/${mediaId}/insights?metric=${set.join(",")}&access_token=${encodeURIComponent(token)}`;
            const res = await fetchWithTimeout(url, {}, 15_000);
            igCalls++;
            if (res.status === 429) return { kind: "rate_limit", message: "Instagram rate limit reached", igCalls };
            if (!res.ok) {
                let msg = `Instagram insights request failed (HTTP ${res.status})`;
                try {
                    const errBody = await res.json();
                    if (errBody?.error?.message) msg = String(errBody.error.message);
                    else if (errBody?.error) msg = String(errBody.error);
                } catch {
                    /* keep the generic message — non-JSON body */
                }
                if (isAuthError({ message: msg })) return { kind: "auth", message: msg, igCalls };
                insightErrors.push(msg);
                continue;
            }
            const d = await res.json();
            if (d?.error) {
                const msg = String(d.error.message || d.error || `Instagram error (HTTP ${res.status})`);
                if (isAuthError(d.error)) return { kind: "auth", message: msg, igCalls };
                insightErrors.push(msg);
                continue;
            }
            if (!Array.isArray(d?.data)) {
                insightErrors.push("Malformed insights response from Instagram");
                continue;
            }
            const parsed = parseInsightsData(d.data);
            if (Object.values(parsed).some(v => v > 0)) {
                metrics = parsed;
                break;
            }
            // Keep a zero-filled valid response as last-resort fallback
            if (Array.isArray(d.data) && d.data.length > 0 && !fallbackCandidate) {
                fallbackCandidate = parsed;
            }
        } catch (error: unknown) {
            const isMalformed = error instanceof Error && /unexpected token|json|parse/i.test(error.message);
            insightErrors.push(isMalformed ? "Malformed insights response from Instagram" : "Instagram insights request failed");
            continue;
        }
    }
    if (Object.values(metrics).every(v => v === 0) && fallbackCandidate) {
        metrics = fallbackCandidate;
    }
    if (Object.values(metrics).every(v => v === 0) && insightErrors.length > 0) {
        return { kind: "error", message: insightErrors[0], igCalls };
    }

    return { kind: "ok", meta, metrics, igCalls, ...(insightErrors.length > 0 ? { errors: insightErrors } : {}) };
}

// ─── Persistence ───────────────────────────────────────────────────────────────

export async function upsertPostMetric(
    postId: string,
    channelId: string | null,
    metrics: IgMetrics
): Promise<void> {
    const data = {
        likes: metrics.likes,
        comments: metrics.comments,
        plays: metrics.plays,
        reach: metrics.reach,
        impressions: metrics.impressions,
        saved: metrics.saved,
        shares: metrics.shares,
        fetched_at: new Date(),
    };
    await prisma.postMetric.upsert({
        where: { post_id: postId },
        update: data,
        create: { post_id: postId, channel_id: channelId, ...data },
    });
}

// ─── Aggregation ───────────────────────────────────────────────────────────────

export type Totals = IgMetrics & { posts_analyzed: number };

export function totalsFromMetrics(entries: { metrics: IgMetrics }[]): Totals {
    const totals: Totals = { ...EMPTY_METRICS, posts_analyzed: 0 };
    for (const entry of entries) {
        let any = false;
        for (const k of ["likes", "comments", "plays", "reach", "impressions", "saved", "shares"] as const) {
            totals[k] += entry.metrics[k];
            if (entry.metrics[k] > 0) any = true;
        }
        if (any) totals.posts_analyzed++;
    }
    return totals;
}
