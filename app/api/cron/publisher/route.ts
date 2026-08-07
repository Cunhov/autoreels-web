import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
    fetchWithTimeout,
    getGraphBaseUrl,
    GRAPH_API_VERSION,
    refreshInstagramToken,
    resolveAccessToken,
} from '@/lib/instagram';
import { describeChannelHealth, resolvePlannerRuntime } from '@/lib/planner-runtime';

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

/** Posts older than this window that keep hitting transient errors are failed instead of retried forever. */
const MAX_TRANSIENT_AGE_MS = 24 * 60 * 60 * 1000;

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

/** Wall-clock "HH:MM" in a given IANA timezone, without fragile string re-parsing. */
function getTimeInTimeZone(date: Date, tz: string): { hh: string; mm: string } {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const hh = (parts.find(p => p.type === 'hour')?.value || '00').padStart(2, '0');
    const mm = (parts.find(p => p.type === 'minute')?.value || '00').padStart(2, '0');
    return { hh, mm };
}

/** Insert a planner log entry. */
async function logPlanner(plannerId: string, message: string, level: 'info' | 'error' = 'info', details: any = {}) {
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
            console.error(`[ChannelRefresh] ${channel.id}:`, err instanceof Error ? err.message : err);
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

            const results: any = {
                pending: 0, processing: 0, published: 0, errors: 0,
                cleaned: 0, tokens_refreshed: 0,
                planners_processed: 0, claimed: 0, skipped: 0, transient: 0, rate_limited: 0,
            };
            const now = new Date();
            results.tokens_refreshed = await refreshDueChannelTokens(now, startTime, MAX_EXEC_MS);

            // ═══════════════════════════════════════════════════════════════════════
            // PHASE -1: Cleanup — instantly fail posts with no media
            // ═══════════════════════════════════════════════════════════════════════
            const cleanup = await prisma.post.updateMany({
                where: { status: 'pending', video_url: null, image_url: null, children_urls: null },
                data: { status: 'failed', error_message: 'No media URL — content item missing', failed_reason: 'Missing Media' },
            });
            results.cleaned = cleanup.count;

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
                    let rawConfig = planner.config || '{}';
                    let config: any;
                    try {
                        const first = JSON.parse(rawConfig);
                        config = typeof first === 'string' ? JSON.parse(first) : first;
                    } catch (e: any) {
                        await logPlanner(planner.id, `[Phase0] Config parse error: ${e.message}`, 'error', { raw: rawConfig.slice(0, 200) });
                        continue;
                    }

                    const lastRun = planner.last_run ? new Date(planner.last_run) : null;

                    // Calculate interval
                    const freqVal = config.frequency?.value || 10;
                    const freqUnit = config.frequency?.unit || 'minutes';
                    let intervalMs = freqVal * 60 * 1000;
                    if (freqUnit === 'hours') intervalMs = freqVal * 60 * 60 * 1000;
                    else if (freqUnit === 'days') intervalMs = freqVal * 24 * 60 * 60 * 1000;
                    else if (freqUnit === 'weeks') intervalMs = freqVal * 7 * 24 * 60 * 60 * 1000;

                    const isDue = !lastRun || (now.getTime() >= lastRun.getTime() + intervalMs - 15000);
                    if (!isDue) continue;

                    if (config.start_time && now < new Date(config.start_time)) {
                        await logPlanner(planner.id, `[Phase0] start_time not reached`, 'info');
                        continue;
                    }

                    if (config.sleep_schedule) {
                        const tz = config.timezone || 'America/Sao_Paulo';
                        const { hh, mm } = getTimeInTimeZone(now, tz);
                        const hhmm = `${hh}:${mm}`;
                        const sleepStart = config.sleep_schedule.start || '00:00';
                        const sleepEnd = config.sleep_schedule.end || '06:00';
                        const isSleeping = sleepStart <= sleepEnd
                            ? (hhmm >= sleepStart && hhmm < sleepEnd)
                            : (hhmm >= sleepStart || hhmm < sleepEnd);
                        if (isSleeping) {
                            await logPlanner(planner.id, `[Phase0] Sleep schedule active`, 'info');
                            continue;
                        }
                    }

                    if (!planner.channels || planner.channels.length === 0) {
                        await logPlanner(planner.id, `[Phase0] No channels connected`, 'error');
                        continue;
                    }

                    // Atomic claim on last_run: only one overlapping run may process this planner.
                    // (updateMany with the previously-read last_run; count===1 means we won the claim.)
                    const claim = await prisma.planner.updateMany({
                        where: { id: planner.id, last_run: planner.last_run },
                        data: { last_run: now },
                    });
                    if (claim.count !== 1) {
                        results.skipped++;
                        continue;
                    }

                    const runtime = await resolvePlannerRuntime(prisma, planner, now);
                    if (!runtime.ok) {
                        await logPlanner(planner.id, `[Phase0] Planner preview blocked: ${runtime.errors.join('; ')}`, 'error', runtime);
                        continue;
                    }

                    const publishableChannels = (planner.channels || []).filter((channel: any) => describeChannelHealth(channel, now).ok);
                    const blockedChannels = (planner.channels || []).filter((channel: any) => !describeChannelHealth(channel, now).ok);
                    if (blockedChannels.length > 0) {
                        await logPlanner(planner.id, `[Phase0] ${blockedChannels.length} channel(s) blocked`, 'info', {
                            blocked: blockedChannels.map((channel: any) => channel.id),
                        });
                    }
                    if (publishableChannels.length === 0) {
                        await logPlanner(planner.id, `[Phase0] No publishable channels available`, 'error');
                        continue;
                    }

                    const { selectedIndex, selectedContent, mediaUrl, mediaType, caption, locationId, shareToFeed, thumbnailUrl, children, collaborators, audioConfiguration, userTags, nextState, warnings } = runtime;
                    const safeChildren = children || [];
                    for (const warning of warnings) {
                        await logPlanner(planner.id, `[Phase0] ${warning}`, 'info');
                    }

                    await logPlanner(planner.id, `[Phase0] Selected content[${selectedIndex}]: type=${selectedContent?.type}, id=${selectedContent?.id}, url=${mediaUrl || selectedContent?.url}`, 'info');

                    const isVideoStory = mediaType === 'STORIES' && !!mediaUrl && mediaUrl.includes('.mp4');
                    let postsCreated = 0;
                    for (const channel of publishableChannels) {
                        await prisma.post.create({
                            data: {
                                user_id: planner.user_id,
                                channel_id: channel.id,
                                status: 'pending',
                                media_type: mediaType,
                                // STORIES with an .mp4 URL must be stored in video_url (Phase 1 sends video_url for it)
                                video_url: (mediaType === 'REELS' || isVideoStory) ? mediaUrl : null,
                                image_url: (mediaType === 'IMAGE') ? mediaUrl
                                    : (mediaType === 'STORIES' && mediaUrl && !mediaUrl.includes('.mp4')) ? mediaUrl
                                    : (mediaType === 'CAROUSEL' && safeChildren.length > 0) ? safeChildren[0].url // Set first child as thumbnail
                                    : null,
                                thumbnail_url: thumbnailUrl || (safeChildren.length > 0 ? safeChildren[0].url : null),
                                children_urls: safeChildren.length > 0 ? JSON.stringify(safeChildren) : null,
                                share_to_feed: shareToFeed,
                                location_id: locationId,
                                collaborators: collaborators,
                                audio_configuration: audioConfiguration ? JSON.stringify(audioConfiguration) : null,
                                user_tags: userTags,
                                caption,
                                scheduled_at: now,
                                planner_id: planner.id,
                            },
                        });
                        postsCreated++;
                    }

                    await logPlanner(planner.id, `[Phase0] Created ${postsCreated} post(s) for mediaType=${mediaType}`, 'info');
                    // last_run was already claimed above — only persist the state/config here
                    await prisma.planner.update({
                        where: { id: planner.id },
                        data: { config: JSON.stringify({ ...config, state: nextState }) },
                    });
                    results.planners_processed++;
                } catch (err: any) {
                    await logPlanner(planner.id, `[Phase0] Uncaught error: ${err.message}`, 'error', { stack: err.stack });
                }
            }

            // ═══════════════════════════════════════════════════════════════════════
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

                        // Parallelize carousel child creation
                        const childPromises = childrenData.map(async (child, idx) => {
                            const mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, child.url);
                            const childParams = new URLSearchParams({
                                is_carousel_item: 'true',
                                access_token: accessToken,
                                [child.type === 'video' ? 'video_url' : 'image_url']: mediaUrlAbsolute
                            });
                            if (child.type === 'video') childParams.append('media_type', 'VIDEO');
                            if (idx === 0 && child.type !== 'video' && post.user_tags) {
                                const usernames = post.user_tags.split(',').map((u: string) => u.trim()).filter(Boolean);
                                if (usernames.length > 0) {
                                    const tagsJson = usernames.map((username: string) => ({
                                        username,
                                        x: 0.5,
                                        y: 0.5
                                    }));
                                    childParams.append('user_tags', JSON.stringify(tagsJson));
                                }
                            }

                            await logPlanner(plannerId, `[Phase1] Sending Carousel Child[${idx}] to IG: type=${child.type}, url=${mediaUrlAbsolute}`, 'info');

                            const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`, {
                                method: 'POST',
                                headers: igHeaders,
                                body: childParams.toString()
                            }, 300_000); // 5 minutes for large videos
                            const data = await res.json();

                            if (data.id) {
                                return { id: data.id };
                            } else {
                                const err = `Child[${idx}] failed: ${data.error?.message || JSON.stringify(data)}`;
                                await logPlanner(plannerId, err, 'error', data);
                                return { error: err, status: res.status };
                            }
                        });

                        const childResults = await Promise.all(childPromises);
                        const failedChildren = childResults.filter(r => r.error);

                        if (failedChildren.length > 0) {
                            const worstStatus = Math.max(0, ...failedChildren.map(f => f.status || 0));
                            const err = withIgStatus(`Carousel failed: ${failedChildren.length} children failed to initialize. First error: ${failedChildren[0].error}`, worstStatus);
                            throw err;
                        }

                        const successfulIds = childResults.map(r => r.id!).filter(Boolean);
                        if (successfulIds.length > 0) {
                            await prisma.post.update({
                                where: { id: post.id },
                                data: {
                                    status: 'processing_children',
                                    instagram_child_ids: JSON.stringify(successfulIds)
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
                        await prisma.post.update({ where: { id: post.id }, data: { status: 'processing_upload', instagram_container_id: data.id } });
                        results.pending++;
                    } else {
                        await logPlanner(plannerId, `Media creation failed for post ${post.id}`, 'error', data);
                        const err = withIgStatus(data.error?.message || 'Media creation failed', apiRes.status);
                        throw err;
                    }
                } catch (e: any) {
                    const kind = classifyError(e, lastStatus);
                    const isAbort = e.name === 'AbortError';
                    const errMsg = isAbort ? 'Instagram API timed out (5m)' : e.message;

                    if (kind === 'rate-limited') {
                        results.rate_limited++;
                        // Revert claim so the post is retried on a later tick, and stop the batch
                        await prisma.post.updateMany({ where: { id: post.id, status: 'processing' }, data: { status: 'pending' } });
                        await logPlanner(plannerId, `[Phase1] Rate limited (429) for post ${post.id} — retrying later`, 'error');
                        break;
                    }

                    if (kind === 'transient') {
                        if (isPostTooOld(post, now)) {
                            await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: 'Transient errors for too long' } });
                            results.errors++;
                        } else {
                            // Revert the claim — the post will be retried on the next tick
                            await prisma.post.updateMany({ where: { id: post.id, status: 'processing' }, data: { status: 'pending' } });
                            await logPlanner(plannerId, `[Phase1] Transient error post=${post.id}: ${errMsg} — retrying later`, 'error');
                            results.transient++;
                        }
                        continue;
                    }

                    // Definitive error → fail the post
                    await logPlanner(plannerId, `Phase1 Error post=${post.id}: ${errMsg}`, 'error');
                    await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: e instanceof MalformedDataError ? 'Malformed Data' : 'Initialization Failed' } });
                    results.errors++;
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
                        let childIds: string[] = [];
                        if (post.instagram_child_ids) {
                            try {
                                childIds = JSON.parse(post.instagram_child_ids);
                            } catch {
                                throw new MalformedDataError('Malformed instagram_child_ids');
                            }
                        }
                        if (childIds.length === 0) {
                            throw new MalformedDataError('No child container IDs stored');
                        }

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
                                await prisma.post.update({ where: { id: post.id }, data: { status: 'processing_upload', instagram_container_id: data.id } });
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
                            // Delay publishing for 3 minutes from creation. We don't have a
                            // `container_created_at` column, so scheduled_at is the closest
                            // safe baseline (Phase 0/1 set scheduled_at ≈ creation request time).
                            // Limitation: for manual posts that were scheduled far in the past,
                            // the delay is skipped — acceptable, the container is already finished.
                            const timeSinceScheduled = Date.now() - (post.scheduled_at?.getTime() || 0);
                            if (timeSinceScheduled > 3 * 60 * 1000) {
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
                        }
                        // else: still processing — will retry next tick
                    }
                    results.processing++;
                } catch (e: any) {
                    const kind = classifyError(e, lastStatus);
                    const isAbort = e.name === 'AbortError';
                    const errMsg = isAbort ? 'Instagram API timed out (15s)' : e.message;

                    if (kind === 'rate-limited') {
                        results.rate_limited++;
                        await logPlanner(post.planner_id || 'unknown', `[Phase2] Rate limited (429) for post ${post.id} — retrying later`, 'error');
                        break;
                    }

                    if (kind === 'transient') {
                        if (isPostTooOld(post, now)) {
                            await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: 'Transient errors for too long' } });
                            results.errors++;
                        } else {
                            // Keep the current processing_* status — retried on the next tick
                            await logPlanner(post.planner_id || 'unknown', `Phase2 Transient post=${post.id}: ${errMsg} — retrying later`, 'error');
                            results.transient++;
                        }
                        continue;
                    }

                    // Definitive error → fail the post
                    await logPlanner(post.planner_id || 'unknown', `Phase2 Error post=${post.id}: ${errMsg}`, 'error');
                    await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: e instanceof MalformedDataError ? 'Malformed Data' : 'Processing Exception' } });
                    results.errors++;
                }
            }

            // ═══════════════════════════════════════════════════════════════════════
            // PHASE 2.5: Timeout posts stuck in processing for > 2 hours,
            // and revert posts claimed by Phase 1 but stuck in 'processing' for > 15 min
            // (process crash / aborted run) back to pending so they are retried.
            // ═══════════════════════════════════════════════════════════════════════

            const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
            await prisma.post.updateMany({
                where: { status: { in: ['processing_upload', 'processing_children'] }, created_at: { lte: twoHoursAgo } },
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
                } catch (e: any) {
                    const kind = classifyError(e, lastStatus);
                    const isAbort = e.name === 'AbortError';
                    const errMsg = isAbort ? 'Instagram API timed out (15s)' : e.message;

                    if (kind === 'rate-limited') {
                        results.rate_limited++;
                        await logPlanner(post.planner_id || 'unknown', `[Phase3] Rate limited (429) for post ${post.id} — retrying later`, 'error');
                        break;
                    }

                    if (kind === 'transient') {
                        if (isPostTooOld(post, now)) {
                            await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: 'Transient errors for too long' } });
                            results.errors++;
                        } else {
                            // Keep ready_to_publish — retried on the next tick
                            await logPlanner(post.planner_id || 'unknown', `Phase3 Transient post=${post.id}: ${errMsg} — retrying later`, 'error');
                            results.transient++;
                        }
                        continue;
                    }

                    // Definitive error → fail the post
                    await logPlanner(post.planner_id || 'unknown', `Phase3 Error post=${post.id}: ${errMsg}`, 'error', { igStatus: lastStatus });
                    await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: 'Publishing Failed' } });
                    results.errors++;
                }
            }

            return NextResponse.json(results);
        } finally {
            publisherRunning = false;
        }
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
