import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { isPlainObject, MAX_SUBSTANCE_IMPORT, validateSubstanceInput } from "@/lib/ig-automation/validate";
import {
    badRequest,
    readJsonBody,
    requireUserId,
    unauthorized,
} from "../../shared";

/**
 * POST /api/ig/substances/import — body {substances:[...]}
 * Upsert em lote por keyword (1..500 itens) → {imported, updated}.
 */
export async function POST(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body) || !Array.isArray(body.substances)) {
            return badRequest("Envie uma lista de substâncias");
        }
        const rawList = body.substances;
        if (rawList.length === 0) return badRequest("Envie ao menos uma substância");
        if (rawList.length > MAX_SUBSTANCE_IMPORT) {
            return badRequest(`Máximo de ${MAX_SUBSTANCE_IMPORT} substâncias por importação`);
        }

        const validated: Array<{
            keyword: string;
            name: string;
            keywords: string[];
            description: string;
            action: string;
            dosage: string;
            duration: string;
            url: string | null;
            enabled: boolean;
        }> = [];
        const byKeyword = new Map<string, (typeof validated)[number]>();
        for (let i = 0; i < rawList.length; i++) {
            const result = validateSubstanceInput(rawList[i], { partial: false });
            if (!result.ok) return badRequest(`Substância ${i + 1}: ${result.error}`);
            const data = result.data;
            if (!data.keyword) return badRequest(`Substância ${i + 1}: keyword é obrigatória`);
            const item = {
                keyword: data.keyword,
                name: data.name ?? data.keyword,
                keywords: data.keywords ?? [],
                description: data.description ?? "",
                action: data.action ?? "",
                dosage: data.dosage ?? "",
                duration: data.duration ?? "",
                url: data.url ?? null,
                enabled: data.enabled ?? true,
            };
            byKeyword.set(item.keyword, item);
        }
        validated.push(...byKeyword.values());

        const keywords = validated.map((item) => item.keyword);
        const existing = await prisma.igSubstance.findMany({
            where: { keyword: { in: keywords } },
            select: { id: true, keyword: true, user_id: true },
        });
        const foreign = existing.find((row) => row.user_id && row.user_id !== userId);
        if (foreign) {
            return NextResponse.json(
                { error: `Keyword "${foreign.keyword}" já cadastrada por outro usuário` },
                { status: 409 }
            );
        }

        const updatedCount = existing.length;

        await prisma.$transaction(async (tx) => {
            for (const item of validated) {
                const found = existing.find((row) => row.keyword === item.keyword);
                if (found) {
                    await tx.igSubstance.update({
                        where: { id: found.id },
                        data: {
                            user_id: userId,
                            name: item.name,
                            keywords: JSON.stringify(item.keywords),
                            description: item.description,
                            action: item.action,
                            dosage: item.dosage,
                            duration: item.duration,
                            url: item.url,
                            enabled: item.enabled,
                        },
                    });
                } else {
                    await tx.igSubstance.create({
                        data: {
                            user_id: userId,
                            keyword: item.keyword,
                            name: item.name,
                            keywords: JSON.stringify(item.keywords),
                            description: item.description,
                            action: item.action,
                            dosage: item.dosage,
                            duration: item.duration,
                            url: item.url,
                            enabled: item.enabled,
                        },
                    });
                }
            }
        });

        return NextResponse.json({
            imported: validated.length - updatedCount,
            updated: updatedCount,
        });
    } catch (error: unknown) {
        console.error("Import ig substances error:", error);
        return badRequest(getErrorMessage(error));
    }
}
