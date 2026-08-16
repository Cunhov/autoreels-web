import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    fetchWithTimeout,
    getGraphBaseUrl,
    GRAPH_API_VERSION,
    refreshInstagramToken,
    resolveAccessToken,
    classifyTokenRefreshError,
} from '@/lib/instagram';
import { runPlannerOnce } from '@/lib/planner-runtime';
import { sendNotification } from '@/lib/notify';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the public base URL used to build absolute media URLs sent to the
 * Instagram Graph API. The IG API must be able to download the media from this
 * URL, so it CANNOT be a Docker-internal hostname (e.g. http://app:3000).
 *
 * Priority:
 *   1. PUBLIC_BASE_URL  (explicit, recommended — e.g. https://autoreels.example.com)
 *   2. NEXTAUTH_URL     (fallback — used as-is, even if it looks local, but warns)
 *   3. ''               (relative URLs + error log — the IG API will reject them,
 *                       but the cron run itself does not crash)
 */
function resolveSystemBaseUrl(): string {
    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (publicBaseUrl) {
        if (publicBaseUrl.includes('localhost') || publicBaseUrl.includes('app:')) {
            console.warn(
                `[Cron] PUBLIC_BASE_URL looks internal (${publicBaseUrl}). ` +
                'The Instagram API must be able to reach this URL to download media.'
            );
        }
        return publicBaseUrl;
    }

    const envUrl = (process.env.NEXTAUTH_URL || '').replace(/\/$/, '');
    if (envUrl) {
        if (envUrl.includes('localhost') || envUrl.includes('app:')) {
            console.warn(
                `[Cron] NEXTAUTH_URL is "${envUrl}" — the Instagram API will not be able to reach media URLs. ` +
                'Set PUBLIC_BASE_URL to the public domain (e.g. https://your-domain.com).'
            );
        }
        return envUrl;
    }

    console.error(
        '[Cron] Neither PUBLIC_BASE_URL nor NEXTAUTH_URL is set — media URLs will be relative and ' +
        'the Instagram API cannot download them. Set PUBLIC_BASE_URL to the public domain.'
    );
    return '';
}

function makeAbsoluteUrl(baseOut: string, path: string | null | undefined): string {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${baseOut}${cleanPath}`;
}

/** JSON.parse with a fallback — never throws on malformed stored data. */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

/** Error marker for malformed persisted data (children_urls, instagram_child_ids...). */
class MalformedDataError extends Error {}

/** Posts that exhaust transient retries are failed instead of retried forever. */
const MAX_TRANSIENT_ATTEMPTS = 5;
const MAX_TRANSIENT_AGE_MS = 48 * 60 * 60 * 1000;

function isPostTooOld(post: { created_at?: Date | null }, now: Date): boolean {
    const created = post.created_at?.getTime() || 0;
    return created > 0 && now.getTime() - created > MAX_TRANSIENT_AGE_MS;
}

/**
 * Classify an error as:
 *   - 'definitive'    → permanent (4xx IG validation/OAuth, missing credentials, malformed data) → fail the post now
 *   - 'transient'     → temporary (network, timeouts, 5xx, non-JSON body) → keep status, retry next tick
 *   - 'rate-limited'  → 429 → keep status, retry next tick, and stop the current batch
 */
function classifyError(e: unknown, lastStatus: number): 'definitive' | 'transient' | 'rate-limited' {
    if (e instanceof MalformedDataError) return 'definitive';
    if (e instanceof Error && e.name === 'AbortError') return 'transient';

    const igStatus = (e as { igStatus?: number })?.igStatus;
    const status = igStatus || lastStatus || 0;
    if (status === 429) return 'rate-limited';
    if (status >= 500) return 'transient';
    if (status >= 400 && status < 500) return 'definitive';

    // res.json() throwing on a non-JSON body (proxy error page, HTML) is transient
    if (e instanceof SyntaxError) return 'transient';

    const msg = e instanceof Error ? e.message : String(e || '');
    if (/missing credentials/i.test(msg)) return 'definitive';
    if (/carousel has no media items/i.test(msg)) return 'definitive';

    // Unknown/network errors: retry rather than burn the post
    return 'transient';
}

/** Build an Error that carries the HTTP status of the IG API response. */
function withIgStatus(message: string, status: number): Error & { igStatus: number } {
    const e = new Error(message) as Error & { igStatus: number };
    e.igStatus = status;
    return e;
}

// ─── Carousel child-id store (index-aware, backward compatible) ─────────────
//
// instagram_child_ids is a JSON array of child container ids. Legacy rows (the
// pre-2026 all-or-nothing code) are a plain positional array of id strings: the
// array index is the child index. New writes use index-aware entries so a
// PARTIAL set (some children created, some failed) keeps its gaps reconcileable
// — child 0 and 2 can exist while child 1 is still missing, and the retry only
// ever creates the missing one. Reads accept both encodings.

/** Parse the stored child-id JSON into an index → id map (throws on bad shape). */
function parseChildIdEntries(raw: string | null | undefined): Map<number, string> {
    const entries = new Map<number, string>();
    if (!raw) return entries;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new MalformedDataError('Malformed instagram_child_ids');
    }
    if (!Array.isArray(parsed)) throw new MalformedDataError('Malformed instagram_child_ids');

    const firstItem = parsed[0];
    const indexAware = firstItem !== null && typeof firstItem === 'object'
        && typeof (firstItem as { index?: unknown }).index === 'number'
        && typeof (firstItem as { id?: unknown }).id === 'string';

    if (indexAware) {
        // { index, id } entries written by the current code (gaps are allowed).
        for (const item of parsed) {
            const entry = item as { index?: unknown; id?: unknown } | null;
            if (!entry || typeof entry !== 'object' || typeof entry.index !== 'number' || typeof entry.id !== 'string') {
                throw new MalformedDataError('Malformed instagram_child_ids');
            }
            entries.set(entry.index, entry.id);
        }
    } else {
        // Legacy positional string array: array index i → child i's id.
        for (let i = 0; i < parsed.length; i++) {
            if (typeof parsed[i] !== 'string') throw new MalformedDataError('Malformed instagram_child_ids');
            entries.set(i, parsed[i] as string);
        }
    }
    return entries;
}

/** Serialize the index → id map as index-aware entries (stable, sorted). */
function serializeChildIdEntries(entries: Map<number, string>): string {
    return JSON.stringify(
        [...entries.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([index, id]) => ({ index, id })),
    );
}

/** Child ids in child-index order (the order the carousel API expects). */
function sortedChildIds(entries: Map<number, string>): string[] {
    return [...entries.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, id]) => id);
}

/** Build the request body for one carousel child container (shared by both phases). */
function buildCarouselChildParams(opts: {
    child: { url: string; type: string };
    idx: number;
    mediaUrlAbsolute: string;
    accessToken: string;
    postUserTags?: string | null;
}): URLSearchParams {
    const params = new URLSearchParams();
    params.set('is_carousel_item', 'true');
    params.set('access_token', opts.accessToken);
    params.set(opts.child.type === 'video' ? 'video_url' : 'image_url', opts.mediaUrlAbsolute);
    if (opts.child.type === 'video') params.append('media_type', 'VIDEO');
    if (opts.idx === 0 && opts.child.type !== 'video' && opts.postUserTags) {
        const usernames = opts.postUserTags.split(',').map((u: string) => u.trim()).filter(Boolean);
        if (usernames.length > 0) {
            const tagsJson = usernames.map((username: string) => ({ username, x: 0.5, y: 0.5 }));
            params.append('user_tags', JSON.stringify(tagsJson));
        }
    }
    return params;
}

/** Fire a failure notification for a post (Telegram/webhook via AppConfig). Never throws. */
async function notifyPostFailed(
    post: { caption?: string | null; channel?: { name?: string | null } | null },
    errMsg: string
): Promise<void> {
    const caption = (post.caption || 'No caption').replace(/\s+/g, ' ').trim().slice(0, 60);
    const channel = post.channel?.name || 'canal desconhecido';
    await sendNotification(`❌ Publicação falhou (${channel}): ${caption} — ${errMsg.slice(0, 200)}`);
}

/** Minimal shape of a Post that flows through retry/throttle helpers. */
interface RetryablePost {
    id: string;
    caption?: string | null;
    attempts?: number;
    created_at?: Date | null;
    channel?: { id?: string; name?: string | null; settings?: string | null } | null;
}

/** Minimal shape of the counters the retry helper updates. */
interface PublishResults {
    errors: number;
    transient: number;
    rate_limited: number;
    throttled: number;
}

/**
 * Record a retryable failure: bump attempts/last_attempt_at and either keep the
 * post in a retryable status or fail it once retries are exhausted
 * (MAX_TRANSIENT_ATTEMPTS attempts or MAX_TRANSIENT_AGE_MS since creation).
 */
async function handleRetryableFailure(opts: {
    post: RetryablePost;
    errMsg: string;
    revertToStatus?: string | null; // null/undefined = keep the current status
    countAs?: 'transient' | 'rate_limited';
    plannerId: string;
    now: Date;
    results: PublishResults;
}): Promise<void> {
    const { post, errMsg, revertToStatus, countAs = 'transient', plannerId, now, results } = opts;
    const attemptNumber = (post.attempts || 0) + 1;
    const tooLong = attemptNumber >= MAX_TRANSIENT_ATTEMPTS || isPostTooOld(post, now);

    const data: Prisma.PostUncheckedUpdateInput = { attempts: { increment: 1 }, last_attempt_at: now };
    if (tooLong) {
        data.status = 'failed';
        data.error_message = errMsg;
        data.failed_reason = 'Transient errors for too long';
    } else if (revertToStatus) {
        data.status = revertToStatus;
    }

    await prisma.post.update({ where: { id: post.id }, data });

    if (tooLong) {
        results.errors++;
        await logPlanner(plannerId, `Post ${post.id} failed after ${attemptNumber} transient attempts: ${errMsg}`, 'error');
        await notifyPostFailed(post, errMsg);
    } else {
        results[countAs]++;
        await logPlanner(plannerId, `Post ${post.id} ${countAs === 'rate_limited' ? 'rate limited (429)' : 'transient error'}: ${errMsg} — retrying later (attempt ${attemptNumber})`, 'error');
    }
}

// ─── Publish throttle (per channel + global) ───────────────────────────────────

/** Global minimum interval between publishes, from AppConfig (seconds → ms). 0 = off. */
async function getGlobalPublishIntervalMs(): Promise<number> {
    try {
        const row = await prisma.appConfig.findUnique({ where: { key: 'PUBLISH_MIN_INTERVAL_SECONDS' } });
        const secs = Number(row?.value || 0);
        return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
    } catch {
        return 0;
    }
}

/** Per-channel interval from Channel.settings.max_posts_per_hour (ms). 0 = off. */
async function getChannelIntervalMs(channel: { settings?: string | null } | null | undefined): Promise<number> {
    const settings = safeJsonParse<{ max_posts_per_hour?: number } | null>(channel?.settings, null);
    const perHour = Number(settings?.max_posts_per_hour);
    if (Number.isFinite(perHour) && perHour > 0) return Math.round(3_600_000 / perHour);
    return 0;
}

/** True when the channel published within the last `minIntervalMs` ms. */
async function isChannelThrottled(channel: { id?: string } | null | undefined, now: Date, minIntervalMs: number): Promise<boolean> {
    if (minIntervalMs <= 0 || !channel?.id) return false;
    const last = await prisma.post.findFirst({
        where: { channel_id: channel.id, status: 'published', published_at: { not: null } },
        orderBy: { published_at: 'desc' },
        select: { published_at: true },
    });
    if (!last?.published_at) return false;
    return now.getTime() - last.published_at.getTime() < minIntervalMs;
}

/** Insert a planner log entry. */
async function logPlanner(plannerId: string, message: string, level: 'info' | 'error' = 'info', details: unknown = {}) {
    if (!plannerId || plannerId === 'unknown') return;
    console.log(`[PlannerLog][${level.toUpperCase()}] ${plannerId}: ${message}`, details);
    try {
        await prisma.plannerLog.create({
            data: {
                planner_id: plannerId,
                message,
                level,
                details: JSON.stringify(details),
            },
        });
    } catch { /* Don't crash on log failures */ }
}

/**
 * Log de rotina com throttle (ex.: 'start_time not reached', 'Sleep schedule
 * active') — evita ~1440 linhas/dia/planner. Loga no máximo 1x a cada TTL.
 */
const lastThrottledLogAt = new Map<string, number>();
const LOG_THROTTLE_MS = 30 * 60 * 1000; // 30 min

async function throttledLog(plannerId: string, message: string, level: 'info' | 'error' = 'info', details: unknown = {}) {
    const key = `${plannerId}:${message}`;
    const last = lastThrottledLogAt.get(key) || 0;
    if (Date.now() - last < LOG_THROTTLE_MS) return;
    lastThrottledLogAt.set(key, Date.now());
    await logPlanner(plannerId, message, level, details);
}

async function refreshDueChannelTokens(now: Date, startTime: number, maxExecMs: number) {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const channels = await prisma.channel.findMany({
        where: {
            platform: 'instagram',
            status: 'active',
            access_token: { not: null },
            NOT: { access_token: { startsWith: 'token_' } },
            OR: [
                { token_refreshed_at: null },
                { token_refreshed_at: { lte: sevenDaysAgo } },
                { token_expires_at: { lte: fourteenDaysFromNow } },
            ],
        },
        take: 10,
    });

    let refreshed = 0;
    for (const channel of channels) {
        // Respect the execution budget even inside the refresh loop
        if (Date.now() - startTime > maxExecMs) break;
        try {
            const tokenData = await refreshInstagramToken(channel.access_token || '');
            await prisma.channel.update({
                where: { id: channel.id },
                data: {
                    access_token: tokenData.token,
                    token_expires_at: new Date(Date.now() + tokenData.expiresIn * 1000),
                    token_refreshed_at: now,
                    token_source: channel.token_source || 'manual',
                },
            });
            refreshed++;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
            if (classifyTokenRefreshError(err) === 'permanent') {
                // Permanent: never retry every tick. A rejected token deactivates
                // the channel (reconnect via OAuth flips status back to 'active');
                // missing server credentials only pause the refresh, the channel
                // itself is fine.
                const missingCredentials = /must be configured to refresh/i.test(message);
                await prisma.channel.update({
                    where: { id: channel.id },
                    // token_expires_at: null on ANY permanent failure — the selection
                    // query ORs `token_expires_at <= now+14d`, so a channel whose token
                    // is within 14 days of expiry would otherwise be re-selected EVERY
                    // tick and spam [ChannelRefresh]. NULL never matches `<=`, and it
                    // means 'no known expiry — needs manual reconnect'; both reconnect
                    // paths (OAuth callback, manual refresh) restore it on success.
                    data: missingCredentials
                        ? { token_refreshed_at: now, token_expires_at: null }
                        : { status: 'inactive', token_refreshed_at: now, token_expires_at: null },
                }).catch(() => { /* best-effort: the log line below is the source of truth */ });
                console.error(
                    `[ChannelRefresh] ${channel.id}: ${message} — ${missingCredentials
                        ? 'server credentials missing; refresh paused (fix INSTAGRAM_CLIENT_ID/SECRET)'
                        : 'access token rejected; channel deactivated (reconnect it)'}`
                );
            } else {
                // Transient (network/5xx/timeout): retry next tick.
                console.error(`[ChannelRefresh] ${channel.id}: ${message}`);
            }
        }
    }
    return refreshed;
}

// ─── Route Handler ────────────────────────────────────────────────────────────

// Simple in-process lock: the Next.js server is a single process, so this
// prevents overlapping runs (worker tick + manual trigger) from double-publishing.
// Limitation: does not protect across multiple replicas (not used in the monolith).
let publisherRunning = false;

export async function GET(request: Request) {
    return handler(request);
}

export async function POST(request: Request) {
    return handler(request);
}

async function handler(request: Request) {
    try {
        // Auth check
        const cronSecret = request.headers.get('x-cron-auth') || new URL(request.url).searchParams.get('secret');
        const expectedSecret = process.env.CRON_SECRET;
        if (!expectedSecret || cronSecret !== expectedSecret) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // In-process lock — reject overlapping runs instead of duplicating work
        if (publisherRunning) {
            return NextResponse.json({ skipped: true, reason: 'Another run is still in progress' });
        }
        publisherRunning = true;

        try {
            const systemBaseUrl = resolveSystemBaseUrl();

            const startTime = Date.now();
            const MAX_EXEC_MS = 45_000; // Leave 10-15s buffer for the 60s worker heartbeat

interface PublisherResults {
    pending: number; processing: number; published: number; errors: number;
    cleaned: number; tokens_refreshed: number;
    planners_processed: number; claimed: number; skipped: number; transient: number;
    rate_limited: number; throttled: number;
    timeout?: boolean;
}

            const results: PublisherResults = {
                pending: 0, processing: 0, published: 0, errors: 0,
                cleaned: 0, tokens_refreshed: 0,
                planners_processed: 0, claimed: 0, skipped: 0, transient: 0, rate_limited: 0, throttled: 0,
            };
            const now = new Date();
            results.tokens_refreshed = await refreshDueChannelTokens(now, startTime, MAX_EXEC_MS);

            // ═══════════════════════════════════════════════════════════════════════
            // PHASE -1: Cleanup — instantly fail posts with no media
            // ═══════════════════════════════════════════════════════════════════════
            const cleanupPosts = await prisma.post.findMany({
                where: { status: 'pending', video_url: null, image_url: null, children_urls: null },
                select: { id: true, caption: true },
            });
            if (cleanupPosts.length > 0) {
                await prisma.post.updateMany({
                    where: { id: { in: cleanupPosts.map(p => p.id) }, status: 'pending' },
                    data: { status: 'failed', error_message: 'No media URL — content item missing', failed_reason: 'Missing Media' },
                });
                results.cleaned = cleanupPosts.length;
                for (const p of cleanupPosts) {
                    await notifyPostFailed({ caption: p.caption, channel: null }, 'No media URL — content item missing');
                }
            }

            // ═══════════════════════════════════════════════════════════════════════
            // PHASE 0: Planner Processing — create Posts from active Planners
            // ═══════════════════════════════════════════════════════════════════════

            const planners = await prisma.planner.findMany({
                where: { status: 'active' },
                include: { channels: true },
            });

            for (const planner of planners) {
                if (Date.now() - startTime > MAX_EXEC_MS) { results.timeout = true; break; }
                try {
                    const outcome = await runPlannerOnce(prisma, planner, now);

                    if (outcome.ok) {
                        results.planners_processed++;
                        results.claimed++;
                        await logPlanner(planner.id, `[Phase0] Created ${outcome.created ?? 0} post(s)`, 'info');
                    } else if (outcome.skipped) {
                        if (outcome.skipped === 'not_due') {
                            // Rotina normal — silêncio total (sem spam)
                        } else if (outcome.skipped === 'start_time' || outcome.skipped === 'sleep') {
                            // Rotina com throttle de 30 min (não ~1440/dia)
                            await throttledLog(planner.id, `[Phase0] ${outcome.error || outcome.skipped}`, 'info');
                        } else if (outcome.skipped === 'already_running') {
                            results.skipped++;
                        } else {
                            // Erros reais: config inválido, sem canais, resolução falhou...
                            await logPlanner(planner.id, `[Phase0] ${outcome.error || outcome.skipped}`, 'error');
                        }
                    } else {
                        await logPlanner(planner.id, `[Phase0] ${outcome.error || 'Planner skipped'}`, 'error');
                    }
                } catch (err: unknown) {
                    const errMsg = err instanceof Error ? err.message : String(err ?? 'Unknown error');
                    const errStack = err instanceof Error ? err.stack : undefined;
                    await logPlanner(planner.id, `[Phase0] Uncaught error: ${errMsg}`, 'error', { stack: errStack });
                }
            }

// PHASE 1: Pending → Processing (create IG media containers)
            // ═══════════════════════════════════════════════════════════════════════

            // Posts with scheduled_at = NULL (manual posts without a date) must be included
            const pendingPosts = await prisma.post.findMany({
                where: {
                    status: 'pending',
                    OR: [{ scheduled_at: { lte: now } }, { scheduled_at: null }],
                },
                include: { channel: true },
                orderBy: { scheduled_at: 'asc' }, // oldest first — avoids starvation
                take: 5,
            });

            // Atomic claim: pending → processing. Only posts we win the claim for are processed.
            if (pendingPosts.length > 0) {
                await prisma.post.updateMany({
                    where: { id: { in: pendingPosts.map(p => p.id) }, status: 'pending' },
                    data: { status: 'processing' },
                });
            }
            const claimedPosts = await prisma.post.findMany({
                where: { id: { in: pendingPosts.map(p => p.id) }, status: 'processing' },
                include: { channel: true },
            });
            results.claimed = claimedPosts.length;

            const globalPublishIntervalMs = await getGlobalPublishIntervalMs();

            for (const post of claimedPosts) {
                if (Date.now() - startTime > MAX_EXEC_MS) { results.timeout = true; break; }
                const plannerId = post.planner_id || 'unknown';
                let lastStatus = 0;
                try {
                    // Pre-flight: abort immediately with no external calls
                    const hasMedia = post.video_url || post.image_url || post.children_urls;
                    if (!hasMedia) {
                        await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: 'No media URL', failed_reason: 'Missing Media' } });
                        results.errors++;
                        await notifyPostFailed(post, 'No media URL');
                        continue;
                    }

                    // Publish throttle: skip (and revert the claim) when the channel published too recently
                    const minIntervalMs = Math.max(globalPublishIntervalMs, await getChannelIntervalMs(post.channel));
                    if (await isChannelThrottled(post.channel, now, minIntervalMs)) {
                        results.throttled++;
                        await prisma.post.updateMany({ where: { id: post.id, status: 'processing' }, data: { status: 'pending' } });
                        continue;
                    }

                    // A previous attempt may have created an IG container already (e.g. the
                    // response was lost after a successful POST). Reuse it instead of creating
                    // a duplicate container.
                    if (post.instagram_container_id) {
                        await prisma.post.update({ where: { id: post.id }, data: { status: 'processing_upload' } });
                        results.pending++;
                        continue;
                    }

                    const accessToken = await resolveAccessToken(post.channel?.access_token || null);
                    const accountId = (post.channel?.account_id || '').trim();
                    if (!accessToken || !accountId) throw new Error('Missing credentials');

                    const baseUrl = getGraphBaseUrl(accessToken);
                    const mediaType = post.media_type || 'REELS';
                    const igHeaders = {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    };

                    // CAROUSEL
                    if (mediaType === 'CAROUSEL') {
                        let childrenData: { url: string; type: string }[] = [];
                        if (post.children_urls) {
                            try {
                                childrenData = JSON.parse(post.children_urls);
                            } catch {
                                throw new MalformedDataError('Malformed children_urls');
                            }
                        }

                        if (childrenData.length === 0) {
                            throw new Error('Carousel has no media items');
                        }

                        // Resume: a previous attempt may already have created some
                        // child containers (partial failure). Only create the ones we
                        // do not have an id for — never duplicate existing children.
                        const existingChildren = parseChildIdEntries(post.instagram_child_ids ?? null);
                        const missingChildren = childrenData
                            .map((child, idx) => ({ child, idx }))
                            .filter(({ idx }) => !existingChildren.has(idx));

                        // Parallelize creation of the missing carousel child containers
                        const childResults = await Promise.all(
                            missingChildren.map(async ({ child, idx }): Promise<{ idx: number; id?: string; error?: string; status?: number }> => {
                                const mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, child.url);
                                const childParams = buildCarouselChildParams({
                                    child,
                                    idx,
                                    mediaUrlAbsolute,
                                    accessToken,
                                    postUserTags: post.user_tags ?? null,
                                });

                                await logPlanner(plannerId, `[Phase1] Sending Carousel Child[${idx}] to IG: type=${child.type}, url=${mediaUrlAbsolute}`, 'info');

                                const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`, {
                                    method: 'POST',
                                    headers: igHeaders,
                                    body: childParams.toString()
                                }, 300_000); // 5 minutes for large videos
                                const data = await res.json();

                                if (data.id) {
                                    return { idx, id: data.id };
                                } else {
                                    const err = `Child[${idx}] failed: ${data.error?.message || JSON.stringify(data)}`;
                                    await logPlanner(plannerId, err, 'error', data);
                                    return { idx, error: err, status: res.status };
                                }
                            }),
                        );

                        // Merge the new successes into any previously-stored ids.
                        // The merged set only ever grows — never re-creates a child.
                        const mergedChildren = new Map(existingChildren);
                        for (const result of childResults) {
                            if (result.id) mergedChildren.set(result.idx, result.id);
                        }
                        const failedChildren = childResults.filter(r => r.error);

                        if (failedChildren.length > 0) {
                            // Partial failure: keep the children that succeeded so the
                            // retry only creates the missing ones (no orphans, no dupes).
                            if (mergedChildren.size > 0) {
                                const worstStatus = Math.max(0, ...failedChildren.map(f => f.status || 0));
                                const errMsg = `Carousel failed: ${failedChildren.length} children failed to initialize (${mergedChildren.size} OK). First error: ${failedChildren[0].error}`;
                                const countAs = worstStatus === 429 ? 'rate_limited' : 'transient';
                                await prisma.post.update({
                                    where: { id: post.id },
                                    data: { instagram_child_ids: serializeChildIdEntries(mergedChildren) },
                                });
                                // Revert the claim; the retry (pending) resumes from the
                                // stored ids and creates only the missing children.
                                await handleRetryableFailure({ post, errMsg, revertToStatus: 'pending', countAs, plannerId, now, results });
                                if (countAs === 'rate_limited') break;
                                continue;
                            }
                            // No child at all succeeded — the whole attempt failed.
                            const worstStatus = Math.max(0, ...failedChildren.map(f => f.status || 0));
                            throw withIgStatus(`Carousel failed: ${failedChildren.length} children failed to initialize. First error: ${failedChildren[0].error}`, worstStatus);
                        }

                        if (mergedChildren.size > 0 && mergedChildren.size === childrenData.length) {
                            await prisma.post.update({
                                where: { id: post.id },
                                data: {
                                    status: 'processing_children',
                                    instagram_child_ids: serializeChildIdEntries(mergedChildren),
                                    container_created_at: now,
                                }
                            });
                            results.pending++;
                        } else {
                            throw new Error('No carousel child containers created (unknown reason)');
                        }
                        continue;
                    }

                    // SINGLE MEDIA
                    const bodyParams = new URLSearchParams({ access_token: accessToken });
                    let mediaUrlAbsolute = '';
                    if (mediaType === 'IMAGE') {
                        mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, post.image_url);
                        bodyParams.append('image_url', mediaUrlAbsolute);
                        bodyParams.append('caption', post.caption || '');
                        if (post.location_id) bodyParams.append('location_id', post.location_id);
                        if (post.user_tags) {
                            const usernames = post.user_tags.split(',').map((u: string) => u.trim()).filter(Boolean);
                            if (usernames.length > 0) {
                                const tagsJson = usernames.map((username: string) => ({
                                    username,
                                    x: 0.5,
                                    y: 0.5
                                }));
                                bodyParams.append('user_tags', JSON.stringify(tagsJson));
                            }
                        }
                    } else {
                        bodyParams.append('media_type', mediaType === 'STORIES' ? 'STORIES' : 'REELS');
                        if (mediaType === 'STORIES' && !post.video_url) {
                            // Image stories must be sent via image_url, not video_url
                            mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, post.image_url);
                            bodyParams.append('image_url', mediaUrlAbsolute);
                        } else {
                            mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, post.video_url || post.image_url);
                            bodyParams.append('video_url', mediaUrlAbsolute);
                        }
                        if (mediaType !== 'STORIES') bodyParams.append('caption', post.caption || '');
                        if (mediaType === 'REELS') {
                            bodyParams.append('share_to_feed', post.share_to_feed === false ? 'false' : 'true');
                            if (post.location_id) bodyParams.append('location_id', post.location_id);
                            if (post.audio_configuration) {
                                const audioConfig = safeJsonParse<{ audio_id?: string; audio_volume?: number; video_volume?: number } | null>(post.audio_configuration, null);
                                if (audioConfig && audioConfig.audio_id) {
                                    bodyParams.append('audio_configuration', JSON.stringify(audioConfig));
                                }
                            }
                        }
                    }

                    if (post.collaborators && mediaType !== 'STORIES') {
                        const list = post.collaborators.split(',').map((c: string) => c.trim()).filter(Boolean);
                        if (list.length > 0) {
                            // IG requires [{"username":"..."}] — not a plain string array
                            bodyParams.append('collaborators', JSON.stringify(list.map((u: string) => ({ username: u }))));
                        }
                    }

                    await logPlanner(plannerId, `[Phase1] Sending to IG: mediaType=${mediaType}, url=${mediaUrlAbsolute}`, 'info');

                    const apiRes = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`, { method: 'POST', headers: igHeaders, body: bodyParams.toString() }, 300_000); // 5 minutes for large videos
                    lastStatus = apiRes.status;
                    const data = await apiRes.json();

                    if (data.id) {
                        await prisma.post.update({ where: { id: post.id }, data: { status: 'processing_upload', instagram_container_id: data.id, container_created_at: now } });
                        results.pending++;
                    } else {
                        await logPlanner(plannerId, `Media creation failed for post ${post.id}`, 'error', data);
                        const err = withIgStatus(data.error?.message || 'Media creation failed', apiRes.status);
                        throw err;
                    }
                } catch (e: unknown) {
                    const kind = classifyError(e, lastStatus);
                    const isAbort = e instanceof Error && e.name === 'AbortError';
                    const errMsg = isAbort ? 'Instagram API timed out (5m)' : (e instanceof Error ? e.message : String(e ?? 'Unknown error'));

                    if (kind === 'rate-limited') {
                        // Revert claim so the post is retried on a later tick, and stop the batch
                        await handleRetryableFailure({ post, errMsg: `Rate limited (429): ${errMsg}`, revertToStatus: 'pending', countAs: 'rate_limited', plannerId, now, results });
                        break;
                    }

                    if (kind === 'transient') {
                        // Revert the claim — the post will be retried on the next tick
                        await handleRetryableFailure({ post, errMsg, revertToStatus: 'pending', plannerId, now, results });
                        continue;
                    }

                    // Definitive error → fail the post
                    await logPlanner(plannerId, `Phase1 Error post=${post.id}: ${errMsg}`, 'error');
                    await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: e instanceof MalformedDataError ? 'Malformed Data' : 'Initialization Failed' } });
                    results.errors++;
                    await notifyPostFailed(post, errMsg);
                }
            }

            // ═══════════════════════════════════════════════════════════════════════
            // PHASE 2: Processing → Ready (check IG container status)
            // ═══════════════════════════════════════════════════════════════════════

            const processingPosts = await prisma.post.findMany({
                where: { status: { in: ['processing_upload', 'processing_children'] } },
                include: { channel: true },
                orderBy: { created_at: 'asc' }, // oldest first — avoids starvation
                take: 10,
            });

            for (const post of processingPosts) {
                if (Date.now() - startTime > MAX_EXEC_MS) { results.timeout = true; break; }
                let lastStatus = 0;
                try {
                    const accessToken = await resolveAccessToken(post.channel?.access_token || null);
                    const baseUrl = getGraphBaseUrl(accessToken);
                    const igHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' };

                    if (post.status === 'processing_children') {
                        // Index-aware child-id store (gaps allowed); legacy positional
                        // string arrays are accepted too. Never re-create a child whose
                        // container id we already hold.
                        const childEntries = parseChildIdEntries(post.instagram_child_ids ?? null);
                        if (childEntries.size === 0) {
                            throw new MalformedDataError('No child container IDs stored');
                        }

                        // Reconcile: create containers for children that have no stored
                        // id yet (a partially-failed carousel can land in this lane with
                        // an incomplete set). Only the missing ones are created.
                        let childrenData: { url: string; type: string }[] = [];
                        if (post.children_urls) {
                            try {
                                childrenData = JSON.parse(post.children_urls);
                            } catch {
                                throw new MalformedDataError('Malformed children_urls');
                            }
                        }
                        const missingChildren = childrenData
                            .map((child, idx) => ({ child, idx }))
                            .filter(({ idx }) => !childEntries.has(idx));
                        if (missingChildren.length > 0) {
                            const created: { idx: number; id: string }[] = [];
                            for (const { child, idx } of missingChildren) {
                                const mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, child.url);
                                const childParams = buildCarouselChildParams({
                                    child,
                                    idx,
                                    mediaUrlAbsolute,
                                    accessToken,
                                    postUserTags: post.user_tags ?? null,
                                });
                                try {
                                    const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media`, {
                                        method: 'POST',
                                        headers: igHeaders,
                                        body: childParams.toString()
                                    }, 300_000); // 5 minutes for large videos
                                    const data = await res.json();
                                    if (data.id) {
                                        created.push({ idx, id: data.id });
                                    } else {
                                        await logPlanner(post.planner_id || 'unknown', `Child reconcile[${idx}] failed: ${data.error?.message || JSON.stringify(data)}`, 'error', data);
                                    }
                                } catch (reconcileErr: unknown) {
                                    await logPlanner(post.planner_id || 'unknown', `Child reconcile[${idx}] error: ${reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)}`, 'error');
                                }
                            }
                            for (const { idx, id } of created) childEntries.set(idx, id);
                            if (created.length > 0) {
                                await prisma.post.update({
                                    where: { id: post.id },
                                    data: { instagram_child_ids: serializeChildIdEntries(childEntries) },
                                });
                            }
                            // Still incomplete (some reconciled children failed): the
                            // carousel cannot be assembled yet — retry on a later tick.
                            const stillMissing = childrenData.some((_, idx) => !childEntries.has(idx));
                            if (stillMissing) {
                                await logPlanner(post.planner_id || 'unknown', `Carousel ${post.id}: ${missingChildren.length} child(ren) missing or failed to initialize — retry later`, 'info');
                                continue;
                            }
                        }

                        const childIds = sortedChildIds(childEntries);
                        // Parallelize child status checks
                        const statusPromises = childIds.map(async (cid) => {
                            const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${cid}?fields=status_code&access_token=${accessToken}`);
                            return { status: res.status, body: await res.json() };
                        });
                        const statusResults = await Promise.all(statusPromises);

                        // Any child still processing → keep waiting. Any child ERROR → fail the post.
                        const errored = statusResults.find(r => r.body?.status_code === 'ERROR');
                        if (errored) {
                            const msg = `IG Processing Error: ${errored.body?.error?.message || JSON.stringify(errored.body)}`;
                            await logPlanner(post.planner_id || 'unknown', msg, 'error', errored.body);
                            await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: msg, failed_reason: 'Processing Failed' } });
                            results.errors++;
                            await notifyPostFailed(post, msg);
                            continue;
                        }

                        const allFinished = statusResults.every(r => r.body?.status_code === 'FINISHED');
                        if (allFinished) {
                            const body = new URLSearchParams({
                                media_type: 'CAROUSEL',
                                children: childIds.join(','),
                                caption: post.caption || '',
                                access_token: accessToken
                            });
                            if (post.location_id) body.append('location_id', post.location_id);
                            if (post.collaborators) {
                                const list = post.collaborators.split(',').map((c: string) => c.trim()).filter(Boolean);
                                if (list.length > 0) {
                                    body.append('collaborators', JSON.stringify(list.map((u: string) => ({ username: u }))));
                                }
                            }
                            const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media`, { method: 'POST', headers: igHeaders, body: body.toString() });
                            lastStatus = res.status;
                            const data = await res.json();
                            if (data.id) {
                                await prisma.post.update({ where: { id: post.id }, data: { status: 'processing_upload', instagram_container_id: data.id, container_created_at: now } });
                            } else {
                                const err = withIgStatus(data.error?.message || 'Carousel container creation failed', res.status);
                                throw err;
                            }
                        }
                    } else {
                        // Single media — check status
                        const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${post.instagram_container_id}?fields=status_code&access_token=${accessToken}`);
                        lastStatus = res.status;
                        const data = await res.json();
                        if (data.status_code === 'FINISHED') {
                            // Delay publishing for 3 minutes from container creation
                            // (container_created_at, set in Phase 1/2). Falls back to created_at
                            // for legacy posts that predate the column.
                            const createdRef = post.container_created_at ?? post.created_at;
                            const timeSinceCreation = Date.now() - (createdRef?.getTime() || 0);
                            if (timeSinceCreation > 3 * 60 * 1000) {
                                await prisma.post.update({ where: { id: post.id }, data: { status: 'ready_to_publish' } });
                            } else {
                                // Leave in processing state temporarily
                                await logPlanner(post.planner_id || 'unknown', `Media ${post.id} is FINISHED but waiting 3 min safety delay.`, 'info');
                            }
                        } else if (data.status_code === 'ERROR') {
                            const msg = `IG Processing Error: ${data.error?.message || JSON.stringify(data)}`;
                            await logPlanner(post.planner_id || 'unknown', msg, 'error', data);
                            await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: msg, failed_reason: 'Processing Failed' } });
                            results.errors++;
                            await notifyPostFailed(post, msg);
                        }
                        // else: still processing — will retry next tick
                    }
                    results.processing++;
                } catch (e: unknown) {
                    const kind = classifyError(e, lastStatus);
                    const isAbort = e instanceof Error && e.name === 'AbortError';
                    const errMsg = isAbort ? 'Instagram API timed out (15s)' : (e instanceof Error ? e.message : String(e ?? 'Unknown error'));

                    if (kind === 'rate-limited') {
                        // Keep processing_* status — retried on the next tick; stop the batch
                        await handleRetryableFailure({ post, errMsg: `Rate limited (429): ${errMsg}`, countAs: 'rate_limited', plannerId: post.planner_id || 'unknown', now, results });
                        break;
                    }

                    if (kind === 'transient') {
                        // Keep the current processing_* status — retried on the next tick
                        await handleRetryableFailure({ post, errMsg, plannerId: post.planner_id || 'unknown', now, results });
                        continue;
                    }

                    // Definitive error → fail the post
                    await logPlanner(post.planner_id || 'unknown', `Phase2 Error post=${post.id}: ${errMsg}`, 'error');
                    await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: e instanceof MalformedDataError ? 'Malformed Data' : 'Processing Exception' } });
                    results.errors++;
                    await notifyPostFailed(post, errMsg);
                }
            }

            // ═══════════════════════════════════════════════════════════════════════
            // PHASE 2.5: Timeout posts stuck in processing for > 2 hours,
            // and revert posts claimed by Phase 1 but stuck in 'processing' for > 15 min
            // (process crash / aborted run) back to pending so they are retried.
            // ═══════════════════════════════════════════════════════════════════════

            const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
            // Dead-letter: prefer last_attempt_at (most accurate proxy for when the cron
            // last touched the post); fall back to created_at for legacy rows.
            await prisma.post.updateMany({
                where: {
                    status: { in: ['processing_upload', 'processing_children'] },
                    OR: [
                        { last_attempt_at: { lte: twoHoursAgo } },
                        { last_attempt_at: null, created_at: { lte: twoHoursAgo } },
                    ],
                },
                data: { status: 'failed', error_message: 'Timed out: still processing after 2 hours', failed_reason: 'Processing Timeout' },
            });

            const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
            await prisma.post.updateMany({
                where: { status: 'processing', created_at: { lte: fifteenMinutesAgo } },
                data: { status: 'pending' },
            });

            // ═══════════════════════════════════════════════════════════════════════
            // PHASE 3: Ready → Published
            // ═══════════════════════════════════════════════════════════════════════

            const readyPosts = await prisma.post.findMany({
                where: { status: 'ready_to_publish' },
                include: { channel: true },
                orderBy: { created_at: 'asc' }, // oldest first — avoids starvation
                take: 5,
            });

            for (const post of readyPosts) {
                if (Date.now() - startTime > MAX_EXEC_MS) { results.timeout = true; break; }
                let lastStatus = 0;
                try {
                    // Publish throttle: skip (keep ready_to_publish) when the channel published too recently
                    const minIntervalMs = Math.max(globalPublishIntervalMs, await getChannelIntervalMs(post.channel));
                    if (await isChannelThrottled(post.channel, now, minIntervalMs)) {
                        results.throttled++;
                        continue;
                    }

                    const accessToken = await resolveAccessToken(post.channel?.access_token || null);
                    const baseUrl = getGraphBaseUrl(accessToken);

                    const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media_publish`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            creation_id: post.instagram_container_id || '',
                            access_token: accessToken
                        }).toString(),
                    });
                    lastStatus = res.status;
                    const data = await res.json();

                    if (data.id) {
                        await prisma.post.update({ where: { id: post.id }, data: { status: 'published', published_at: new Date(), instagram_media_id: data.id } });
                        results.published++;
                    } else {
                        const msg = data.error?.message || 'Publishing Failed';
                        if (msg.toLowerCase().includes('already published')) {
                            await prisma.post.update({ where: { id: post.id }, data: { status: 'published', published_at: new Date() } });
                            results.published++;
                        } else {
                            const err = withIgStatus(msg, res.status);
                            throw err;
                        }
                    }
                } catch (e: unknown) {
                    const kind = classifyError(e, lastStatus);
                    const isAbort = e instanceof Error && e.name === 'AbortError';
                    const errMsg = isAbort ? 'Instagram API timed out (15s)' : (e instanceof Error ? e.message : String(e ?? 'Unknown error'));

                    if (kind === 'rate-limited') {
                        // Keep ready_to_publish — retried on the next tick; stop the batch
                        await handleRetryableFailure({ post, errMsg: `Rate limited (429): ${errMsg}`, countAs: 'rate_limited', plannerId: post.planner_id || 'unknown', now, results });
                        break;
                    }

                    if (kind === 'transient') {
                        // Keep ready_to_publish — retried on the next tick
                        await handleRetryableFailure({ post, errMsg, plannerId: post.planner_id || 'unknown', now, results });
                        continue;
                    }

                    // Definitive error → fail the post
                    await logPlanner(post.planner_id || 'unknown', `Phase3 Error post=${post.id}: ${errMsg}`, 'error', { igStatus: lastStatus });
                    await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: 'Publishing Failed' } });
                    results.errors++;
                    await notifyPostFailed(post, errMsg);
                }
            }

            // Summarize failures — digest notification only for batches with
            // several failures (single post failures already notify individually
            // via notifyPostFailed, avoiding double alerts on the common case).
            if (results.errors > 3) {
                await sendNotification(`⚠️ ${results.errors} publicação(ões) falharam no último ciclo do publisher.`);
            }

            return NextResponse.json(results);
        } finally {
            publisherRunning = false;
        }
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err ?? 'Unknown error');
        return NextResponse.json({ error: errMsg }, { status: 500 });
    }
}
