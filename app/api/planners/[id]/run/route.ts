import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * POST /api/planners/[id]/run
 * 
 * Triggers a single planner run immediately for the authenticated user.
 * Bypasses the CRON_SECRET requirement — uses session auth instead.
 * Resets last_run so the next cron tick picks it up as due.
 */
export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    try {
        const planner = await prisma.planner.findFirst({
            where: { id, user_id: (session.user as any).id },
            include: { channels: true },
        });

        if (!planner) {
            return NextResponse.json({ error: 'Planner not found' }, { status: 404 });
        }

        const config = JSON.parse(planner.config || '{}');
        const contentList = config.content || [];

        if (contentList.length === 0) {
            return NextResponse.json({ error: 'Planner has no content configured' }, { status: 400 });
        }

        if (!planner.channels || planner.channels.length === 0) {
            return NextResponse.json({ error: 'Planner has no channels connected' }, { status: 400 });
        }

        const now = new Date();

        // Select next content item based on sort order
        const sortOrder = config.sort_order || 'random_loop';
        const state = config.state || {};
        let selectedIndex = -1;

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
        if (!selectedContent) {
            return NextResponse.json({ error: 'Could not select content item' }, { status: 400 });
        }

        // Resolve library items
        let mediaUrl = selectedContent.url;
        let mediaType = selectedContent.media_type || 'REELS';
        let caption = selectedContent.caption || '';
        const locationId = selectedContent.location_id || null;
        const shareToFeed = selectedContent.share_to_feed !== false;
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
                    children = subItems.map((c: any) => {
                        const urlStr = c.url || '';
                        const isVideo = c.type === 'video' || (urlStr && /\.(mp4|mov)(\?.*)?$/i.test(urlStr));
                        return {
                            url: urlStr,
                            type: isVideo ? 'video' : 'image',
                        };
                    });
                }

                let itemTitle = libItem.title || selectedContent.title_fallback || '';
                let itemCaption = libItem.caption || selectedContent.caption_fallback || '';

                caption = (caption || '')
                    .replace(/{post_title}/g, itemTitle)
                    .replace(/{post_caption}/g, itemCaption);
            } else {
                return NextResponse.json({ error: 'Library item no longer exists' }, { status: 400 });
            }
        }

        if (!mediaUrl && children.length === 0) {
            return NextResponse.json({ error: 'Media URL missing for this content item' }, { status: 400 });
        }

        // Create posts for each channel
        let postsCreated = 0;
        for (const channel of planner.channels) {
            await prisma.post.create({
                data: {
                    user_id: planner.user_id,
                    channel_id: channel.id,
                    status: 'pending',
                    media_type: mediaType,
                    video_url: mediaType === 'REELS' ? mediaUrl : null,
                    image_url: (mediaType === 'IMAGE') ? mediaUrl
                        : (mediaType === 'STORIES' && mediaUrl && !mediaUrl?.includes('.mp4')) ? mediaUrl : null,
                    children_urls: children.length > 0 ? JSON.stringify(children) : null,
                    share_to_feed: shareToFeed,
                    location_id: locationId,
                    caption,
                    scheduled_at: now,
                    planner_id: planner.id,
                },
            });
            postsCreated++;
        }

        // Update planner last_run + state so the next cron interval is counted from now
        await prisma.planner.update({
            where: { id: planner.id },
            data: {
                last_run: now,
                config: JSON.stringify({ ...config, state }),
            },
        });

        // Write a log entry
        await prisma.plannerLog.create({
            data: {
                planner_id: planner.id,
                message: `Manual run triggered — ${postsCreated} post(s) created`,
                level: 'info',
                details: JSON.stringify({ triggered_by: 'user', posts_created: postsCreated }),
            },
        }).catch(() => { });

        return NextResponse.json({ success: true, posts_created: postsCreated });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
