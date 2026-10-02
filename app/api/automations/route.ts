import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { validateAutomationInput } from "@/lib/ig-automation/validate";
import { AUTOMATION_INCLUDE, actionForChannel, normalizeMediaIds, profileGroupId, serializeGroup, serializePhysical, validateActionMappings, validateActionReferences, validateChannelMapKeys, withProfileGroup } from "@/lib/ig-automation/profile-groups";
import {
    actionToDb, automationToDb, badRequest, notFound, readJsonBody, requireUserId, unauthorized,
} from "../ig/shared";

export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();
    try {
        const { searchParams } = new URL(req.url);
        const channelId = searchParams.get("channelId") ?? searchParams.get("channel_id");
        const grouped = searchParams.get("grouped") === "1";
        const rows = await prisma.igAutomation.findMany({
            where: { user_id: userId, ...(grouped ? {} : channelId ? { channel_id: channelId } : {}) },
            include: AUTOMATION_INCLUDE,
            orderBy: [{ priority: "desc" }, { created_at: "asc" }],
        });
        if (!grouped) return NextResponse.json({ automations: rows.map(serializePhysical) });
        const buckets = new Map<string, any[]>();
        for (const row of rows) {
            const key = profileGroupId(row.settings) ?? row.id;
            const group = buckets.get(key) ?? []; group.push(row); buckets.set(key, group);
        }
        const automations = [...buckets.values()]
            .filter((group) => !channelId || group.some((row) => row.channel_id === channelId))
            .map(serializeGroup);
        return NextResponse.json({ automations });
    } catch (error: unknown) {
        console.error("List automations error:", error);
        return badRequest(getErrorMessage(error));
    }
}

export async function POST(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();
    try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) return badRequest("Corpo da requisição inválido");
        const raw = body as Record<string, unknown>;
        const result = validateAutomationInput(body, { partial: false });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;
        let ids: string[];
        if (raw.channelIds !== undefined) {
            if (!Array.isArray(raw.channelIds) || raw.channelIds.length < 1 || raw.channelIds.some((x) => typeof x !== "string" || !x.trim())) return badRequest("Perfis inválidos");
            ids = [...new Set((raw.channelIds as string[]).map((x) => x.trim()))];
            if (ids.length !== raw.channelIds.length) return badRequest("Perfis duplicados");
        } else if (typeof raw.channelId === "string" && raw.channelId.trim()) ids = [raw.channelId.trim()];
        else return badRequest("Canal é obrigatório");
        const channels = await prisma.channel.findMany({ where: { id: { in: ids }, user_id: userId }, select: { id: true, platform: true } });
        if (channels.length !== ids.length) return notFound("Canal não encontrado");
        if (channels.some((c) => c.platform !== "instagram")) return badRequest("Canal não é do Instagram");
        const mediaMap = raw.mediaIdsByChannel;
        if (mediaMap !== undefined && (!mediaMap || typeof mediaMap !== "object" || Array.isArray(mediaMap))) return badRequest("Mapeamento de posts inválido");
        if (mediaMap && Object.keys(mediaMap as object).some((id) => !ids.includes(id))) return badRequest("Mapeamento contém perfil fora da automação");
        const mediaByChannel = new Map<string, string[] | null>();
        for (const id of ids) {
            const values = mediaMap ? (mediaMap as Record<string, unknown>)[id] ?? [] : data.mediaIds === undefined ? [] : data.mediaIds;
            if (values === null) { mediaByChannel.set(id, null); continue; }
            const normalized = normalizeMediaIds(values);
            if (!normalized) return badRequest("Lista de posts inválida");
            mediaByChannel.set(id, normalized);
        }
        const mapError = validateChannelMapKeys(data.actions, ids);
        if (mapError) return badRequest(mapError);
        const mappingError = validateActionMappings(data.actions, ids);
        if (mappingError) return badRequest(mappingError);
        for (const channelId of ids) {
            const err = await validateActionReferences(userId, data.actions?.map((a) => actionForChannel(a, channelId)), channelId);
            if (err) return err.status === 404 ? notFound(err.error) : badRequest(err.error);
        }
        const createdRows = await prisma.$transaction(async (tx) => {
            const made: string[] = [];
            for (const channelId of ids) {
                const settings = { ...(data.settings ?? {}) };
                delete settings._profileGroupId;
                const created = await tx.igAutomation.create({ data: {
                    ...automationToDb({ ...data, mediaIds: mediaByChannel.get(channelId), settings }),
                    ...(ids.length > 1 ? { settings: withProfileGroup(settings, "pending") } : {}),
                    user_id: userId, channel_id: channelId,
                    ...(data.enabled === undefined ? { enabled: false } : {}),
                } as Prisma.IgAutomationUncheckedCreateInput });
                if (data.actions?.length) await tx.igAutomationAction.createMany({ data: data.actions.map((a) => actionToDb(actionForChannel(a, channelId), created.id)) });
                made.push(created.id);
                if (ids.length > 1 && made.length === 1) {
                    // Initial leader ID is the stable logical ID for the group.
                    await tx.igAutomation.update({ where: { id: created.id }, data: { settings: withProfileGroup(settings, created.id) } });
                } else if (ids.length > 1) {
                    await tx.igAutomation.update({ where: { id: created.id }, data: { settings: withProfileGroup(settings, made[0]) } });
                }
            }
            return tx.igAutomation.findMany({ where: { id: { in: made } }, include: AUTOMATION_INCLUDE, orderBy: { created_at: "asc" } });
        });
        return NextResponse.json(ids.length > 1 ? serializeGroup(createdRows) : serializePhysical(createdRows[0]), { status: 201 });
    } catch (error: unknown) {
        console.error("Create automation error:", error);
        return badRequest(getErrorMessage(error));
    }
}
