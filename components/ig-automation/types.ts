/**
 * Tipos locais e normalizadores da UI de Automações Instagram.
 *
 * Contrato congelado: docs/IG_AUTOMATION_SPEC.md §4 e §11. As respostas das
 * APIs podem vir com JSON já parseado (camelCase) ou colunas cruas do Prisma
 * (snake_case, com strings JSON), então a UI normaliza defensivamente as duas
 * formas e envia os corpos exatamente como a seção 11 define.
 */

export type IgTrigger =
    | "comment"
    | "dm"
    | "story_reply"
    | "story_mention"
    | "postback";

export type IgMatchType = "contains" | "exact" | "starts_with" | "regex";
export type IgMatchMode = "any" | "all";

export type IgActionType =
    | "public_comment_reply"
    | "private_reply"
    | "dm_text"
    | "dm_buttons"
    | "dm_quick_replies"
    | "dm_media"
    | "ai_reply"
    | "assign_tag"
    | "start_sequence"
    | "outbound_webhook";

export const TRIGGERS: IgTrigger[] = [
    "comment",
    "dm",
    "story_reply",
    "story_mention",
    "postback",
];

export const MATCH_TYPES: IgMatchType[] = [
    "contains",
    "exact",
    "starts_with",
    "regex",
];

export const ACTION_TYPES: IgActionType[] = [
    "public_comment_reply",
    "private_reply",
    "dm_text",
    "dm_buttons",
    "dm_quick_replies",
    "dm_media",
    "ai_reply",
    "assign_tag",
    "start_sequence",
    "outbound_webhook",
];

export const TRIGGER_LABELS: Record<IgTrigger, string> = {
    comment: "Comentário no post",
    dm: "Mensagem direta (DM)",
    story_reply: "Resposta do story",
    story_mention: "Menção no story",
    postback: "Clique em botão de resposta",
};

export const MATCH_TYPE_LABELS: Record<IgMatchType, string> = {
    contains: "Contém",
    exact: "Exato",
    starts_with: "Começa com",
    regex: "Expressão regular",
};

export const MATCH_MODE_LABELS: Record<IgMatchMode, string> = {
    any: "Pelo menos uma palavra",
    all: "Todas as palavras",
};

export const ACTION_TYPE_LABELS: Record<IgActionType, string> = {
    public_comment_reply: "Resposta pública no comentário",
    private_reply: "Enviar no privado após comentário",
    dm_text: "Mensagem privada de texto",
    dm_buttons: "Mensagem privada com botões",
    dm_quick_replies: "Mensagem com respostas rápidas",
    dm_media: "Mensagem privada com imagem",
    ai_reply: "Resposta com IA",
    assign_tag: "Adicionar tag ao contato",
    start_sequence: "Iniciar sequência",
    outbound_webhook: "Notificar uma integração",
};

/** Tipos que aceitam editor de variações de texto. */
export const TEXT_ACTION_TYPES: IgActionType[] = [
    "public_comment_reply",
    "private_reply",
    "dm_text",
    "dm_buttons",
    "dm_quick_replies",
    "dm_media",
];

export interface IgButton {
    type: "web_url" | "postback";
    title: string;
    url?: string;
    payload?: string;
    track?: boolean;
}

export interface IgQuickReply {
    title: string;
    payload: string;
}

export interface IgQuietHours {
    start: string;
    end: string;
    tz: string;
}

export interface ChannelLite {
    id: string;
    name: string;
    platform: string;
    accountId: string;
    username: string;
    status: string;
}

export interface IgActionDraft {
    id?: string;
    position: number;
    type: IgActionType;
    delaySeconds: number;
    textVariants: string[];
    buttons: IgButton[];
    quickReplies: IgQuickReply[];
    mediaUrl: string;
    tag: string;
    sequenceId: string;
    webhookId: string;
    aiPrompt: string;
    trackClicks: boolean;
    sequenceIdsByChannel?: Record<string, string>;
    webhookIdsByChannel?: Record<string, string>;
    config?: Record<string, unknown>;
}

export interface IgAutomation {
    id: string;
    channelId: string;
    channelIds: string[];
    channels: ChannelLite[];
    memberIds: string[];
    mediaIdsByChannel: Record<string, string[]>;
    name: string;
    enabled: boolean;
    priority: number;
    trigger: IgTrigger;
    keywords: string[];
    matchMode: IgMatchMode;
    matchType: IgMatchType;
    negativeKeywords: string[];
    mediaIds: string[];
    firstInteractionOnly: boolean;
    cooldownHours: number | null;
    dailyLimit: number | null;
    quietHours: IgQuietHours | null;
    settings: Record<string, unknown>;
    statsMatched: number;
    statsSent: number;
    statsFailed: number;
    statsClicks: number;
    lastRunAt: string | null;
    createdAt: string | null;
    channel: ChannelLite | null;
    actions: IgActionDraft[];
}

export interface SimplestOption {
    id: string;
    name: string;
    channelId?: string | null;
}

export interface IgContact {
    id: string;
    channelId: string;
    igUserId: string;
    username: string;
    name: string;
    profilePicture: string;
    tags: string[];
    notes: string;
    customFields: Record<string, unknown>;
    botPausedUntil: string | null;
    lastMessageAt: string | null;
    lastCommentAt: string | null;
    interactionsCount: number;
    createdAt: string | null;
}

export interface IgSequence {
    id: string;
    name: string;
    enabled: boolean;
    channelId: string;
    steps: IgActionDraft[];
    createdAt: string | null;
}

export interface IgSubstance {
    id: string;
    keyword: string;
    name: string;
    keywords: string[];
    description: string;
    action: string;
    dosage: string;
    duration: string;
    url: string;
    enabled: boolean;
}

export interface IgOutboundWebhook {
    id: string;
    name: string;
    url: string;
    secret: string;
    hasSecret: boolean;
    events: string[];
    enabled: boolean;
    channelId: string;
}

export interface WebhookStatus {
    channelId: string;
    name: string;
    username: string;
    status: string;
    subscribedFields: string[];
    lastCheckedAt: string | null;
    lastEventAt: string | null;
    lastError: string | null;
}

export interface IgSettings {
    webhookUrl: string;
    verifyToken: string;
    envOverride: boolean;
    enabled: boolean;
    dryRun: boolean;
    limits: Record<string, unknown>;
}

export interface IgGateResult {
    gate: string;
    passed: boolean;
    reason?: string;
}

export interface IgMatchedAction {
    actionId: string;
    type: IgActionType;
    position: number;
    runAtOffsetMs: number;
    renderedText?: string;
    buttons?: IgButton[];
    quickReplies?: IgQuickReply[];
    target?: string;
}

export interface IgSimulationResult {
    matched: { automationId: string; name: string } | null;
    actions: IgMatchedAction[];
    gates: IgGateResult[];
    contact: { igUserId?: string; username?: string; firstInteraction: boolean };
}

export interface AnalyticsTotals {
    matched: number;
    sent: number;
    failed: number;
    clicks: number;
    contacts: number;
}

export interface AnalyticsPoint {
    date: string;
    matched: number;
    sent: number;
    failed: number;
    clicks: number;
}

export interface AnalyticsByAutomation {
    automationId: string;
    name: string;
    matched: number;
    sent: number;
    failed: number;
    clicks: number;
}

export interface IgAnalytics {
    totals: AnalyticsTotals;
    series: AnalyticsPoint[];
    byAutomation: AnalyticsByAutomation[];
}

export const OUTBOUND_EVENTS = [
    "comment.matched",
    "dm.matched",
    "action.sent",
    "action.failed",
    "click",
    "sequence.step",
] as const;

// ── Normalizadores ───────────────────────────────────────────────────────────

export function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function firstDefined(
    o: Record<string, unknown>,
    keys: string[],
): unknown {
    for (const k of keys) {
        const v = o[k];
        if (v !== undefined && v !== null) return v;
    }
    return undefined;
}

export function asString(v: unknown, fallback = ""): string {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return fallback;
}

export function asNumber(v: unknown, fallback = 0): number {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return fallback;
}

export function asBool(v: unknown, fallback = false): boolean {
    if (typeof v === "boolean") return v;
    if (v === 1 || v === "1" || v === "true") return true;
    if (v === 0 || v === "0" || v === "false") return false;
    return fallback;
}

export function parseJsonValue(v: unknown): unknown {
    if (typeof v !== "string") return v;
    const t = v.trim();
    if (!t) return null;
    try {
        return JSON.parse(t) as unknown;
    } catch {
        return null;
    }
}

export function asStringArray(v: unknown): string[] {
    const parsed = parseJsonValue(v);
    const arr = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "string"
          ? parsed.split(",")
          : [];
    return arr
        .map((x) =>
            typeof x === "string"
                ? x.trim()
                : typeof x === "number"
                  ? String(x)
                  : "",
        )
        .filter(Boolean);
}

export function asObject(v: unknown): Record<string, unknown> {
    const parsed = parseJsonValue(v);
    return isRecord(parsed) ? parsed : {};
}

export function extractItems(raw: unknown, keys: string[]): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (isRecord(raw)) {
        for (const k of keys) {
            const v = raw[k];
            if (Array.isArray(v)) return v;
        }
    }
    return [];
}

function normalizeButton(v: unknown): IgButton | null {
    if (!isRecord(v)) return null;
    const title = asString(firstDefined(v, ["title", "text"]));
    if (!title) return null;
    const typeRaw = asString(firstDefined(v, ["type"]), "web_url");
    const type: IgButton["type"] =
        typeRaw === "postback" ? "postback" : "web_url";
    const trackRaw = firstDefined(v, ["track"]);
    return {
        type,
        title,
        url: asString(firstDefined(v, ["url"])) || undefined,
        payload: asString(firstDefined(v, ["payload"])) || undefined,
        track: trackRaw === undefined ? undefined : asBool(trackRaw, true),
    };
}

function normalizeQuickReply(v: unknown): IgQuickReply | null {
    if (!isRecord(v)) return null;
    const title = asString(firstDefined(v, ["title", "text"]));
    if (!title) return null;
    return { title, payload: asString(firstDefined(v, ["payload"])) || title };
}

export function normalizeAction(raw: unknown, index: number): IgActionDraft {
    const o = isRecord(raw) ? raw : {};
    const typeRaw = asString(o.type, "dm_text");
    const type = (ACTION_TYPES as string[]).includes(typeRaw)
        ? (typeRaw as IgActionType)
        : "dm_text";
    const buttonsRaw = parseJsonValue(firstDefined(o, ["buttons"]));
    const quickRaw = parseJsonValue(
        firstDefined(o, ["quickReplies", "quick_replies"]),
    );
    const config = asObject(o.config);
    const referenceMap = (value: unknown): Record<string, string> => Object.fromEntries(
        Object.entries(asObject(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    return {
        id: asString(o.id) || undefined,
        position: asNumber(firstDefined(o, ["position"]), index),
        type,
        delaySeconds: Math.max(
            0,
            Math.round(asNumber(firstDefined(o, ["delaySeconds", "delay_seconds"]), 0)),
        ),
        textVariants: asStringArray(
            firstDefined(o, ["textVariants", "text_variants"]),
        ),
        buttons: (Array.isArray(buttonsRaw) ? buttonsRaw : [])
            .map(normalizeButton)
            .filter((b): b is IgButton => b !== null),
        quickReplies: (Array.isArray(quickRaw) ? quickRaw : [])
            .map(normalizeQuickReply)
            .filter((q): q is IgQuickReply => q !== null),
        mediaUrl: asString(firstDefined(o, ["mediaUrl", "media_url"])),
        tag: asString(o.tag),
        sequenceId: asString(firstDefined(o, ["sequenceId", "sequence_id"])),
        webhookId: asString(firstDefined(o, ["webhookId", "webhook_id"])),
        aiPrompt: asString(firstDefined(o, ["aiPrompt", "ai_prompt"])),
        trackClicks: asBool(firstDefined(config, ["trackClicks"]), true),
        sequenceIdsByChannel: referenceMap(config.sequenceIdsByChannel),
        webhookIdsByChannel: referenceMap(config.webhookIdsByChannel),
        config,
    };
}

export function newActionDraft(
    type: IgActionType,
    position: number,
): IgActionDraft {
    return {
        position,
        type,
        delaySeconds: 0,
        textVariants: [""],
        buttons: [],
        quickReplies: [],
        mediaUrl: "",
        tag: "",
        sequenceId: "",
        webhookId: "",
        aiPrompt: "",
        trackClicks: true,
    };
}

export function normalizeQuietHours(v: unknown): IgQuietHours | null {
    const o = asObject(v);
    const start = asString(o.start);
    const end = asString(o.end);
    if (!start && !end) return null;
    return {
        start: start || "23:00",
        end: end || "07:00",
        tz: asString(o.tz, "America/Bahia") || "America/Bahia",
    };
}

export function normalizeChannel(raw: unknown): ChannelLite {
    const o = isRecord(raw) ? raw : {};
    return {
        id: asString(o.id),
        name: asString(o.name),
        platform: asString(o.platform),
        accountId: asString(firstDefined(o, ["accountId", "account_id"])),
        username: asString(o.username),
        status: asString(o.status, "active"),
    };
}

export function channelLabel(c: ChannelLite): string {
    const handle = c.username || c.name || c.accountId;
    return handle ? `@${handle.replace(/^@/, "")}` : c.id;
}

export function normalizeAutomation(
    raw: unknown,
    fallbackIndex = 0,
): IgAutomation {
    const o = isRecord(raw) ? raw : {};
    const triggerRaw = asString(o.trigger, "comment");
    const trigger = (TRIGGERS as string[]).includes(triggerRaw)
        ? (triggerRaw as IgTrigger)
        : "comment";
    const matchModeRaw = asString(
        firstDefined(o, ["matchMode", "match_mode"]),
        "any",
    );
    const matchTypeRaw = asString(
        firstDefined(o, ["matchType", "match_type"]),
        "contains",
    );
    const channelRaw = o.channel;
    const actionsRaw = Array.isArray(o.actions) ? o.actions : [];
    const settings = asObject(o.settings);
    const cooldown = firstDefined(o, ["cooldownHours", "cooldown_hours"]);
    const daily = firstDefined(o, ["dailyLimit", "daily_limit"]);
    const primaryChannelId = asString(firstDefined(o, ["channelId", "channel_id"]));
    const channelIds = asStringArray(o.channelIds);
    const mediaIds = asStringArray(firstDefined(o, ["mediaIds", "media_ids"]));
    const mediaIdsByChannel = Object.fromEntries(Object.entries(asObject(o.mediaIdsByChannel)).map(([id, values]) => [id, asStringArray(values)]));
    return {
        id: asString(o.id, String(fallbackIndex)),
        channelId: primaryChannelId,
        channelIds: channelIds.length ? channelIds : [primaryChannelId].filter(Boolean),
        channels: Array.isArray(o.channels) ? o.channels.map(normalizeChannel) : isRecord(channelRaw) ? [normalizeChannel(channelRaw)] : [],
        memberIds: asStringArray(o.memberIds).length ? asStringArray(o.memberIds) : [asString(o.id)].filter(Boolean),
        mediaIdsByChannel: Object.keys(mediaIdsByChannel).length ? mediaIdsByChannel : primaryChannelId ? { [primaryChannelId]: mediaIds } : {},
        name: asString(o.name, "Automação"),
        enabled: asBool(o.enabled, true),
        priority: asNumber(o.priority, 0),
        trigger,
        keywords: asStringArray(o.keywords),
        matchMode: matchModeRaw === "all" ? "all" : "any",
        matchType: (MATCH_TYPES as string[]).includes(matchTypeRaw)
            ? (matchTypeRaw as IgMatchType)
            : "contains",
        negativeKeywords: asStringArray(
            firstDefined(o, ["negativeKeywords", "negative_keywords"]),
        ),
        mediaIds,
        firstInteractionOnly: asBool(
            firstDefined(o, ["firstInteractionOnly", "first_interaction_only"]),
        ),
        cooldownHours: cooldown == null ? null : asNumber(cooldown, 0),
        dailyLimit: daily == null ? null : asNumber(daily, 0),
        quietHours: normalizeQuietHours(
            firstDefined(o, ["quietHours", "quiet_hours"]),
        ),
        settings,
        statsMatched: asNumber(
            firstDefined(o, ["statsMatched", "stats_matched"]),
        ),
        statsSent: asNumber(firstDefined(o, ["statsSent", "stats_sent"])),
        statsFailed: asNumber(firstDefined(o, ["statsFailed", "stats_failed"])),
        statsClicks: asNumber(firstDefined(o, ["statsClicks", "stats_clicks"])),
        lastRunAt: asString(
            firstDefined(o, ["lastRunAt", "last_run_at"]),
        ) || null,
        createdAt: asString(o.createdAt) || asString(o.created_at) || null,
        channel: isRecord(channelRaw) ? normalizeChannel(channelRaw) : null,
        actions: actionsRaw.map((a, i) => normalizeAction(a, i)),
    };
}

export interface AutomationPayload {
    channelId: string;
    channelIds?: string[];
    mediaIdsByChannel?: Record<string, string[]>;
    name: string;
    enabled: boolean;
    priority: number;
    trigger: IgTrigger;
    keywords: string[];
    matchMode: IgMatchMode;
    matchType: IgMatchType;
    negativeKeywords: string[];
    mediaIds: string[];
    firstInteractionOnly: boolean;
    cooldownHours: number | null;
    dailyLimit: number | null;
    quietHours: IgQuietHours | null;
    settings: Record<string, unknown>;
    actions: Record<string, unknown>[];
}

export function serializeActionPayload(
    a: IgActionDraft,
    index: number,
    keyStyle: "camel" | "snake" = "camel",
): Record<string, unknown> {
    if (keyStyle === "snake") {
        return {
            position: index,
            type: a.type,
            delay_seconds: a.delaySeconds,
            text_variants: a.textVariants.filter((t) => t.trim() !== ""),
            buttons: a.buttons,
            quick_replies: a.quickReplies,
            media_url: a.mediaUrl.trim() || null,
            tag: a.tag.trim() || null,
            sequence_id: a.sequenceId || null,
            webhook_id: a.webhookId || null,
            ai_prompt: a.aiPrompt.trim() || null,
            config: { ...a.config, trackClicks: a.trackClicks, sequenceIdsByChannel: a.sequenceIdsByChannel, webhookIdsByChannel: a.webhookIdsByChannel },
        };
    }
    return {
        position: index,
        type: a.type,
        delaySeconds: a.delaySeconds,
        textVariants: a.textVariants.filter((t) => t.trim() !== ""),
        buttons: a.buttons,
        quickReplies: a.quickReplies,
        mediaUrl: a.mediaUrl.trim() || null,
        tag: a.tag.trim() || null,
        sequenceId: a.sequenceId || null,
        webhookId: a.webhookId || null,
        aiPrompt: a.aiPrompt.trim() || null,
        config: { ...a.config, trackClicks: a.trackClicks, sequenceIdsByChannel: a.sequenceIdsByChannel, webhookIdsByChannel: a.webhookIdsByChannel },
    };
}

export function automationToPayload(a: IgAutomation): AutomationPayload {
    return {
        channelId: a.channelId,
        channelIds: a.channelIds,
        mediaIdsByChannel: a.mediaIdsByChannel,
        name: a.name,
        enabled: a.enabled,
        priority: a.priority,
        trigger: a.trigger,
        keywords: a.keywords,
        matchMode: a.matchMode,
        matchType: a.matchType,
        negativeKeywords: a.negativeKeywords,
        mediaIds: a.mediaIds,
        firstInteractionOnly: a.firstInteractionOnly,
        cooldownHours: a.cooldownHours,
        dailyLimit: a.dailyLimit,
        quietHours: a.quietHours,
        settings: a.settings,
        actions: a.actions.map((x, i) =>
            serializeActionPayload(x, i, "camel"),
        ),
    };
}

export function normalizeContact(raw: unknown): IgContact {
    const o = isRecord(raw) ? raw : {};
    return {
        id: asString(o.id),
        channelId: asString(firstDefined(o, ["channelId", "channel_id"])),
        igUserId: asString(firstDefined(o, ["igUserId", "ig_user_id"])),
        username: asString(o.username),
        name: asString(o.name),
        profilePicture: asString(
            firstDefined(o, ["profilePicture", "profile_picture"]),
        ),
        tags: asStringArray(o.tags),
        notes: asString(o.notes),
        customFields: asObject(
            firstDefined(o, ["customFields", "custom_fields"]),
        ),
        botPausedUntil:
            asString(firstDefined(o, ["botPausedUntil", "bot_paused_until"])) ||
            null,
        lastMessageAt:
            asString(firstDefined(o, ["lastMessageAt", "last_message_at"])) ||
            null,
        lastCommentAt:
            asString(firstDefined(o, ["lastCommentAt", "last_comment_at"])) ||
            null,
        interactionsCount: asNumber(
            firstDefined(o, ["interactionsCount", "interactions_count"]),
        ),
        createdAt: asString(o.createdAt) || asString(o.created_at) || null,
    };
}

export function normalizeSequence(raw: unknown): IgSequence {
    const o = isRecord(raw) ? raw : {};
    const stepsRaw = parseJsonValue(o.steps);
    return {
        id: asString(o.id),
        name: asString(o.name, "Sequência"),
        enabled: asBool(o.enabled, true),
        channelId: asString(firstDefined(o, ["channelId", "channel_id"])),
        steps: (Array.isArray(stepsRaw) ? stepsRaw : []).map((s, i) =>
            normalizeAction(s, i),
        ),
        createdAt: asString(o.createdAt) || asString(o.created_at) || null,
    };
}

export function normalizeSubstance(raw: unknown): IgSubstance {
    const o = isRecord(raw) ? raw : {};
    return {
        id: asString(o.id),
        keyword: asString(o.keyword),
        name: asString(o.name),
        keywords: asStringArray(o.keywords),
        description: asString(o.description),
        action: asString(o.action),
        dosage: asString(o.dosage),
        duration: asString(o.duration),
        url: asString(o.url),
        enabled: asBool(o.enabled, true),
    };
}

export function normalizeOutboundWebhook(raw: unknown): IgOutboundWebhook {
    const o = isRecord(raw) ? raw : {};
    return {
        id: asString(o.id),
        name: asString(o.name),
        url: asString(o.url),
        secret: asString(o.secret),
        hasSecret: asBool(firstDefined(o, ["has_secret", "hasSecret"])),
        events: asStringArray(o.events),
        enabled: asBool(o.enabled, true),
        channelId: asString(firstDefined(o, ["channelId", "channel_id"])),
    };
}

export function normalizeWebhookStatus(raw: unknown): WebhookStatus {
    const o = isRecord(raw) ? raw : {};
    const channelRaw = isRecord(o.channel) ? o.channel : {};
    return {
        channelId: asString(
            firstDefined(o, ["channelId", "channel_id"]) ??
                firstDefined(channelRaw, ["id"]),
        ),
        name: asString(
            firstDefined(o, ["name"]) ?? firstDefined(channelRaw, ["name"]),
        ),
        username: asString(
            firstDefined(o, ["username"]) ??
                firstDefined(channelRaw, ["username"]),
        ),
        status: asString(o.status, "unknown"),
        subscribedFields: asStringArray(
            firstDefined(o, ["subscribedFields", "subscribed_fields"]),
        ),
        lastCheckedAt:
            asString(firstDefined(o, ["lastCheckedAt", "last_checked_at"])) ||
            null,
        lastEventAt:
            asString(firstDefined(o, ["lastEventAt", "last_event_at"])) || null,
        lastError:
            asString(firstDefined(o, ["lastError", "last_error"])) || null,
    };
}

export function normalizeSettings(raw: unknown): IgSettings {
    const o = isRecord(raw) ? raw : {};
    const limits = asObject(
        firstDefined(o, ["limits", "limites"]) ?? o,
    );
    return {
        webhookUrl: asString(
            firstDefined(o, ["webhookUrl", "webhook_url"]),
        ),
        verifyToken: asString(
            firstDefined(o, ["verifyToken", "verify_token"]),
        ),
        envOverride: asBool(
            firstDefined(o, ["envOverride", "env_override"]),
        ),
        enabled: asBool(o.enabled, true),
        dryRun: asBool(firstDefined(o, ["dryRun", "dry_run"]), false),
        limits,
    };
}

export function normalizeSimulation(raw: unknown): IgSimulationResult {
    const o = isRecord(raw) ? raw : {};
    const matchedRaw = o.matched;
    const actionsRaw = Array.isArray(o.actions) ? o.actions : [];
    const gatesRaw = Array.isArray(o.gates) ? o.gates : [];
    const contactRaw = isRecord(o.contact) ? o.contact : {};
    return {
        matched: isRecord(matchedRaw)
            ? {
                  automationId: asString(
                      firstDefined(matchedRaw, ["automationId", "automation_id"]),
                  ),
                  name: asString(matchedRaw.name),
              }
            : null,
        actions: actionsRaw.map((a): IgMatchedAction => {
            const ao = isRecord(a) ? a : {};
            const typeRaw = asString(ao.type, "dm_text");
            const buttonsRaw = parseJsonValue(ao.buttons);
            const quickRaw = parseJsonValue(
                firstDefined(ao, ["quickReplies", "quick_replies"]),
            );
            return {
                actionId: asString(
                    firstDefined(ao, ["actionId", "action_id", "id"]),
                ),
                type: (ACTION_TYPES as string[]).includes(typeRaw)
                    ? (typeRaw as IgActionType)
                    : "dm_text",
                position: asNumber(ao.position),
                runAtOffsetMs: asNumber(
                    firstDefined(ao, ["runAtOffsetMs", "run_at_offset_ms"]),
                ),
                renderedText:
                    asString(
                        firstDefined(ao, ["renderedText", "rendered_text"]),
                    ) || undefined,
                buttons: (Array.isArray(buttonsRaw) ? buttonsRaw : [])
                    .map(normalizeButton)
                    .filter((b): b is IgButton => b !== null),
                quickReplies: (Array.isArray(quickRaw) ? quickRaw : [])
                    .map(normalizeQuickReply)
                    .filter((q): q is IgQuickReply => q !== null),
                target: asString(ao.target) || undefined,
            };
        }),
        gates: gatesRaw.map((g): IgGateResult => {
            const go = isRecord(g) ? g : {};
            return {
                gate: asString(go.gate, "gate"),
                passed: asBool(go.passed),
                reason: asString(go.reason) || undefined,
            };
        }),
        contact: {
            igUserId:
                asString(firstDefined(contactRaw, ["igUserId", "ig_user_id"])) ||
                undefined,
            username: asString(contactRaw.username) || undefined,
            firstInteraction: asBool(
                firstDefined(contactRaw, [
                    "firstInteraction",
                    "first_interaction",
                ]),
            ),
        },
    };
}

export function normalizeAnalytics(raw: unknown): IgAnalytics {
    const o = isRecord(raw) ? raw : {};
    const totalsRaw = isRecord(o.totals) ? o.totals : {};
    const seriesRaw = Array.isArray(o.series) ? o.series : [];
    const byRaw = Array.isArray(o.byAutomation)
        ? o.byAutomation
        : Array.isArray(o.by_automation)
          ? o.by_automation
          : [];
    return {
        totals: {
            matched: asNumber(totalsRaw.matched),
            sent: asNumber(totalsRaw.sent),
            failed: asNumber(totalsRaw.failed),
            clicks: asNumber(totalsRaw.clicks),
            contacts: asNumber(totalsRaw.contacts),
        },
        series: seriesRaw.map((p): AnalyticsPoint => {
            const po = isRecord(p) ? p : {};
            return {
                date: asString(po.date),
                matched: asNumber(po.matched),
                sent: asNumber(po.sent),
                failed: asNumber(po.failed),
                clicks: asNumber(po.clicks),
            };
        }),
        byAutomation: byRaw.map((p): AnalyticsByAutomation => {
            const po = isRecord(p) ? p : {};
            const automationRaw = isRecord(po.automation) ? po.automation : {};
            return {
                automationId: asString(
                    firstDefined(po, ["automationId", "automation_id"]) ??
                        firstDefined(po, ["id"]) ??
                        firstDefined(automationRaw, ["id"]),
                ),
                name: asString(
                    firstDefined(po, ["name"]) ??
                        firstDefined(automationRaw, ["name"]),
                ),
                matched: asNumber(po.matched),
                sent: asNumber(po.sent),
                failed: asNumber(po.failed),
                clicks: asNumber(po.clicks),
            };
        }),
    };
}

// ── datas / helpers de UI ────────────────────────────────────────────────────

export function formatDateTime(v: unknown): string {
    const s = asString(v);
    if (!s) return "—";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function relativeTime(v: unknown): string {
    const s = asString(v);
    if (!s) return "—";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "—";
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "agora";
    const min = Math.floor(diff / 60_000);
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h} h`;
    const days = Math.floor(h / 24);
    if (days < 30) return `há ${days} d`;
    return formatDateTime(s);
}

export function isPaused(contact: IgContact): boolean {
    if (!contact.botPausedUntil) return false;
    const until = new Date(contact.botPausedUntil).getTime();
    return Number.isFinite(until) && until > Date.now();
}

// ── fetch helper ─────────────────────────────────────────────────────────────

export class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

function defaultErrorMessage(status: number): string {
    if (status === 401) return "Sessão expirada — faça login novamente.";
    if (status === 403) return "Você não tem acesso a este recurso.";
    if (status === 404) return "Recurso ainda não disponível nesta versão.";
    if (status >= 500) return "Erro interno no servidor. Tente novamente.";
    return `Falha na requisição (HTTP ${status}).`;
}

export async function apiFetch<T>(
    url: string,
    init?: RequestInit,
): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }
    let res: Response;
    try {
        res = await fetch(url, { credentials: "include", ...init, headers });
    } catch {
        throw new ApiError("Falha de rede — verifique sua conexão.", 0);
    }
    let data: unknown = null;
    const text = await res.text();
    if (text) {
        try {
            data = JSON.parse(text) as unknown;
        } catch {
            data = null;
        }
    }
    if (!res.ok) {
        const errorMsg = isRecord(data) ? asString(data.error) : "";
        throw new ApiError(
            errorMsg || defaultErrorMessage(res.status),
            res.status,
        );
    }
    return data as T;
}
