import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { validateContactPatch } from "@/lib/ig-automation/validate";
import {
    badRequest,
    notFound,
    readJsonBody,
    requireUserId,
    serializeContact,
    unauthorized,
} from "../../shared";

type RouteParams = { params: Promise<{ id: string }> };

async function findOwnedContact(userId: string, id: string) {
    return prisma.igContact.findFirst({ where: { id, user_id: userId } });
}

/** GET /api/ig/contacts/[id] */
export async function GET(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const contact = await findOwnedContact(userId, id);
        if (!contact) return notFound("Contato não encontrado");
        return NextResponse.json(serializeContact(contact));
    } catch (error: unknown) {
        console.error("Get ig contact error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/** PATCH /api/ig/contacts/[id] — {tags?, notes?, customFields?, botPausedUntil?} */
export async function PATCH(req: Request, { params }: RouteParams) {
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
        const patch = validateContactPatch(body);
        if (!patch.ok) return badRequest(patch.error);

        const data: Prisma.IgContactUncheckedUpdateInput = {};
        if (patch.data.tags !== undefined) {
            data.tags = patch.data.tags.length > 0 ? JSON.stringify(patch.data.tags) : null;
        }
        if (patch.data.notes !== undefined) data.notes = patch.data.notes;
        if (patch.data.customFields !== undefined) {
            data.custom_fields = patch.data.customFields
                ? JSON.stringify(patch.data.customFields)
                : null;
        }
        if (patch.data.botPausedUntil !== undefined) data.bot_paused_until = patch.data.botPausedUntil;

        const contact = await prisma.igContact.update({ where: { id }, data });
        return NextResponse.json(serializeContact(contact));
    } catch (error: unknown) {
        console.error("Update ig contact error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/** DELETE /api/ig/contacts/[id] */
export async function DELETE(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igContact.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
        });
        if (!existing) return notFound("Contato não encontrado");

        await prisma.igContact.delete({ where: { id } });
        return NextResponse.json({ ok: true });
    } catch (error: unknown) {
        console.error("Delete ig contact error:", error);
        return badRequest(getErrorMessage(error));
    }
}
