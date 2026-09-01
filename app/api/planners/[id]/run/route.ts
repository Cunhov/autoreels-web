import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getErrorMessage } from '@/lib/api';
// Contract with fix3-core: runPlannerOnce(prisma, planner, now, { force }) is added
// to lib/planner-runtime.ts by that worktree. It performs the full Phase 0 logic
// (due/sleep/start_time checks, content selection, templates, post creation,
// state + last_run persistence) and returns { ok, created, errors, warnings }.
import { runPlannerOnce } from '@/lib/planner-runtime';
import { getPlannerPlatformType, PLANNER_MIX_ERROR } from '@/lib/planner-config';

// Contract result shape — defensive: accepts both `created` and `posts_created`.
type RunOnceResult = {
    ok: boolean;
    created?: number;
    posts_created?: number;
    selected_index?: number | null;
    errors?: string[];
    warnings?: string[];
};

/**
 * POST /api/planners/[id]/run
 *
 * Triggers a single planner run immediately for the authenticated user.
 * Bypasses the CRON_SECRET requirement — uses session auth instead.
 * A paused planner must be explicitly activated first (409).
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
        const userId = (session.user as { id?: string } | undefined)?.id;
        const planner = await prisma.planner.findFirst({
            where: { id, user_id: userId ?? "" },
            include: { channels: true },
        });

        if (!planner) {
            return NextResponse.json({ error: 'Planner not found' }, { status: 404 });
        }

        if (planner.status === 'paused') {
            return NextResponse.json({ error: 'Planner is paused' }, { status: 409 });
        }

        if (!planner.channels || planner.channels.length === 0) {
            return NextResponse.json({ error: 'Planner has no channels connected' }, { status: 400 });
        }

        // Isolation: detectar planners mistos grandfathered — logar warning mas não bloquear execução
        const platformType = getPlannerPlatformType({}, planner.channels as Array<{ platform?: string | null }>);
        if (platformType === 'mixed') {
            console.warn(`[planner run] planner ${planner.id} é misto YT+IG (grandfathered) — ${PLANNER_MIX_ERROR}`);
            try {
                await prisma.plannerLog.create({
                    data: {
                        planner_id: planner.id,
                        level: 'warning',
                        message: `Planner misto detectado (grandfathered) — ${PLANNER_MIX_ERROR}`,
                        details: JSON.stringify({ platform_type: platformType, channels: planner.channels.map((c: { id: string; platform: string | null }) => ({ id: c.id, platform: c.platform })) }),
                    },
                });
            } catch {}
        }

        const now = new Date();
        // force: true → ignores frequency/start_time/sleep gating (explicit user action).
        const rawResult = await runPlannerOnce(prisma, planner, now, { force: true });
        const result = rawResult as RunOnceResult;

        if (!result || result.ok === false) {
            const errors = result?.errors?.length ? result.errors : ['Planner run failed'];
            return NextResponse.json({
                error: errors.join('; '),
                warnings: result?.warnings ?? [],
            }, { status: 400 });
        }

        const postsCreated = result.created ?? result.posts_created ?? 0;

        // Informational log entry (runPlannerOnce may already log — duplicates are benign).
        await prisma.plannerLog.create({
            data: {
                planner_id: planner.id,
                message: `Manual run triggered — ${postsCreated} post(s) created`,
                level: 'info',
                details: JSON.stringify({ triggered_by: 'user', posts_created: postsCreated }),
            },
        }).catch(() => { });

        const warnings = [...(result?.warnings ?? [])];
        if (platformType === 'mixed') warnings.push(PLANNER_MIX_ERROR);
        return NextResponse.json({
            success: true,
            posts_created: postsCreated,
            selected_index: result.selected_index ?? null,
            warnings,
            platform_type: platformType,
        });
    } catch (error: unknown) {
        console.error('Run planner error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
