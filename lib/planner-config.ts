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

/**
 * Parse defensivo do config: aceita string (possivelmente double-stringified),
 * objeto já parseado, ou null/undefined → {}. NUNCA lança.
 */
export function parsePlannerConfig(rawConfig: unknown): Record<string, any> {
    if (rawConfig == null) return {};
    if (typeof rawConfig === 'object') return rawConfig as Record<string, any>;
    try {
        const first = JSON.parse(String(rawConfig));
        return typeof first === 'string' ? JSON.parse(first) : first;
    } catch {
        return {};
    }
}

/** Parse defensivo do estado de publicação (Planner.state). NUNCA lança. */
export function parsePlannerState(rawState: unknown): Record<string, any> {
    if (rawState == null) return {};
    if (typeof rawState === 'object') return rawState as Record<string, any>;
    try {
        const first = JSON.parse(String(rawState));
        return typeof first === 'string' ? JSON.parse(first) : first;
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

/**
 * Valida a estrutura do config. Retorna { ok, errors } — NUNCA lança.
 * Usado nas rotas de escrita (400 com a lista) e pelo runtime (log claro).
 */
export function validatePlannerConfig(config: unknown): { ok: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { ok: false, errors: ['config deve ser um objeto JSON'] };
    }

    const c = config as Record<string, any>;

    // frequency
    if (c.frequency !== undefined && c.frequency !== null) {
        const freq = c.frequency;
        if (typeof freq !== 'object' || Array.isArray(freq)) {
            errors.push('frequency deve ser um objeto { value, unit }');
        } else {
            if (freq.value !== undefined && freq.value !== null) {
                const num = Number(freq.value);
                if (!Number.isFinite(num) || num < 1) {
                    errors.push('frequency.value deve ser um número >= 1');
                }
            }
            if (freq.unit !== undefined && freq.unit !== null && !(FREQUENCY_UNITS as readonly string[]).includes(String(freq.unit))) {
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
            if (s.start !== undefined && s.start !== null && !isHHMM(s.start)) errors.push('sleep_schedule.start deve estar no formato HH:MM');
            if (s.end !== undefined && s.end !== null && !isHHMM(s.end)) errors.push('sleep_schedule.end deve estar no formato HH:MM');
            // start == end → janela que nunca dorme (isSleepingNow: hhmm >= s && hhmm < s é
            // sempre false). O wizard já bloqueia com este mesmo texto; o servidor agora
            // aplica a mesma regra para payloads via API.
            if (
                typeof s.start === 'string' && typeof s.end === 'string' &&
                isHHMM(s.start) && isHHMM(s.end) &&
                s.start === s.end
            ) {
                errors.push('Sleep start and end must be different times.');
            }
        }
    }

    // caption templates
    if (c.caption_templates !== undefined) {
        if (!Array.isArray(c.caption_templates) || c.caption_templates.some((t: unknown) => typeof t !== 'string')) {
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
        } else if (typeof c.audio_configuration.audio_id !== 'string' || !c.audio_configuration.audio_id.trim()) {
            errors.push('audio_configuration.audio_id é obrigatório');
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

    // timezone
    if (c.timezone !== undefined && typeof c.timezone !== 'string') {
        errors.push('timezone deve ser uma string IANA (ex.: America/Sao_Paulo)');
    }

    return { ok: errors.length === 0, errors };
}

/** Timezone default compartilhado. */
export function getPlannerTimezone(config: Record<string, any>): string {
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
export function getPlannerIntervalMs(config: Record<string, any>): number | null {
    const freq = config.frequency;
    if (!freq || typeof freq !== 'object') return 10 * 60 * 1000; // default 10 min
    const rawValue = freq.value ?? 10;
    const val = Number(rawValue);
    if (!Number.isFinite(val) || val < 1) return null;

    const unit = String(freq.unit || 'minutes');
    const MULTIPLIERS: Record<string, number> = {
        minutes: 60 * 1000,
        hours: 60 * 60 * 1000,
        days: 24 * 60 * 60 * 1000,
        weeks: 7 * 24 * 60 * 60 * 1000,
    };
    return val * (MULTIPLIERS[unit] ?? MULTIPLIERS.minutes);
}

/** Checa se a janela de sleep (HH:MM) está ativa agora, no fuso do planner. */
export function isSleepingNow(config: Record<string, any>, now: Date): boolean {
    const schedule = config.sleep_schedule;
    if (!schedule || typeof schedule !== 'object') return false;
    const { hh, mm } = getTimeInTimeZone(now, getPlannerTimezone(config));
    const hhmm = `${hh}:${mm}`;
    const start = String(schedule.start || '00:00');
    const end = String(schedule.end || '06:00');
    if (start <= end) return hhmm >= start && hhmm < end;
    return hhmm >= start || hhmm < end; // janela que cruza a meia-noite
}
