import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { parseJsonValue } from "@/lib/ig-automation/validate";
import {
    CHANNEL_SUMMARY_SELECT,
    CONTACT_SUMMARY_SELECT,
    badRequest,
    cursorOrFilter,
    firstParam,
    parseCursorParam,
    parseLimitParam,
    requireUserId,
    unauthorized,
} from "../shared";

/**
 * GET /api/ig/events?direction=&kind=&status=&channelId=&automationId=&limit=&cursor=&includePayload=1
 *   → { items: IgEvent & {contact?, channel?}, nextCursor }
 * `payload` fica fora por padrão; includePayload=1 devolve o JSON cru parseado.
 */
export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const { searchParams } = new URL(req.url);
        const limit = parseLimitParam(searchParams.get("limit"), 30, 100);
        const cursorId = parseCursorParam(searchParams.get("cursor"));
        const direction = firstParam(searchParams, "direction");
        const kind = firstParam(searchParams, "kind");
        const status = firstParam(searchParams, "status");
        const channelId = firstParam(searchParams, "channelId", "channel_id");
        const automationId = firstParam(searchParams, "automationId", "automation_id");
        const includePayload =
            searchParams.get("includePayload") === "1" || searchParams.get("include_payload") === "1";

        const baseWhere: Prisma.IgEventWhereInput = { user_id: userId };
        if (direction) baseWhere.direction = direction;
        if (kind) baseWhere.kind = kind;
        if (status) baseWhere.status = status;
        if (channelId) baseWhere.channel_id = channelId;
        if (automationId) baseWhere.automation_id = automationId;

        let where: Prisma.IgEventWhereInput = baseWhere;
        if (cursorId) {
            const cursor = await prisma.igEvent.findFirst({
                where: { id: cursorId, user_id: userId },
                select: { id: true, created_at: true },
            });
            if (cursor) where = { ...baseWhere, ...cursorOrFilter(cursor) };
        }

        const rows = await prisma.igEvent.findMany({
            where,
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: limit + 1,
            include: {
                contact: { select: CONTACT_SUMMARY_SELECT },
                channel: { select: CHANNEL_SUMMARY_SELECT },
            },
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? page[page.length - 1].id : null;

        const items = page.map((row) => {
            const { payload, ...rest } = row;
            if (!includePayload) return rest;
            return { ...rest, payload: parseJsonValue(payload) };
        });

        return NextResponse.json({ items, nextCursor });
    } catch (error: unknown) {
        console.error("List ig events error:", error);
        return badRequest(getErrorMessage(error));
    }
}
