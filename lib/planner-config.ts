/**
 * planner-config.ts — fonte ÚNICA de parse, validação e normalização do config
 * de planners. Usado por: lib/planner-runtime.ts (cron + run manual),
 * app/api/planners/** (validação de escrita) e app/api/admin/fix-planners.
 *
 * Convenções do config (objeto JSON armazenado em Planner.config):
 *   frequency:      { value: number >= 1, unit: 'minutes'|'hours'|'days'|'weeks' }
 *   sort_order:     'random_loop' | 'old_to_new' | 'new_to_old'
 *   content:        array de itens (library_item | config | carousel_folder)
 *   sleep_schedule: { start: 'HH:MM', end: 'HH:MM' } | null
 *   timezone:       IANA (default 'America/Sao_Paulo')
 *   start_time:     ISO string (data de início)
 *   caption_templates: string[]
 *   caption_rotation:  'off' | 'sequential' | 'random'
 *   collaborators:  string[] OU string comma-separated (normalizado p/ comma-string)
 *   user_tags:      string[] OU string comma-separated (normalizado p/ comma-string)
 *   audio_configuration: objeto { audio_id, audio_volume?, video_volume? }
 *
 * O STATE de publicação (published_indexes, last_index, template_index) NÃO faz
 * parte do config — vive em Planner.state (coluna própria, migration 0003).
 */

const SORT_ORDERS = ['random_loop', 'old_to_new', 'new_to_old'] as const;
const FREQUENCY_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const;
const CAPTION_ROTATIONS = ['off', 'sequential', 'random'] as const;
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

/** Regex estrito de relógio HH:MM (00:00–23:59). */
export function isHHMM(value: unknown): boolean {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** JSON livre de um config/state de planner (shape aceito de qualquer origem). */
export type PlannerJson = Record<string, unknown>;

/**
 * Parse defensivo do config: aceita string (possivelmente double-stringified),
 * objeto já parseado, ou null/undefined → {}. NUNCA lança.
 */
export function parsePlannerConfig(rawConfig: unknown): PlannerJson {
    if (rawConfig == null) return {};
    if (typeof rawConfig === 'object') return rawConfig as PlannerJson;
    try {
        const first = JSON.parse(String(rawConfig));
        return typeof first === 'string' ? JSON.parse(first) : (first as PlannerJson);
    } catch {
        return {};
    }
}

/** Parse defensivo do estado de publicação (Planner.state). NUNCA lança. */
export function parsePlannerState(rawState: unknown): PlannerJson {
    if (rawState == null) return {};
    if (typeof rawState === 'object') return rawState as PlannerJson;
    try {
        const first = JSON.parse(String(rawState));
        return typeof first === 'string' ? JSON.parse(first) : (first as PlannerJson);
    } catch {
        return {};
    }
}

/**
 * Normaliza uma lista de usernames (colaboradores ou tags) para o formato
 * canônico comma-string gravado no banco (coluna String do Post).
 * Aceita: array de strings | string comma-separated | null/undefined.
 * Formato inválido → null (com warning). NUNCA lança.
 */
export function normalizeUsernameList(value: unknown, field: 'collaborators' | 'user_tags'): string | null {
    if (value == null) return null;
    if (Array.isArray(value)) {
        const clean = value
            .map(v => (typeof v === 'string' ? v.trim() : ''))
            .filter(Boolean);
        return clean.length > 0 ? clean.join(',') : null;
    }
    if (typeof value === 'string') {
        const clean = value
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .join(',');
        return clean.length > 0 ? clean : null;
    }
    console.warn(`[planner-config] ${field} com formato inválido (esperado array de strings ou string); ignorado.`);
    return null;
}

export function normalizeCollaborators(value: unknown): string | null {
    return normalizeUsernameList(value, 'collaborators');
}

export function normalizeUserTags(value: unknown): string | null {
    return normalizeUsernameList(value, 'user_tags');
}
/** Normaliza CSV de produtos afiliados YouTube (string comma-separated ou array) -> string CSV limpa ou null. */
export function normalizeYoutubeProductsCsv(value: unknown): string | null {
    if (value == null) return null;
    if (Array.isArray(value)) {
        const clean = value.map(v => (typeof v === 'string' ? v.trim() : String(v ?? '').trim())).filter(Boolean);
        return clean.length > 0 ? clean.join(',') : null;
    }
    if (typeof value === 'string') {
        const clean = value.split(',').map(s => s.trim()).filter(Boolean).join(',');
        return clean.length > 0 ? clean : null;
    }
    console.warn('[planner-config] youtube_products com formato inválido (esperado string CSV); ignorado.');
    return null;
}

/** Const de privacidades válidas do YouTube (para UI e validação). */
export const YOUTUBE_PRIVACIES = ['PUBLIC', 'UNLISTED', 'PRIVATE'] as const;


/**
 * Valida a estrutura do config. Retorna { ok, errors } — NUNCA lança.
 * Usado nas rotas de escrita (400 com a lista) e pelo runtime (log claro).
 */
export function validatePlannerConfig(config: unknown): { ok: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { ok: false, errors: ['config deve ser um objeto JSON'] };
    }

    const c = config as PlannerJson;

    // frequency
    if (c.frequency !== undefined && c.frequency !== null) {
        const freq = c.frequency;
        if (typeof freq !== 'object' || Array.isArray(freq)) {
            errors.push('frequency deve ser um objeto { value, unit }');
        } else {
            const f = freq as PlannerJson;
            if (f.value !== undefined && f.value !== null) {
                const num = Number(f.value);
                if (!Number.isFinite(num) || num < 1) {
                    errors.push('frequency.value deve ser um número >= 1');
                }
            }
            if (f.unit !== undefined && f.unit !== null && !(FREQUENCY_UNITS as readonly string[]).includes(String(f.unit))) {
                errors.push('frequency.unit deve ser minutes | hours | days | weeks');
            }
        }
    }

    // sort_order
    if (c.sort_order !== undefined && !(SORT_ORDERS as readonly string[]).includes(String(c.sort_order))) {
        errors.push(`sort_order deve ser ${SORT_ORDERS.join(' | ')}`);
    }

    // content
    if (c.content !== undefined && !Array.isArray(c.content)) {
        errors.push('content deve ser um array');
    }

    // sleep_schedule
    if (c.sleep_schedule !== undefined && c.sleep_schedule !== null) {
        const s = c.sleep_schedule;
        if (typeof s !== 'object' || Array.isArray(s)) {
            errors.push('sleep_schedule deve ser um objeto { start, end } ou null');
        } else {
            const sched = s as PlannerJson;
            if (sched.start !== undefined && sched.start !== null && !isHHMM(sched.start)) errors.push('sleep_schedule.start deve estar no formato HH:MM');
            if (sched.end !== undefined && sched.end !== null && !isHHMM(sched.end)) errors.push('sleep_schedule.end deve estar no formato HH:MM');
            // start == end → janela que nunca dorme (isSleepingNow: hhmm >= s && hhmm < s é
            // sempre false). O wizard já bloqueia com este mesmo texto; o servidor agora
            // aplica a mesma regra para payloads via API.
            if (
                typeof sched.start === 'string' && typeof sched.end === 'string' &&
                isHHMM(sched.start) && isHHMM(sched.end) &&
                sched.start === sched.end
            ) {
                errors.push('Sleep start and end must be different times.');
            }
        }
    }

    // caption templates
    if (c.caption_templates !== undefined) {
        const templates = c.caption_templates;
        if (!Array.isArray(templates) || templates.some((t: unknown) => typeof t !== 'string')) {
            errors.push('caption_templates deve ser um array de strings');
        }
    }
    if (c.caption_rotation !== undefined && !(CAPTION_ROTATIONS as readonly string[]).includes(String(c.caption_rotation))) {
        errors.push(`caption_rotation deve ser ${CAPTION_ROTATIONS.join(' | ')}`);
    }

    // collaborators / user_tags — mesmo formato aceito pela normalização
    if (c.collaborators !== undefined && c.collaborators !== null && normalizeCollaborators(c.collaborators) === null) {
        errors.push('collaborators deve ser um array de strings ou string comma-separated');
    }
    if (c.user_tags !== undefined && c.user_tags !== null && normalizeUserTags(c.user_tags) === null) {
        errors.push('user_tags deve ser um array de strings ou string comma-separated');
    }

    // audio_configuration
    if (c.audio_configuration !== undefined && c.audio_configuration !== null) {
        if (typeof c.audio_configuration !== 'object' || Array.isArray(c.audio_configuration)) {
            errors.push('audio_configuration deve ser um objeto');
        } else {
            const audio = c.audio_configuration as PlannerJson;
            if (typeof audio.audio_id !== 'string' || !audio.audio_id.trim()) {
                errors.push('audio_configuration.audio_id é obrigatório');
            }
        }
    }

    // start_time
    // Contract: '' ≡ undefined ≡ null ≡ "no start restriction" (the runtime's
    // gate is `config.start_time && now < new Date(...)` — an empty string is
    // already falsy there). The wizard sends '' when "Start When?" is left
    // empty; rejecting it made the default create/edit flow impossible.
    if (c.start_time !== undefined && c.start_time !== null && c.start_time !== '') {
        const d = new Date(String(c.start_time));
        if (Number.isNaN(d.getTime())) {
            errors.push('start_time deve ser uma data ISO válida');
        }
    }

    // ── YouTube (planner YT) ──────────────────────────────────────────────
    // Campos só relevantes quando o planner tem canal YouTube; validação é
    // permissiva: se presente, deve ser válido; vazio/null ≡ ausente.
    const YT_PRIVACIES = ['PUBLIC', 'UNLISTED', 'PRIVATE'] as const;

    // youtube_title: 1..100 chars (trim)
    if (c.youtube_title !== undefined && c.youtube_title !== null && c.youtube_title !== '') {
        if (typeof c.youtube_title !== 'string') {
            errors.push('youtube_title deve ser uma string');
        } else {
            const t = String(c.youtube_title).trim();
            if (t.length === 0) errors.push('Título do YouTube não pode ser vazio');
            else if (t.length > 100) errors.push('Título do YouTube deve ter no máximo 100 caracteres');
        }
    }
    // alias youtube_pinned_comment (spec) e youtube_pinned_comment_text (runtime)
    const ytPinnedRaw = (c as PlannerJson)['youtube_pinned_comment'] ?? (c as PlannerJson)['youtube_pinned_comment_text'];
    // youtube_description: até 5000 chars
    if (c.youtube_description !== undefined && c.youtube_description !== null && c.youtube_description !== '') {
        if (typeof c.youtube_description !== 'string') {
            errors.push('youtube_description deve ser uma string');
        } else if (String(c.youtube_description).length > 5000) {
            errors.push('Descrição do YouTube deve ter no máximo 5000 caracteres');
        }
    }
    // youtube_products: CSV string — cada item não vazio após trim
    if (c.youtube_products !== undefined && c.youtube_products !== null && c.youtube_products !== '') {
        if (typeof c.youtube_products !== 'string' && !Array.isArray(c.youtube_products)) {
            errors.push('youtube_products deve ser uma string com IDs separados por vírgula');
        } else {
            const raw = Array.isArray(c.youtube_products) ? (c.youtube_products as unknown[]).join(',') : String(c.youtube_products);
            // detecta itens vazios (ex: "a,,b" ou "a, ,b" ou trailing comma)
            const parts = raw.split(',');
            const hasEmpty = parts.some((p) => {
                // ignora string vazia total já tratada; mas se houver vírgula, cada segmento deve ser não-vazio
                // um CSV como "" já foi filtrado; "a,b" → 2 partes válidas; "a,,b" → parte vazia no meio → erro
                // "a,b," → última vazia → erro (usuário digitou vírgula extra)
                const trimmed = p.trim();
                // Se raw termina com vírgula ou contém ",,", haverá parte vazia
                return trimmed.length === 0;
            });
            // Permite string vazia/whitespace-only como "sem produtos"? já filtrado ('' não entra). Se usuário enviou "   " → após split → ["   "] → trim vazio → erro
            if (raw.trim().length > 0 && hasEmpty) {
                errors.push('Produtos afiliados contêm item vazio — verifique os IDs separados por vírgula');
            }
            // cada item após trim deve ser não vazio; já coberto, mas valida tamanho individual
            const cleaned = parts.map(p => p.trim()).filter(Boolean);
            if (cleaned.some(item => item.length === 0)) {
                errors.push('Produtos afiliados contêm item vazio — verifique os IDs separados por vírgula');
            }
            if (cleaned.some(item => item.length > 200)) {
                errors.push('Cada produto afiliado deve ter no máximo 200 caracteres');
            }
        }
    }
    // youtube_privacy
    if (c.youtube_privacy !== undefined && c.youtube_privacy !== null && c.youtube_privacy !== '') {
        const v = String(c.youtube_privacy).toUpperCase().trim();
        if (!(YT_PRIVACIES as readonly string[]).includes(v)) {
            errors.push('youtube_privacy deve ser PUBLIC, UNLISTED ou PRIVATE');
        }
    }
    // youtube_made_for_kids
    if (c.youtube_made_for_kids !== undefined && c.youtube_made_for_kids !== null && c.youtube_made_for_kids !== '') {
        const v = c.youtube_made_for_kids;
        const okBool = typeof v === 'boolean' || (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) || v === 0 || v === 1;
        if (!okBool) errors.push('youtube_made_for_kids deve ser verdadeiro ou falso');
    }
    // youtube_monetize_with_ads
    if (c.youtube_monetize_with_ads !== undefined && c.youtube_monetize_with_ads !== null && c.youtube_monetize_with_ads !== '') {
        const v = c.youtube_monetize_with_ads;
        const okBool = typeof v === 'boolean' || (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) || v === 0 || v === 1;
        if (!okBool) errors.push('youtube_monetize_with_ads deve ser verdadeiro ou falso');
    }
    // youtube_category_id
    if (c.youtube_category_id !== undefined && c.youtube_category_id !== null && c.youtube_category_id !== '') {
        const n = Number(c.youtube_category_id);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
            errors.push('youtube_category_id deve ser um número inteiro entre 1 e 100');
        }
    }
    // youtube_pinned_comment / youtube_pinned_comment_text: até 10000
    if (ytPinnedRaw !== undefined && ytPinnedRaw !== null && ytPinnedRaw !== '') {
        if (typeof ytPinnedRaw !== 'string') {
            errors.push('Comentário fixado do YouTube deve ser uma string');
        } else if (String(ytPinnedRaw).length > 10000) {
            errors.push('Comentário fixado do YouTube deve ter no máximo 10000 caracteres');
        }
    }

    // timezone
    if (c.timezone !== undefined && typeof c.timezone !== 'string') {
        errors.push('timezone deve ser uma string IANA (ex.: America/Sao_Paulo)');
    }

    return { ok: errors.length === 0, errors };
}

/** Timezone default compartilhado. */
export function getPlannerTimezone(config: PlannerJson): string {
    return typeof config.timezone === 'string' && config.timezone.trim() ? config.timezone : DEFAULT_TIMEZONE;
}

/** Relógio "HH:MM" no fuso do planner (sem re-parse frágil de string localizada). */
export function getTimeInTimeZone(date: Date, tz: string): { hh: string; mm: string } {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const hh = (parts.find(p => p.type === 'hour')?.value || '00').padStart(2, '0');
    const mm = (parts.find(p => p.type === 'minute')?.value || '00').padStart(2, '0');
    return { hh, mm };
}

/**
 * Intervalo de publicação em ms com validação defensiva:
 * frequência inválida (NaN, 0, negativa) → null (planner deve ser pulado com aviso,
 * em vez de publicar a cada tick ou nunca).
 */
export function getPlannerIntervalMs(config: PlannerJson): number | null {
    const freq = config.frequency;
    if (!freq || typeof freq !== 'object') return 10 * 60 * 1000; // default 10 min
    const f = freq as PlannerJson;
    const rawValue = f.value ?? 10;
    const val = Number(rawValue);
    if (!Number.isFinite(val) || val < 1) return null;

    const unit = String(f.unit || 'minutes');
    const MULTIPLIERS: Record<string, number> = {
        minutes: 60 * 1000,
        hours: 60 * 60 * 1000,
        days: 24 * 60 * 60 * 1000,
        weeks: 7 * 24 * 60 * 60 * 1000,
    };
    return val * (MULTIPLIERS[unit] ?? MULTIPLIERS.minutes);
}

/** Checa se a janela de sleep (HH:MM) está ativa agora, no fuso do planner. */
export function isSleepingNow(config: PlannerJson, now: Date): boolean {
    const schedule = config.sleep_schedule;
    if (!schedule || typeof schedule !== 'object') return false;
    const { hh, mm } = getTimeInTimeZone(now, getPlannerTimezone(config));
    const hhmm = `${hh}:${mm}`;
    const sched = schedule as PlannerJson;
    const start = String(sched.start || '00:00');
    const end = String(sched.end || '06:00');
    if (start <= end) return hhmm >= start && hhmm < end;
    return hhmm >= start || hhmm < end; // janela que cruza a meia-noite
}

// ── Isolation: YouTube vs Instagram ──────────────────────────────────────────

/** Mensagem padrão quando tenta misturar plataformas num mesmo planner. */
export const PLANNER_MIX_ERROR =
    "Planners não podem misturar canais de YouTube e Instagram. Crie planners separados.";

export type PlannerPlatformType = "youtube" | "instagram" | "mixed" | null;

/**
 * Normaliza platform para comparação (lowercase, trim).
 */
function normalizePlatform(p: unknown): string {
    return String(p || "").toLowerCase().trim();
}

/**
 * Determina o tipo de planner a partir dos canais conectados.
 * - [] ou sem plataforma reconhecida → null
 * - só youtube → "youtube"
 * - só instagram → "instagram"
 * - misto youtube+instagram (ou qualquer 2 plataformas distintas) → "mixed"
 *
 * Assinatura oficial: getPlannerPlatformType(config, channels).
 * `config` é aceito mas ignorado na inferência atual — mantido para compatibilidade
 * futura (ex.: config.youtube_*). Sobrecarga: se o primeiro arg for um array e o
 * segundo for undefined, trata o primeiro como `channels`.
 */
export function getPlannerPlatformType(
    config: unknown,
    channels?: Array<{ platform?: string | null }>,
): PlannerPlatformType {
    let list: Array<{ platform?: string | null }>;
    if (Array.isArray(config) && channels === undefined) {
        list = config as Array<{ platform?: string | null }>;
    } else {
        list = (channels || []) as Array<{ platform?: string | null }>;
    }
    if (!list || list.length === 0) return null;
    const platforms = new Set(
        list.map((c) => normalizePlatform((c as { platform?: string | null })?.platform)).filter(Boolean),
    );
    if (platforms.size === 0) return null;
    if (platforms.size === 1) {
        const only = [...platforms][0];
        if (only === "youtube") return "youtube";
        if (only === "instagram") return "instagram";
        // plataforma desconhecida singular → trata como instagram por compatibilidade
        return only as PlannerPlatformType;
    }
    // >1 plataforma distinta
    const hasYt = platforms.has("youtube");
    const hasIg = platforms.has("instagram");
    if (hasYt && hasIg) return "mixed";
    if (platforms.size > 1) return "mixed";
    return null;
}

/**
 * Valida que channelIds não contém plataformas mistas.
 * Busca os canais no banco via prisma e verifica se há mais de uma plataforma distinta.
 * Retorna { ok: true } se válido ou vazio; { ok: false, error: PLANNER_MIX_ERROR } se misto.
 * Não lança — quem chama decide o status HTTP.
 *
 * Assinatura oficial: validatePlannerChannelMix(channelIds, prisma).
 */
export async function validatePlannerChannelMix(
    channelIds: string[],
    prisma: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<{ ok: boolean; error?: string; platforms?: string[] }> {
    if (!channelIds || channelIds.length === 0) return { ok: true, platforms: [] };
    const channels = await prisma.channel.findMany({
        where: { id: { in: channelIds } },
        select: { platform: true },
    } as never);
    const platforms: string[] = [...new Set(channels.map((c: { platform?: string | null }) => normalizePlatform(c.platform)).filter(Boolean) as string[])];
    if (platforms.length > 1) {
        // Se há youtube e instagram simultaneamente, ou qualquer mix, bloqueia.
        return { ok: false, error: PLANNER_MIX_ERROR, platforms };
    }
    return { ok: true, platforms };
}

/**
 * Helper síncrono para listas já carregadas (sem prisma).
 */
export function isMixedPlatformChannels(channels: Array<{ platform?: string | null }>): boolean {
    return getPlannerPlatformType(channels) === "mixed";
}

