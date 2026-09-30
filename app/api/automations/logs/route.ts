import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import {
    AUTOMATION_SUMMARY_SELECT,
    CONTACT_SUMMARY_SELECT,
    badRequest,
    cursorOrFilter,
    firstParam,
    parseCursorParam,
    parseLimitParam,
    requireUserId,
    unauthorized,
} from "../../ig/shared";

/**
 * GET /api/automations/logs?automationId=&channelId=&status=&actionType=&kind=&limit=&cursor=
 *   → { items: IgActionLog & {contact?, automation?}, nextCursor }
 * Paginação estável: orderBy (created_at desc, id desc), cursor = id.
 */
export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const { searchParams } = new URL(req.url);
        const limit = parseLimitParam(searchParams.get("limit"), 30, 100);
        const cursorId = parseCursorParam(searchParams.get("cursor"));
        const automationId = firstParam(searchParams, "automationId", "automation_id");
        const channelId = firstParam(searchParams, "channelId", "channel_id");
        const status = firstParam(searchParams, "status");
        const actionType = firstParam(searchParams, "actionType", "action_type", "kind");

        const baseWhere: Prisma.IgActionLogWhereInput = { user_id: userId };
        if (automationId) baseWhere.automation_id = automationId;
        if (channelId) baseWhere.channel_id = channelId;
        if (status) baseWhere.status = status;
        if (actionType) baseWhere.action_type = actionType;

        let where: Prisma.IgActionLogWhereInput = baseWhere;
        if (cursorId) {
            const cursor = await prisma.igActionLog.findFirst({
                where: { id: cursorId, user_id: userId },
                select: { id: true, created_at: true },
            });
            if (cursor) where = { ...baseWhere, ...cursorOrFilter(cursor) };
        }

        const rows = await prisma.igActionLog.findMany({
            where,
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: limit + 1,
            include: {
                contact: { select: CONTACT_SUMMARY_SELECT },
                automation: { select: AUTOMATION_SUMMARY_SELECT },
            },
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? items[items.length - 1].id : null;

        return NextResponse.json({ items, nextCursor });
    } catch (error: unknown) {
        console.error("List automation logs error:", error);
        return badRequest(getErrorMessage(error));
    }
}
