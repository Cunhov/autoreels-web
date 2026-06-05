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

function makeAbsoluteUrl(baseOut: string, path: string | null | undefined): string {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${baseOut}${cleanPath}`;
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

async function refreshDueChannelTokens(now: Date) {
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

        const results: any = { pending: 0, processing: 0, published: 0, errors: 0, cleaned: 0, tokens_refreshed: 0 };
        const now = new Date();
        results.tokens_refreshed = await refreshDueChannelTokens(now);

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

                if (!planner.channels || planner.channels.length === 0) {
                    await logPlanner(planner.id, `[Phase0] No channels connected`, 'error');
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

                let postsCreated = 0;
                for (const channel of publishableChannels) {
                    await prisma.post.create({
                        data: {
                            user_id: planner.user_id,
                            channel_id: channel.id,
                            status: 'pending',
                            media_type: mediaType,
                            video_url: mediaType === 'REELS' ? mediaUrl : null,
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
                await prisma.planner.update({
                    where: { id: planner.id },
                    data: { last_run: now, config: JSON.stringify({ ...config, state: nextState }) },
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

                const baseUrl = getGraphBaseUrl(accessToken);
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
                    mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, post.video_url || post.image_url);
                    bodyParams.append('video_url', mediaUrlAbsolute);
                    if (mediaType !== 'STORIES') bodyParams.append('caption', post.caption || '');
                    if (mediaType === 'REELS') {
                        bodyParams.append('share_to_feed', post.share_to_feed === false ? 'false' : 'true');
                        if (post.location_id) bodyParams.append('location_id', post.location_id);
                        if (post.audio_configuration) {
                            try {
                                const audioConfig = JSON.parse(post.audio_configuration);
                                if (audioConfig && audioConfig.audio_id) {
                                    bodyParams.append('audio_configuration', JSON.stringify(audioConfig));
                                }
                            } catch (err) {
                                console.error('Failed to parse audio_configuration:', err);
                            }
                        }
                    }
                }

                if (post.collaborators && mediaType !== 'STORIES') {
                    const list = post.collaborators.split(',').map((c: string) => c.trim()).filter(Boolean);
                    if (list.length > 0) {
                        bodyParams.append('collaborators', JSON.stringify(list));
                    }
                }

                await logPlanner(plannerId, `[Phase1] Sending to IG: mediaType=${mediaType}, url=${mediaUrlAbsolute}`, 'info');

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
                const baseUrl = getGraphBaseUrl(accessToken);
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
                        if (post.location_id) body.append('location_id', post.location_id);
                        if (post.collaborators) {
                            const list = post.collaborators.split(',').map((c: string) => c.trim()).filter(Boolean);
                            if (list.length > 0) {
                                body.append('collaborators', JSON.stringify(list));
                            }
                        }
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
                const baseUrl = getGraphBaseUrl(accessToken);

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
