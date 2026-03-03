import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GRAPH_API_VERSION = 'v22.0';

function getBaseUrl(token: string) {
    return token.startsWith('IG') ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
}

/** Resolve access token — supports Redis `token_` prefix if Redis is configured. */
async function resolveAccessToken(tokenOrKey: string | null): Promise<string> {
    if (!tokenOrKey) return '';

    // If the token starts with "token_", try to resolve from Redis via app_config
    if (tokenOrKey.startsWith('token_')) {
        try {
            const redisUrlRow = await prisma.appConfig.findUnique({ where: { key: 'REDIS_URL' } });
            const redisTokenRow = await prisma.appConfig.findUnique({ where: { key: 'REDIS_TOKEN' } });

            let redisUrl = process.env.REDIS_URL || redisUrlRow?.value || '';
            let redisToken = process.env.REDIS_TOKEN || redisTokenRow?.value || '';

            if (redisUrl && redisUrl.startsWith('rediss://')) {
                const match = redisUrl.match(/rediss:\/\/[^:]+:([^@]+)@([^:]+)/);
                if (match) { redisToken = match[1]; redisUrl = `https://${match[2]}`; }
            }

            if (redisUrl) {
                // Dynamic import only if Redis is available
                const { Redis } = await import('@upstash/redis');
                const redis = new Redis({ url: redisUrl, token: redisToken });

                let resolved: string | null = null;
                try {
                    const val = await redis.get<string>(tokenOrKey);
                    if (val) resolved = val;
                } catch { /* ignore */ }

                if (!resolved) {
                    try {
                        const listVal = await redis.lindex(tokenOrKey, 0);
                        if (listVal) resolved = listVal as string;
                    } catch { /* ignore */ }
                }

                if (resolved) return resolved.trim().replace(/^["']|["']$/g, '');
            }
        } catch { /* Redis not available, fall through */ }
    }

    return tokenOrKey;
}

/** Insert a planner log entry. */
async function logPlanner(plannerId: string, message: string, level: 'info' | 'error' = 'info', details: any = {}) {
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
        // Auth check
        const cronSecret = request.headers.get('x-cron-auth') || new URL(request.url).searchParams.get('secret');
        const expectedSecret = process.env.CRON_SECRET;
        if (!expectedSecret || cronSecret !== expectedSecret) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const results = { pending: 0, processing: 0, published: 0, errors: 0 };
        const now = new Date();

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 0: Planner Processing — create Posts from active Planners
        // ═══════════════════════════════════════════════════════════════════════

        const planners = await prisma.planner.findMany({
            where: { status: { not: 'paused' } },
            include: { channels: true },
        });

        for (const planner of planners) {
            try {
                const config = JSON.parse(planner.config || '{}');
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

                // Respect start_time
                if (config.start_time && now < new Date(config.start_time)) continue;

                // Respect sleep schedule
                if (config.sleep_schedule) {
                    const tz = config.timezone || 'America/Sao_Paulo';
                    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
                    const hhmm = `${String(nowInTz.getHours()).padStart(2, '0')}:${String(nowInTz.getMinutes()).padStart(2, '0')}`;
                    const sleepStart = config.sleep_schedule.start || '00:00';
                    const sleepEnd = config.sleep_schedule.end || '06:00';
                    if (sleepStart <= sleepEnd) {
                        if (hhmm >= sleepStart && hhmm < sleepEnd) continue;
                    } else {
                        if (hhmm >= sleepStart || hhmm < sleepEnd) continue;
                    }
                }

                const contentList = config.content || [];
                if (contentList.length === 0) continue;

                // Select content based on sort order
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
                    // old_to_new (default sequential)
                    const last = state.last_index !== undefined ? state.last_index : -1;
                    selectedIndex = (last + 1) % contentList.length;
                    state.last_index = selectedIndex;
                }

                const selectedContent = contentList[selectedIndex];
                if (!selectedContent) continue;

                // Resolve content
                let mediaUrl = selectedContent.url;
                let mediaType = selectedContent.media_type || 'REELS';
                let caption = selectedContent.caption || '';
                let children: { url: string; type: string }[] = selectedContent.children_urls || [];

                if (selectedContent.type === 'library_item') {
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
                            children = subItems.map((c: any) => ({
                                url: c.url || '',
                                type: c.type === 'video' ? 'video' : 'image',
                            }));
                        }

                        caption = (caption || '')
                            .replace(/{post_title}/g, libItem.title || '')
                            .replace(/{post_caption}/g, libItem.caption || '');
                    }
                }

                // Create posts for each linked channel
                for (const channel of planner.channels) {
                    await prisma.post.create({
                        data: {
                            user_id: planner.user_id,
                            channel_id: channel.id,
                            status: 'pending',
                            media_type: mediaType,
                            video_url: (mediaType === 'REELS' || mediaType === 'VIDEO') ? mediaUrl : null,
                            image_url: (mediaType === 'IMAGE') ? mediaUrl
                                : (mediaType === 'STORIES' && mediaUrl && !mediaUrl.includes('.mp4')) ? mediaUrl : null,
                            children_urls: children.length > 0 ? JSON.stringify(children) : null,
                            caption,
                            scheduled_at: now,
                            planner_id: planner.id,
                        },
                    });
                }

                // Update planner state
                await prisma.planner.update({
                    where: { id: planner.id },
                    data: {
                        last_run: now,
                        config: JSON.stringify({ ...config, state }),
                    },
                });
            } catch (err: any) {
                await logPlanner(planner.id, `Planner Error: ${err.message}`, 'error');
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 1: Pending → Processing (create IG media containers)
        // ═══════════════════════════════════════════════════════════════════════

        const pendingPosts = await prisma.post.findMany({
            where: {
                status: 'pending',
                scheduled_at: { lte: now },
            },
            include: { channel: true },
            take: 5,
        });

        for (const post of pendingPosts) {
            const plannerId = post.planner_id || 'unknown';
            try {
                const accessToken = await resolveAccessToken(post.channel?.access_token || null);
                const accountId = (post.channel?.account_id || '').trim();
                if (!accessToken || !accountId) throw new Error('Missing credentials');

                const baseUrl = getBaseUrl(accessToken);
                const mediaType = post.media_type || 'REELS';

                // CAROUSEL — create child containers first
                if (mediaType === 'CAROUSEL') {
                    const childIds: string[] = [];
                    const childrenData: { url: string; type: string }[] = post.children_urls ? JSON.parse(post.children_urls) : [];

                    for (const child of childrenData) {
                        const childParams = new URLSearchParams({
                            is_carousel_item: 'true',
                            [child.type === 'video' ? 'video_url' : 'image_url']: child.url,
                        });
                        if (child.type === 'video') childParams.append('media_type', 'VIDEO');

                        const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${accessToken}`,
                                'Content-Type': 'application/x-www-form-urlencoded',
                            },
                            body: childParams.toString(),
                        });
                        const data = await res.json();
                        if (data.id) childIds.push(data.id);
                    }

                    if (childIds.length > 0) {
                        await prisma.post.update({
                            where: { id: post.id },
                            data: { status: 'processing_children', instagram_child_ids: JSON.stringify(childIds) },
                        });
                        results.pending++;
                    }
                    continue;
                }

                // SINGLE MEDIA — create container
                const bodyParams = new URLSearchParams();
                if (mediaType === 'IMAGE') {
                    bodyParams.append('image_url', post.image_url || '');
                    bodyParams.append('caption', post.caption || '');
                } else {
                    bodyParams.append('media_type', mediaType === 'STORIES' ? 'STORIES' : 'REELS');
                    bodyParams.append('video_url', post.video_url || post.image_url || '');
                    bodyParams.append('caption', post.caption || '');
                    if (mediaType === 'REELS') {
                        bodyParams.append('share_to_feed', 'false');
                    }
                }

                const apiRes = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: bodyParams.toString(),
                });

                const data = await apiRes.json();
                if (data.id) {
                    await prisma.post.update({
                        where: { id: post.id },
                        data: { status: 'processing_upload', instagram_container_id: data.id },
                    });
                    results.pending++;
                } else {
                    await logPlanner(plannerId, `Media Creation Failed for post ${post.id}`, 'error', data);
                    throw new Error(data.error?.message || 'Media Creation Failed');
                }
            } catch (e: any) {
                await logPlanner(plannerId, `Phase 1 Error for post ${post.id}: ${e.message}`, 'error', e);
                await prisma.post.update({
                    where: { id: post.id },
                    data: { status: 'failed', error_message: e.message, failed_reason: 'Initialization Failed' },
                });
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
            try {
                const accessToken = await resolveAccessToken(post.channel?.access_token || null);
                const baseUrl = getBaseUrl(accessToken);

                if (post.status === 'processing_children') {
                    const childIds: string[] = post.instagram_child_ids ? JSON.parse(post.instagram_child_ids) : [];
                    let allFinished = true;

                    for (const cid of childIds) {
                        const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${cid}?fields=status_code&access_token=${accessToken}`);
                        const data = await res.json();
                        if (data.status_code !== 'FINISHED') { allFinished = false; break; }
                    }

                    if (allFinished) {
                        const body = new URLSearchParams({
                            media_type: 'CAROUSEL',
                            children: childIds.join(','),
                            caption: post.caption || '',
                        });
                        const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media`, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${accessToken}`,
                                'Content-Type': 'application/x-www-form-urlencoded',
                            },
                            body: body.toString(),
                        });
                        const data = await res.json();
                        if (data.id) {
                            await prisma.post.update({
                                where: { id: post.id },
                                data: { status: 'processing_upload', instagram_container_id: data.id },
                            });
                        }
                    }
                } else {
                    // Single media — check status
                    const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${post.instagram_container_id}?fields=status_code&access_token=${accessToken}`);
                    const data = await res.json();
                    if (data.status_code === 'FINISHED') {
                        await prisma.post.update({
                            where: { id: post.id },
                            data: { status: 'ready_to_publish' },
                        });
                    } else if (data.status_code === 'ERROR') {
                        const msg = `IG Processing Error: ${data.status_code}`;
                        await logPlanner(post.planner_id || 'unknown', msg, 'error', data);
                        await prisma.post.update({
                            where: { id: post.id },
                            data: { status: 'failed', error_message: msg, failed_reason: 'Processing Failed' },
                        });
                    }
                    // else: still processing, do nothing
                }
            } catch (e: any) {
                await logPlanner(post.planner_id || 'unknown', `Phase 2 Error for post ${post.id}`, 'error', e);
                await prisma.post.update({
                    where: { id: post.id },
                    data: { status: 'failed', error_message: e.message, failed_reason: 'Processing Exception' },
                });
            }
        }
        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 2.5: Timeout posts stuck in processing for > 2 hours
        // ═══════════════════════════════════════════════════════════════════════

        const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
        await prisma.post.updateMany({
            where: {
                status: { in: ['processing_upload', 'processing_children'] },
                created_at: { lte: twoHoursAgo },
            },
            data: {
                status: 'failed',
                error_message: 'Timed out: still processing after 2 hours',
                failed_reason: 'Processing Timeout',
            },
        });


        const readyPosts = await prisma.post.findMany({
            where: { status: 'ready_to_publish' },
            include: { channel: true },
            take: 5,
        });

        for (const post of readyPosts) {
            try {
                const accessToken = await resolveAccessToken(post.channel?.access_token || null);
                const baseUrl = getBaseUrl(accessToken);

                const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media_publish`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({ creation_id: post.instagram_container_id || '' }).toString(),
                });
                const data = await res.json();

                if (data.id) {
                    await prisma.post.update({
                        where: { id: post.id },
                        data: { status: 'published', published_at: new Date(), instagram_media_id: data.id },
                    });
                    results.published++;
                } else {
                    const msg = data.error?.message || 'Publishing Failed';
                    if (msg.toLowerCase().includes('already published')) {
                        await prisma.post.update({
                            where: { id: post.id },
                            data: { status: 'published', published_at: new Date() },
                        });
                        await logPlanner(post.planner_id || 'unknown', `Post ${post.id} was already published. Status updated.`, 'info');
                        results.published++;
                    } else {
                        await logPlanner(post.planner_id || 'unknown', `Phase 3 Error for post ${post.id}: ${msg}`, 'error', data);
                        await prisma.post.update({
                            where: { id: post.id },
                            data: { status: 'failed', error_message: msg, failed_reason: 'Publishing Failed' },
                        });
                        results.errors++;
                    }
                }
            } catch (e: any) {
                await logPlanner(post.planner_id || 'unknown', `Phase 3 Exception for post ${post.id}`, 'error', e);
                await prisma.post.update({
                    where: { id: post.id },
                    data: { status: 'failed', error_message: e.message, failed_reason: 'Publishing Exception' },
                });
                results.errors++;
            }
        }

        return NextResponse.json(results);
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
