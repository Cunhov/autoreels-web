import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { validateSubstanceInput } from "@/lib/ig-automation/validate";
import {
    badRequest,
    notFound,
    readJsonBody,
    requireUserId,
    serializeSubstance,
    substanceToDb,
    unauthorized,
} from "../../shared";

type RouteParams = { params: Promise<{ id: string }> };

/** PATCH /api/ig/substances/[id] */
export async function PATCH(req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igSubstance.findFirst({
            where: { id, user_id: userId },
        });
        if (!existing) return notFound("Substância não encontrada");

        const body = await readJsonBody(req);
        const result = validateSubstanceInput(body, { partial: true });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;

        // Troca de keyword precisa respeitar o unique global.
        if (data.keyword && data.keyword !== existing.keyword) {
            const clash = await prisma.igSubstance.findUnique({ where: { keyword: data.keyword } });
            if (clash) {
                return NextResponse.json(
                    { error: "Já existe uma substância com essa keyword" },
                    { status: 409 }
                );
            }
        }

        const updated = await prisma.igSubstance.update({
            where: { id },
            data: substanceToDb(data),
        });
        return NextResponse.json(serializeSubstance(updated));
    } catch (error: unknown) {
        console.error("Update ig substance error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/** DELETE /api/ig/substances/[id] */
export async function DELETE(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    const { id } = await params;
    try {
        const existing = await prisma.igSubstance.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
        });
        if (!existing) return notFound("Substância não encontrada");

        await prisma.igSubstance.delete({ where: { id } });
        return NextResponse.json({ ok: true });
    } catch (error: unknown) {
        console.error("Delete ig substance error:", error);
        return badRequest(getErrorMessage(error));
    }
}
