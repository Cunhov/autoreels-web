import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import {
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
} from "../ig/shared";

const AUTOMATION_INCLUDE = {
    actions: { orderBy: { position: "asc" as const } },
    channel: { select: CHANNEL_SUMMARY_SELECT },
} satisfies Prisma.IgAutomationInclude;

/**
 * FIX-M9: valida ownership das referências das ações — `sequenceId` pertence ao
 * user (e ao mesmo canal da automação) e `webhookId` pertence ao user (global
 * ou do mesmo canal). Devolve o erro HTTP pronto ou null quando tudo ok.
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

/**
 * GET /api/automations?channelId=
 *   → { automations: [Automation & { actions, channel }] }
 */
export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const { searchParams } = new URL(req.url);
        const channelId = searchParams.get("channelId") ?? searchParams.get("channel_id");

        const automations = await prisma.igAutomation.findMany({
            where: {
                user_id: userId,
                ...(channelId ? { channel_id: channelId } : {}),
            },
            include: AUTOMATION_INCLUDE,
            orderBy: [{ priority: "desc" }, { created_at: "asc" }],
        });

        return NextResponse.json({
            automations: automations.map((automation) => ({
                ...serializeAutomation(automation),
                actions: automation.actions.map(serializeAction),
                channel: automation.channel,
            })),
        });
    } catch (error: unknown) {
        console.error("List automations error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/**
 * POST /api/automations — cria a automação + ações em transação.
 */
export async function POST(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const body = await readJsonBody(req);
        const result = validateAutomationInput(body, { partial: false });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return badRequest("Corpo da requisição inválido");
        }
        const rawChannelId = (body as Record<string, unknown>).channelId;
        if (typeof rawChannelId !== "string" || !rawChannelId.trim()) {
            return badRequest("Canal é obrigatório");
        }
        const channel = await findOwnedChannel(userId, rawChannelId.trim());
        if (!channel) return notFound("Canal não encontrado");
        if (channel.platform !== "instagram") {
            return badRequest("Canal não é do Instagram");
        }

        // FIX-M9: sequência/webhook referenciados precisam ser do user/canal.
        const referenceError = await validateActionReferences(
            userId,
            data.actions,
            channel.id,
        );
        if (referenceError) {
            return referenceError.status === 404
                ? notFound(referenceError.error)
                : badRequest(referenceError.error);
        }

        const automation = await prisma.$transaction(async (tx) => {
            const created = await tx.igAutomation.create({
                data: {
                    ...automationToDb(data),
                    user_id: userId,
                    channel_id: channel.id,
                } as Prisma.IgAutomationUncheckedCreateInput,
            });
            if (data.actions && data.actions.length > 0) {
                await tx.igAutomationAction.createMany({
                    data: data.actions.map((action) => actionToDb(action, created.id)),
                });
            }
            return tx.igAutomation.findUniqueOrThrow({
                where: { id: created.id },
                include: AUTOMATION_INCLUDE,
            });
        });

        return NextResponse.json(
            {
                ...serializeAutomation(automation),
                actions: automation.actions.map(serializeAction),
                channel: automation.channel,
            },
            { status: 201 }
        );
    } catch (error: unknown) {
        console.error("Create automation error:", error);
        return badRequest(getErrorMessage(error));
    }
}
