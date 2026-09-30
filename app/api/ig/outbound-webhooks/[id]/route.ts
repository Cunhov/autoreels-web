import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { validateOutboundInput } from "@/lib/ig-automation/validate";
import {
    badRequest,
    findOwnedChannel,
    notFound,
    outboundToDb,
    readJsonBody,
    requireUserId,
    serializeOutboundWebhook,
    unauthorized,
} from "../../shared";

type RouteParams = { params: Promise<{ id: string }> };

async function findOwnedWebhook(userId: string, id: string) {
    return prisma.igOutboundWebhook.findFirst({ where: { id, user_id: userId } });
}

/** PATCH /api/ig/outbound-webhooks/[id] */
export async function PATCH(req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igOutboundWebhook.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
        });
        if (!existing) return notFound("Webhook não encontrado");

        const body = await readJsonBody(req);
        const result = validateOutboundInput(body, { partial: true });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;

        if (data.channelId) {
            const channel = await findOwnedChannel(userId, data.channelId);
            if (!channel) return notFound("Canal não encontrado");
            if (channel.platform !== "instagram") return badRequest("Canal não é do Instagram");
        }

        const updated = await prisma.igOutboundWebhook.update({
            where: { id },
            data: outboundToDb(data),
        });

        return NextResponse.json(serializeOutboundWebhook(updated));
    } catch (error: unknown) {
        console.error("Update ig outbound webhook error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/** DELETE /api/ig/outbound-webhooks/[id] */
export async function DELETE(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await findOwnedWebhook(userId, id);
        if (!existing) return notFound("Webhook não encontrado");

        await prisma.igOutboundWebhook.delete({ where: { id } });
        return NextResponse.json({ ok: true });
    } catch (error: unknown) {
        console.error("Delete ig outbound webhook error:", error);
        return badRequest(getErrorMessage(error));
    }
}
