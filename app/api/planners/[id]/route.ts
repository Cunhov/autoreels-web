import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
// Contract with fix3-core: lib/planner-config.ts is created by that worktree.
import { parsePlannerConfig, validatePlannerConfig } from "@/lib/planner-config";

const VALID_PLANNER_STATUS = ["active", "paused"];

function isNotFound(error: unknown): boolean {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'P2025') {
        return true;
    }
    return error instanceof Error && error.message.includes("P2025");
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const data = await req.json();
        const { channel_ids, config, reset_state, ...rest } = data;

        // Whitelist updatable fields — never allow user_id / id / created_at / state via spread
        const safeRest: Record<string, unknown> = {};
        if (rest.name !== undefined) {
            if (typeof rest.name !== "string" || rest.name.trim().length === 0) {
                return NextResponse.json({ error: "Invalid planner name" }, { status: 400 });
            }
            safeRest.name = rest.name;
        }
        if (rest.status !== undefined) {
            if (!VALID_PLANNER_STATUS.includes(rest.status)) {
                return NextResponse.json({ error: "Invalid planner status" }, { status: 400 });
            }
            safeRest.status = rest.status;
        }

        // Validate config when provided (frequency, sort_order, content, templates, ...)
        let safeConfig: string | undefined;
        if (config !== undefined) {
            const configObj = typeof config === 'string' ? parsePlannerConfig(config) : (config ?? {});
            const validation = validatePlannerConfig(configObj);
            if (validation && validation.ok === false) {
                return NextResponse.json({
                    error: "Invalid planner config",
                    details: Array.isArray(validation.errors) ? validation.errors : ['Invalid planner config'],
                }, { status: 400 });
            }
            safeConfig = JSON.stringify(configObj);
        }

        // channel_ids: must be an array; every id must belong to this user.
        // Empty array is VALID (user explicitly disconnected all channels).
        let safeChannelIds: string[] | undefined;
        if (channel_ids !== undefined) {
            if (!Array.isArray(channel_ids)) {
                return NextResponse.json({ error: "channel_ids must be an array" }, { status: 400 });
            }
            if (channel_ids.length > 0) {
                const owned = await prisma.channel.findMany({
                    where: { id: { in: channel_ids }, user_id: userId },
                    select: { id: true },
                });
                if (owned.length !== channel_ids.length) {
                    return NextResponse.json({ error: "One or more channels do not belong to this user" }, { status: 400 });
                }
            }
            safeChannelIds = channel_ids;
        }

        const planner = await prisma.planner.update({
            where: { id, user_id: userId },
            data: {
                ...safeRest,
                ...(safeConfig !== undefined ? { config: safeConfig } : {}),
                // reset_state: true → clear publish state (used by the wizard when content changed).
                // state is NEVER accepted from the client as a value.
                ...(reset_state === true ? { state: '{}' } : {}),
                ...(safeChannelIds !== undefined ? {
                    channels: {
                        set: safeChannelIds.map(channelId => ({ id: channelId })),
                    },
                } : {}),
            },
        });

        return NextResponse.json(planner);
    } catch (error: unknown) {
        console.error('Update planner error:', error);
        if (isNotFound(error)) {
            return NextResponse.json({ error: "Planner not found" }, { status: 404 });
        }
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        // Hard delete — planner_logs cascade. Manual run / cron history is not archived.
        await prisma.planner.delete({
            where: { id, user_id: userId },
        });
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('Delete planner error:', error);
        if (isNotFound(error)) {
            return NextResponse.json({ error: "Planner not found" }, { status: 404 });
        }
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
