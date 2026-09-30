/**
 * Validação manual (sem zod) dos contratos de entrada do módulo IG Automation.
 *
 * Toda função `validate*` devolve `{ok:true,data}` ou `{ok:false,error}` com
 * mensagem PT-BR pronta para a resposta HTTP. Nenhuma função consulta o banco:
 * existência/ownership de canal, contato, sequência ou webhook é responsabilidade
 * das rotas.
 *
 * Campos JSON são devolvidos como objetos/arrays já parseados; as rotas fazem
 * `JSON.stringify` ao persistir (o DB guarda string) e usam `parseJsonArray`/
 * `parseJsonObject` ao serializar a resposta.
 */

// ─── Constantes congeladas (espelham §4 da spec) ─────────────────────────────

export const IG_TRIGGERS = ["comment", "dm", "story_reply", "story_mention", "postback"] as const;
export type IgTrigger = (typeof IG_TRIGGERS)[number];

export const IG_MATCH_TYPES = ["contains", "exact", "starts_with", "regex"] as const;
export type IgMatchType = (typeof IG_MATCH_TYPES)[number];

export const IG_MATCH_MODES = ["any", "all"] as const;
export type IgMatchMode = (typeof IG_MATCH_MODES)[number];

export const IG_ACTION_TYPES = [
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
] as const;
export type IgActionType = (typeof IG_ACTION_TYPES)[number];

export const IG_BUTTON_TYPES = ["web_url", "postback"] as const;
export type IgButtonType = (typeof IG_BUTTON_TYPES)[number];

export const IG_OUTBOUND_EVENTS = [
    "comment.matched",
    "dm.matched",
    "action.sent",
    "action.failed",
    "click",
    "sequence.step",
] as const;
export type IgOutboundEvent = (typeof IG_OUTBOUND_EVENTS)[number];

export const IG_EVENT_STATUSES = [
    "received",
    "matched",
    "sent",
    "failed",
    "skipped",
    "paused",
    "duplicate",
] as const;

export const IG_ACTION_LOG_STATUSES = ["pending", "sent", "failed", "skipped"] as const;

const MAX_KEYWORDS = 50;
const MAX_KEYWORD_LENGTH = 120;
const MAX_MEDIA_IDS = 50;
const MAX_ACTIONS = 20;
const MAX_ACTION_DELAY_SECONDS = 86400;
const MAX_TEXT_VARIANTS = 10;
const MAX_TEXT_VARIANT_LENGTH = 4000;
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE_LENGTH = 80;
const MAX_QUICK_REPLIES = 13;
const MAX_SEQUENCE_STEPS = 20;
export const MAX_SUBSTANCE_IMPORT = 500;
const MAX_CONTACT_TAGS = 30;
const MAX_CONTACT_TAG_LENGTH = 50;
const MAX_NOTES_LENGTH = 5000;
const DEFAULT_TZ = "America/Bahia";
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

// ─── Tipos de resultado ───────────────────────────────────────────────────────

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ValidatedButton {
    type: IgButtonType;
    title: string;
    url?: string;
    payload?: string;
    track?: boolean;
}

export interface ValidatedQuickReply {
    title: string;
    payload: string;
}

export interface ValidatedQuietHours {
    start: string;
    end: string;
    tz: string;
}

export interface ValidatedActionInput {
    position: number;
    type: IgActionType;
    delaySeconds: number;
    textVariants: string[];
    buttons: ValidatedButton[] | null;
    quickReplies: ValidatedQuickReply[] | null;
    mediaUrl: string | null;
    tag: string | null;
    sequenceId: string | null;
    webhookId: string | null;
    aiPrompt: string | null;
    config: Record<string, unknown> | null;
}

export interface ValidatedAutomationInput {
    name?: string;
    enabled?: boolean;
    priority?: number;
    trigger?: IgTrigger;
    keywords?: string[];
    matchMode?: IgMatchMode;
    matchType?: IgMatchType;
    negativeKeywords?: string[] | null;
    mediaIds?: string[] | null;
    firstInteractionOnly?: boolean;
    cooldownHours?: number | null;
    dailyLimit?: number | null;
    quietHours?: ValidatedQuietHours | null;
    settings?: Record<string, unknown> | null;
    actions?: ValidatedActionInput[];
}

export interface ValidatedSubstanceInput {
    keyword?: string;
    name?: string;
    keywords?: string[];
    description?: string;
    action?: string;
    dosage?: string;
    duration?: string;
    url?: string | null;
    enabled?: boolean;
}

export type ValidatedSequenceStep = Omit<ValidatedActionInput, "position" | "tag" | "sequenceId" | "webhookId">;

export interface ValidatedSequenceInput {
    name?: string;
    channelId?: string;
    enabled?: boolean;
    steps?: ValidatedSequenceStep[];
}

export interface ValidatedOutboundInput {
    name?: string;
    channelId?: string | null;
    url?: string;
    secret?: string | null;
    events?: string[];
    enabled?: boolean;
}

export interface ValidatedContactPatch {
    tags?: string[];
    notes?: string | null;
    customFields?: Record<string, unknown> | null;
    botPausedUntil?: Date | null;
}

// ─── Helpers defensivos de JSON ──────────────────────────────────────────────

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasField(body: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(body, key);
}

function fail<T = never>(error: string): ValidationResult<T> {
    return { ok: false, error };
}

/**
 * Parse defensivo de um campo que deveria ser `string[]` (aceita array ou
 * string JSON). Qualquer falha devolve `[]` — nunca lança.
 */
export function parseJsonArray(raw: unknown): string[] {
    let value: unknown = raw;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            value = JSON.parse(trimmed);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
}

/**
 * Parse defensivo de um campo que deveria ser um objeto JSON (aceita objeto ou
 * string JSON). Qualquer falha devolve `null` — nunca lança.
 */
export function parseJsonObject(raw: unknown): Record<string, unknown> | null {
    let value: unknown = raw;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;
        try {
            value = JSON.parse(trimmed);
        } catch {
            return null;
        }
    }
    return isPlainObject(value) ? value : null;
}

/** Parse defensivo de um campo JSON que pode ser qualquer valor (payload cru). */
export function parseJsonValue(raw: unknown): unknown {
    if (typeof raw !== "string") return raw ?? null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return raw;
    }
}

/** Lista JSON de objetos (botões/quick replies/steps) com fallback `[]`. */
export function parseJsonList(raw: unknown): unknown[] {
    let value: unknown = raw;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            value = JSON.parse(trimmed);
        } catch {
            return [];
        }
    }
    return Array.isArray(value) ? value : [];
}

// ─── Helpers internos ────────────────────────────────────────────────────────

/** Minúsculas, sem acento e sem espaços nas pontas — base do dedupe de keywords. */
export function normalizeKeyword(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function asInt(raw: unknown): number | null {
    if (typeof raw === "boolean") return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? Math.trunc(raw) : null;
    if (typeof raw === "string" && raw.trim() !== "") {
        const n = Number(raw);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    return null;
}

function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function validateKeywordList(
    raw: unknown,
    label: string
): ValidationResult<string[]> {
    if (!Array.isArray(raw)) return fail(`${label} deve ser uma lista de textos`);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string") return fail(`${label} deve conter apenas textos`);
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (trimmed.length > MAX_KEYWORD_LENGTH) {
            return fail(`Cada item de ${label} deve ter no máximo ${MAX_KEYWORD_LENGTH} caracteres`);
        }
        const key = normalizeKeyword(trimmed);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    if (out.length > MAX_KEYWORDS) return fail(`Máximo de ${MAX_KEYWORDS} itens em ${label}`);
    return { ok: true, data: out };
}

function validateMediaIds(raw: unknown): ValidationResult<string[] | null> {
    if (raw === null) return { ok: true, data: null };
    if (!Array.isArray(raw)) return fail("Posts deve ser uma lista de IDs");
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string") return fail("Posts deve conter apenas textos");
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (trimmed.length > 200) return fail("ID de post muito longo");
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    if (out.length > MAX_MEDIA_IDS) return fail(`Máximo de ${MAX_MEDIA_IDS} posts`);
    return { ok: true, data: out };
}

function validateQuietHours(raw: unknown): ValidationResult<ValidatedQuietHours | null> {
    if (raw === undefined || raw === null) return { ok: true, data: null };
    if (!isPlainObject(raw)) return fail("Quiet hours inválido");
    const { start, end } = raw;
    if (typeof start !== "string" || !HHMM_RE.test(start)) {
        return fail("Horário de início inválido (use HH:MM)");
    }
    if (typeof end !== "string" || !HHMM_RE.test(end)) {
        return fail("Horário de fim inválido (use HH:MM)");
    }
    // Timezone inválida não bloqueia: cai no default America/Bahia (spec §6.1).
    const tz = typeof raw.tz === "string" && raw.tz.trim() && isValidTimezone(raw.tz.trim())
        ? raw.tz.trim()
        : DEFAULT_TZ;
    return { ok: true, data: { start, end, tz } };
}

function validateButtons(raw: unknown): ValidationResult<ValidatedButton[] | null> {
    if (raw === undefined || raw === null) return { ok: true, data: null };
    if (!Array.isArray(raw)) return fail("Botões deve ser uma lista");
    if (raw.length > MAX_BUTTONS) return fail(`Máximo de ${MAX_BUTTONS} botões`);
    const out: ValidatedButton[] = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (!isPlainObject(item)) return fail(`Botão ${i + 1} inválido`);
        const type = item.type;
        if (type !== "web_url" && type !== "postback") {
            return fail(`Botão ${i + 1}: tipo inválido`);
        }
        if (typeof item.title !== "string" || !item.title.trim()) {
            return fail(`Botão ${i + 1}: título é obrigatório`);
        }
        const title = item.title.trim();
        if (title.length > MAX_BUTTON_TITLE_LENGTH) {
            return fail(`Botão ${i + 1}: título deve ter no máximo ${MAX_BUTTON_TITLE_LENGTH} caracteres`);
        }
        const button: ValidatedButton = { type, title };
        if (type === "web_url") {
            if (typeof item.url !== "string" || !HTTP_URL_RE.test(item.url.trim())) {
                return fail(`Botão ${i + 1}: URL http(s) inválida`);
            }
            button.url = item.url.trim();
        } else {
            if (typeof item.payload !== "string" || !item.payload.trim()) {
                return fail(`Botão ${i + 1}: payload é obrigatório`);
            }
            if (item.payload.trim().length > 1000) {
                return fail(`Botão ${i + 1}: payload deve ter no máximo 1000 caracteres`);
            }
            button.payload = item.payload.trim();
        }
        if (item.track !== undefined) {
            if (typeof item.track !== "boolean") return fail(`Botão ${i + 1}: track deve ser booleano`);
            button.track = item.track;
        }
        out.push(button);
    }
    return { ok: true, data: out };
}

function validateQuickReplies(raw: unknown): ValidationResult<ValidatedQuickReply[] | null> {
    if (raw === undefined || raw === null) return { ok: true, data: null };
    if (!Array.isArray(raw)) return fail("Respostas rápidas deve ser uma lista");
    if (raw.length > MAX_QUICK_REPLIES) {
        return fail(`Máximo de ${MAX_QUICK_REPLIES} respostas rápidas`);
    }
    const out: ValidatedQuickReply[] = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (!isPlainObject(item)) return fail(`Resposta rápida ${i + 1} inválida`);
        if (typeof item.title !== "string" || !item.title.trim()) {
            return fail(`Resposta rápida ${i + 1}: título é obrigatório`);
        }
        if (typeof item.payload !== "string" || !item.payload.trim()) {
            return fail(`Resposta rápida ${i + 1}: payload é obrigatório`);
        }
        const title = item.title.trim();
        const payload = item.payload.trim();
        if (title.length > MAX_BUTTON_TITLE_LENGTH) {
            return fail(`Resposta rápida ${i + 1}: título deve ter no máximo ${MAX_BUTTON_TITLE_LENGTH} caracteres`);
        }
        if (payload.length > 1000) {
            return fail(`Resposta rápida ${i + 1}: payload deve ter no máximo 1000 caracteres`);
        }
        out.push({ title, payload });
    }
    return { ok: true, data: out };
}

type ValidatedActionFields = Omit<ValidatedActionInput, "position">;

function validateActionFields(raw: unknown, context: string): ValidationResult<ValidatedActionFields> {
    if (!isPlainObject(raw)) return fail(`${context}: dados inválidos`);

    const type = raw.type;
    if (typeof type !== "string" || !(IG_ACTION_TYPES as readonly string[]).includes(type)) {
        return fail(`${context}: tipo de ação inválido`);
    }

    let delaySeconds = 0;
    if (raw.delaySeconds !== undefined && raw.delaySeconds !== null) {
        const parsed = asInt(raw.delaySeconds);
        if (parsed === null || parsed < 0 || parsed > MAX_ACTION_DELAY_SECONDS) {
            return fail(`${context}: delay deve estar entre 0 e ${MAX_ACTION_DELAY_SECONDS} segundos`);
        }
        delaySeconds = parsed;
    }

    const textVariants: string[] = [];
    if (raw.textVariants !== undefined && raw.textVariants !== null) {
        if (!Array.isArray(raw.textVariants)) return fail(`${context}: variações de texto deve ser uma lista`);
        if (raw.textVariants.length > MAX_TEXT_VARIANTS) {
            return fail(`${context}: máximo de ${MAX_TEXT_VARIANTS} variações de texto`);
        }
        for (const variant of raw.textVariants) {
            if (typeof variant !== "string") return fail(`${context}: variações de texto deve conter apenas textos`);
            const trimmed = variant.trim();
            if (!trimmed) continue;
            if (trimmed.length > MAX_TEXT_VARIANT_LENGTH) {
                return fail(`${context}: cada variação deve ter no máximo ${MAX_TEXT_VARIANT_LENGTH} caracteres`);
            }
            textVariants.push(trimmed);
        }
    }

    const buttons = validateButtons(raw.buttons);
    if (!buttons.ok) return fail(`${context}: ${buttons.error}`);

    const quickReplies = validateQuickReplies(raw.quickReplies);
    if (!quickReplies.ok) return fail(`${context}: ${quickReplies.error}`);

    let mediaUrl: string | null = null;
    if (raw.mediaUrl !== undefined && raw.mediaUrl !== null && raw.mediaUrl !== "") {
        if (typeof raw.mediaUrl !== "string" || !HTTP_URL_RE.test(raw.mediaUrl.trim())) {
            return fail(`${context}: URL de mídia inválida`);
        }
        mediaUrl = raw.mediaUrl.trim();
    }

    let tag: string | null = null;
    if (raw.tag !== undefined && raw.tag !== null && raw.tag !== "") {
        if (typeof raw.tag !== "string" || !raw.tag.trim()) return fail(`${context}: tag inválida`);
        tag = raw.tag.trim();
        if (tag.length > MAX_BUTTON_TITLE_LENGTH) {
            return fail(`${context}: tag deve ter no máximo ${MAX_BUTTON_TITLE_LENGTH} caracteres`);
        }
    }

    const sequenceId = readOptionalId(raw.sequenceId);
    if (sequenceId === false) return fail(`${context}: sequência inválida`);
    const webhookId = readOptionalId(raw.webhookId);
    if (webhookId === false) return fail(`${context}: webhook inválido`);

    let aiPrompt: string | null = null;
    if (raw.aiPrompt !== undefined && raw.aiPrompt !== null && raw.aiPrompt !== "") {
        if (typeof raw.aiPrompt !== "string") return fail(`${context}: prompt de IA inválido`);
        aiPrompt = raw.aiPrompt.trim() || null;
        if (aiPrompt && aiPrompt.length > MAX_TEXT_VARIANT_LENGTH) {
            return fail(`${context}: prompt de IA deve ter no máximo ${MAX_TEXT_VARIANT_LENGTH} caracteres`);
        }
    }

    let config: Record<string, unknown> | null = null;
    if (raw.config !== undefined && raw.config !== null) {
        config = parseJsonObject(raw.config);
        if (config === null) return fail(`${context}: configuração inválida`);
    }

    return {
        ok: true,
        data: {
            type: type as IgActionType,
            delaySeconds,
            textVariants,
            buttons: buttons.data,
            quickReplies: quickReplies.data,
            mediaUrl,
            tag,
            sequenceId,
            webhookId,
            aiPrompt,
            config,
        },
    };
}

function readOptionalId(raw: unknown): string | null | false {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string" || !raw.trim()) return false;
    const value = raw.trim();
    if (value.length > 100) return false;
    return value;
}

function validateActionsArray(raw: unknown): ValidationResult<ValidatedActionInput[]> {
    if (!Array.isArray(raw)) return fail("Ações deve ser uma lista");
    if (raw.length > MAX_ACTIONS) return fail(`Máximo de ${MAX_ACTIONS} ações`);
    const out: ValidatedActionInput[] = [];
    for (let i = 0; i < raw.length; i++) {
        const fields = validateActionFields(raw[i], `Ação ${i + 1}`);
        if (!fields.ok) return fail(fields.error);
        // Posições são normalizadas para 0..n-1 conforme a ordem enviada.
        out.push({ position: i, ...fields.data });
    }
    return { ok: true, data: out };
}

function parseStrictRegexKeywords(keywords: string[]): string | null {
    for (const keyword of keywords) {
        try {
            new RegExp(keyword);
        } catch {
            return keyword;
        }
    }
    return null;
}

// ─── Automação ───────────────────────────────────────────────────────────────

export function validateAutomationInput(
    body: unknown,
    options: { partial?: boolean } = {}
): ValidationResult<ValidatedAutomationInput> {
    if (!isPlainObject(body)) return fail("Corpo da requisição inválido");
    const partial = options.partial === true;
    const data: ValidatedAutomationInput = {};

    if (hasField(body, "name")) {
        if (typeof body.name !== "string" || !body.name.trim()) return fail("Nome é obrigatório");
        const name = body.name.trim();
        if (name.length > 120) return fail("Nome deve ter no máximo 120 caracteres");
        data.name = name;
    } else if (!partial) {
        return fail("Nome é obrigatório");
    }

    if (hasField(body, "enabled")) {
        if (typeof body.enabled !== "boolean") return fail("Campo enabled deve ser booleano");
        data.enabled = body.enabled;
    }

    if (hasField(body, "priority")) {
        const priority = asInt(body.priority);
        if (priority === null || priority < -1000 || priority > 1000) {
            return fail("Prioridade deve estar entre -1000 e 1000");
        }
        data.priority = priority;
    }

    if (hasField(body, "trigger")) {
        if (typeof body.trigger !== "string" || !(IG_TRIGGERS as readonly string[]).includes(body.trigger)) {
            return fail("Gatilho inválido");
        }
        data.trigger = body.trigger as IgTrigger;
    } else if (!partial) {
        data.trigger = "comment";
    }

    if (hasField(body, "keywords")) {
        const keywords = validateKeywordList(body.keywords, "Palavras-chave");
        if (!keywords.ok) return fail(keywords.error);
        data.keywords = keywords.data;
    } else if (!partial) {
        data.keywords = [];
    }

    if (hasField(body, "matchMode")) {
        if (typeof body.matchMode !== "string" || !(IG_MATCH_MODES as readonly string[]).includes(body.matchMode)) {
            return fail("Modo de correspondência inválido");
        }
        data.matchMode = body.matchMode as IgMatchMode;
    } else if (!partial) {
        data.matchMode = "any";
    }

    if (hasField(body, "matchType")) {
        if (typeof body.matchType !== "string" || !(IG_MATCH_TYPES as readonly string[]).includes(body.matchType)) {
            return fail("Tipo de correspondência inválido");
        }
        data.matchType = body.matchType as IgMatchType;
    } else if (!partial) {
        data.matchType = "contains";
    }

    if (hasField(body, "negativeKeywords")) {
        if (body.negativeKeywords === null) {
            data.negativeKeywords = null;
        } else {
            const negatives = validateKeywordList(body.negativeKeywords, "Palavras-chave negativas");
            if (!negatives.ok) return fail(negatives.error);
            data.negativeKeywords = negatives.data;
        }
    }

    if (hasField(body, "mediaIds")) {
        const mediaIds = validateMediaIds(body.mediaIds);
        if (!mediaIds.ok) return fail(mediaIds.error);
        data.mediaIds = mediaIds.data;
    }

    if (hasField(body, "firstInteractionOnly")) {
        if (typeof body.firstInteractionOnly !== "boolean") {
            return fail("Campo firstInteractionOnly deve ser booleano");
        }
        data.firstInteractionOnly = body.firstInteractionOnly;
    }

    if (hasField(body, "cooldownHours")) {
        if (body.cooldownHours === null) {
            data.cooldownHours = null;
        } else {
            const cooldown = asInt(body.cooldownHours);
            if (cooldown === null || cooldown < 0 || cooldown > 8760) {
                return fail("Cooldown deve estar entre 0 e 8760 horas");
            }
            data.cooldownHours = cooldown;
        }
    }

    if (hasField(body, "dailyLimit")) {
        if (body.dailyLimit === null) {
            data.dailyLimit = null;
        } else {
            const dailyLimit = asInt(body.dailyLimit);
            if (dailyLimit === null || dailyLimit < 0 || dailyLimit > 1000) {
                return fail("Limite diário deve estar entre 0 e 1000");
            }
            data.dailyLimit = dailyLimit;
        }
    }

    if (hasField(body, "quietHours")) {
        const quietHours = validateQuietHours(body.quietHours);
        if (!quietHours.ok) return fail(quietHours.error);
        data.quietHours = quietHours.data;
    }

    if (hasField(body, "settings")) {
        if (body.settings === null) {
            data.settings = null;
        } else {
            const settings = parseJsonObject(body.settings);
            if (settings === null) return fail("Configurações inválidas");
            data.settings = settings;
        }
    }

    if (hasField(body, "actions")) {
        if (body.actions === null) {
            data.actions = [];
        } else {
            const actions = validateActionsArray(body.actions);
            if (!actions.ok) return fail(actions.error);
            data.actions = actions.data;
        }
    }

    // Keywords em regex precisam compilar (só valida o que veio neste payload).
    if (data.matchType === "regex" && data.keywords && data.keywords.length > 0) {
        const invalid = parseStrictRegexKeywords(data.keywords);
        if (invalid !== null) return fail(`Regex inválida: "${invalid}"`);
    }

    return { ok: true, data };
}

// ─── Substância ──────────────────────────────────────────────────────────────

export function validateSubstanceInput(
    body: unknown,
    options: { partial?: boolean } = {}
): ValidationResult<ValidatedSubstanceInput> {
    if (!isPlainObject(body)) return fail("Corpo da requisição inválido");
    const partial = options.partial === true;
    const data: ValidatedSubstanceInput = {};

    if (hasField(body, "keyword")) {
        if (typeof body.keyword !== "string" || !body.keyword.trim()) return fail("Keyword é obrigatória");
        const keyword = body.keyword.trim();
        if (keyword.length > 120) return fail("Keyword deve ter no máximo 120 caracteres");
        data.keyword = keyword;
    } else if (!partial) {
        return fail("Keyword é obrigatória");
    }

    if (hasField(body, "name")) {
        if (typeof body.name !== "string" || !body.name.trim()) return fail("Nome é obrigatório");
        const name = body.name.trim();
        if (name.length > 200) return fail("Nome deve ter no máximo 200 caracteres");
        data.name = name;
    } else if (!partial) {
        return fail("Nome é obrigatório");
    }

    if (hasField(body, "keywords")) {
        const synonyms = validateKeywordList(body.keywords, "Sinônimos");
        if (!synonyms.ok) return fail(synonyms.error);
        data.keywords = synonyms.data;
    } else if (!partial) {
        data.keywords = [];
    }

    const textFields: Array<{ key: "description" | "action" | "dosage" | "duration"; label: string }> = [
        { key: "description", label: "Descrição" },
        { key: "action", label: "Ação" },
        { key: "dosage", label: "Dosagem" },
        { key: "duration", label: "Duração" },
    ];
    for (const { key, label } of textFields) {
        if (hasField(body, key)) {
            if (body[key] === null) {
                data[key] = "";
            } else if (typeof body[key] !== "string") {
                return fail(`${label} deve ser texto`);
            } else {
                const value = (body[key] as string).trim();
                if (value.length > 10000) return fail(`${label} deve ter no máximo 10000 caracteres`);
                data[key] = value;
            }
        } else if (!partial) {
            data[key] = "";
        }
    }

    if (hasField(body, "url")) {
        if (body.url === null || body.url === "") {
            data.url = null;
        } else if (typeof body.url !== "string" || !HTTP_URL_RE.test(body.url.trim())) {
            return fail("URL inválida");
        } else {
            data.url = body.url.trim();
        }
    } else if (!partial) {
        data.url = null;
    }

    if (hasField(body, "enabled")) {
        if (typeof body.enabled !== "boolean") return fail("Campo enabled deve ser booleano");
        data.enabled = body.enabled;
    }

    return { ok: true, data };
}

// ─── Sequência ───────────────────────────────────────────────────────────────

export function validateSequenceInput(
    body: unknown,
    options: { partial?: boolean } = {}
): ValidationResult<ValidatedSequenceInput> {
    if (!isPlainObject(body)) return fail("Corpo da requisição inválido");
    const partial = options.partial === true;
    const data: ValidatedSequenceInput = {};

    if (hasField(body, "name")) {
        if (typeof body.name !== "string" || !body.name.trim()) return fail("Nome é obrigatório");
        const name = body.name.trim();
        if (name.length > 120) return fail("Nome deve ter no máximo 120 caracteres");
        data.name = name;
    } else if (!partial) {
        return fail("Nome é obrigatório");
    }

    if (hasField(body, "channelId")) {
        if (typeof body.channelId !== "string" || !body.channelId.trim()) {
            return fail("Canal é obrigatório");
        }
        data.channelId = body.channelId.trim();
    } else if (!partial) {
        return fail("Canal é obrigatório");
    }

    if (hasField(body, "enabled")) {
        if (typeof body.enabled !== "boolean") return fail("Campo enabled deve ser booleano");
        data.enabled = body.enabled;
    }

    if (hasField(body, "steps")) {
        if (!Array.isArray(body.steps)) return fail("Passos deve ser uma lista");
        if (body.steps.length > MAX_SEQUENCE_STEPS) {
            return fail(`Máximo de ${MAX_SEQUENCE_STEPS} passos`);
        }
        const steps: ValidatedSequenceStep[] = [];
        for (let i = 0; i < body.steps.length; i++) {
            const fields = validateActionFields(body.steps[i], `Passo ${i + 1}`);
            if (!fields.ok) return fail(fields.error);
            steps.push({
                type: fields.data.type,
                delaySeconds: fields.data.delaySeconds,
                textVariants: fields.data.textVariants,
                buttons: fields.data.buttons,
                quickReplies: fields.data.quickReplies,
                mediaUrl: fields.data.mediaUrl,
                aiPrompt: fields.data.aiPrompt,
                config: fields.data.config,
            });
        }
        data.steps = steps;
    } else if (!partial) {
        data.steps = [];
    }

    return { ok: true, data };
}

// ─── Webhook de saída ────────────────────────────────────────────────────────

export function validateOutboundInput(
    body: unknown,
    options: { partial?: boolean } = {}
): ValidationResult<ValidatedOutboundInput> {
    if (!isPlainObject(body)) return fail("Corpo da requisição inválido");
    const partial = options.partial === true;
    const data: ValidatedOutboundInput = {};

    if (hasField(body, "name")) {
        if (typeof body.name !== "string" || !body.name.trim()) return fail("Nome é obrigatório");
        const name = body.name.trim();
        if (name.length > 120) return fail("Nome deve ter no máximo 120 caracteres");
        data.name = name;
    } else if (!partial) {
        return fail("Nome é obrigatório");
    }

    if (hasField(body, "channelId")) {
        if (body.channelId === null || body.channelId === "") {
            data.channelId = null;
        } else if (typeof body.channelId !== "string" || !body.channelId.trim()) {
            return fail("Canal inválido");
        } else {
            data.channelId = body.channelId.trim();
        }
    } else if (!partial) {
        data.channelId = null;
    }

    if (hasField(body, "url")) {
        if (typeof body.url !== "string" || !HTTP_URL_RE.test(body.url.trim())) {
            return fail("URL deve ser http(s)");
        }
        data.url = body.url.trim();
    } else if (!partial) {
        return fail("URL é obrigatória");
    }

    if (hasField(body, "events")) {
        if (!Array.isArray(body.events) || body.events.length === 0) {
            return fail("Informe ao menos um evento");
        }
        const seen = new Set<string>();
        for (const item of body.events) {
            if (typeof item !== "string" || !(IG_OUTBOUND_EVENTS as readonly string[]).includes(item)) {
                return fail("Evento inválido");
            }
            seen.add(item);
        }
        data.events = [...seen];
    } else if (!partial) {
        return fail("Informe ao menos um evento");
    }

    if (hasField(body, "secret")) {
        if (body.secret === null || body.secret === "") {
            data.secret = null;
        } else if (typeof body.secret !== "string") {
            return fail("Segredo inválido");
        } else {
            const secret = body.secret.trim();
            if (secret.length > 500) return fail("Segredo deve ter no máximo 500 caracteres");
            data.secret = secret || null;
        }
    }

    if (hasField(body, "enabled")) {
        if (typeof body.enabled !== "boolean") return fail("Campo enabled deve ser booleano");
        data.enabled = body.enabled;
    }

    return { ok: true, data };
}

// ─── Contato (PATCH manual) ──────────────────────────────────────────────────

export function validateContactPatch(body: unknown): ValidationResult<ValidatedContactPatch> {
    if (!isPlainObject(body)) return fail("Corpo da requisição inválido");
    const data: ValidatedContactPatch = {};

    if (hasField(body, "tags")) {
        if (body.tags === null) {
            data.tags = [];
        } else {
            if (!Array.isArray(body.tags)) return fail("Tags deve ser uma lista");
            const seen = new Set<string>();
            const tags: string[] = [];
            for (const item of body.tags) {
                if (typeof item !== "string") return fail("Tags deve conter apenas textos");
                const tag = item.trim();
                if (!tag) continue;
                if (tag.length > MAX_CONTACT_TAG_LENGTH) {
                    return fail(`Cada tag deve ter no máximo ${MAX_CONTACT_TAG_LENGTH} caracteres`);
                }
                const key = tag.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                tags.push(tag);
            }
            if (tags.length > MAX_CONTACT_TAGS) return fail(`Máximo de ${MAX_CONTACT_TAGS} tags`);
            data.tags = tags;
        }
    }

    if (hasField(body, "notes")) {
        if (body.notes === null) {
            data.notes = null;
        } else if (typeof body.notes !== "string") {
            return fail("Notas deve ser texto");
        } else {
            const notes = body.notes.trim();
            if (notes.length > MAX_NOTES_LENGTH) return fail(`Notas deve ter no máximo ${MAX_NOTES_LENGTH} caracteres`);
            data.notes = notes || null;
        }
    }

    if (hasField(body, "customFields")) {
        if (body.customFields === null) {
            data.customFields = null;
        } else {
            const customFields = parseJsonObject(body.customFields);
            if (customFields === null) return fail("Campos personalizados inválidos");
            data.customFields = customFields;
        }
    }

    if (hasField(body, "botPausedUntil")) {
        const raw = body.botPausedUntil;
        if (raw === null || raw === "") {
            data.botPausedUntil = null;
        } else if (raw instanceof Date) {
            if (Number.isNaN(raw.getTime())) return fail("Data de pausa inválida");
            data.botPausedUntil = raw;
        } else if (typeof raw === "number" && Number.isFinite(raw)) {
            const ms = raw > 1e11 ? raw : raw * 1000;
            const date = new Date(ms);
            if (Number.isNaN(date.getTime())) return fail("Data de pausa inválida");
            data.botPausedUntil = date;
        } else if (typeof raw === "string") {
            const date = new Date(raw.trim());
            if (Number.isNaN(date.getTime())) return fail("Data de pausa inválida");
            data.botPausedUntil = date;
        } else {
            return fail("Data de pausa inválida");
        }
    }

    return { ok: true, data };
}
