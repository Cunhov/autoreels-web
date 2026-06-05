import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { describeChannelHealth, resolvePlannerRuntime } from '@/lib/planner-runtime';

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

        if (!planner.channels || planner.channels.length === 0) {
            return NextResponse.json({ error: 'Planner has no channels connected' }, { status: 400 });
        }

        const now = new Date();
        const runtime = await resolvePlannerRuntime(prisma, planner, now);
        if (!runtime.ok) {
            return NextResponse.json({ error: runtime.errors.join('; '), warnings: runtime.warnings }, { status: 400 });
        }

        const publishableChannels = (planner.channels || []).filter((channel: any) => describeChannelHealth(channel, now).ok);
        if (publishableChannels.length === 0) {
            return NextResponse.json({ error: 'No publishable channels available' }, { status: 400 });
        }

        const { selectedIndex, mediaUrl, mediaType, caption, locationId, shareToFeed, thumbnailUrl, children, nextState, warnings } = runtime;
        const safeChildren = children || [];

        // Create posts for each channel
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
                        : (mediaType === 'STORIES' && mediaUrl && !mediaUrl?.includes('.mp4')) ? mediaUrl : null,
                    thumbnail_url: thumbnailUrl || (safeChildren.length > 0 ? safeChildren[0].url : null),
                    children_urls: safeChildren.length > 0 ? JSON.stringify(safeChildren) : null,
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
                config: JSON.stringify({ ...runtime.config, state: nextState }),
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

        return NextResponse.json({ success: true, posts_created: postsCreated, selected_index: selectedIndex, warnings });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
