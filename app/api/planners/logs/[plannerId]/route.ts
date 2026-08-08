import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";

/**
 * GET /api/planners/logs/[plannerId]?cursor=<logId>&take=50&level=all
 *   → { logs, total, nextCursor }
 * DELETE /api/planners/logs/[plannerId]
 *   → clears all logs for the planner → { deleted: N }
 *
 * Cursor pagination: orderBy [created_at desc, id desc]; the cursor is the id of
 * the last log of the previous page (tie-break on id for stable ordering).
 */
const DEFAULT_TAKE = 50;
const MAX_TAKE = 200;

export async function GET(
    req: Request,
    { params }: { params: Promise<{ plannerId: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { plannerId } = await params;

    try {
        const url = new URL(req.url);
        const takeRaw = Number(url.searchParams.get("take") || String(DEFAULT_TAKE));
        const take = Number.isFinite(takeRaw)
            ? Math.min(Math.max(Math.floor(takeRaw), 1), MAX_TAKE)
            : DEFAULT_TAKE;
        const level = url.searchParams.get("level") || "all";
        const cursorId = url.searchParams.get("cursor");

        const baseWhere: Record<string, unknown> = {
            planner_id: plannerId,
            planner: {
                user_id: userId,
            },
        };
        if (level === "info" || level === "error") {
            baseWhere.level = level;
        }

        // Resolve cursor → (created_at, id) for stable tie-break pagination.
        let cursorWhere: Record<string, unknown> | undefined;
        if (cursorId) {
            const cursorLog = await prisma.plannerLog.findFirst({
                where: { id: cursorId, planner_id: plannerId },
                select: { id: true, created_at: true },
            });
            if (cursorLog) {
                cursorWhere = {
                    OR: [
                        { created_at: { lt: cursorLog.created_at } },
                        { created_at: cursorLog.created_at, id: { lt: cursorLog.id } },
                    ],
                };
            }
        }

        const where = cursorWhere
            ? { ...baseWhere, ...cursorWhere }
            : baseWhere;

        const [logs, total] = await Promise.all([
            prisma.plannerLog.findMany({
                where,
                orderBy: [{ created_at: "desc" }, { id: "desc" }],
                take: take + 1, // +1 to detect whether a next page exists
            }),
            prisma.plannerLog.count({ where: baseWhere }),
        ]);

        const hasMore = logs.length > take;
        const pageLogs = hasMore ? logs.slice(0, take) : logs;
        const nextCursor = hasMore ? pageLogs[pageLogs.length - 1].id : null;

        return NextResponse.json({
            logs: pageLogs,
            total,
            next_cursor: nextCursor,
        });
    } catch (error: unknown) {
        console.error('List planner logs error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ plannerId: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { plannerId } = await params;

    try {
        // Ownership guard: the planner must belong to the user.
        const planner = await prisma.planner.findFirst({
            where: { id: plannerId, user_id: userId },
            select: { id: true },
        });
        if (!planner) {
            return NextResponse.json({ error: "Planner not found" }, { status: 404 });
        }

        const result = await prisma.plannerLog.deleteMany({
            where: { planner_id: plannerId },
        });
        return NextResponse.json({ deleted: result.count });
    } catch (error: unknown) {
        console.error('Clear planner logs error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
