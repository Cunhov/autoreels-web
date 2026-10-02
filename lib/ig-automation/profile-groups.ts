import { parseJsonObject } from "@/lib/ig-automation/validate";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHANNEL_SUMMARY_SELECT, serializeAction, serializeAutomation } from "@/app/api/ig/shared";
import type { ValidatedActionInput } from "@/lib/ig-automation/validate";

export const AUTOMATION_INCLUDE = {
    actions: { orderBy: { position: "asc" as const } },
    channel: { select: CHANNEL_SUMMARY_SELECT },
} satisfies Prisma.IgAutomationInclude;

export async function validateActionReferences(userId: string, actions: ValidatedActionInput[] | undefined, channelId: string) {
    if (!actions?.length) return null;
    const sequenceIds = [...new Set(actions.map((a) => a.sequenceId).filter((id): id is string => !!id))];
    if (sequenceIds.length) {
        const rows = await prisma.igSequence.findMany({ where: { id: { in: sequenceIds }, user_id: userId }, select: { id: true, channel_id: true } });
        const byId = new Map(rows.map((r) => [r.id, r.channel_id]));
        for (const id of sequenceIds) {
            if (!byId.has(id)) return { status: 404 as const, error: "Sequência não encontrada" };
            if (byId.get(id) !== channelId) return { status: 400 as const, error: "Sequência pertence a outro canal" };
        }
    }
    const webhookIds = [...new Set(actions.map((a) => a.webhookId).filter((id): id is string => !!id))];
    if (webhookIds.length) {
        const rows = await prisma.igOutboundWebhook.findMany({ where: { id: { in: webhookIds }, user_id: userId }, select: { id: true, channel_id: true } });
        const byId = new Map(rows.map((r) => [r.id, r.channel_id]));
        for (const id of webhookIds) {
            if (!byId.has(id)) return { status: 404 as const, error: "Webhook de saída não encontrado" };
            const target = byId.get(id);
            if (target !== null && target !== channelId) return { status: 400 as const, error: "Webhook de saída pertence a outro canal" };
        }
    }
    return null;
}

export function serializePhysical(row: any) {
    return {
        ...serializeAutomation(row), actions: row.actions.map(serializeAction), channel: row.channel,
        channelIds: [row.channel_id], channels: [row.channel], memberIds: [row.id],
        mediaIdsByChannel: { [row.channel_id]: parseStoredStringArray(row.media_ids) },
    };
}

export function serializeGroup(rows: any[]) {
    const groupId = profileGroupId(rows[0].settings) ?? rows[0].id;
    const leader = rows.find((r) => r.id === groupId) ?? rows[0];
    const stats = aggregateGroupStats(rows);
    const mediaIdsByChannel: Record<string, string[]> = {};
    for (const row of rows) mediaIdsByChannel[row.channel_id] = parseStoredStringArray(row.media_ids);
    return {
        ...serializePhysical(leader), id: groupId,
        enabled: rows.some((r) => r.enabled),
        stats_sent: stats.stats_sent, stats_matched: stats.stats_matched, stats_failed: stats.stats_failed,
        stats_clicks: stats.stats_clicks, last_run_at: stats.last_run_at,
        channelIds: rows.map((r) => r.channel_id), channels: rows.map((r) => r.channel),
        memberIds: rows.map((r) => r.id), mediaIdsByChannel,
    };
}

function parseStoredStringArray(raw: unknown): string[] {
    if (typeof raw !== "string") return [];
    try { const value = JSON.parse(raw); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
    catch { return []; }
}

/** Reserved server-owned marker stored inside the existing settings JSON. */
export const PROFILE_GROUP_SETTING = "_profileGroupId";

export function profileGroupId(settings: unknown): string | null {
    const id = parseJsonObject(settings)?.[PROFILE_GROUP_SETTING];
    return typeof id === "string" && id.length > 0 ? id : null;
}

export function withProfileGroup(settings: unknown, groupId: string): string {
    const value = { ...(parseJsonObject(settings) ?? {}), [PROFILE_GROUP_SETTING]: groupId };
    return JSON.stringify(value);
}

export function withoutProfileGroup(settings: unknown): string | null {
    const value = { ...(parseJsonObject(settings) ?? {}) };
    delete value[PROFILE_GROUP_SETTING];
    return Object.keys(value).length ? JSON.stringify(value) : null;
}

export function isProfileGroupMember(row: { id: string; settings: unknown }, groupId: string) {
    return row.id === groupId || profileGroupId(row.settings) === groupId;
}

export function aggregateGroupStats<T extends {
    stats_sent: number; stats_matched: number; stats_failed: number; stats_clicks: number;
    last_run_at: Date | null;
}>(rows: T[]) {
    return rows.reduce((sum, row) => ({
        stats_sent: sum.stats_sent + row.stats_sent,
        stats_matched: sum.stats_matched + row.stats_matched,
        stats_failed: sum.stats_failed + row.stats_failed,
        stats_clicks: sum.stats_clicks + row.stats_clicks,
        last_run_at: !sum.last_run_at || (row.last_run_at && row.last_run_at > sum.last_run_at) ? row.last_run_at : sum.last_run_at,
    }), { stats_sent: 0, stats_matched: 0, stats_failed: 0, stats_clicks: 0, last_run_at: null as Date | null });
}

export function actionForChannel(action: any, channelId: string) {
    const config = action.config && typeof action.config === "object" ? { ...action.config } : {};
    const sequenceMap = config.sequenceIdsByChannel;
    const webhookMap = config.webhookIdsByChannel;
    const hasSequenceMap = !!sequenceMap && typeof sequenceMap === "object" && !Array.isArray(sequenceMap) && Object.keys(sequenceMap).length > 0;
    const hasWebhookMap = !!webhookMap && typeof webhookMap === "object" && !Array.isArray(webhookMap) && Object.keys(webhookMap).length > 0;
    return {
        ...action,
        sequenceId: hasSequenceMap
            ? (typeof sequenceMap[channelId] === "string" ? sequenceMap[channelId] : null)
            : action.sequenceId,
        webhookId: hasWebhookMap
            ? (typeof webhookMap[channelId] === "string" ? webhookMap[channelId] : null)
            : action.webhookId,
    };
}

export function validateChannelMapKeys(actions: any[] | undefined, channelIds: string[]) {
    if (!actions) return null;
    const allowed = new Set(channelIds);
    for (const action of actions) {
        for (const key of ["sequenceIdsByChannel", "webhookIdsByChannel"]) {
            const mapping = action.config?.[key];
            if (mapping === undefined) continue;
            if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return `A configuração ${key} é inválida`;
            if (Object.keys(mapping).some((id) => !allowed.has(id))) return "Ação referencia um perfil fora da automação";
            if (Object.values(mapping).some((value) => value !== null && value !== "" && (typeof value !== "string" || value.length > 100))) return `A configuração ${key} é inválida`;
        }
    }
    return null;
}

export function normalizeMediaIds(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") return null;
        const id = item.trim();
        if (!id) continue;
        if (id.length > 200) return null;
        if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out.length <= 50 ? out : null;
}

export function validateActionMappings(actions: any[] | undefined, channelIds: string[]) {
    if (!actions) return null;
    for (const action of actions) {
        const sequenceMap = action.config?.sequenceIdsByChannel;
        const webhookMap = action.config?.webhookIdsByChannel;
        for (const channelId of channelIds) {
            if (action.type === "start_sequence" && sequenceMap && Object.keys(sequenceMap).length > 0 && !sequenceMap[channelId]) {
                return "Selecione uma sequência para cada perfil selecionado";
            }
            if (action.type === "outbound_webhook" && webhookMap && Object.keys(webhookMap).length > 0 && !webhookMap[channelId] && !action.webhookId) {
                return "Selecione um webhook para cada perfil selecionado";
            }
        }
    }
    return null;
}
