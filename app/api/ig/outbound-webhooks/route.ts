import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { validateOutboundInput } from "@/lib/ig-automation/validate";
import {
    badRequest,
    findOwnedChannel,
    firstParam,
    notFound,
    outboundToDb,
    readJsonBody,
    requireUserId,
    serializeOutboundWebhook,
    unauthorized,
} from "../shared";

/**
 * GET /api/ig/outbound-webhooks?channelId=
 *   → Webhook[] (secret omitido; has_secret indica se há segredo)
 */
export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const { searchParams } = new URL(req.url);
        const channelId = firstParam(searchParams, "channelId", "channel_id");

        const webhooks = await prisma.igOutboundWebhook.findMany({
            where: {
                user_id: userId,
                ...(channelId ? { channel_id: channelId } : {}),
            },
            orderBy: { created_at: "desc" },
        });

        return NextResponse.json(webhooks.map(serializeOutboundWebhook));
    } catch (error: unknown) {
        console.error("List ig outbound webhooks error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/** POST /api/ig/outbound-webhooks — body {name, url, events, channelId?, secret?, enabled?} */
export async function POST(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const body = await readJsonBody(req);
        const result = validateOutboundInput(body, { partial: false });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;

        if (data.channelId) {
            const channel = await findOwnedChannel(userId, data.channelId);
            if (!channel) return notFound("Canal não encontrado");
            if (channel.platform !== "instagram") return badRequest("Canal não é do Instagram");
        }

        const created = await prisma.igOutboundWebhook.create({
            data: {
                ...outboundToDb(data),
                user_id: userId,
            } as Prisma.IgOutboundWebhookUncheckedCreateInput,
        });

        return NextResponse.json(serializeOutboundWebhook(created), { status: 201 });
    } catch (error: unknown) {
        console.error("Create ig outbound webhook error:", error);
        return badRequest(getErrorMessage(error));
    }
}
