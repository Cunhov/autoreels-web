import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSessionUserId } from '@/lib/api';
import { describeChannelHealth, resolvePlannerRuntime } from '@/lib/planner-runtime';

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const planner = await prisma.planner.findFirst({
        where: { id, user_id: userId },
        include: { channels: true },
    });

    if (!planner) {
        return NextResponse.json({ error: 'Planner not found' }, { status: 404 });
    }

    const runtime = await resolvePlannerRuntime(prisma, planner);
    const channels = (planner.channels || []).map((channel: any) => ({
        id: channel.id,
        name: channel.name,
        status: channel.status,
        account_id: channel.account_id,
        username: channel.username,
        token_source: channel.token_source,
        token_expires_at: channel.token_expires_at,
        health: describeChannelHealth(channel),
    }));

    return NextResponse.json({
        planner: {
            id: planner.id,
            name: planner.name,
            status: planner.status,
            last_run: planner.last_run,
        },
        runtime,
        channels,
        publishable_channels: channels.filter((channel: any) => channel.health.ok),
    });
}
