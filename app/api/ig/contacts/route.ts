import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { isPlainObject, validateContactPatch } from "@/lib/ig-automation/validate";
import {
    badRequest,
    cursorOrFilter,
    findOwnedChannel,
    firstParam,
    notFound,
    parseCursorParam,
    parseLimitParam,
    readJsonBody,
    requireUserId,
    serializeContact,
    unauthorized,
} from "../shared";

function optionalText(value: unknown, max: number, label: string): string | null | { error: string } {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") return { error: `${label} inválido` };
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > max) return { error: `${label} deve ter no máximo ${max} caracteres` };
    return trimmed;
}

/**
 * GET /api/ig/contacts?channelId=&q=&tag=&limit=&cursor=
 *   → { items: IgContact[], nextCursor }
 */
export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const { searchParams } = new URL(req.url);
        const limit = parseLimitParam(searchParams.get("limit"), 30, 100);
        const cursorId = parseCursorParam(searchParams.get("cursor"));
        const channelId = firstParam(searchParams, "channelId", "channel_id");
        const q = firstParam(searchParams, "q", "search");
        const tag = firstParam(searchParams, "tag");

        const baseWhere: Prisma.IgContactWhereInput = { user_id: userId };
        if (channelId) baseWhere.channel_id = channelId;
        if (q) {
            const needle = q.trim();
            baseWhere.OR = [
                { username: { contains: needle } },
                { name: { contains: needle } },
            ];
        }
        if (tag) {
            // Tags são armazenadas como JSON array string — o token com aspas evita
            // que "cat" case com "category".
            baseWhere.tags = { contains: JSON.stringify(tag.trim()) };
        }

        let where: Prisma.IgContactWhereInput = baseWhere;
        if (cursorId) {
            const cursor = await prisma.igContact.findFirst({
                where: { id: cursorId, user_id: userId },
                select: { id: true, created_at: true },
            });
            // `AND` preserva o OR da busca (`q`) e os filtros tag/channelId;
            // o spread antigo sobrescrevia `OR` e perdia a busca na 2ª página.
            if (cursor) where = { AND: [baseWhere, cursorOrFilter(cursor)] };
        }

        const rows = await prisma.igContact.findMany({
            where,
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: limit + 1,
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? page[page.length - 1].id : null;

        return NextResponse.json({ items: page.map(serializeContact), nextCursor });
    } catch (error: unknown) {
        console.error("List ig contacts error:", error);
        return badRequest(getErrorMessage(error));
    }
}

/**
 * POST /api/ig/contacts — criação manual (upsert defensivo por channel+igUserId).
 */
export async function POST(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body)) return badRequest("Corpo da requisição inválido");

        const igUserId = optionalText(body.igUserId, 120, "igUserId");
        if (igUserId === null || typeof igUserId !== "string") {
            return badRequest("igUserId é obrigatório");
        }
        const channelId = optionalText(body.channelId, 100, "channelId");
        if (channelId === null || typeof channelId !== "string") {
            return badRequest("channelId é obrigatório");
        }

        const channel = await findOwnedChannel(userId, channelId);
        if (!channel) return notFound("Canal não encontrado");
        if (channel.platform !== "instagram") return badRequest("Canal não é do Instagram");

        const patch = validateContactPatch(body);
        if (!patch.ok) return badRequest(patch.error);

        const username = optionalText(body.username, 120, "username");
        if (username && typeof username === "object") return badRequest(username.error);
        const name = optionalText(body.name, 200, "name");
        if (name && typeof name === "object") return badRequest(name.error);
        const profilePicture = optionalText(body.profilePicture, 1000, "profilePicture");
        if (profilePicture && typeof profilePicture === "object") return badRequest(profilePicture.error);

        const createData: Prisma.IgContactUncheckedCreateInput = {
            user_id: userId,
            channel_id: channelId,
            ig_user_id: igUserId,
            username: typeof username === "string" ? username : null,
            name: typeof name === "string" ? name : null,
            profile_picture: typeof profilePicture === "string" ? profilePicture : null,
            tags: patch.data.tags ? JSON.stringify(patch.data.tags) : null,
            notes: patch.data.notes ?? null,
            custom_fields: patch.data.customFields ? JSON.stringify(patch.data.customFields) : null,
        };

        const updateData: Prisma.IgContactUncheckedUpdateInput = {};
        if (typeof username === "string") updateData.username = username;
        if (typeof name === "string") updateData.name = name;
        if (typeof profilePicture === "string") updateData.profile_picture = profilePicture;
        if (patch.data.tags !== undefined) updateData.tags = JSON.stringify(patch.data.tags);
        if (patch.data.notes !== undefined) updateData.notes = patch.data.notes;
        if (patch.data.customFields !== undefined) {
            updateData.custom_fields = patch.data.customFields ? JSON.stringify(patch.data.customFields) : null;
        }

        const contact = await prisma.igContact.upsert({
            where: {
                channel_id_ig_user_id: { channel_id: channelId, ig_user_id: igUserId },
            },
            create: createData,
            update: updateData,
        });

        return NextResponse.json(serializeContact(contact));
    } catch (error: unknown) {
        console.error("Create ig contact error:", error);
        return badRequest(getErrorMessage(error));
    }
}
