import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { isPlainObject, validateAutomationInput } from "@/lib/ig-automation/validate";
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
            select: { id: true },
        });
        if (!existing) return notFound("Automação não encontrada");

        const body = await readJsonBody(req);
        const result = validateAutomationInput(body, { partial: true });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;

        const dbData = automationToDb(data);

        // Canal pode ser trocado via PATCH (valida ownership + plataforma).
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
