import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import { Prisma } from "@prisma/client";
import { isPlainObject, parseJsonArray, parseJsonList, parseJsonObject, validateAutomationInput } from "@/lib/ig-automation/validate";
import { actionForChannel, AUTOMATION_INCLUDE, normalizeMediaIds, profileGroupId, serializeGroup, serializePhysical, validateActionMappings, validateActionReferences, validateChannelMapKeys, withProfileGroup } from "@/lib/ig-automation/profile-groups";
import { actionToDb, automationToDb, badRequest, notFound, readJsonBody, requireUserId, unauthorized } from "../../ig/shared";

type RouteParams = { params: Promise<{ id: string }> };
class ConcurrentGroupEdit extends Error {}

function configurationFingerprint(rows: Prisma.IgAutomationGetPayload<{ include: typeof AUTOMATION_INCLUDE }>[]) {
    return JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)).map(({ stats_sent, stats_matched, stats_failed, stats_clicks, last_run_at, updated_at, channel, ...configuration }) => configuration));
}
async function cancelPendingActionJobs(tx: Prisma.TransactionClient, userId: string, automationIds: string[], actionIds: string[]) {
    if (!automationIds.length && !actionIds.length) return;
    const jobs = await tx.igJob.findMany({ where: { user_id: userId, type: "action", status: "pending" }, select: { id: true, payload: true } });
    const automationSet = new Set(automationIds);
    const actionSet = new Set(actionIds);
    const ids = jobs.filter((job) => {
        try {
            const payload = JSON.parse(job.payload);
            if (!payload || typeof payload !== "object") return false;
            const automationId = payload.automationId ?? payload.automation_id;
            const actionId = payload.actionId ?? payload.action_id;
            return automationSet.has(automationId) || actionSet.has(actionId);
        } catch { return false; }
    }).map((job) => job.id);
    if (ids.length) await tx.igJob.updateMany({ where: { id: { in: ids }, user_id: userId, status: "pending" }, data: { status: "cancelled" } });
}

async function resolveGroup(userId: string, id: string) {
    const all = await prisma.igAutomation.findMany({ where: { user_id: userId }, include: AUTOMATION_INCLUDE });
    const matched = all.find((row) => row.id === id || profileGroupId(row.settings) === id);
    if (!matched) return null;
    const groupId = profileGroupId(matched.settings);
    const rows = groupId ? all.filter((row) => row.id === groupId || profileGroupId(row.settings) === groupId) : [matched];
    return { groupId, rows };
}

function parseMediaMap(raw: unknown, targets: string[]) {
    if (raw === undefined) return { ok: true as const, map: null as Record<string, string[]> | null };
    if (!isPlainObject(raw) || Object.keys(raw).some((id) => !targets.includes(id))) return { ok: false as const };
    const map: Record<string, string[]> = {};
    for (const [id, value] of Object.entries(raw)) {
        const normalized = normalizeMediaIds(value);
        if (!normalized) return { ok: false as const };
        map[id] = normalized;
    }
    return { ok: true as const, map };
}

function pruneActionMaps(action: any, channelIds: string[]) {
    const parsedConfig = parseJsonObject(action.config);
    const config = parsedConfig ? { ...parsedConfig } : null;
    if (config) for (const key of ["sequenceIdsByChannel", "webhookIdsByChannel"]) {
        if (config[key] && typeof config[key] === "object" && !Array.isArray(config[key])) {
            config[key] = Object.fromEntries(Object.entries(config[key]).filter(([id]) => channelIds.includes(id)));
        }
    }
    return {
        position: action.position, type: action.type, delaySeconds: action.delay_seconds ?? action.delaySeconds ?? 0,
        textVariants: action.text_variants ? parseJsonArray(action.text_variants) : action.textVariants ?? [],
        buttons: action.buttons ? parseJsonList(action.buttons) : null,
        quickReplies: action.quick_replies ? parseJsonList(action.quick_replies) : action.quickReplies ?? null,
        mediaUrl: action.media_url ?? action.mediaUrl ?? null, tag: action.tag ?? null,
        sequenceId: action.sequence_id ?? action.sequenceId ?? null, webhookId: action.webhook_id ?? action.webhookId ?? null,
        aiPrompt: action.ai_prompt ?? action.aiPrompt ?? null, config,
    };
}

export async function GET(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();
    try {
        const { id } = await params;
        const group = await resolveGroup(userId, id);
        if (!group) return notFound("Automação não encontrada");
        return NextResponse.json(group.groupId ? serializeGroup(group.rows) : serializePhysical(group.rows[0]));
    } catch (error: unknown) {
        console.error("Get automation error:", error);
        return badRequest(getErrorMessage(error));
    }
}

export async function PATCH(req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();
    try {
        const { id } = await params;
        const group = await resolveGroup(userId, id);
        if (!group) return notFound("Automação não encontrada");
        const body = await readJsonBody(req);
        if (!isPlainObject(body)) return badRequest("Corpo da requisição inválido");
        const representative = group.rows.find((r) => r.id === group.groupId) ?? group.rows[0];
        const result = validateAutomationInput(body, { partial: true, existingKeywords: parseJsonArray(representative.keywords), existingMatchType: representative.match_type });
        if (!result.ok) return badRequest(result.error);
        const data = result.data;
        const isGroup = !!group.groupId || (Array.isArray(body.channelIds) && body.channelIds.length > 1);
        const logicalGroupId = group.groupId ?? representative.id;

        let desiredIds = group.rows.map((r) => r.channel_id);
        if (body.channelIds !== undefined) {
            if (!Array.isArray(body.channelIds) || !body.channelIds.length || body.channelIds.some((v) => typeof v !== "string" || !v.trim())) return badRequest("Perfis inválidos");
            desiredIds = [...new Set((body.channelIds as string[]).map((v) => v.trim()))];
            if (desiredIds.length !== body.channelIds.length) return badRequest("Perfis duplicados");
        }
        if (body.channelId !== undefined && body.channelIds !== undefined) {
            if (typeof body.channelId !== "string" || !desiredIds.includes(body.channelId.trim())) return badRequest("Canal incompatível com os perfis selecionados");
        } else if (body.channelId !== undefined && !isGroup) {
            if (typeof body.channelId !== "string" || !body.channelId.trim()) return badRequest("Canal inválido");
            desiredIds = [body.channelId.trim()];
        } else if (body.channelId !== undefined && isGroup) return badRequest("Use channelIds para alterar os perfis");

        const channels = await prisma.channel.findMany({ where: { id: { in: desiredIds }, user_id: userId }, select: { id: true, platform: true } });
        if (channels.length !== desiredIds.length) return notFound("Canal não encontrado");
        if (channels.some((c) => c.platform !== "instagram")) return badRequest("Canal não é do Instagram");
        const membershipChanged = desiredIds.length !== group.rows.length || desiredIds.some((id) => !group.rows.some((row) => row.channel_id === id));
        const effectiveActions = data.actions ?? (membershipChanged ? representative.actions.map((action: any) => pruneActionMaps(action, desiredIds)) : undefined);
        const mapError = validateChannelMapKeys(effectiveActions, desiredIds);
        if (mapError) return badRequest(mapError);
        const mappingError = validateActionMappings(effectiveActions, desiredIds);
        if (mappingError) return badRequest(mappingError);
        const referenceChannels = body.channelIds !== undefined ? desiredIds : (body.channelId !== undefined ? desiredIds : group.rows.map((r) => r.channel_id));
        for (const channelId of referenceChannels) {
            const err = await validateActionReferences(userId, effectiveActions?.map((a) => actionForChannel(a, channelId)), channelId);
            if (err) return err.status === 404 ? notFound(err.error) : badRequest(err.error);
        }
        const parsedMap = parseMediaMap(body.mediaIdsByChannel, desiredIds);
        if (!parsedMap.ok) return badRequest("Mapeamento de posts inválido ou contém perfil fora da automação");
        if (isGroup && membershipChanged) {
            const addedProfiles = desiredIds.filter((channelId) => !group.rows.some((row) => row.channel_id === channelId));
            if (addedProfiles.some((channelId) => !parsedMap.map || !Object.prototype.hasOwnProperty.call(parsedMap.map, channelId))) {
                return badRequest("Defina os posts de cada novo perfil. Use uma lista vazia para escolher explicitamente todos os posts.");
            }
        }
        const dbData = automationToDb(data);
        // Strip the reserved marker on all client-provided settings; restore the marker below.
        if (data.settings !== undefined) {
            const safeSettings = { ...(data.settings ?? {}) };
            delete safeSettings._profileGroupId;
            dbData.settings = isGroup ? withProfileGroup(safeSettings, logicalGroupId) : (Object.keys(safeSettings).length ? JSON.stringify(safeSettings) : null);
        }
        if (body.channelId !== undefined && !isGroup) dbData.channel_id = desiredIds[0];

        const currentByChannel = new Map(group.rows.map((r) => [r.channel_id, r]));
        const movingSingle = !isGroup && desiredIds.length === 1 && (body.channelId !== undefined || (body.channelIds !== undefined && desiredIds[0] !== group.rows[0].channel_id));
        const next = await prisma.$transaction(async (tx) => {
            const currentRows = await tx.igAutomation.findMany({ where: { user_id: userId }, include: AUTOMATION_INCLUDE });
            const actual = group.groupId
                ? currentRows.filter((row) => row.id === group.groupId || profileGroupId(row.settings) === group.groupId)
                : currentRows.filter((row) => row.id === representative.id);
            if (configurationFingerprint(actual) !== configurationFingerprint(group.rows)) {
                throw new ConcurrentGroupEdit("Esta automação foi alterada em outra janela. Recarregue os dados antes de salvar.");
            }
            // Existing rows keep their IDs, stats, and logs. New profiles inherit the complete shared config.
            const toRemove = movingSingle ? [] : group.rows.filter((r) => !desiredIds.includes(r.channel_id));
            await cancelPendingActionJobs(tx, userId, toRemove.map((r) => r.id), toRemove.flatMap((r) => r.actions.map((a: any) => a.id)));
            if (data.enabled === false) await cancelPendingActionJobs(tx, userId, group.rows.map((r) => r.id), []);
            if (toRemove.length) await tx.igAutomation.deleteMany({ where: { id: { in: toRemove.map((r) => r.id) }, user_id: userId } });
            for (const channelId of desiredIds) {
                const existing = currentByChannel.get(channelId) ?? (movingSingle ? group.rows[0] : undefined);
                const safeBaseSettings = data.settings !== undefined
                    ? { ...(data.settings ?? {}) }
                    : (parseJsonObject(representative.settings) ?? {});
                delete safeBaseSettings._profileGroupId;
                const settings = isGroup ? withProfileGroup(data.settings === undefined && existing ? (parseJsonObject(existing.settings) ?? {}) : safeBaseSettings, logicalGroupId) : (data.settings !== undefined ? (Object.keys(safeBaseSettings).length ? JSON.stringify(safeBaseSettings) : null) : representative.settings);
                const mediaIds = parsedMap.map?.[channelId] ?? (data.mediaIds !== undefined ? data.mediaIds : existing ? parseJsonArray(existing.media_ids) : parseJsonArray(representative.media_ids));
                if (existing) {
                    const update: any = { ...dbData, media_ids: mediaIds === null ? null : JSON.stringify(mediaIds) };
                    delete update.settings;
                    if (isGroup || data.settings !== undefined) update.settings = settings;
                    if (movingSingle) update.channel_id = desiredIds[0];
                    await tx.igAutomation.update({ where: { id: existing.id }, data: update });
                    if (data.actions !== undefined) {
                        const unused = new Map(existing.actions.map((action: any) => [action.id, action]));
                        const inserts: any[] = [];
                        for (const input of data.actions) {
                            const prior = existing.actions.find((action: any) => action.position === input.position && action.type === input.type && unused.has(action.id));
                            const db = actionToDb(actionForChannel(input, channelId), existing.id) as any;
                            if (prior) {
                                unused.delete(prior.id);
                                delete db.automation_id;
                                await tx.igAutomationAction.update({ where: { id: prior.id }, data: db });
                            } else inserts.push(db);
                        }
                        const removedIds = [...unused.keys()];
                        await cancelPendingActionJobs(tx, userId, [], removedIds);
                        if (removedIds.length) await tx.igAutomationAction.deleteMany({ where: { id: { in: removedIds } } });
                        if (inserts.length) await tx.igAutomationAction.createMany({ data: inserts });
                    } else if (membershipChanged) {
                        for (const action of existing.actions) {
                            const pruned = pruneActionMaps(action, desiredIds);
                            if (JSON.stringify(pruned.config ?? null) !== JSON.stringify(action.config ? JSON.parse(action.config) : null)) {
                                await tx.igAutomationAction.update({ where: { id: action.id }, data: { config: pruned.config ? JSON.stringify(pruned.config) : null } });
                            }
                        }
                    }
                } else {
                    const create: any = {
                        user_id: userId, channel_id: channelId, name: data.name ?? representative.name,
                        enabled: data.enabled ?? representative.enabled, priority: data.priority ?? representative.priority,
                        trigger: data.trigger ?? representative.trigger, keywords: JSON.stringify(data.keywords ?? parseJsonArray(representative.keywords)),
                        match_mode: data.matchMode ?? representative.match_mode, match_type: data.matchType ?? representative.match_type,
                        negative_keywords: data.negativeKeywords === undefined ? representative.negative_keywords : data.negativeKeywords === null ? null : JSON.stringify(data.negativeKeywords),
                        media_ids: mediaIds === null ? null : JSON.stringify(mediaIds), first_interaction_only: data.firstInteractionOnly ?? representative.first_interaction_only,
                        cooldown_hours: data.cooldownHours === undefined ? representative.cooldown_hours : data.cooldownHours,
                        daily_limit: data.dailyLimit === undefined ? representative.daily_limit : data.dailyLimit,
                        quiet_hours: data.quietHours === undefined ? representative.quiet_hours : data.quietHours === null ? null : JSON.stringify(data.quietHours),
                        settings,
                    };
                    const created = await tx.igAutomation.create({ data: create });
                    const actions = effectiveActions ?? representative.actions.map((a: any) => pruneActionMaps(a, desiredIds));
                    if (actions.length) await tx.igAutomationAction.createMany({ data: actions.map((a: any) => actionToDb(actionForChannel(a, channelId), created.id)) });
                }
            }
            return tx.igAutomation.findMany({ where: { user_id: userId, ...(isGroup ? { settings: { contains: logicalGroupId } } : { id: { in: desiredIds.map((cid) => currentByChannel.get(cid)?.id).filter(Boolean) as string[] } }) }, include: AUTOMATION_INCLUDE });
        });
        // Query by group marker can be overly broad because settings is JSON text; filter exact marker.
        const rows = isGroup ? next.filter((r) => profileGroupId(r.settings) === logicalGroupId || r.id === logicalGroupId) : next;
        if (isGroup) return NextResponse.json(serializeGroup(rows));
        const fresh = await prisma.igAutomation.findFirst({ where: { user_id: userId, id: group.rows[0].id }, include: AUTOMATION_INCLUDE });
        return NextResponse.json(fresh ? serializePhysical(fresh) : serializePhysical(rows[0]));
    } catch (error: unknown) {
        console.error("Update automation error:", error);
        if (error instanceof ConcurrentGroupEdit) return NextResponse.json({ error: error.message }, { status: 409 });
        return badRequest(getErrorMessage(error));
    }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();
    try {
        const { id } = await params;
        const group = await resolveGroup(userId, id);
        if (!group) return notFound("Automação não encontrada");
        await prisma.$transaction(async (tx) => {
            await cancelPendingActionJobs(tx, userId, group.rows.map((r) => r.id), group.rows.flatMap((r) => r.actions.map((a: any) => a.id)));
            await tx.igAutomation.deleteMany({ where: { user_id: userId, id: { in: group.rows.map((r) => r.id) } } });
        });
        return NextResponse.json({ ok: true });
    } catch (error: unknown) {
        console.error("Delete automation error:", error);
        return badRequest(getErrorMessage(error));
    }
}
