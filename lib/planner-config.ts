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

const SORT_ORDERS = ["random_loop", "old_to_new", "new_to_old"] as const;
const FREQUENCY_UNITS = ["minutes", "hours", "days", "weeks"] as const;
const CAPTION_ROTATIONS = ["off", "sequential", "random"] as const;
const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/** Regex estrito de relógio HH:MM (00:00–23:59). */
export function isHHMM(value: unknown): boolean {
    return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** JSON livre de um config/state de planner (shape aceito de qualquer origem). */
export type PlannerJson = Record<string, unknown>;

/**
 * Parse defensivo do config: aceita string (possivelmente double-stringified),
 * objeto já parseado, ou null/undefined → {}. NUNCA lança.
 */
export function parsePlannerConfig(rawConfig: unknown): PlannerJson {
    if (rawConfig == null) return {};
    if (typeof rawConfig === "object") return rawConfig as PlannerJson;
    try {
        const first = JSON.parse(String(rawConfig));
        return typeof first === "string"
            ? JSON.parse(first)
            : (first as PlannerJson);
    } catch {
        return {};
    }
}

/** Parse defensivo do estado de publicação (Planner.state). NUNCA lança. */
export function parsePlannerState(rawState: unknown): PlannerJson {
    if (rawState == null) return {};
    if (typeof rawState === "object") return rawState as PlannerJson;
    try {
        const first = JSON.parse(String(rawState));
        return typeof first === "string"
            ? JSON.parse(first)
            : (first as PlannerJson);
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
export function normalizeUsernameList(
    value: unknown,
    field: "collaborators" | "user_tags",
): string | null {
    if (value == null) return null;
    if (Array.isArray(value)) {
        const clean = value
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter(Boolean);
        return clean.length > 0 ? clean.join(",") : null;
    }
    if (typeof value === "string") {
        const clean = value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .join(",");
        return clean.length > 0 ? clean : null;
    }
    console.warn(
        `[planner-config] ${field} com formato inválido (esperado array de strings ou string); ignorado.`,
    );
    return null;
}

export function normalizeCollaborators(value: unknown): string | null {
    return normalizeUsernameList(value, "collaborators");
}

export function normalizeUserTags(value: unknown): string | null {
    return normalizeUsernameList(value, "user_tags");
}
/** Normaliza CSV de produtos afiliados YouTube (string comma-separated ou array) -> string CSV limpa ou null. */
export function normalizeYoutubeProductsCsv(value: unknown): string | null {
    if (value == null) return null;
    if (Array.isArray(value)) {
        const clean = value
            .map((v) =>
                typeof v === "string" ? v.trim() : String(v ?? "").trim(),
            )
            .filter(Boolean);
        return clean.length > 0 ? clean.join(",") : null;
    }
    if (typeof value === "string") {
        const clean = value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .join(",");
        return clean.length > 0 ? clean : null;
    }
    console.warn(
        "[planner-config] youtube_products com formato inválido (esperado string CSV); ignorado.",
    );
    return null;
}

/**
 * Formato canônico de produto afiliado no config do planner:
 *   { query: nome digitado, item?: bloco verbatim (itemId) quando o usuário
 *     escolheu um produto específico da busca; se ausente, a API auto-seleciona
 *     o melhor produto para aquele nome na publicação }
 */
export interface YoutubeProductEntry {
    query: string;
    item?: unknown;
    title?: string;
    vendor?: string;
    price?: string;
    commission_pct?: number;
}

/**
 * Normaliza youtube_products (novo formato) -> array de {query, item?}.
 * Aceita: array de {query,item?} | array de strings | CSV string (legacy).
 * Retorna null se vazio/ inválido. NUNCA lança.
 */
export function normalizeYoutubeProductsList(
    value: unknown,
): YoutubeProductEntry[] | null {
    if (value == null) return null;
    if (Array.isArray(value)) {
        const out: YoutubeProductEntry[] = [];
        for (const v of value) {
            if (typeof v === "string") {
                const q = v.trim();
                if (q) out.push({ query: q });
            } else if (v && typeof v === "object") {
                const o = v as Record<string, unknown>;
                const q =
                    typeof o.query === "string"
                        ? o.query.trim()
                        : String(o.title ?? o.name ?? "").trim();
                if (!q) continue;
                out.push({
                    query: q,
                    ...(o.item !== undefined ? { item: o.item } : {}),
                    ...(typeof o.title === "string" ? { title: o.title } : {}),
                    ...(typeof o.vendor === "string"
                        ? { vendor: o.vendor }
                        : {}),
                    ...(typeof o.price === "string" ? { price: o.price } : {}),
                    ...(typeof o.commission_pct === "number"
                        ? { commission_pct: o.commission_pct }
                        : {}),
                });
            }
        }
        return out.length > 0 ? out : null;
    }
    if (typeof value === "string") {
        const clean = value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (clean.length === 0) return null;
        // legacy CSV de itemIds: cada entrada vira { query: id } (sem item)
        return clean.map((q) => ({ query: q }));
    }
    console.warn(
        "[planner-config] youtube_products inválido (esperado array de {query,item?} ou CSV); ignorado.",
    );
    return null;
}

/** Serializa a lista de produtos para o config JSON (array de objetos). */
export function serializeYoutubeProducts(
    entries: YoutubeProductEntry[] | null,
): YoutubeProductEntry[] | null {
    if (!entries || entries.length === 0) return null;
    return entries.map((e) => ({
        query: e.query,
        ...(e.item !== undefined ? { item: e.item } : {}),
        ...(e.title !== undefined ? { title: e.title } : {}),
        ...(e.vendor !== undefined ? { vendor: e.vendor } : {}),
        ...(e.price !== undefined ? { price: e.price } : {}),
        ...(e.commission_pct !== undefined
            ? { commission_pct: e.commission_pct }
            : {}),
    }));
}

/**
 * Payload separado de produtos afiliados para a publicação do Short (B1).
 * Única fonte usada por buildPostData, propagação e preview: transforma
 * youtube_products do config (Array<{query,item?}> | array de strings | CSV
 * legacy) no formato que o publisher roteia:
 *   - names: entradas query-only -> POST /api/shorts/auto (product_names)
 *   - items: entradas verbatim -> POST /api/shorts (products: [{item}])
 * NUNCA misturar os dois na MESMA chamada da API externa.
 */
export interface YoutubeProductsPayload {
    /** Nomes/termos de busca (entradas sem item) — rota /api/shorts/auto. */
    names: string[];
    /** Itens verbatim { item: <bloco do catálogo> } — rota /api/shorts. */
    items: { item: unknown }[];
    hasNames: boolean;
    hasItems: boolean;
}

/**
 * B1/M1..M4/M22 — helper ÚNICO de produtos afiliados.
 * Converte youtube_products em { names, items } usando
 * normalizeYoutubeProductsList (que já aceita CSV legacy / array de strings /
 * array de {query,item?}). NUNCA aplica template {var} nem split por vírgula
 * no nome do produto (M22): o nome viaja intacto em `names` e cada `item` é
 * preservado verbatim. Entrada com item -> items (não vira name).
 */
/** Forma bruta aceita como fonte de produtos (CSV de nomes, array de
 * {query,item?}, ou null/undefined = sem produtos). */
export type YoutubeProductsSource = string | unknown[] | null | undefined;

/**
 * REGRA ITEM > FIXO (decisão do dono — produtos por vídeo na library):
 * devolve a fonte de produtos que vence: o CSV de nomes do ContentItem
 * (quando não-vazio) preferido ao youtube_products fixo do config do planner.
 * Função PURA (testável) — o runtime a usa em buildYoutubeOptionsForPost e
 * propagação; a UI a espelha para o aviso "este vídeo tem N produto(s)".
 */
export function resolveYoutubeProductsSource(
	itemProducts: YoutubeProductsSource,
	configProducts: YoutubeProductsSource,
): YoutubeProductsSource {
	if (typeof itemProducts === "string" && itemProducts.trim()) {
		// Não normaliza aqui: toYoutubeProductsJson faz a separação nomes/verbatim.
		return itemProducts;
	}
	return configProducts;
}

export function toYoutubeProductsJson(value: unknown): YoutubeProductsPayload {
    const entries = normalizeYoutubeProductsList(value) ?? [];
    const names: string[] = [];
    const items: { item: unknown }[] = [];
    for (const e of entries) {
        if (e.item !== undefined) {
            // verbatim: { item: <bloco do catálogo> } (compatível com
            // build_products_selection da API externa — passthrough fiel).
            items.push({ item: e.item });
        } else {
            const q = e.query.trim();
            if (q) names.push(q);
        }
    }
    return { names, items, hasNames: names.length > 0, hasItems: items.length > 0 };
}

/**
 * B1 — roteamento real de tagging no publisher (lado do Short).
 * Única fonte da DECISÃO /api/shorts vs /api/shorts/auto (extraída do bloco
 * inline do publisher para ser testável — cf. scripts/gauntlet/products-routing.mts).
 * Lê `youtube_options.products` (JSON string | array) e `product_names`
 * (JSON string | array) do post e devolve o que mandar em cada rota:
 *   - verbatim: algum item-objeto -> POST /api/shorts com `products`
 *     (nomes coexistentes viram `skippedNames` — NUNCA misturados na mesma
 *     chamada; regra segura: item escolhido pelo usuário tem prioridade);
 *   - auto: só nomes -> POST /api/shorts/auto com `product_names`;
 *   - none: nada -> /shorts com products vazio.
 * Legacy (M1/M22): products como '["nome"]' / CSV cru / lixo "[object Object]"
 * de configs pré-B1 são colapsados em nomes (auto) ou descartados — a API
 * externa _parse_products descarta strings silenciosamente, então strings
 * NUNCA voltam para `items`.
 */
export interface ShortProductsRouting {
    route: "verbatim" | "auto" | "none";
    /** Itens-objeto (dicts) p/ POST /api/shorts — products. */
    items: unknown[];
    /** Nomes/termos de busca p/ POST /api/shorts/auto — product_names. */
    names: string[];
    /** Nomes ignorados por coexistirem com itens verbatim (SKIP). */
    skippedNames: number;
}

export function resolveShortProductsRouting(options: {
    products?: unknown;
    product_names?: unknown;
}): ShortProductsRouting {
    let itemsArr: unknown[] = [];
    if (typeof options.products === "string" && options.products.trim()) {
        try {
            const parsed = JSON.parse(options.products) as unknown;
            if (Array.isArray(parsed)) itemsArr = parsed;
            else if (typeof parsed === "string" && parsed.trim()) {
                // CSV cru dentro do JSON (legado): nomes, não itens
                itemsArr = parsed
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
        } catch {
            // não-JSON: CSV cru de posts MUITO antigos — nomes, não itens
            itemsArr = options.products
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }
    } else if (Array.isArray(options.products)) {
        itemsArr = options.products;
    }

    let namesArr: string[] = [];
    if (Array.isArray(options.product_names)) {
        namesArr = (options.product_names as unknown[])
            .filter((x): x is string => typeof x === "string" && !!x.trim())
            .map((s) => s.trim());
    } else if (typeof options.product_names === "string" && options.product_names.trim()) {
        try {
            const parsed = JSON.parse(options.product_names) as unknown;
            if (Array.isArray(parsed)) {
                namesArr = (parsed as unknown[])
                    .filter((x): x is string => typeof x === "string" && !!x.trim())
                    .map((s) => s.trim());
            } else {
                namesArr = [options.product_names.trim()];
            }
        } catch {
            namesArr = [];
        }
    }

    // itens verbatim = objetos (shape B1 { item } ou shape legacy
    // {merchant_id,...}); strings legacy viram nomes (auto-select).
    const verbatimItems = itemsArr.filter(
        (v): v is Record<string, unknown> =>
            v != null && typeof v === "object" && !Array.isArray(v),
    );
    const legacyNameStrings = itemsArr.filter(
        (v): v is string => typeof v === "string" && !!v.trim(),
    );
    if (legacyNameStrings.length > 0) namesArr.push(...legacyNameStrings.map((s) => s.trim()));
    // lixo de configs pré-B1 (array de objetos virou "[object Object]"):
    // nunca vira nome de busca — descartado
    namesArr = namesArr.filter((n) => n !== "[object Object]");

    let route: ShortProductsRouting["route"] = "none";
    if (verbatimItems.length > 0) route = "verbatim";
    else if (namesArr.length > 0) route = "auto";
    return {
        route,
        items: verbatimItems,
        names: namesArr,
        skippedNames: route === "verbatim" ? namesArr.length : 0,
    };
}

/** Categorias de vídeo do YouTube (id -> nome) para o dropdown do planner. */
export const YOUTUBE_CATEGORIES: Record<number, string> = {
    1: "Film & Animation",
    2: "Autos & Vehicles",
    10: "Music",
    15: "Pets & Animals",
    17: "Sports",
    18: "Short Movies",
    19: "Travel & Events",
    20: "Gaming",
    21: "Videoblogging",
    22: "People & Blogs",
    23: "Comedy",
    24: "Entertainment",
    25: "News & Politics",
    26: "Howto & Style",
    27: "Education",
    28: "Science & Technology",
    29: "Nonprofits & Activism",
};

export const YOUTUBE_CATEGORY_DEFAULT = 22;

export const TIKTOK_PRIVACY_OPTIONS = [
	"PUBLIC_TO_EVERYONE",
	"MUTUAL_FOLLOW_FRIENDS",
	"FOLLOWER_OF_CREATOR",
	"SELF_ONLY",
] as const;

export const TIKTOK_PRIVACY_FALLBACK: readonly string[] = [
	"PUBLIC_TO_EVERYONE",
	"MUTUAL_FOLLOW_FRIENDS",
	"SELF_ONLY",
] as const;

export type TiktokPrivacyLevel = typeof TIKTOK_PRIVACY_OPTIONS[number];

/**
 * Estima o texto FINAL de uma legenda como o runtime fará (applyCaptionTemplate
 * simplificado, sem acesso ao banco): rotação ativa com templates → substitui
 * cada template; senão → substitui a caption base. Variáveis conhecidas
 * resolvem dos fallbacks que o planner conhece; {date} e {channel_name} sempre
 * resolvem não-vazios; placeholders desconhecidos ({hashtags}, {qualquer_coisa})
 * resolvem "" — conservador: um texto que possa resolver vazio falha
 * permanentemente na publicação (Comunidade exige message não-vazia no
 * publisher e na API externa). Fonte ÚNICA também do wizard
 * (components/PlannerWizard.tsx importa esta função) para não divergirem.
 */
export function resolveCaptionTextForWizard(opts: {
	caption: string;
	captionTemplates: string;
	captionRotation: string;
	captionFallback: string;
	titleFallback: string;
}): string {
	const {
		caption,
		captionTemplates,
		captionRotation,
		captionFallback,
		titleFallback,
	} = opts;
	const templates = captionTemplates
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	const source =
		templates.length > 0 && captionRotation !== "off"
			? templates.join("\n")
			: caption;
	return source.replace(/\{[a-zA-Z0-9_]+\}/g, (m: string) => {
		switch (m) {
			case "{post_caption}":
				return captionFallback;
			case "{post_title}":
				return titleFallback;
			case "{date}":
			case "{channel_name}":
				return "1"; // sempre resolvem não-vazio
			default:
				return ""; // {hashtags} e desconhecidos → ""
		}
	});
}

/** Campos youtube_* do config — presença indica planner com canal YouTube. */
const YT_CONFIG_KEYS = [
	"youtube_title",
	"youtube_description",
	"youtube_products",
	"youtube_privacy",
	"youtube_made_for_kids",
	"youtube_monetize_with_ads",
	"youtube_category_id",
	"youtube_pinned_comment",
	"youtube_pinned_comment_text",
] as const;

/**
 * M7/P0-B0 — Post na Comunidade do YouTube exige texto (deadlock do wizard:
 * campos IG ocultos pelo isolation sem substituto YT). Só dispara para
 * planners com canal YouTube (config tem campo youtube_*) e entradas de
 * Comunidade (media_type IMAGE/CAROUSEL — o wizard oculta os campos de vídeo
 * nesse modo e expõe "Texto da Publicação" gravando no MESMO content[].caption).
 * SHORTS NUNCA bloqueiam aqui: entradas media_type REELS (ou sem media_type,
 * legado preservado tal-qual) passam sem exigir texto — com youtube_title o
 * upload direto de Short não depende de caption (rawYtTitle é a 1ª fonte do
 * título no runtime, planner-runtime.ts:452-474).
 */
function validateYtCommunityText(
	config: PlannerJson,
	errors: string[],
): void {
	if (!Array.isArray(config.content)) return;
	const hasYtField = YT_CONFIG_KEYS.some((k) => k in config);
	if (!hasYtField) return; // planner IG: regra não se aplica
	const cfgTemplates: string[] = Array.isArray(config.caption_templates)
		? config.caption_templates.filter(
				(t: unknown): t is string => typeof t === "string",
			)
		: [];
	const cfgRotation = String(config.caption_rotation || "off");
	for (const entry of config.content) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const mediaType = String(e.media_type || "");
		// Comunidade = IMAGE/CAROUSEL (o runtime classifica YT CAROUSEL como
		// community, planner-runtime.ts:414-418). REELS/sem media_type → Short
		// ou legado: jamais bloqueia.
		if (mediaType !== "IMAGE" && mediaType !== "CAROUSEL") continue;
		const text = resolveCaptionTextForWizard({
			caption: typeof e.caption === "string" ? e.caption : "",
			captionTemplates: cfgTemplates.join("\n"),
			captionRotation: cfgRotation,
			captionFallback:
				typeof e.caption_fallback === "string" ? e.caption_fallback : "",
			titleFallback: typeof e.title_fallback === "string" ? e.title_fallback : "",
		}).trim();
		if (!text) {
			errors.push(
				'Posts na Comunidade do YouTube exigem texto — preencha o campo "Texto da Publicação" no planner.',
			);
			break;
		}
	}
}

/**
 * Valida a estrutura do config. Retorna { ok, errors } — NUNCA lança.
 * Usado nas rotas de escrita (400 com a lista) e pelo runtime (log claro).
 */
export function validatePlannerConfig(config: unknown): {
    ok: boolean;
    errors: string[];
} {
    const errors: string[] = [];

    if (!config || typeof config !== "object" || Array.isArray(config)) {
        return { ok: false, errors: ["config deve ser um objeto JSON"] };
    }

    const c = config as PlannerJson;

    // frequency
    if (c.frequency !== undefined && c.frequency !== null) {
        const freq = c.frequency;
        if (typeof freq !== "object" || Array.isArray(freq)) {
            errors.push("frequency deve ser um objeto { value, unit }");
        } else {
            const f = freq as PlannerJson;
            if (f.value !== undefined && f.value !== null) {
                const num = Number(f.value);
                if (!Number.isFinite(num) || num < 1) {
                    errors.push("frequency.value deve ser um número >= 1");
                }
            }
            if (
                f.unit !== undefined &&
                f.unit !== null &&
                !(FREQUENCY_UNITS as readonly string[]).includes(String(f.unit))
            ) {
                errors.push(
                    "frequency.unit deve ser minutes | hours | days | weeks",
                );
            }
        }
    }

    // sort_order
    if (
        c.sort_order !== undefined &&
        !(SORT_ORDERS as readonly string[]).includes(String(c.sort_order))
    ) {
        errors.push(`sort_order deve ser ${SORT_ORDERS.join(" | ")}`);
    }

    // content
    if (c.content !== undefined && !Array.isArray(c.content)) {
        errors.push("content deve ser um array");
    }

    // YT Community (M7/P0-B0): texto da publicação obrigatório server-side, mas
    // Shorts com youtube_title NUNCA são bloqueados (entrada REELS ou legado).
    validateYtCommunityText(c, errors);

    // sleep_schedule
    if (c.sleep_schedule !== undefined && c.sleep_schedule !== null) {
        const s = c.sleep_schedule;
        if (typeof s !== "object" || Array.isArray(s)) {
            errors.push(
                "sleep_schedule deve ser um objeto { start, end } ou null",
            );
        } else {
            const sched = s as PlannerJson;
            if (
                sched.start !== undefined &&
                sched.start !== null &&
                !isHHMM(sched.start)
            )
                errors.push("sleep_schedule.start deve estar no formato HH:MM");
            if (
                sched.end !== undefined &&
                sched.end !== null &&
                !isHHMM(sched.end)
            )
                errors.push("sleep_schedule.end deve estar no formato HH:MM");
            // start == end → janela que nunca dorme (isSleepingNow: hhmm >= s && hhmm < s é
            // sempre false). O wizard já bloqueia com este mesmo texto; o servidor agora
            // aplica a mesma regra para payloads via API.
            if (
                typeof sched.start === "string" &&
                typeof sched.end === "string" &&
                isHHMM(sched.start) &&
                isHHMM(sched.end) &&
                sched.start === sched.end
            ) {
                errors.push("Sleep start and end must be different times.");
            }
        }
    }

    // caption templates
    if (c.caption_templates !== undefined) {
        const templates = c.caption_templates;
        if (
            !Array.isArray(templates) ||
            templates.some((t: unknown) => typeof t !== "string")
        ) {
            errors.push("caption_templates deve ser um array de strings");
        }
    }
    if (
        c.caption_rotation !== undefined &&
        !(CAPTION_ROTATIONS as readonly string[]).includes(
            String(c.caption_rotation),
        )
    ) {
        errors.push(
            `caption_rotation deve ser ${CAPTION_ROTATIONS.join(" | ")}`,
        );
    }

    // collaborators / user_tags — mesmo formato aceito pela normalização
    if (
        c.collaborators !== undefined &&
        c.collaborators !== null &&
        normalizeCollaborators(c.collaborators) === null
    ) {
        errors.push(
            "collaborators deve ser um array de strings ou string comma-separated",
        );
    }
    if (
        c.user_tags !== undefined &&
        c.user_tags !== null &&
        normalizeUserTags(c.user_tags) === null
    ) {
        errors.push(
            "user_tags deve ser um array de strings ou string comma-separated",
        );
    }

    // audio_configuration
    if (c.audio_configuration !== undefined && c.audio_configuration !== null) {
        if (
            typeof c.audio_configuration !== "object" ||
            Array.isArray(c.audio_configuration)
        ) {
            errors.push("audio_configuration deve ser um objeto");
        } else {
            const audio = c.audio_configuration as PlannerJson;
            if (typeof audio.audio_id !== "string" || !audio.audio_id.trim()) {
                errors.push("audio_configuration.audio_id é obrigatório");
            }
        }
    }

    // start_time
    // Contract: '' ≡ undefined ≡ null ≡ "no start restriction" (the runtime's
    // gate is `config.start_time && now < new Date(...)` — an empty string is
    // already falsy there). The wizard sends '' when "Start When?" is left
    // empty; rejecting it made the default create/edit flow impossible.
    if (
        c.start_time !== undefined &&
        c.start_time !== null &&
        c.start_time !== ""
    ) {
        const d = new Date(String(c.start_time));
        if (Number.isNaN(d.getTime())) {
            errors.push("start_time deve ser uma data ISO válida");
        }
    }

    // ── YouTube (planner YT) ──────────────────────────────────────────────
    // Campos só relevantes quando o planner tem canal YouTube; validação é
    // permissiva: se presente, deve ser válido; vazio/null ≡ ausente.
    const YT_PRIVACIES = ["PUBLIC", "UNLISTED", "PRIVATE"] as const;

    // youtube_title: 1..100 chars (trim)
    if (
        c.youtube_title !== undefined &&
        c.youtube_title !== null &&
        c.youtube_title !== ""
    ) {
        if (typeof c.youtube_title !== "string") {
            errors.push("youtube_title deve ser uma string");
        } else {
            const t = String(c.youtube_title).trim();
            if (t.length === 0)
                errors.push("Título do YouTube não pode ser vazio");
            else if (t.length > 100)
                errors.push(
                    "Título do YouTube deve ter no máximo 100 caracteres",
                );
        }
    }
    // alias youtube_pinned_comment (spec) e youtube_pinned_comment_text (runtime)
    const ytPinnedRaw =
        (c as PlannerJson)["youtube_pinned_comment"] ??
        (c as PlannerJson)["youtube_pinned_comment_text"];
    // youtube_description: até 5000 chars
    if (
        c.youtube_description !== undefined &&
        c.youtube_description !== null &&
        c.youtube_description !== ""
    ) {
        if (typeof c.youtube_description !== "string") {
            errors.push("youtube_description deve ser uma string");
        } else if (String(c.youtube_description).length > 5000) {
            errors.push(
                "Descrição do YouTube deve ter no máximo 5000 caracteres",
            );
        }
    }
    // youtube_products (B1): formato canônico Array<{query,item?}> — aceita
    // também array de strings e CSV legacy (normalizados para {query}).
    // Shape-check via normalizeYoutubeProductsList: NUNCA aceita valores que o
    // runtime descartaria (o CSV com vírgula no nome some com o novo formato;
    // M22). Array vazio = "sem produtos" (válido).
    if (
        c.youtube_products !== undefined &&
        c.youtube_products !== null &&
        c.youtube_products !== ""
    ) {
        const raw = c.youtube_products;
        if (Array.isArray(raw) && (raw as unknown[]).length === 0) {
            // vazio = sem produtos: ok
        } else {
            const norm = normalizeYoutubeProductsList(raw);
            if (!norm) {
                errors.push(
                    "youtube_products deve ser uma lista de produtos (array de {query, item?}, array de strings ou CSV legacy)",
                );
            } else {
                if (norm.some((entry) => entry.query.length > 500)) {
                    errors.push(
                        "Cada produto afiliado deve ter no máximo 500 caracteres no nome/termo",
                    );
                }
                if (norm.length > 50) {
                    errors.push("Limite de 50 produtos afiliados por planner");
                }
            }
        }
    }
    // youtube_privacy
    if (
        c.youtube_privacy !== undefined &&
        c.youtube_privacy !== null &&
        c.youtube_privacy !== ""
    ) {
        const v = String(c.youtube_privacy).toUpperCase().trim();
        if (!(YT_PRIVACIES as readonly string[]).includes(v)) {
            errors.push("youtube_privacy deve ser PUBLIC, UNLISTED ou PRIVATE");
        }
    }
    // youtube_made_for_kids
    if (
        c.youtube_made_for_kids !== undefined &&
        c.youtube_made_for_kids !== null &&
        c.youtube_made_for_kids !== ""
    ) {
        const v = c.youtube_made_for_kids;
        const okBool =
            typeof v === "boolean" ||
            (typeof v === "string" && /^(true|false)$/i.test(v.trim())) ||
            v === 0 ||
            v === 1;
        if (!okBool)
            errors.push("youtube_made_for_kids deve ser verdadeiro ou falso");
    }
    // youtube_monetize_with_ads
    if (
        c.youtube_monetize_with_ads !== undefined &&
        c.youtube_monetize_with_ads !== null &&
        c.youtube_monetize_with_ads !== ""
    ) {
        const v = c.youtube_monetize_with_ads;
        const okBool =
            typeof v === "boolean" ||
            (typeof v === "string" && /^(true|false)$/i.test(v.trim())) ||
            v === 0 ||
            v === 1;
        if (!okBool)
            errors.push(
                "youtube_monetize_with_ads deve ser verdadeiro ou falso",
            );
    }
    // youtube_category_id
    if (
        c.youtube_category_id !== undefined &&
        c.youtube_category_id !== null &&
        c.youtube_category_id !== ""
    ) {
        const n = Number(c.youtube_category_id);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
            errors.push(
                "youtube_category_id deve ser um número inteiro entre 1 e 100",
            );
        }
    }
    // youtube_pinned_comment / youtube_pinned_comment_text: até 10000
    if (
        ytPinnedRaw !== undefined &&
        ytPinnedRaw !== null &&
        ytPinnedRaw !== ""
    ) {
        if (typeof ytPinnedRaw !== "string") {
            errors.push("Comentário fixado do YouTube deve ser uma string");
        } else if (String(ytPinnedRaw).length > 10000) {
            errors.push(
                "Comentário fixado do YouTube deve ter no máximo 10000 caracteres",
            );
        }
    }

    // ── TikTok (planner TikTok) ───────────────────────────────────────────────
    // Campos só relevantes quando o planner tem canal TikTok; validação é
    // permissiva: se presente, deve ser válido; vazio/null ≡ ausente.
    // tiktok_caption / tiktok_title: 1..2200 chars (trim)
    const tiktokCaptionRaw =
        (c as PlannerJson)["tiktok_caption"] ??
        (c as PlannerJson)["tiktok_title"] ??
        (c as PlannerJson)["tiktok_description"];
    if (
        tiktokCaptionRaw !== undefined &&
        tiktokCaptionRaw !== null &&
        tiktokCaptionRaw !== ""
    ) {
        if (typeof tiktokCaptionRaw !== "string") {
            errors.push("Legenda do TikTok deve ser uma string");
        } else {
            const t = String(tiktokCaptionRaw).trim();
            if (t.length === 0)
                errors.push("Legenda do TikTok não pode ser vazia");
            else if (t.length > 2200)
                errors.push(
                    "Legenda do TikTok deve ter no máximo 2200 caracteres",
                );
        }
    }
    // tiktok_privacy_level
    if (
        c.tiktok_privacy_level !== undefined &&
        c.tiktok_privacy_level !== null &&
        c.tiktok_privacy_level !== ""
    ) {
        const v = String(c.tiktok_privacy_level).trim();
        if (!(TIKTOK_PRIVACY_OPTIONS as readonly string[]).includes(v)) {
            errors.push(
                `tiktok_privacy_level deve ser ${TIKTOK_PRIVACY_OPTIONS.join(" | ")}`,
            );
        }
    }
    // tiktok_privacy (alias)
    if (
        (c as PlannerJson)["tiktok_privacy"] !== undefined &&
        (c as PlannerJson)["tiktok_privacy"] !== null &&
        (c as PlannerJson)["tiktok_privacy"] !== ""
    ) {
        const v = String((c as PlannerJson)["tiktok_privacy"]).trim();
        if (!(TIKTOK_PRIVACY_OPTIONS as readonly string[]).includes(v)) {
            errors.push(
                `tiktok_privacy deve ser ${TIKTOK_PRIVACY_OPTIONS.join(" | ")}`,
            );
        }
    }
    // privacy_level alias (generic)
    if (
        (c as PlannerJson)["privacy_level"] !== undefined &&
        (c as PlannerJson)["privacy_level"] !== null &&
        (c as PlannerJson)["privacy_level"] !== "" &&
        // só valida se for contexto TikTok (tem algum campo tiktok_*)
        ((c as PlannerJson)["tiktok_privacy_level"] !== undefined ||
            (c as PlannerJson)["tiktok_caption"] !== undefined)
    ) {
        const v = String((c as PlannerJson)["privacy_level"]).trim();
        if (!(TIKTOK_PRIVACY_OPTIONS as readonly string[]).includes(v)) {
            errors.push(
                `privacy_level deve ser ${TIKTOK_PRIVACY_OPTIONS.join(" | ")}`,
            );
        }
    }
    // disable flags (boolean)
    for (const flag of [
        "tiktok_disable_duet",
        "tiktok_disable_stitch",
        "tiktok_disable_comment",
        "disable_duet",
        "disable_stitch",
        "disable_comment",
    ] as const) {
        const v = (c as PlannerJson)[flag];
        if (v !== undefined && v !== null && v !== "") {
            const okBool =
                typeof v === "boolean" ||
                (typeof v === "string" && /^(true|false)$/i.test(String(v).trim())) ||
                v === 0 ||
                v === 1;
            if (!okBool) errors.push(`${flag} deve ser verdadeiro ou falso`);
        }
    }
    // video_cover_timestamp_ms
    const coverRaw =
        (c as PlannerJson)["tiktok_video_cover_timestamp_ms"] ??
        (c as PlannerJson)["video_cover_timestamp_ms"];
    if (coverRaw !== undefined && coverRaw !== null && coverRaw !== "") {
        const n = Number(coverRaw);
        if (!Number.isInteger(n) || n < 0) {
            errors.push(
                "tiktok_video_cover_timestamp_ms deve ser um número inteiro >= 0",
            );
        }
    }
    // brand flags (boolean)
    for (const flag of [
        "tiktok_brand_content_toggle",
        "tiktok_brand_organic_toggle",
        "brand_content_toggle",
        "brand_organic_toggle",
    ] as const) {
        const v = (c as PlannerJson)[flag];
        if (v !== undefined && v !== null && v !== "") {
            const okBool =
                typeof v === "boolean" ||
                (typeof v === "string" && /^(true|false)$/i.test(String(v).trim())) ||
                v === 0 ||
                v === 1;
            if (!okBool) errors.push(`${flag} deve ser verdadeiro ou falso`);
        }
    }
    // tiktok_type: só "video" em v1
    if (
        (c as PlannerJson)["tiktok_type"] !== undefined &&
        (c as PlannerJson)["tiktok_type"] !== null &&
        (c as PlannerJson)["tiktok_type"] !== ""
    ) {
        const v = String((c as PlannerJson)["tiktok_type"]).toLowerCase().trim();
        if (v !== "video") {
            errors.push('tiktok_type deve ser "video" (TikTok v1: apenas vídeo)');
        }
    }
    // mutual exclusivity: youtube_type vs tiktok_type
    const hasYtType =
        (c as PlannerJson)["youtube_type"] !== undefined &&
        (c as PlannerJson)["youtube_type"] !== null &&
        (c as PlannerJson)["youtube_type"] !== "";
    const hasTiktokType =
        (c as PlannerJson)["tiktok_type"] !== undefined &&
        (c as PlannerJson)["tiktok_type"] !== null &&
        (c as PlannerJson)["tiktok_type"] !== "";
    if (hasYtType && hasTiktokType) {
        errors.push(
            "youtube_type e tiktok_type são mutuamente exclusivos — um planner não pode ter ambos",
        );
    }
    // Nota: não bloqueia config mista de campos YT vs TikTok aqui — isolation
    // de canais já bloqueia 400. A validação acima só impede type conflitante.

    // timezone
    if (c.timezone !== undefined && typeof c.timezone !== "string") {
        errors.push(
            "timezone deve ser uma string IANA (ex.: America/Sao_Paulo)",
        );
    }

    return { ok: errors.length === 0, errors };
}

/** Timezone default compartilhado. */
export function getPlannerTimezone(config: PlannerJson): string {
    return typeof config.timezone === "string" && config.timezone.trim()
        ? config.timezone
        : DEFAULT_TIMEZONE;
}

/** Relógio "HH:MM" no fuso do planner (sem re-parse frágil de string localizada). */
export function getTimeInTimeZone(
    date: Date,
    tz: string,
): { hh: string; mm: string } {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const hh = (parts.find((p) => p.type === "hour")?.value || "00").padStart(
        2,
        "0",
    );
    const mm = (parts.find((p) => p.type === "minute")?.value || "00").padStart(
        2,
        "0",
    );
    return { hh, mm };
}

/**
 * Intervalo de publicação em ms com validação defensiva:
 * frequência inválida (NaN, 0, negativa) → null (planner deve ser pulado com aviso,
 * em vez de publicar a cada tick ou nunca).
 */
export function getPlannerIntervalMs(config: PlannerJson): number | null {
    const freq = config.frequency;
    if (!freq || typeof freq !== "object") return 10 * 60 * 1000; // default 10 min
    const f = freq as PlannerJson;
    const rawValue = f.value ?? 10;
    const val = Number(rawValue);
    if (!Number.isFinite(val) || val < 1) return null;

    const unit = String(f.unit || "minutes");
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
    if (!schedule || typeof schedule !== "object") return false;
    const { hh, mm } = getTimeInTimeZone(now, getPlannerTimezone(config));
    const hhmm = `${hh}:${mm}`;
    const sched = schedule as PlannerJson;
    const start = String(sched.start || "00:00");
    const end = String(sched.end || "06:00");
    if (start <= end) return hhmm >= start && hhmm < end;
    return hhmm >= start || hhmm < end; // janela que cruza a meia-noite
}

// ── Isolation: YouTube vs Instagram vs TikTok ──────────────────────────────

/** Mensagem padrão quando tenta misturar plataformas num mesmo planner (YT+IG). */
export const PLANNER_MIX_ERROR =
    "Planners não podem misturar canais de YouTube e Instagram. Crie planners separados.";

/** Mensagem quando tenta misturar TikTok com outras plataformas. */
export const PLANNER_TIKTOK_MIX_ERROR =
    "Planners TikTok não podem misturar canais de outras plataformas.";

export type PlannerPlatformType = "youtube" | "instagram" | "tiktok" | "mixed" | null;

/**
 * Normaliza platform para comparação (lowercase, trim).
 */
function normalizePlatform(p: unknown): string {
    return String(p || "")
        .toLowerCase()
        .trim();
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
        list
            .map((c) =>
                normalizePlatform(
                    (c as { platform?: string | null })?.platform,
                ),
            )
            .filter(Boolean),
    );
    if (platforms.size === 0) return null;
    if (platforms.size === 1) {
        const only = [...platforms][0];
        if (only === "youtube") return "youtube";
        if (only === "instagram") return "instagram";
        if (only === "tiktok") return "tiktok";
        // plataforma desconhecida singular → trata como instagram por compatibilidade
        return only as PlannerPlatformType;
    }
    // >1 plataforma distinta
    const hasYt = platforms.has("youtube");
    const hasIg = platforms.has("instagram");
    const hasTt = platforms.has("tiktok");
    if (hasTt) return "mixed";
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
    if (!channelIds || channelIds.length === 0)
        return { ok: true, platforms: [] };
    const channels = await prisma.channel.findMany({
        where: { id: { in: channelIds } },
        select: { platform: true },
    } as never);
    const platforms: string[] = [
        ...new Set(
            channels
                .map((c: { platform?: string | null }) =>
                    normalizePlatform(c.platform),
                )
                .filter(Boolean) as string[],
        ),
    ];
    if (platforms.length > 1) {
        // Se há TikTok envolvido, mensagem específica PT-BR
        const hasTiktok = platforms.includes("tiktok");
        const err = hasTiktok ? PLANNER_TIKTOK_MIX_ERROR : PLANNER_MIX_ERROR;
        return { ok: false, error: err, platforms };
    }
    return { ok: true, platforms };
}

/**
 * Helper síncrono para listas já carregadas (sem prisma).
 */
export function isMixedPlatformChannels(
    channels: Array<{ platform?: string | null }>,
): boolean {
    return getPlannerPlatformType(channels) === "mixed";
}
