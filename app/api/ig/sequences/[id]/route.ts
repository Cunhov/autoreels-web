import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { validateSequenceInput } from "@/lib/ig-automation/validate";
import {
    badRequest,
    findOwnedChannel,
    notFound,
    readJsonBody,
    requireUserId,
    sequenceStepToDb,
    serializeSequence,
    unauthorized,
} from "../../shared";

type RouteParams = { params: Promise<{ id: string }> };

async function findOwnedSequence(userId: string, id: string) {
    return prisma.igSequence.findFirst({ where: { id, user_id: userId } });
}

/** GET /api/ig/sequences/[id] */
export async function GET(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const sequence = await findOwnedSequence(userId, id);
        if (!sequence) return notFound("Sequência não encontrada");
        return NextResponse.json(serializeSequence(sequence));
    } catch (error: unknown) {
        console.error("Get ig sequence error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/** PATCH /api/ig/sequences/[id] */
export async function PATCH(req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igSequence.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
        });
        if (!existing) return notFound("Sequência não encontrada");

        const body = await readJsonBody(req);
        const result = validateSequenceInput(body, { partial: true });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;

        const updateData: Prisma.IgSequenceUncheckedUpdateInput = {};
        if (data.name !== undefined) updateData.name = data.name;
        if (data.enabled !== undefined) updateData.enabled = data.enabled;
        if (data.channelId !== undefined) {
            const channel = await findOwnedChannel(userId, data.channelId);
            if (!channel) return notFound("Canal não encontrado");
            if (channel.platform !== "instagram") return badRequest("Canal não é do Instagram");
            updateData.channel_id = channel.id;
        }
        if (data.steps !== undefined) {
            updateData.steps = JSON.stringify(data.steps.map(sequenceStepToDb));
        }

        const sequence = await prisma.igSequence.update({ where: { id }, data: updateData });
        return NextResponse.json(serializeSequence(sequence));
    } catch (error: unknown) {
        console.error("Update ig sequence error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/** DELETE /api/ig/sequences/[id] */
export async function DELETE(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igSequence.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
        });
        if (!existing) return notFound("Sequência não encontrada");

        await prisma.igSequence.delete({ where: { id } });
        return NextResponse.json({ ok: true });
    } catch (error: unknown) {
        console.error("Delete ig sequence error:", error);
        return badRequest(getErrorMessage(error));
    }
}
