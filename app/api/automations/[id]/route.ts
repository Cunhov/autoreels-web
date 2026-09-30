import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import {
    isPlainObject,
    parseJsonArray,
    validateAutomationInput,
    type ValidatedActionInput,
} from "@/lib/ig-automation/validate";
import {
    CHANNEL_SUMMARY_SELECT,
    actionToDb,
    automationToDb,
    badRequest,
    findOwnedChannel,
    notFound,
    readJsonBody,
    requireUserId,
    serializeAction,
    serializeAutomation,
    unauthorized,
} from "../../ig/shared";

const AUTOMATION_INCLUDE = {
    actions: { orderBy: { position: "asc" as const } },
    channel: { select: CHANNEL_SUMMARY_SELECT },
} satisfies Prisma.IgAutomationInclude;

type RouteParams = { params: Promise<{ id: string }> };

/**
 * FIX-M9: valida ownership das referências das ações — `sequenceId` pertence ao
 * user (e ao canal efetivo da automação) e `webhookId` pertence ao user
 * (global ou do canal efetivo). Erro HTTP pronto ou null quando tudo ok.
 */
async function validateActionReferences(
    userId: string,
    actions: ValidatedActionInput[] | undefined,
    channelId: string,
): Promise<{ status: 400 | 404; error: string } | null> {
    if (!actions || actions.length === 0) return null;

    const sequenceIds = Array.from(
        new Set(
            actions
                .map((action) => action.sequenceId)
                .filter((id): id is string => typeof id === "string" && id !== "")
        )
    );
    if (sequenceIds.length > 0) {
        const sequences = await prisma.igSequence.findMany({
            where: { id: { in: sequenceIds }, user_id: userId },
            select: { id: true, channel_id: true },
        });
        const byId = new Map(sequences.map((s) => [s.id, s.channel_id]));
        for (const id of sequenceIds) {
            if (!byId.has(id)) {
                return { status: 404, error: "Sequência não encontrada" };
            }
            if (byId.get(id) !== channelId) {
                return { status: 400, error: "Sequência pertence a outro canal" };
            }
        }
    }

    const webhookIds = Array.from(
        new Set(
            actions
                .map((action) => action.webhookId)
                .filter((id): id is string => typeof id === "string" && id !== "")
        )
    );
    if (webhookIds.length > 0) {
        const webhooks = await prisma.igOutboundWebhook.findMany({
            where: { id: { in: webhookIds }, user_id: userId },
            select: { id: true, channel_id: true },
        });
        const byId = new Map(webhooks.map((w) => [w.id, w.channel_id]));
        for (const id of webhookIds) {
            if (!byId.has(id)) {
                return { status: 404, error: "Webhook de saída não encontrado" };
            }
            const webhookChannel = byId.get(id);
            if (webhookChannel !== null && webhookChannel !== channelId) {
                return {
                    status: 400,
                    error: "Webhook de saída pertence a outro canal",
                };
            }
        }
    }

    return null;
}

async function findOwnedAutomation(userId: string, id: string) {
    return prisma.igAutomation.findFirst({
        where: { id, user_id: userId },
        include: AUTOMATION_INCLUDE,
    });
}

/** GET /api/automations/[id] */
export async function GET(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const automation = await findOwnedAutomation(userId, id);
        if (!automation) return notFound("Automação não encontrada");

        return NextResponse.json({
            ...serializeAutomation(automation),
            actions: automation.actions.map(serializeAction),
            channel: automation.channel,
        });
    } catch (error: unknown) {
        console.error("Get automation error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/** PATCH /api/automations/[id] — parcial; se `actions` vier, substitui o conjunto. */
export async function PATCH(req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igAutomation.findFirst({
            where: { id, user_id: userId },
            select: {
                id: true,
                channel_id: true,
                keywords: true,
                match_type: true,
            },
        });
        if (!existing) return notFound("Automação não encontrada");

        const body = await readJsonBody(req);
        const result = validateAutomationInput(body, {
            partial: true,
            existingKeywords: parseJsonArray(existing.keywords),
            existingMatchType: existing.match_type,
        });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;

        const dbData = automationToDb(data);

        // Canal pode ser trocado via PATCH (valida ownership + plataforma).
        let effectiveChannelId = existing.channel_id;
        if (isPlainObject(body) && body.channelId !== undefined) {
            if (typeof body.channelId !== "string" || !body.channelId.trim()) {
                return badRequest("Canal inválido");
            }
            const channel = await findOwnedChannel(userId, body.channelId.trim());
            if (!channel) return notFound("Canal não encontrado");
            if (channel.platform !== "instagram") {
                return badRequest("Canal não é do Instagram");
            }
            dbData.channel_id = channel.id;
            effectiveChannelId = channel.id;
        }

        // FIX-M9: sequência/webhook referenciados precisam ser do user/canal.
        if (data.actions !== undefined) {
            const referenceError = await validateActionReferences(
                userId,
                data.actions,
                effectiveChannelId,
            );
            if (referenceError) {
                return referenceError.status === 404
                    ? notFound(referenceError.error)
                    : badRequest(referenceError.error);
            }
        }

        const automation = await prisma.$transaction(async (tx) => {
            if (data.actions !== undefined) {
                await tx.igAutomationAction.deleteMany({ where: { automation_id: id } });
                if (data.actions.length > 0) {
                    await tx.igAutomationAction.createMany({
                        data: data.actions.map((action) => actionToDb(action, id)),
                    });
                }
            }
            await tx.igAutomation.update({ where: { id }, data: dbData });
            return tx.igAutomation.findUniqueOrThrow({
                where: { id },
                include: AUTOMATION_INCLUDE,
            });
        });

        return NextResponse.json({
            ...serializeAutomation(automation),
            actions: automation.actions.map(serializeAction),
            channel: automation.channel,
        });
    } catch (error: unknown) {
        console.error("Update automation error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/** DELETE /api/automations/[id] */
export async function DELETE(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igAutomation.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
        });
        if (!existing) return notFound("Automação não encontrada");

        await prisma.igAutomation.delete({ where: { id } });
        return NextResponse.json({ ok: true });
    } catch (error: unknown) {
        console.error("Delete automation error:", error);
        return badRequest(getErrorMessage(error));
    }
}
