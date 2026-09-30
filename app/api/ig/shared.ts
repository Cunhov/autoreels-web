/**
 * Helpers compartilhados das rotas IG Automation (api-crud).
 * Serialização: JSON fields saem parseados nas respostas; persistência usa
 * `JSON.stringify`. Nunca expõe access_token/proxy_url/secret.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
    parseJsonArray,
    parseJsonList,
    parseJsonObject,
    type ValidatedActionInput,
    type ValidatedAutomationInput,
    type ValidatedOutboundInput,
    type ValidatedSequenceStep,
    type ValidatedSubstanceInput,
} from "@/lib/ig-automation/validate";

export const CHANNEL_SUMMARY_SELECT = {
    id: true,
    name: true,
    username: true,
} as const;

export const CONTACT_SUMMARY_SELECT = {
    id: true,
    ig_user_id: true,
    username: true,
    name: true,
} as const;

export const AUTOMATION_SUMMARY_SELECT = {
    id: true,
    name: true,
} as const;

// ─── Sessão / respostas ──────────────────────────────────────────────────────

export async function requireUserId(): Promise<string | null> {
    const session = await getServerSession(authOptions);
    return getSessionUserId(session) ?? null;
}

export function unauthorized() {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function notFound(message = "Recurso não encontrado") {
    return NextResponse.json({ error: message }, { status: 404 });
}

export function badRequest(message: string) {
    return NextResponse.json({ error: message }, { status: 400 });
}

export async function readJsonBody(req: Request): Promise<unknown> {
    try {
        return await req.json();
    } catch {
        return null;
    }
}

// ─── Query params / paginação ────────────────────────────────────────────────

export function firstParam(searchParams: URLSearchParams, ...names: string[]): string | null {
    for (const name of names) {
        const value = searchParams.get(name);
        if (value !== null && value !== "") return value;
    }
    return null;
}

export function parseLimitParam(raw: string | null, def = 30, max = 100): number {
    if (raw === null || raw.trim() === "") return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(Math.trunc(n), 1), max);
}

export function parseCursorParam(raw: string | null): string | null {
    if (raw === null) return null;
    const value = raw.trim();
    return value ? value : null;
}

export function parseDaysParam(raw: string | null, def = 7, min = 1, max = 90): number {
    if (raw === null || raw.trim() === "") return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Filtro estável para paginação por cursor `(created_at, id)` desc. */
export function cursorOrFilter(cursor: { id: string; created_at: Date }) {
    return {
        OR: [
            { created_at: { lt: cursor.created_at } },
            { created_at: cursor.created_at, id: { lt: cursor.id } },
        ],
    };
}

// ─── Canal ───────────────────────────────────────────────────────────────────

export async function findOwnedChannel(userId: string, channelId: string) {
    return prisma.channel.findFirst({
        where: { id: channelId, user_id: userId },
        select: { id: true, name: true, username: true, platform: true },
    });
}

// ─── Serialização de JSON fields ─────────────────────────────────────────────

export function serializeAction(row: {
    id: string;
    automation_id: string;
    position: number;
    type: string;
    delay_seconds: number;
    text_variants: string | null;
    buttons: string | null;
    quick_replies: string | null;
    media_url: string | null;
    tag: string | null;
    sequence_id: string | null;
    webhook_id: string | null;
    ai_prompt: string | null;
    config: string | null;
    created_at: Date;
}) {
    return {
        ...row,
        text_variants: parseJsonArray(row.text_variants),
        buttons: parseJsonList(row.buttons),
        quick_replies: parseJsonList(row.quick_replies),
        config: parseJsonObject(row.config),
    };
}

export function serializeAutomation(row: {
    id: string;
    user_id: string;
    channel_id: string;
    name: string;
    enabled: boolean;
    priority: number;
    trigger: string;
    keywords: string;
    match_mode: string;
    match_type: string;
    negative_keywords: string | null;
    media_ids: string | null;
    first_interaction_only: boolean;
    cooldown_hours: number | null;
    daily_limit: number | null;
    quiet_hours: string | null;
    settings: string | null;
    stats_sent: number;
    stats_matched: number;
    stats_failed: number;
    stats_clicks: number;
    last_run_at: Date | null;
    created_at: Date;
    updated_at: Date;
}) {
    return {
        ...row,
        keywords: parseJsonArray(row.keywords),
        negative_keywords: row.negative_keywords === null ? null : parseJsonArray(row.negative_keywords),
        media_ids: row.media_ids === null ? null : parseJsonArray(row.media_ids),
        quiet_hours: parseJsonObject(row.quiet_hours),
        settings: parseJsonObject(row.settings),
    };
}

export function serializeContact(row: {
    id: string;
    user_id: string;
    channel_id: string;
    ig_user_id: string;
    username: string | null;
    name: string | null;
    profile_picture: string | null;
    tags: string | null;
    notes: string | null;
    custom_fields: string | null;
    bot_paused_until: Date | null;
    last_message_at: Date | null;
    last_comment_at: Date | null;
    interactions_count: number;
    created_at: Date;
    updated_at: Date;
}) {
    return {
        ...row,
        tags: parseJsonArray(row.tags),
        custom_fields: parseJsonObject(row.custom_fields),
    };
}

export function serializeSubstance(row: {
    id: string;
    user_id: string | null;
    keyword: string;
    name: string;
    keywords: string;
    description: string;
    action: string;
    dosage: string;
    duration: string;
    url: string | null;
    enabled: boolean;
    created_at: Date;
}) {
    return {
        ...row,
        keywords: parseJsonArray(row.keywords),
    };
}

export function serializeSequence(row: {
    id: string;
    user_id: string;
    channel_id: string;
    name: string;
    enabled: boolean;
    steps: string;
    created_at: Date;
    updated_at: Date;
}) {
    return {
        ...row,
        steps: parseJsonList(row.steps),
    };
}

export function serializeOutboundWebhook(row: {
    id: string;
    user_id: string;
    channel_id: string | null;
    name: string;
    url: string;
    secret: string | null;
    events: string;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
}) {
    const { secret, ...rest } = row;
    return {
        ...rest,
        events: parseJsonArray(row.events),
        has_secret: typeof secret === "string" && secret.length > 0,
    };
}

// ─── Mapeamento validação → colunas do DB ────────────────────────────────────

export function automationToDb(data: ValidatedAutomationInput): Prisma.IgAutomationUncheckedUpdateInput {
    const out: Prisma.IgAutomationUncheckedUpdateInput = {};
    if (data.name !== undefined) out.name = data.name;
    if (data.enabled !== undefined) out.enabled = data.enabled;
    if (data.priority !== undefined) out.priority = data.priority;
    if (data.trigger !== undefined) out.trigger = data.trigger;
    if (data.keywords !== undefined) out.keywords = JSON.stringify(data.keywords);
    if (data.matchMode !== undefined) out.match_mode = data.matchMode;
    if (data.matchType !== undefined) out.match_type = data.matchType;
    if (data.negativeKeywords !== undefined) {
        out.negative_keywords = data.negativeKeywords === null ? null : JSON.stringify(data.negativeKeywords);
    }
    if (data.mediaIds !== undefined) {
        out.media_ids = data.mediaIds === null ? null : JSON.stringify(data.mediaIds);
    }
    if (data.firstInteractionOnly !== undefined) out.first_interaction_only = data.firstInteractionOnly;
    if (data.cooldownHours !== undefined) out.cooldown_hours = data.cooldownHours;
    if (data.dailyLimit !== undefined) out.daily_limit = data.dailyLimit;
    if (data.quietHours !== undefined) {
        out.quiet_hours = data.quietHours === null ? null : JSON.stringify(data.quietHours);
    }
    if (data.settings !== undefined) {
        out.settings = data.settings === null ? null : JSON.stringify(data.settings);
    }
    return out;
}

export function actionToDb(
    action: ValidatedActionInput,
    automationId: string
): Prisma.IgAutomationActionUncheckedCreateInput {
    return {
        automation_id: automationId,
        position: action.position,
        type: action.type,
        delay_seconds: action.delaySeconds,
        text_variants: action.textVariants.length > 0 ? JSON.stringify(action.textVariants) : null,
        buttons: action.buttons && action.buttons.length > 0 ? JSON.stringify(action.buttons) : null,
        quick_replies: action.quickReplies && action.quickReplies.length > 0 ? JSON.stringify(action.quickReplies) : null,
        media_url: action.mediaUrl,
        tag: action.tag,
        sequence_id: action.sequenceId,
        webhook_id: action.webhookId,
        ai_prompt: action.aiPrompt,
        config: action.config ? JSON.stringify(action.config) : null,
    };
}

export function substanceToDb(data: ValidatedSubstanceInput): Prisma.IgSubstanceUncheckedUpdateInput {
    const out: Prisma.IgSubstanceUncheckedUpdateInput = {};
    if (data.keyword !== undefined) out.keyword = data.keyword;
    if (data.name !== undefined) out.name = data.name;
    if (data.keywords !== undefined) out.keywords = JSON.stringify(data.keywords);
    if (data.description !== undefined) out.description = data.description;
    if (data.action !== undefined) out.action = data.action;
    if (data.dosage !== undefined) out.dosage = data.dosage;
    if (data.duration !== undefined) out.duration = data.duration;
    if (data.url !== undefined) out.url = data.url;
    if (data.enabled !== undefined) out.enabled = data.enabled;
    return out;
}

export function sequenceStepToDb(step: ValidatedSequenceStep) {
    return {
        delay_seconds: step.delaySeconds,
        type: step.type,
        text_variants: step.textVariants.length > 0 ? step.textVariants : null,
        buttons: step.buttons && step.buttons.length > 0 ? step.buttons : null,
        quick_replies: step.quickReplies && step.quickReplies.length > 0 ? step.quickReplies : null,
        media_url: step.mediaUrl,
        ai_prompt: step.aiPrompt,
        config: step.config,
    };
}

export function outboundToDb(data: ValidatedOutboundInput): Prisma.IgOutboundWebhookUncheckedUpdateInput {
    const out: Prisma.IgOutboundWebhookUncheckedUpdateInput = {};
    if (data.name !== undefined) out.name = data.name;
    if (data.channelId !== undefined) out.channel_id = data.channelId;
    if (data.url !== undefined) out.url = data.url;
    if (data.secret !== undefined) out.secret = data.secret;
    if (data.events !== undefined) out.events = JSON.stringify(data.events);
    if (data.enabled !== undefined) out.enabled = data.enabled;
    return out;
}
