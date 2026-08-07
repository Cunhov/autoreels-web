import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { safeEqual } from '@/lib/secret';

/**
 * GET /api/admin/fix-planners
 * Header: x-admin-secret (or x-cron-auth) = CRON_SECRET
 *
 * Deep diagnostic: shows full config + recent posts for each planner.
 * Pass &fix=true to patch planners with wrong status to 'active'.
 */
export async function GET(req: Request) {
    const url = new URL(req.url);
    const fix = url.searchParams.get('fix') === 'true';

    // Secret via header only (never query string — it leaks into access logs)
    const provided = req.headers.get('x-admin-secret') || req.headers.get('x-cron-auth');
    const expected = process.env.CRON_SECRET;
    if (!expected || !provided || !safeEqual(provided, expected)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allPlanners = await prisma.planner.findMany({
        include: { channels: { select: { id: true, name: true, account_id: true, status: true } } },
    });

    const now = new Date();

    const diagnosis = await Promise.all(allPlanners.map(async (p: any) => {
        let configParsed: any = {};
        let parseError = null;
        let isDoubleStringified = false;

        try {
            const firstParse = JSON.parse(p.config || '{}');
            // Check for double-stringification
            if (typeof firstParse === 'string') {
                isDoubleStringified = true;
                configParsed = JSON.parse(firstParse);
            } else {
                configParsed = firstParse;
            }
        } catch (e: any) { parseError = e.message; }

        const contentList = configParsed.content || [];
        const freqVal = configParsed.frequency?.value || 10;
        const freqUnit = configParsed.frequency?.unit || 'minutes';
        let intervalMs = freqVal * 60 * 1000;
        if (freqUnit === 'hours') intervalMs = freqVal * 60 * 60 * 1000;
        else if (freqUnit === 'days') intervalMs = freqVal * 24 * 60 * 60 * 1000;

        const lastRun = p.last_run ? new Date(p.last_run) : null;
        const isDue = !lastRun || (now.getTime() >= lastRun.getTime() + intervalMs - 15000);
        const nextRunMs = lastRun ? (lastRun.getTime() + intervalMs) - now.getTime() : 0;

        // Fetch last 3 posts for this planner
        const recentPosts = await prisma.post.findMany({
            where: { planner_id: p.id },
            orderBy: { created_at: 'desc' },
            take: 3,
            select: { id: true, status: true, error_message: true, created_at: true, media_type: true, video_url: true, image_url: true },
        });

        return {
            id: p.id,
            name: p.name,
            status: p.status,
            last_run: p.last_run,
            is_due_now: isDue,
            next_run_in_seconds: Math.ceil(nextRunMs / 1000),
            channels: p.channels.map((c: any) => ({
                name: c.name,
                account_id: c.account_id,
                has_token: true, // token exists but we don't expose it
                status: c.status,
            })),
            content_count: contentList.length,
            content_items: contentList.map((item: any) => ({
                type: item.type,
                id: item.id,
                url: item.url,
                media_type: item.media_type,
                caption_preview: (item.caption || '').slice(0, 60),
            })),
            sort_order: configParsed.sort_order,
            sleep_schedule: configParsed.sleep_schedule,
            state: configParsed.state,
            is_double_stringified: isDoubleStringified,
            config_parse_error: parseError,
            recent_posts: recentPosts,
        };
    }));

    let fixed = 0;
    if (fix) {
        const result = await prisma.planner.updateMany({
            where: { status: { not: { in: ['active', 'paused'] } } },
            data: { status: 'active' },
        });
        fixed = result.count;

        // Also fix double-stringified configs
        for (const p of allPlanners as any[]) {
            try {
                const firstParse = JSON.parse(p.config);
                if (typeof firstParse === 'string') {
                    // It's double-stringified — unwrap it
                    await prisma.planner.update({
                        where: { id: p.id },
                        data: { config: firstParse },
                    });
                }
            } catch { /* ignore */ }
        }
    }

    return NextResponse.json({
        total: allPlanners.length,
        by_status: {
            active: allPlanners.filter((p: any) => p.status === 'active').length,
            paused: allPlanners.filter((p: any) => p.status === 'paused').length,
            other: allPlanners.filter((p: any) => p.status !== 'active' && p.status !== 'paused').length,
        },
        fixed_count: fix ? fixed : 'dry-run — pass &fix=true to apply',
        planners: diagnosis,
    });
}
