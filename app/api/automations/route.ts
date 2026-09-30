import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { validateAutomationInput } from "@/lib/ig-automation/validate";
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
