import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import {
    badRequest,
    notFound,
    requireUserId,
    serializeContact,
    unauthorized,
} from "../../../shared";

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/ig/contacts/[id]/resume — limpa bot_paused_until. */
export async function POST(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igContact.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
        });
        if (!existing) return notFound("Contato não encontrado");

        const contact = await prisma.igContact.update({
            where: { id },
            data: { bot_paused_until: null },
        });

        return NextResponse.json(serializeContact(contact));
    } catch (error: unknown) {
        console.error("Resume ig contact error:", error);
        return badRequest(getErrorMessage(error));
    }
}
