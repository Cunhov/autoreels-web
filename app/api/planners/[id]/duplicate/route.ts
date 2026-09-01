import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getErrorMessage, getSessionUserId } from '@/lib/api';
import { validatePlannerChannelMix, PLANNER_MIX_ERROR } from '@/lib/planner-config';

/**
 * POST /api/planners/[id]/duplicate
 *
 * Clones a planner owned by the authenticated user:
 * - name gets " (copy)" suffix
 * - config is copied verbatim
 * - state is reset (fresh publish state)
 * - status is set to 'paused' so the user reviews before activating
 * - channels are re-connected (ownership re-validated)
 */
export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    try {
        const source = await prisma.planner.findFirst({
            where: { id, user_id: userId },
            include: { channels: { select: { id: true } } },
        });

        if (!source) {
            return NextResponse.json({ error: 'Planner not found' }, { status: 404 });
        }

        const channelIds = (source.channels || []).map(channel => channel.id);

        // Isolation: bloquear duplicação de planners mistos (grandfathered)
        if (channelIds.length > 1) {
            const mixCheck = await validatePlannerChannelMix(channelIds, prisma);
            if (!mixCheck.ok) {
                // TikTok no mix → mensagem dedicada PT-BR (validatePlannerChannelMix já a escolhe)
                return NextResponse.json({ error: mixCheck.error || PLANNER_MIX_ERROR }, { status: 400 });
            }
        }

        // Ownership is already guaranteed by the source lookup (same user), so
        // we can safely reconnect the same channel ids on the clone.
        const clone = await prisma.planner.create({
            data: {
                name: `${source.name} (copy)`,
                status: 'paused',
                config: source.config,
                state: null,
                user_id: userId,
                channels: channelIds.length > 0
                    ? { connect: channelIds.map(channelId => ({ id: channelId })) }
                    : undefined,
            },
        });

        return NextResponse.json(clone);
    } catch (error: unknown) {
        console.error('Duplicate planner error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
