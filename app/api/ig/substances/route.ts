import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { validateSubstanceInput } from "@/lib/ig-automation/validate";
import {
    badRequest,
    firstParam,
    readJsonBody,
    requireUserId,
    serializeSubstance,
    substanceToDb,
    unauthorized,
} from "../shared";

/**
 * GET /api/ig/substances?q=
 *   → Substance[] (busca opcional em keyword/name, ordenado por name)
 */
export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const { searchParams } = new URL(req.url);
        const q = firstParam(searchParams, "q", "search");

        const where: Prisma.IgSubstanceWhereInput = { user_id: userId };
        if (q) {
            const needle = q.trim();
            where.OR = [
                { keyword: { contains: needle } },
                { name: { contains: needle } },
            ];
        }

        const substances = await prisma.igSubstance.findMany({
            where,
            orderBy: { name: "asc" },
        });

        return NextResponse.json(substances.map(serializeSubstance));
    } catch (error: unknown) {
        console.error("List ig substances error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/**
 * POST /api/ig/substances — upsert manual por keyword.
 */
export async function POST(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const body = await readJsonBody(req);
        const result = validateSubstanceInput(body, { partial: false });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;
        const keyword = data.keyword;
        if (!keyword) return badRequest("Keyword é obrigatória");

        const existing = await prisma.igSubstance.findUnique({ where: { keyword } });
        // keyword é única globalmente: registro global (user_id null) nunca é
        // alterado/sequestrado — respondemos 409 informativo.
        if (existing && existing.user_id !== userId) {
            return NextResponse.json(
                {
                    error: existing.user_id === null
                        ? `Keyword "${keyword}" já existe no catálogo global e não pode ser alterada`
                        : "Substância já cadastrada por outro usuário",
                },
                { status: 409 }
            );
        }

        if (existing) {
            const updated = await prisma.igSubstance.update({
                where: { id: existing.id },
                data: { ...substanceToDb(data), user_id: userId },
            });
            return NextResponse.json(serializeSubstance(updated));
        }

        const created = await prisma.igSubstance.create({
            data: {
                user_id: userId,
                keyword,
                name: data.name ?? keyword,
                keywords: JSON.stringify(data.keywords ?? []),
                description: data.description ?? "",
                action: data.action ?? "",
                dosage: data.dosage ?? "",
                duration: data.duration ?? "",
                url: data.url ?? null,
                enabled: data.enabled ?? true,
            },
        });
        return NextResponse.json(serializeSubstance(created), { status: 201 });
    } catch (error: unknown) {
        console.error("Create ig substance error:", error);
        return badRequest(getErrorMessage(error));
    }
}
