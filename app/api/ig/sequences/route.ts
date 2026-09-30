import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { validateSequenceInput } from "@/lib/ig-automation/validate";
import {
    badRequest,
    findOwnedChannel,
    firstParam,
    notFound,
    readJsonBody,
    requireUserId,
    sequenceStepToDb,
    serializeSequence,
    unauthorized,
} from "../shared";

/**
 * GET /api/ig/sequences?channelId=
 *   → Sequence[] (steps parseados)
 */
export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const { searchParams } = new URL(req.url);
        const channelId = firstParam(searchParams, "channelId", "channel_id");

        const sequences = await prisma.igSequence.findMany({
            where: {
                user_id: userId,
                ...(channelId ? { channel_id: channelId } : {}),
            },
            orderBy: { created_at: "desc" },
        });

        return NextResponse.json(sequences.map(serializeSequence));
    } catch (error: unknown) {
        console.error("List ig sequences error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/**
 * POST /api/ig/sequences — body {name, channelId, enabled?, steps?}
 */
export async function POST(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const body = await readJsonBody(req);
        const result = validateSequenceInput(body, { partial: false });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;
        if (!data.channelId) return badRequest("Canal é obrigatório");

        const channel = await findOwnedChannel(userId, data.channelId);
        if (!channel) return notFound("Canal não encontrado");
        if (channel.platform !== "instagram") return badRequest("Canal não é do Instagram");

        const steps = (data.steps ?? []).map(sequenceStepToDb);

        const sequence = await prisma.igSequence.create({
            data: {
                user_id: userId,
                channel_id: channel.id,
                name: data.name ?? "Sequência",
                enabled: data.enabled ?? true,
                steps: JSON.stringify(steps),
            } as Prisma.IgSequenceUncheckedCreateInput,
        });

        return NextResponse.json(serializeSequence(sequence), { status: 201 });
    } catch (error: unknown) {
        console.error("Create ig sequence error:", error);
        return badRequest(getErrorMessage(error));
    }
}
