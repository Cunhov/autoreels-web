import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { isPlainObject } from "@/lib/ig-automation/validate";
import {
    badRequest,
    notFound,
    readJsonBody,
    requireUserId,
    unauthorized,
} from "../../../shared";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/ig/sequences/[id]/enroll — body {contactId}
 * Valida contato do usuário/canal e faz upsert (unique sequence+contact).
 */
export async function POST(req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const sequence = await prisma.igSequence.findFirst({
            where: { id, user_id: userId },
            select: { id: true, channel_id: true, enabled: true },
        });
        if (!sequence) return notFound("Sequência não encontrada");

        const body = await readJsonBody(req);
        if (!isPlainObject(body) || typeof body.contactId !== "string" || !body.contactId.trim()) {
            return badRequest("contactId é obrigatório");
        }

        const contact = await prisma.igContact.findFirst({
            where: { id: body.contactId.trim(), user_id: userId },
            select: { id: true, channel_id: true },
        });
        if (!contact) return notFound("Contato não encontrado");
        if (contact.channel_id !== sequence.channel_id) {
            return badRequest("Contato pertence a outro canal");
        }

        const now = new Date();
        const enrollment = await prisma.igSequenceEnrollment.upsert({
            where: {
                sequence_id_contact_id: {
                    sequence_id: sequence.id,
                    contact_id: contact.id,
                },
            },
            create: {
                sequence_id: sequence.id,
                contact_id: contact.id,
                channel_id: sequence.channel_id,
                current_step: 0,
                status: "active",
                next_run_at: now,
            },
            update: {
                status: "active",
                current_step: 0,
                next_run_at: now,
                started_at: now,
            },
        });

        return NextResponse.json(enrollment, { status: 201 });
    } catch (error: unknown) {
        console.error("Enroll ig sequence error:", error);
        return badRequest(getErrorMessage(error));
    }
}
