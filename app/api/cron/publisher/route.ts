import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GRAPH_API_VERSION = 'v22.0';

/** All external HTTP calls go through this — aborts after 15 s by default, but allows overrides (e.g., 5 mins for large uploads). */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function cleanToken(token: string): string {
    return (token || '').trim().replace(/^["']|["']$/g, '').trim();
}

function getBaseUrl(token: string) {
    const cleaned = cleanToken(token);
    return cleaned.startsWith('IG') ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
}

function makeAbsoluteUrl(baseOut: string, path: string | null | undefined): string {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${baseOut}${cleanPath}`;
}

/** Resolve access token — supports Redis `token_` prefix if Redis is configured. */
async function resolveAccessToken(tokenOrKey: string | null): Promise<string> {
    if (!tokenOrKey) return '';

    // Trim early to catch " token_..." cases
    const input = tokenOrKey.trim().replace(/^["']|["']$/g, '').trim();
    let resolvedToken = input;

    if (input.startsWith('token_')) {
        try {
            let redisUrl = process.env.REDIS_URL || '';
            let redisToken = process.env.REDIS_TOKEN || '';

            if (redisUrl && redisUrl.startsWith('rediss://')) {
                const match = redisUrl.match(/rediss:\/\/[^:]+:([^@]+)@([^:]+)/);
                if (match) { redisToken = match[1]; redisUrl = `https://${match[2]}`; }
            }

            if (redisUrl) {
                const { Redis } = await import('@upstash/redis');
                const redis = new Redis({ url: redisUrl, token: redisToken });

                let val: string | null = null;
                try { val = await redis.get<string>(input); } catch (e: any) { console.error(`[Redis] Get failed for ${input}:`, e.message); }

                if (!val) {
                    try { const lv = await redis.lindex(input, 0); if (lv) val = lv as string; } catch { /* ignore */ }
                }

                if (val) {
                    resolvedToken = val;
                } else {
                    const msg = `Token key ${input} yielded no value in Redis`;
                    console.error(`[resolveAccessToken] ${msg}`);
                    throw new Error(`${msg}. Please re-connect the channel.`);
                }
            } else {
                const msg = `Redis URL missing, cannot resolve ${input}`;
                console.error(`[resolveAccessToken] ${msg}`);
                throw new Error(msg);
            }
        } catch (e: any) {
            console.error(`[resolveAccessToken] Exception resolving ${input}:`, e.message);
            throw e;
        }
    }

    return cleanToken(resolvedToken);
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

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(request: Request) {
    return handler(request);
}

export async function POST(request: Request) {
    return handler(request);
}

async function handler(request: Request) {
    try {
        const reqUrl = new URL(request.url);
        const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || reqUrl.host;
        const proto = request.headers.get('x-forwarded-proto') || (reqUrl.protocol === 'https:' ? 'https' : 'http');
        const origin = `${proto}://${host}`;
        const envUrl = (process.env.NEXTAUTH_URL || '').replace(/\/$/, '');
        const systemBaseUrl = (envUrl && !envUrl.includes('localhost') ? envUrl : origin).replace(/\/$/, '');

        // Auth check
        const cronSecret = request.headers.get('x-cron-auth') || new URL(request.url).searchParams.get('secret');
        const expectedSecret = process.env.CRON_SECRET;
        if (!expectedSecret || cronSecret !== expectedSecret) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const startTime = Date.now();
        const MAX_EXEC_MS = 45_000; // Leave 10-15s buffer for the 60s worker heartbeat

        const results: any = { pending: 0, processing: 0, published: 0, errors: 0, cleaned: 0 };
        const now = new Date();

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
            where: { status: { not: 'paused' } },
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
                if (!isDue) {
                    const secLeft = Math.ceil((lastRun!.getTime() + intervalMs - now.getTime()) / 1000);
                    // Avoid logging too frequently on not due to save db writes
                    continue;
                }

                if (config.start_time && now < new Date(config.start_time)) {
                    await logPlanner(planner.id, `[Phase0] start_time not reached`, 'info');
                    continue;
                }

                if (config.sleep_schedule) {
                    const tz = config.timezone || 'America/Sao_Paulo';
                    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
                    const hhmm = `${String(nowInTz.getHours()).padStart(2, '0')}:${String(nowInTz.getMinutes()).padStart(2, '0')}`;
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

                const contentList = config.content || [];
                if (contentList.length === 0) {
                    await logPlanner(planner.id, `[Phase0] No content configured`, 'error');
                    continue;
                }

                if (!planner.channels || planner.channels.length === 0) {
                    await logPlanner(planner.id, `[Phase0] No channels connected`, 'error');
                    continue;
                }

                // Select content
                let selectedIndex = -1;
                const sortOrder = config.sort_order || 'random_loop';
                const state = config.state || {};

                if (sortOrder === 'random_loop') {
                    const published = state.published_indexes || [];
                    const available = contentList.map((_: any, i: number) => i).filter((i: number) => !published.includes(i));
                    if (available.length === 0) {
                        selectedIndex = Math.floor(Math.random() * contentList.length);
                        state.published_indexes = [selectedIndex];
                    } else {
                        selectedIndex = available[Math.floor(Math.random() * available.length)];
                        state.published_indexes = [...published, selectedIndex];
                    }
                } else if (sortOrder === 'new_to_old') {
                    const last = state.last_index !== undefined ? state.last_index : contentList.length;
                    selectedIndex = last - 1 < 0 ? contentList.length - 1 : last - 1;
                    state.last_index = selectedIndex;
                } else {
                    const last = state.last_index !== undefined ? state.last_index : -1;
                    selectedIndex = (last + 1) % contentList.length;
                    state.last_index = selectedIndex;
                }

                const selectedContent = contentList[selectedIndex];
                if (!selectedContent) {
                    await logPlanner(planner.id, `[Phase0] selectedContent is null at index ${selectedIndex}`, 'error');
                    continue;
                }

                await logPlanner(planner.id, `[Phase0] Selected content[${selectedIndex}]: type=${selectedContent.type}, id=${selectedContent.id}, url=${selectedContent.url}`, 'info');

                let mediaUrl = selectedContent.url;
                let mediaType = selectedContent.media_type || 'REELS';
                let caption = selectedContent.caption || '';
                let children: { url: string; type: string }[] = selectedContent.children_urls || selectedContent.carousel_items || [];

                // SUPPORT LEGACY { type: 'config' } and new { type: 'library_item' }
                if (selectedContent.type === 'library_item' || (selectedContent.type === 'config' && selectedContent.id) || (!selectedContent.type && selectedContent.id)) {
                    const libItem = await prisma.contentItem.findUnique({ where: { id: selectedContent.id } });
                    if (libItem) {
                        mediaUrl = libItem.url;
                        mediaType = libItem.type === 'video' ? 'REELS'
                            : libItem.type === 'image' ? 'IMAGE'
                                : libItem.type === 'carousel_folder' ? 'CAROUSEL' : mediaType;

                        if (libItem.type === 'carousel_folder') {
                            const subItems = await prisma.contentItem.findMany({
                                where: { parent_id: libItem.id },
                                orderBy: { created_at: 'asc' },
                            });
                            children = subItems.map((c: any) => {
                                const urlStr = c.url || '';
                                const isVideo = c.type === 'video' || (urlStr && /\.(mp4|mov)(\?.*)?$/i.test(urlStr));
                                return {
                                    url: urlStr,
                                    type: isVideo ? 'video' : 'image'
                                };
                            }).slice(0, 10);
                            await logPlanner(planner.id, `[Phase0] Carousel folder: ${children.length} children (limited to max 10)`, 'info');
                        }

                        let itemTitle = libItem.title || selectedContent.title_fallback || '';
                        let itemCaption = libItem.caption || selectedContent.caption_fallback || '';

                        caption = (caption || '')
                            .replace(/{post_title}/g, itemTitle)
                            .replace(/{post_caption}/g, itemCaption);

                        await logPlanner(planner.id, `[Phase0] Item matched: type=${libItem.type}, title=${itemTitle}`, 'info');
                    } else {
                        await logPlanner(planner.id, `[Phase0] Item ID not found: ${selectedContent.id}`, 'error');
                        // Do not abort, use existing config data as fallback
                    }
                }

                // Final safety checks before post creation
                if (mediaType === 'CAROUSEL') {
                    if (children.length === 0) {
                        await logPlanner(planner.id, `[Phase0] Carousel item at index ${selectedIndex} has no children — skipping`, 'error');
                        await prisma.planner.update({ where: { id: planner.id }, data: { last_run: now, config: JSON.stringify({ ...config, state }) } });
                        continue;
                    }
                    if (children.length > 10) {
                        await logPlanner(planner.id, `[Phase0] Carousel has ${children.length} items, limiting to 10 (Instagram API limit)`, 'info');
                        children = children.slice(0, 10);
                    }
                }

                if (!mediaUrl && children.length === 0) {
                    await logPlanner(planner.id, `[Phase0] Media missing for content[${selectedIndex}] — skipping`, 'error');
                    await prisma.planner.update({ where: { id: planner.id }, data: { last_run: now, config: JSON.stringify({ ...config, state }) } });
                    continue;
                }

                let postsCreated = 0;
                for (const channel of planner.channels) {
                    await prisma.post.create({
                        data: {
                            user_id: planner.user_id,
                            channel_id: channel.id,
                            status: 'pending',
                            media_type: mediaType,
                            video_url: (mediaType === 'REELS' || mediaType === 'VIDEO') ? mediaUrl : null,
                            image_url: (mediaType === 'IMAGE') ? mediaUrl
                                : (mediaType === 'STORIES' && mediaUrl && !mediaUrl.includes('.mp4')) ? mediaUrl
                                    : (mediaType === 'CAROUSEL' && children.length > 0) ? children[0].url // Set first child as thumbnail
                                        : null,
                            children_urls: children.length > 0 ? JSON.stringify(children) : JSON.stringify({ share_to_feed: selectedContent.share_to_feed !== false }),
                            caption,
                            scheduled_at: now,
                            planner_id: planner.id,
                        },
                    });
                    postsCreated++;
                }

                await logPlanner(planner.id, `[Phase0] Created ${postsCreated} post(s) for mediaType=${mediaType}`, 'info');
                await prisma.planner.update({
                    where: { id: planner.id },
                    data: { last_run: now, config: JSON.stringify({ ...config, state }) },
                });
            } catch (err: any) {
                await logPlanner(planner.id, `[Phase0] Uncaught error: ${err.message}`, 'error', { stack: err.stack });
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 1: Pending → Processing (create IG media containers)
        // ═══════════════════════════════════════════════════════════════════════

        const pendingPosts = await prisma.post.findMany({
            where: { status: 'pending', scheduled_at: { lte: now } },
            include: { channel: true },
            take: 5,
        });

        for (const post of pendingPosts) {
            if (Date.now() - startTime > MAX_EXEC_MS) { results.timeout = true; break; }
            const plannerId = post.planner_id || 'unknown';
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

                const baseUrl = getBaseUrl(accessToken);
                const mediaType = post.media_type || 'REELS';
                const igHeaders = {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                };

                // CAROUSEL
                if (mediaType === 'CAROUSEL') {
                    const childIds: string[] = [];
                    const childrenData: { url: string; type: string }[] = post.children_urls ? JSON.parse(post.children_urls) : [];

                    if (childrenData.length === 0) {
                        throw new Error('Carousel has no media items');
                    }

                    // Parallelize carousel child creation
                    const childPromises = childrenData.map(async (child, idx) => {
                        const childParams = new URLSearchParams({
                            is_carousel_item: 'true',
                            access_token: accessToken,
                            [child.type === 'video' ? 'video_url' : 'image_url']: makeAbsoluteUrl(systemBaseUrl, child.url)
                        });
                        if (child.type === 'video') childParams.append('media_type', 'VIDEO');

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
                            return { error: err };
                        }
                    });

                    const childResults = await Promise.all(childPromises);
                    const errors = childResults.filter(r => r.error);

                    if (errors.length > 0) {
                        throw new Error(`Carousel failed: ${errors.length} children failed to initialize. First error: ${errors[0].error}`);
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
                if (mediaType === 'IMAGE') {
                    bodyParams.append('image_url', makeAbsoluteUrl(systemBaseUrl, post.image_url));
                    bodyParams.append('caption', post.caption || '');
                } else {
                    bodyParams.append('media_type', mediaType === 'STORIES' ? 'STORIES' : 'REELS');
                    bodyParams.append('video_url', makeAbsoluteUrl(systemBaseUrl, post.video_url || post.image_url));
                    bodyParams.append('caption', post.caption || '');
                    if (mediaType === 'REELS') {
                        let shareToFeed = 'true';
                        if (post.children_urls && post.children_urls.startsWith('{')) {
                            try {
                                const parsed = JSON.parse(post.children_urls);
                                if (parsed.share_to_feed === false) shareToFeed = 'false';
                            } catch (e) { }
                        }
                        bodyParams.append('share_to_feed', shareToFeed);
                    }
                }

                const apiRes = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`, { method: 'POST', headers: igHeaders, body: bodyParams.toString() }, 300_000); // 5 minutes for large videos
                const data = await apiRes.json();

                if (data.id) {
                    await prisma.post.update({ where: { id: post.id }, data: { status: 'processing_upload', instagram_container_id: data.id } });
                    results.pending++;
                } else {
                    await logPlanner(plannerId, `Media creation failed for post ${post.id}`, 'error', data);
                    throw new Error(data.error?.message || 'Media creation failed');
                }
            } catch (e: any) {
                const isAbort = e.name === 'AbortError';
                const errMsg = isAbort ? 'Instagram API timed out (5m)' : e.message;
                await logPlanner(plannerId, `Phase1 Error post=${post.id}: ${errMsg}`, 'error');
                await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: isAbort ? 'API Timeout (Video too large or slow)' : 'Initialization Failed' } });
                results.errors++;
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 2: Processing → Ready (check IG container status)
        // ═══════════════════════════════════════════════════════════════════════

        const processingPosts = await prisma.post.findMany({
            where: { status: { in: ['processing_upload', 'processing_children'] } },
            include: { channel: true },
            take: 10,
        });

        for (const post of processingPosts) {
            if (Date.now() - startTime > MAX_EXEC_MS) { results.timeout = true; break; }
            try {
                const accessToken = await resolveAccessToken(post.channel?.access_token || null);
                const baseUrl = getBaseUrl(accessToken);
                const igHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' };

                if (post.status === 'processing_children') {
                    const childIds: string[] = post.instagram_child_ids ? JSON.parse(post.instagram_child_ids) : [];

                    // Parallelize child status checks
                    const statusPromises = childIds.map(async (cid) => {
                        const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${cid}?fields=status_code&access_token=${accessToken}`);
                        return await res.json();
                    });
                    const statusResults = await Promise.all(statusPromises);
                    const allFinished = statusResults.every(data => data.status_code === 'FINISHED');

                    if (allFinished) {
                        const body = new URLSearchParams({
                            media_type: 'CAROUSEL',
                            children: childIds.join(','),
                            caption: post.caption || '',
                            access_token: accessToken
                        });
                        const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media`, { method: 'POST', headers: igHeaders, body: body.toString() });
                        const data = await res.json();
                        if (data.id) {
                            await prisma.post.update({ where: { id: post.id }, data: { status: 'processing_upload', instagram_container_id: data.id } });
                        } else {
                            throw new Error(data.error?.message || 'Carousel container creation failed');
                        }
                    }
                } else {
                    const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${post.instagram_container_id}?fields=status_code&access_token=${accessToken}`);
                    const data = await res.json();
                    if (data.status_code === 'FINISHED') {
                        // Delay publishing for 3 minutes from creation (using scheduled_at as safe baseline, or updated_at. We'll extract creation time if available, otherwise just use a hardcoded 3min check since Phase 1 completion)
                        // Actually, Phase 1 sets status to `processing_upload`. We don't have a `container_created_at` field, but we can check if 3 minutes have passed since the Cron started processing it.
                        // To be safe and avoid schema changes, we check if `Date.now() - post.scheduled_at.getTime() > 3 * 60 * 1000`. If they scheduled it immediately, `scheduled_at` perfectly represents creation request time.
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
                    }
                    // else: still processing — will retry next tick
                }
                results.processing++;
            } catch (e: any) {
                const isAbort = e.name === 'AbortError';
                const errMsg = isAbort ? 'Instagram API timed out (15s)' : e.message;
                await logPlanner(post.planner_id || 'unknown', `Phase2 Error post=${post.id}: ${errMsg}`, 'error');
                await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: isAbort ? 'API Timeout' : 'Processing Exception' } });
                results.errors++;
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 2.5: Timeout posts stuck in processing for > 2 hours
        // ═══════════════════════════════════════════════════════════════════════

        const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
        await prisma.post.updateMany({
            where: { status: { in: ['processing_upload', 'processing_children'] }, created_at: { lte: twoHoursAgo } },
            data: { status: 'failed', error_message: 'Timed out: still processing after 2 hours', failed_reason: 'Processing Timeout' },
        });

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 3: Ready → Published
        // ═══════════════════════════════════════════════════════════════════════

        const readyPosts = await prisma.post.findMany({
            where: { status: 'ready_to_publish' },
            include: { channel: true },
            take: 5,
        });

        for (const post of readyPosts) {
            if (Date.now() - startTime > MAX_EXEC_MS) { results.timeout = true; break; }
            try {
                const accessToken = await resolveAccessToken(post.channel?.access_token || null);
                const baseUrl = getBaseUrl(accessToken);

                const res = await fetchWithTimeout(`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media_publish`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        creation_id: post.instagram_container_id || '',
                        access_token: accessToken
                    }).toString(),
                });
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
                        await logPlanner(post.planner_id || 'unknown', `Phase3 Error post=${post.id}: ${msg}`, 'error', data);
                        await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: msg, failed_reason: 'Publishing Failed' } });
                        results.errors++;
                    }
                }
            } catch (e: any) {
                const isAbort = e.name === 'AbortError';
                const errMsg = isAbort ? 'Instagram API timed out (15s)' : e.message;
                await logPlanner(post.planner_id || 'unknown', `Phase3 Error post=${post.id}: ${errMsg}`, 'error');
                await prisma.post.update({ where: { id: post.id }, data: { status: 'failed', error_message: errMsg, failed_reason: isAbort ? 'API Timeout' : 'Publishing Exception' } });
                results.errors++;
            }
        }

        return NextResponse.json(results);
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
