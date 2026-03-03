import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/admin/fix-planners?secret=CRON_SECRET
 *
 * Diagnoses planners in the DB and optionally fixes status=null records.
 * Pass &fix=true to actually update them.
 */
export async function GET(req: Request) {
    const url = new URL(req.url);
    const secret = url.searchParams.get('secret');
    const fix = url.searchParams.get('fix') === 'true';

    if (secret !== process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch ALL planners regardless of status
    const allPlanners = await prisma.planner.findMany({
        include: {
            channels: { select: { id: true, name: true } },
        },
    });

    const diagnosis = allPlanners.map(p => {
        let configParsed: any = {};
        let parseError = null;
        try { configParsed = JSON.parse(p.config || '{}'); }
        catch (e: any) { parseError = e.message; }

        return {
            id: p.id,
            name: p.name,
            status: p.status,
            last_run: p.last_run,
            channels_count: p.channels.length,
            channels: p.channels.map((c: any) => c.name),
            content_count: (configParsed.content || []).length,
            frequency: configParsed.frequency,
            config_parse_error: parseError,
        };
    });

    let fixed = 0;
    if (fix) {
        // Fix planners with empty or non-standard status → set to 'active'
        const result = await prisma.planner.updateMany({
            where: { status: { not: { in: ['active', 'paused'] } } },
            data: { status: 'active' },
        });
        fixed = result.count;
    }

    return NextResponse.json({
        total: allPlanners.length,
        by_status: {
            active: allPlanners.filter(p => p.status === 'active').length,
            paused: allPlanners.filter(p => p.status === 'paused').length,
            other: allPlanners.filter(p => p.status !== 'active' && p.status !== 'paused').length,
        },
        fixed_count: fix ? fixed : 'dry-run (pass &fix=true to apply)',
        planners: diagnosis,
    });
}
