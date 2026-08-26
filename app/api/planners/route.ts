import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
// Contract with fix3-core: lib/planner-config.ts is created by that worktree.
import { parsePlannerConfig, validatePlannerConfig } from "@/lib/planner-config";
import { escapeHtml } from "@/lib/sanitize";

import { PLANNER_STATUSES, isPlannerStatus } from "@/lib/planner-status";
const VALID_PLANNER_STATUS = [...PLANNER_STATUSES] as const;

const publicChannelSelect = {
    id: true,
    name: true,
    platform: true,
    account_id: true,
    username: true,
    profile_picture_url: true,
    status: true,
};

/**
 * Normalize a client-sent config into a string JSON, validating it first.
 * Returns { ok: true, json: string } or { ok: false, errors: string[] }.
 */
async function validateConfigPayload(config: unknown): Promise<{ ok: true; json: string } | { ok: false; errors: string[] }> {
    const configObj = typeof config === 'string' ? parsePlannerConfig(config) : (config ?? {});
    const result = validatePlannerConfig(configObj);
    if (result && result.ok === false) {
        return { ok: false, errors: Array.isArray(result.errors) ? result.errors : ['Invalid planner config'] };
    }
    return { ok: true, json: JSON.stringify(configObj) };
}

/**
 * Validate channel_ids and return the owned subset (or an error).
 * - undefined           → not provided (no-op)
 * - non-array           → error
 * - empty array         → valid (disconnect all)
 * - array with foreign ids → error (never silently drop)
 */
async function resolveOwnedChannelIds(
    userId: string,
    channelIds: unknown
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
    if (channelIds === undefined) return { ok: true, ids: [] };
    if (!Array.isArray(channelIds)) {
        return { ok: false, error: 'channel_ids must be an array' };
    }
    if (channelIds.length === 0) return { ok: true, ids: [] };

    const owned = await prisma.channel.findMany({
        where: { id: { in: channelIds }, user_id: userId },
        select: { id: true },
    });
    if (owned.length !== channelIds.length) {
        return { ok: false, error: 'One or more channels do not belong to this user' };
    }
    return { ok: true, ids: channelIds };
}

export async function GET() {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [planners, postStats] = await Promise.all([
        prisma.planner.findMany({
            where: {
                user_id: userId,
            },
            include: {
                channels: { select: publicChannelSelect },
            },
            orderBy: {
                created_at: "desc",
            },
        }),
        prisma.post.groupBy({
            by: ["planner_id", "status"],
            where: {
                user_id: userId,
                planner_id: { not: null },
            },
            _count: { _all: true },
        }),
    ]);

    const statsByPlanner: Record<string, { total: number; published: number; failed: number }> = {};
    for (const row of postStats) {
        const plannerId = row.planner_id;
        if (!plannerId) continue;
        if (!statsByPlanner[plannerId]) {
            statsByPlanner[plannerId] = { total: 0, published: 0, failed: 0 };
        }
        const count = row._count._all;
        statsByPlanner[plannerId].total += count;
        if (row.status === "published") statsByPlanner[plannerId].published += count;
        if (row.status === "failed") statsByPlanner[plannerId].failed += count;
    }

    return NextResponse.json(
        planners.map(planner => ({
            ...planner,
            // Contract with the wizard: channel_ids (array of ids) alongside `channels`.
            channel_ids: planner.channels.map(channel => channel.id),
            stats: statsByPlanner[planner.id] ?? { total: 0, published: 0, failed: 0 },
        }))
    );
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { name, config, channel_ids, status } = await req.json();

        if (!name || typeof name !== "string" || name.trim().length === 0) {
            return NextResponse.json({ error: "Planner name is required" }, { status: 400 });
        }
        const safeName = escapeHtml(name.trim()).slice(0,80);

        // Restrict status to known values (default: active)
        const safeStatus = isPlannerStatus(status) ? status : "active";

        // Validate config (frequency, sort_order, content, sleep, templates, ...)
        const configCheck = await validateConfigPayload(config);
        if (!configCheck.ok) {
            return NextResponse.json({ error: "Invalid planner config", details: configCheck.errors }, { status: 400 });
        }

        // channel_ids: must be an array; every id must belong to this user.
        const channelCheck = await resolveOwnedChannelIds(userId, channel_ids);
        if (!channelCheck.ok) {
            return NextResponse.json({ error: channelCheck.error }, { status: 400 });
        }

        // BK-05: idempotency header (debounce 800ms do wizard)
        const plannerIdempotencyKey = req.headers.get("x-idempotency-key");
        if (plannerIdempotencyKey) {
            const appKey = `idempotency:planner:${userId}:${String(plannerIdempotencyKey).slice(0,128)}`;
            try {
                const existingMapping = await prisma.appConfig.findUnique({ where: { key: appKey } });
                if (existingMapping?.value) {
                    try {
                        const mapped = JSON.parse(existingMapping.value) as { plannerId?: string; expiresAt?: number };
                        if (mapped?.plannerId && (!mapped.expiresAt || mapped.expiresAt > Date.now())) {
                            const existingPlanner = await prisma.planner.findFirst({ where: { id: mapped.plannerId, user_id: userId } });
                            if (existingPlanner) return NextResponse.json(existingPlanner);
                        }
                    } catch {}
                }
            } catch {}
            const planner = await prisma.planner.create({
                data: {
                    name,
                    status: safeStatus,
                    config: configCheck.json,
                    state: null,
                    user_id: userId,
                    channels: { connect: channelCheck.ids.map(channelId => ({ id: channelId })) },
                },
            });
            try { await prisma.appConfig.upsert({ where: { key: appKey }, create: { key: appKey, value: JSON.stringify({ plannerId: planner.id, expiresAt: Date.now() + 24*60*60*1000 }) }, update: { value: JSON.stringify({ plannerId: planner.id, expiresAt: Date.now() + 24*60*60*1000 }) } }); } catch {}
            return NextResponse.json(planner);
        }
        const planner = await prisma.planner.create({
            data: {
                name: safeName,
                status: safeStatus,
                config: configCheck.json,
                state: null,
                user_id: userId,
                channels: {
                    connect: channelCheck.ids.map(channelId => ({ id: channelId })),
                },
            },
        });
        return NextResponse.json(planner);
    } catch (error: unknown) {
        console.error('Create planner error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
