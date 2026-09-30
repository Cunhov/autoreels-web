import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { isPlainObject } from "@/lib/ig-automation/validate";
import {
    badRequest,
    notFound,
    readJsonBody,
    requireUserId,
    serializeContact,
    unauthorized,
} from "../../../shared";

type RouteParams = { params: Promise<{ id: string }> };

const HOUR_MS = 60 * 60 * 1000;

/** POST /api/ig/contacts/[id]/pause — body {hours?} (default 24; 1..8760). */
export async function POST(req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igContact.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
        });
        if (!existing) return notFound("Contato não encontrado");

        const body = await readJsonBody(req);
        let hours = 24;
        if (isPlainObject(body) && body.hours !== undefined && body.hours !== null && body.hours !== "") {
            const parsed = typeof body.hours === "number" ? body.hours : Number(body.hours);
            if (!Number.isFinite(parsed) || parsed < 1 || parsed > 8760) {
                return badRequest("Horas de pausa deve estar entre 1 e 8760");
            }
            hours = parsed;
        }

        const contact = await prisma.igContact.update({
            where: { id },
            data: { bot_paused_until: new Date(Date.now() + hours * HOUR_MS) },
        });

        return NextResponse.json(serializeContact(contact));
    } catch (error: unknown) {
        console.error("Pause ig contact error:", error);
        return badRequest(getErrorMessage(error));
    }
}
