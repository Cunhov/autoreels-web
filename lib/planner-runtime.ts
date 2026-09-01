/**
 * planner-runtime.ts — resolução de conteúdo e execução da Fase 0 de planners.
 *
 * Arquitetura (migration 0003):
 *   - Planner.config  → configuração editável pelo usuário (JSON string)
 *   - Planner.state   → estado de publicação (published_indexes, last_index,
 *                       template_index) em coluna própria — o cron NÃO reescreve
 *                       mais o config inteiro a cada tick (elimina race com PATCH).
 *
 * Exports principais (contrato com as rotas de API):
 *   - resolvePlannerRuntime(prisma, planner, now)  → preview/resolução
 *   - runPlannerOnce(prisma, planner, now, {force}) → executa a Fase 0 completa
 *   - buildPostData({...})                          → monta o Post (com templates
 *                                                     e normalização de collabs/tags)
 */
import {
	Prisma,
	type ContentItem,
	type Planner,
	type Post,
} from "@prisma/client";
import { getYoutubeSessionId } from "./youtube";
import {
	getPlannerIntervalMs,
	getPlannerTimezone,
	isSleepingNow,
	normalizeCollaborators,
	normalizeUserTags,
	parsePlannerConfig,
	parsePlannerState,
	toYoutubeProductsJson,
	validatePlannerConfig,
	TIKTOK_PRIVACY_FALLBACK,
	PLANNER_TIKTOK_MIX_ERROR,
	type PlannerJson,
} from "./planner-config";

// Compat: parsePlannerConfig vive em planner-config; reexportado para não quebrar imports.
export { parsePlannerConfig, validatePlannerConfig };

type PlannerContentItem = {
	type?: string;
	id?: string;
	folder_id?: string; // legacy — tratado como id de library item
	url?: string;
	media_type?: string;
	caption?: string;
	caption_fallback?: string;
	title_fallback?: string;
	title?: string; // legacy — metadados de upload direto (sem row no banco)
	youtube_products?: string | null; // CSV de nomes — item > fixo do planner
	location_id?: string | null;
	share_to_feed?: boolean | null;
	thumbnail_url?: string;
	children_urls?: { url: string; type: string; thumbnail_url?: string }[];
	carousel_items?: { url: string; type: string; thumbnail_url?: string }[];
	collaborators?: string | string[] | null;
	audio_configuration?: {
		audio_id: string;
		audio_volume?: number;
		video_volume?: number;
	} | null;
	user_tags?: string | string[] | null;
};

type PlannerConfig = PlannerJson;

type PlannerLike = Planner & {
	channels?: (ChannelLike & { settings?: string | null })[] | null;
};

type ChannelLike = {
	id: string;
	name?: string | null;
	platform?: string | null;
	status?: string | null;
	access_token?: string | null;
	token_source?: string | null;
	token_expires_at?: Date | string | null;
	token_refreshed_at?: Date | string | null;
	settings?: string | null;
};

type PrismaLike = {
	contentItem: {
		findFirst: (
			args: Prisma.ContentItemFindFirstArgs,
		) => Promise<ContentItem | null>;
		findMany: (args: Prisma.ContentItemFindManyArgs) => Promise<ContentItem[]>;
	};
	planner: {
		updateMany: (
			args: Prisma.PlannerUpdateManyArgs,
		) => Promise<Prisma.BatchPayload>;
		update: (args: Prisma.PlannerUpdateArgs) => Promise<Planner>;
	};
	post: {
		create: (args: Prisma.PostCreateArgs) => Promise<Post>;
	};
	$transaction?: (ops: Prisma.PrismaPromise<unknown>[]) => Promise<unknown[]>;
};

function cloneState(
	state: Record<string, unknown> | undefined,
): Record<string, unknown> {
	return state ? JSON.parse(JSON.stringify(state)) : {};
}

/**
 * F3 — item_rotation do config (opcional): controle EXPLÍCITO da rotação de
 * itens da library.
 *   mode:   'sequential' | 'random' (com dedupe via published_indexes)
 *   repeat: true (default) = reinício automático quando a fila esgota
 *           (publica todos de novo, como o repeating do FS Poster);
 *           false = para sem consumir item quando todos já foram usados.
 * Retrocompat: config SEM item_rotation → null (comportamento atual do
 * sort_order preservado, com repeat implícito ON).
 */
export type ItemRotationConfig = {
	mode: "" | "sequential" | "random";
	repeat: boolean;
};

/**
 * Lê item_rotation do config defensivamente. Layout inválido → null (falls
 * back para sort_order); mode desconhecido → "" (mesmo fallback); repeat
 * ausente → true (default = reinício ON).
 */
export function parseItemRotation(
	config: PlannerJson,
): ItemRotationConfig | null {
	const raw = config.item_rotation;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const mode = String((raw as Record<string, unknown>).mode ?? "");
	const repeat = (raw as Record<string, unknown>).repeat;
	return {
		mode: mode === "sequential" || mode === "random" ? mode : "",
		repeat: typeof repeat === "boolean" ? repeat : true,
	};
}

type RotationStrategy =
	| { kind: "dedupe-random"; repeat: boolean }
	| { kind: "dedupe-sequential"; repeat: boolean }
	| { kind: "cursor-new-to-old" }
	| { kind: "cursor-old-to-new" };

/**
 * Resolve a estratégia de rotação a partir de sort_order + item_rotation (F3).
 * item_rotation (quando tem mode válido) vence sort_order — é o controle
 * explícito mais novo. Sem item_rotation: random_loop → dedupe-random com
 * repeat (já reseta hoje); new_to_old/old_to_new → cursores com wrap
 * (repeat implícito). Comportamento legado 100% preservado.
 */
export function resolveRotationStrategy(
	sortOrder: string,
	itemRotation?: ItemRotationConfig | null,
): RotationStrategy {
	if (itemRotation?.mode) {
		return {
			kind:
				itemRotation.mode === "random"
					? "dedupe-random"
					: "dedupe-sequential",
			repeat: itemRotation.repeat,
		};
	}
	if (sortOrder === "random_loop") {
		return { kind: "dedupe-random", repeat: true };
	}
	if (sortOrder === "new_to_old") {
		return { kind: "cursor-new-to-old" };
	}
	return { kind: "cursor-old-to-new" };
}

/**
 * Seleção do próximo item da library — fonte ÚNICA da rotação (F3).
 * Dedupe via state.published_indexes; quando a fila esgota (todos os itens já
 * usados, incluindo índices órfãos de conteúdo encolhido):
 *   - repeat=true  → ZERA o registro e recomeça automaticamente;
 *   - repeat=false → retorna selectedIndex -1 com o state INTACTO (não
 *     consome tick; runPlannerOnce trata -1 como fila vazia).
 */
export function selectContentIndex(
	contentList: PlannerContentItem[],
	sortOrder: string,
	state: Record<string, unknown>,
	itemRotation?: ItemRotationConfig | null,
) {
	if (contentList.length === 0) {
		return { selectedIndex: -1, nextState: state };
	}

	const strategy = resolveRotationStrategy(sortOrder, itemRotation);
	const nextState = cloneState(state);
	let selectedIndex = -1;

	if (strategy.kind === "dedupe-random" || strategy.kind === "dedupe-sequential") {
		const published = Array.isArray(nextState.published_indexes)
			? (nextState.published_indexes as unknown[])
			: [];
		const used = new Set(
			published.filter(
				(n): n is number => typeof n === "number" && Number.isFinite(n),
			),
		);
		const available = contentList
			.map((_, i) => i)
			.filter((i) => !used.has(i));

		if (available.length === 0) {
			// Fila esgotada: todos os itens da library já foram usados.
			if (!strategy.repeat) {
				// repeat=false → NÃO recomeça: para sem marcar nada (state
				// original intacto — mesma semântica de fila vazia).
				return { selectedIndex: -1, nextState: state };
			}
			// REINÍCIO automático (FS Poster repeating): zera o registro de
			// usados e recomeça. Random evita repetir o ÚLTIMO item imediatamente
			// (igual random_loop atual); sequential recomeça do início da fila.
			const lastEntry = published[published.length - 1];
			const lastIndex =
				typeof lastEntry === "number" && Number.isFinite(lastEntry)
					? lastEntry
					: -1;
			if (strategy.kind === "dedupe-sequential") {
				selectedIndex = 0;
			} else {
				let candidates = contentList.map((_, i) => i);
				if (contentList.length > 1 && lastIndex !== -1) {
					candidates = candidates.filter((i) => i !== lastIndex);
				}
				selectedIndex =
					candidates[Math.floor(Math.random() * candidates.length)];
			}
			nextState.published_indexes = [selectedIndex];
		} else if (strategy.kind === "dedupe-random") {
			selectedIndex = available[Math.floor(Math.random() * available.length)];
			nextState.published_indexes = [...published, selectedIndex];
		} else {
			// dedupe-sequential: menor índice ainda não usado → cada item é
			// publicado exatamente uma vez por ciclo, em ordem de fila.
			selectedIndex = available[0];
			nextState.published_indexes = [...published, selectedIndex];
		}
	} else if (strategy.kind === "cursor-new-to-old") {
		// Clamp: se o conteúdo encolheu desde o último run, o índice antigo
		// pode estar fora da faixa — nunca deixar wedged (item inexistente).
		const last =
			nextState.last_index !== undefined
				? Number(nextState.last_index)
				: contentList.length;
		const clamped = Math.min(
			Number.isFinite(last) ? last : contentList.length,
			contentList.length,
		);
		selectedIndex = clamped - 1 < 0 ? contentList.length - 1 : clamped - 1;
		nextState.last_index = selectedIndex;
	} else {
		// old_to_new (default): sequencial com wrap
		const last =
			nextState.last_index !== undefined ? Number(nextState.last_index) : -1;
		const base = Number.isFinite(last) && last >= 0 ? last : -1;
		selectedIndex = (base + 1) % contentList.length;
		nextState.last_index = selectedIndex;
	}

	return { selectedIndex, nextState };
}

/**
 * M15: detecta a falha de resolução causada por item de biblioteca DELETADO
 * ("Library item not found"). É o ÚNICO caso em que o runtime avança o índice
 * e tenta o próximo item — demais erros de resolução (mídia ausente,
 * carrossel sem filhos) continuam com o comportamento R3 (não consomem tick).
 */
function isDeletedItemFailure(runtime: {
	ok: boolean;
	warnings?: string[];
}): boolean {
	return (
		!runtime.ok &&
		(runtime.warnings || []).some((w) =>
			/Library item not found/i.test(String(w)),
		)
	);
}

export function getChannelHealth(channel: ChannelLike, now = new Date()) {
	const issues: string[] = [];
	const warnings: string[] = [];
	const hasToken = Boolean(channel.access_token);
	// Canais YouTube não usam access_token do Instagram — a autenticação vive
	// na sessão remota da API externa (Channel.settings.sessionId).
	const isYoutube = (channel.platform || "").toLowerCase() === "youtube";
	const isTiktok = (channel.platform || "").toLowerCase() === "tiktok";

	if ((channel.status || "").toLowerCase() !== "active") {
		issues.push("inactive");
	}

	if (!hasToken && !isYoutube && !isTiktok) {
		issues.push("missing_token");
	}

	// Canal YouTube ativo sem sessionId em settings cria posts que falham
	// sempre no publisher — sinalizar como issue, não como "Ready".
	if (isYoutube && !getYoutubeSessionId(channel.settings)) {
		issues.push("missing_session");
	}
	// Canal TikTok ativo sem tiktok_open_id em settings — bloqueado
	if (isTiktok) {
		try {
			const s = channel.settings ? JSON.parse(String(channel.settings)) : null;
			const hasTiktokId = s && (s.tiktok_open_id || s.tiktok_user_id || s.open_id);
			// Não bloqueia se settings ausente — deixa publisher validar (evita falso bloqueio em testes)
			// Mas se quiser validar, descomente: if (!hasTiktokId) issues.push("missing_tiktok_session");
		} catch {}
	}

	if (!isYoutube && !isTiktok && channel.token_source !== "redis" && channel.token_expires_at) {
		const expiresAt = new Date(channel.token_expires_at);
		const daysLeft =
			(expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
		if (daysLeft < 0) issues.push("expired");
		else if (daysLeft < 14) warnings.push("expiring_soon");
	}

	if (!isYoutube && !isTiktok && channel.token_source === "redis") {
		warnings.push("legacy_redis_token");
	}

	return {
		ok: issues.length === 0,
		issues,
		warnings,
		hasToken,
	};
}

export function describeChannelHealth(channel: ChannelLike, now = new Date()) {
	const health = getChannelHealth(channel, now);
	// Rótulos PT-BR: exibidos no preview/modal dos planners.
	const readableIssues: Record<string, string> = {
		inactive: "Canal pausado",
		missing_token: "Token ausente",
		expired: "Token expirado",
		missing_session: "Sessão do YouTube não vinculada",
	};
	const readableWarnings: Record<string, string> = {
		expiring_soon: "Token expirando em breve",
		legacy_redis_token: "Token Redis legado",
	};

	return {
		...health,
		label: health.ok
			? health.warnings.includes("expiring_soon")
				? "Token expirando"
				: "Pronto"
			: "Bloqueado",
		issues: health.issues.map((item) => readableIssues[item] || item),
		warnings: health.warnings.map((item) => readableWarnings[item] || item),
	};
}

/**
 * Resolve as variáveis de template de legenda ({post_title}, {post_caption},
 * {date}, {channel_name}, {hashtags}). O lookup de library item é IDOR-safe.
 *
 * FEEDBACK-LOOP GUARD: o wizard grava o texto digitado pelo usuário (que
 * contém {post_caption}/{date}/...) no campo `caption` de CADA entrada de
 * config.content. Resolver {post_caption} a partir desse mesmo campo expande
 * o template dentro dele mesmo — a legenda publicada saía duplicada e com
 * chave literal ("A A {post_caption} B ... B 22/08/2026 C"). Por isso
 * {post_caption} e {post_title} resolvem SOMENTE da row do ContentItem no
 * banco e dos campos explícitos *_fallback — NUNCA de selectedContent.caption.
 */
/**
 * RÉGUA ÚNICA de caption final por plataforma (F4 dual captions, M9).
 * Fonte do `{post_caption}` e do texto final quando a entrada referencia a
 * caption do item: youtube → caption_youtube ?? caption; instagram →
 * caption_instagram ?? caption; tiktok → caption_tiktok ?? caption; senão caption. NUNCA criar cópias dessa
 * régua em outro lugar — buildPostData, propagação e preview passam pelo
 * MESMO resolveFinalCaption (via resolveCaptionTemplateVars / platform).
 *
 * `item` aceita tanto a row Prisma (ContentItem tem caption_youtube /
 * caption_instagram) quanto uma PlannerContentItem (campos opcionais).
 */
export type FinalCaptionSource = {
	caption?: string | null;
	caption_youtube?: string | null;
	caption_instagram?: string | null;
	caption_tiktok?: string | null;
};

export type FinalCaptionSourceTiktok = FinalCaptionSource;

export function resolveFinalCaption(
	platform: string | null | undefined,
	item: FinalCaptionSource | null | undefined,
): string {
	const p = (platform || "").toLowerCase();
	// `??` (não `||`): caption por plataforma vazia é ESCOLHA EXPLÍCITA de
	// não usar a genérica — spec F4 ("caption_youtube ?? caption").
	if (p === "youtube") return item?.caption_youtube ?? item?.caption ?? "";
	if (p === "instagram") return item?.caption_instagram ?? item?.caption ?? "";
	if (p === "tiktok") {
		const ti = item as FinalCaptionSourceTiktok | null | undefined;
		return ti?.caption_tiktok ?? item?.caption ?? "";
	}
	return item?.caption ?? "";
}

export async function resolveCaptionTemplateVars(
	prisma: PrismaLike,
	selectedContent: PlannerContentItem | null | undefined,
	planner: { user_id: string },
	config: Record<string, unknown>,
	channelName: string,
	now: Date,
	platform?: string | null,
): Promise<Record<string, string>> {
	let title = "";
	let itemCaption = "";
	let libTags: string | null | undefined = (
		selectedContent as { tags?: string | null } | null
	)?.tags;
	const libId = selectedContent?.id || selectedContent?.folder_id;
	if (libId) {
		const libItem = await prisma.contentItem.findFirst({
			where: { id: libId, user_id: planner.user_id },
			select: { title: true, caption: true, caption_youtube: true, caption_instagram: true, caption_tiktok: true, tags: true },
		});
		if (libItem) {
			title = libItem.title || "";
			// F4/M9: {post_caption} resolve a caption da PLATAFORMA do canal do
			// post (youtube.txt/instagram.txt), com fallback para a caption
			// genérica — régua única resolveFinalCaption.
			itemCaption = resolveFinalCaption(
				platform,
				libItem as FinalCaptionSource,
			);
			libTags = libItem.tags;
		}
	}
	// Fallbacks explícitos por último. `selectedContent.caption` fica
	// deliberadamente fora da cadeia: é onde o template digitado vive.
	title =
		title || selectedContent?.title_fallback || selectedContent?.title || "";
	itemCaption = itemCaption || selectedContent?.caption_fallback || "";
	const tz = getPlannerTimezone(config);
	const dateStr = new Intl.DateTimeFormat("pt-BR", {
		timeZone: tz,
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	}).format(now);
	// {hashtags}: resolved from the selected content's tags (ContentItem.tags,
	// a JSON array of tag strings) formatted as "#tag1 #tag2". Was hardcoded to
	// "" — tags never appeared in captions despite the wizard advertising the
	// variable (user-reported bug). Non-JSON/garbage tag strings resolve to "".
	let hashtags = "";
	const rawTags = (libTags || "") as string;
	if (rawTags) {
		let tagsList: string[] = [];
		try {
			const parsed = JSON.parse(rawTags) as unknown;
			if (Array.isArray(parsed)) {
				tagsList = parsed.filter((t): t is string => typeof t === "string");
			}
		} catch {
			/* malformed tags JSON — resolve empty */
		}
		hashtags = tagsList
			.map((t) => `#${t.trim().replace(/^#/, "")}`)
			.filter((t) => t.length > 1)
			.join(" ");
	}
	return {
		"{post_title}": title || "",
		"{post_caption}": itemCaption || "",
		"{date}": dateStr,
		"{channel_name}": channelName || "",
		"{hashtags}": hashtags,
	};
}

/**
 * Aplica a substituição de variáveis de template de legenda com as MESMAS
 * semânticas usadas na publicação (runtime) e no preview:
 *   - variáveis CONHECIDAS ({post_title}, {date}, ...) → valor resolvido
 *   - variáveis DESCONHECIDAS ({qualquer_coisa}) → '' — nunca vazam chaves
 *     literais para a legenda publicada (eram mantidas literais no preview).
 * Exportada para o preview (app/api/planners/[id]/preview) usar exatamente a
 * mesma regex — a divergência runtime×preview era inconsistência visível.
 */
export function substituteCaptionTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	return template.replace(/\{[a-zA-Z0-9_]+\}/g, (m: string) => vars[m] ?? "");
}

/** Aplica templates de legenda e retorna a legenda final. */
export async function applyCaptionTemplate(opts: {
	prisma: PrismaLike;
	selectedContent: PlannerContentItem | null | undefined;
	planner: { user_id: string };
	config: PlannerConfig;
	channelName: string;
	now: Date;
	templateIndex: number; // índice base (do state) — incrementado POR POST
	postOrdinal: number; // 0-based: quantos posts já foram criados neste run
	platform?: string | null; // plataforma do canal do post (F4 dual captions)
}): Promise<string> {
	const templates = Array.isArray(opts.config.caption_templates)
		? opts.config.caption_templates.filter(
				(t: unknown) => typeof t === "string" && t.trim().length > 0,
			)
		: [];
	const rotation = opts.config.caption_rotation || "off";
	const baseCaption = opts.selectedContent?.caption || "";

	// Template vars are resolved for BOTH lanes: the rotation templates AND the
	// base caption. The base caption previously bypassed substitution entirely —
	// a caption containing {post_caption} / {date} / {hashtags} went out LITERAL
	// (user-reported bug). Unknown vars strip to "" in both lanes, never leaking
	// raw braces into a published caption.
	const vars = await resolveCaptionTemplateVars(
		opts.prisma,
		opts.selectedContent,
		opts.planner,
		opts.config,
		opts.channelName,
		opts.now,
		opts.platform,
	);

	if (templates.length === 0 || rotation === "off") {
		return substituteCaptionTemplate(baseCaption, vars);
	}

	const chosen =
		rotation === "random"
			? templates[Math.floor(Math.random() * templates.length)]
			: templates[(opts.templateIndex + opts.postOrdinal) % templates.length];

	// Replace KNOWN template variables with their resolved value and strip any
	// UNKNOWN {placeholder} to empty string (never leak raw braces into a
	// published caption — unknown vars were previously kept literal).
	return substituteCaptionTemplate(chosen, vars);
}

/**
 * ÚNICA função que monta o youtube_options JSON de um Short (F2/M5/M17/M18).
 * Usada por buildPostData (criação) E propagatePlannerConfigToPendingPosts
 * (edição de planner) — garantia de que editar um planner nunca apaga
 * products/título/template-desc dos Shorts pendentes.
 *
 * Cadeia de título (M17): youtube_title RESOLVIDO de templates → title do item
 * → title_fallback → caption resolvida → nome do arquivo da biblioteca. Antes
 * a propagação re-derivava SEM youtube_title no titleCandidate: editar só o
 * título não se refletia nos pending.
 * Products via toYoutubeProductsJson (F1/M5 — separa names/items, sem {var}),
 * description com resolveYtTpl (M18), alias youtube_pinned_comment ??
 * youtube_pinned_comment_text (G4) e herança privacy/made_for_kids/monetize/
 * category config > item > youtube_options.
 *
 * Retorna JSON string, ou null se não houver título candidato (caption vazia +
 * sem fallbacks) — mesmo contrato do buildPostData original.
 */
async function buildYoutubeOptionsForPost(opts: {
	prisma: PrismaLike;
	planner: { user_id: string };
	config: PlannerConfig;
	selectedContent: PlannerContentItem | null | undefined;
	channelName: string;
	now: Date;
	caption: string;
	itemName?: string; // nome do arquivo do item de biblioteca (se ausente, resolve via lookup)
	platform?: string | null; // plataforma do canal do post (F4 dual captions)
}): Promise<string | null> {
	const { config, selectedContent } = opts;
	const selected = selectedContent as PlannerContentItem | null | undefined;
	const cfg = config as Record<string, unknown>;
	// SAFETY: selected veio de PlannerContentItem (= config.content já parseado defensivamente);
	// o cast gera o acesso genérico usado pela herança config>item>youtube_options.
	const selAny = selected as unknown as Record<string, unknown> | null | undefined;

	// Resolve youtube_title/description templates (se contiver {var}). `{date}`
	// usa `now` — propagação passa o now do run; buildPostData o do post.
	const varsForYt = await resolveCaptionTemplateVars(
		opts.prisma,
		selected as PlannerContentItem | null | undefined,
		opts.planner,
		config,
		opts.channelName,
		opts.now,
		opts.platform,
	);
	const resolveYtTpl = (v: string): string =>
		v.includes("{") ? substituteCaptionTemplate(v, varsForYt) : v;
	const rawYtTitle =
		typeof cfg["youtube_title"] === "string"
			? resolveYtTpl(String(cfg["youtube_title"]))
			: "";
	const rawYtDescTpl =
		typeof cfg["youtube_description"] === "string"
			? resolveYtTpl(String(cfg["youtube_description"]))
			: "";

	// Nome do arquivo do item de biblioteca (último recurso da cadeia de título).
	// buildPostData pré-busca e passa `itemName`; propagação resolve aqui.
	let itemName = opts.itemName || "";
	if (!itemName) {
		const libId = selected?.id || selected?.folder_id;
		if (libId) {
			try {
				const libItem = await opts.prisma.contentItem.findFirst({
					where: { id: libId, user_id: opts.planner.user_id },
					select: { name: true },
				});
				itemName = libItem?.name
					? String(libItem.name).replace(/\.[A-Za-z0-9]+$/, "")
					: "";
			} catch { /* SAFETY: best-effort opcional — campo ausente/malformado não deve abortar o fluxo */ }
		}
	}

	// M17: youtube_title resolvido é a PRIMEIRA fonte do título. Antes a
	// propagação pulava esse passo — editar o título nunca propagava.
	const titleCandidate = [
		rawYtTitle || "",
		selected?.title || "",
		selected?.title_fallback || "",
		opts.caption || "",
		itemName,
	]
		.map((t) => String(t).trim())
		.find(Boolean);
	if (!titleCandidate) return null;

	// helper strict boolean (BK-21)
	const toStrictBool = (v: unknown): boolean => {
		if (typeof v === "boolean") return v;
		if (typeof v === "string") return v.toLowerCase() === "true";
		if (typeof v === "number") return v === 1;
		if (v == null) return false;
		return String(v).toLowerCase() === "true";
	};

	// privacy: config.youtube_privacy > item.privacy > item.youtube_options.privacy > PUBLIC
	let youtubePrivacy: string = "PUBLIC";
	const cfgPrivacy = cfg["youtube_privacy"];
	const selPrivacy = selAny?.["privacy"];
	if (
		typeof cfgPrivacy === "string" &&
		["PUBLIC", "UNLISTED", "PRIVATE"].includes(
			String(cfgPrivacy).toUpperCase(),
		)
	) {
		youtubePrivacy = String(cfgPrivacy).toUpperCase();
	} else if (
		typeof selPrivacy === "string" &&
		["PUBLIC", "UNLISTED", "PRIVATE"].includes(
			String(selPrivacy).toUpperCase(),
		)
	) {
		youtubePrivacy = String(selPrivacy).toUpperCase();
	} else {
		// tenta extrair de youtube_options do item se existir
		const rawYtOpt = selAny?.["youtube_options"];
		if (rawYtOpt != null) {
			try {
				const parsed =
					typeof rawYtOpt === "string"
						? (JSON.parse(rawYtOpt as string) as Record<string, unknown>)
						: (rawYtOpt as Record<string, unknown>);
				if (
					typeof parsed.privacy === "string" &&
					["PUBLIC", "UNLISTED", "PRIVATE"].includes(
						String(parsed.privacy).toUpperCase(),
					)
				) {
					youtubePrivacy = String(parsed.privacy).toUpperCase();
				}
			} catch { /* SAFETY: best-effort opcional — campo ausente/malformado não deve abortar o fluxo */ }
		}
	}
	// made_for_kids / monetize: config > item > youtube_options
	let madeForKids: boolean | null = null;
	if (cfg["youtube_made_for_kids"] !== undefined)
		madeForKids = toStrictBool(cfg["youtube_made_for_kids"]);
	else if (selAny?.["made_for_kids"] !== undefined)
		madeForKids = toStrictBool(selAny?.["made_for_kids"]);
	else {
		const rawYtOpt = selAny?.["youtube_options"];
		if (rawYtOpt != null) {
			try {
				const parsed =
					typeof rawYtOpt === "string"
						? (JSON.parse(rawYtOpt as string) as Record<string, unknown>)
						: (rawYtOpt as Record<string, unknown>);
				if (parsed.made_for_kids !== undefined)
					madeForKids = toStrictBool(parsed.made_for_kids);
			} catch { /* SAFETY: best-effort opcional — campo ausente/malformado não deve abortar o fluxo */ }
		}
	}
	let monetizeWithAds: boolean | null = null;
	if (cfg["youtube_monetize_with_ads"] !== undefined)
		monetizeWithAds = toStrictBool(cfg["youtube_monetize_with_ads"]);
	else if (selAny?.["monetize_with_ads"] !== undefined)
		monetizeWithAds = toStrictBool(selAny?.["monetize_with_ads"]);
	else {
		const rawYtOpt = selAny?.["youtube_options"];
		if (rawYtOpt != null) {
			try {
				const parsed =
					typeof rawYtOpt === "string"
						? (JSON.parse(rawYtOpt as string) as Record<string, unknown>)
						: (rawYtOpt as Record<string, unknown>);
				if (parsed.monetize_with_ads !== undefined)
					monetizeWithAds = toStrictBool(parsed.monetize_with_ads);
			} catch { /* SAFETY: best-effort opcional — campo ausente/malformado não deve abortar o fluxo */ }
		}
	}

	// Produtos afiliados (F1/M5): helper ÚNICO toYoutubeProductsJson separa
	// nomes (auto-select via /api/shorts/auto) de itens verbatim (/api/shorts
	// com products). NUNCA aplicar template {var} nem split por vírgula em
	// nomes de produto (M22) — produto não é caption, e vírgula pode ser parte
	// do nome. CSV legacy é normalizado para {query}.
	//
	// REGRA ITEM > FIXO (decisão do dono — produtos por vídeo na library):
	// se o item de biblioteca referenciado por selectedContent tem
	// youtube_products (CSV de nomes) NÃO-VAZIO, ele vence o youtube_products
	// fixo do config. Planner só usa o fixo quando o item está vazio/ausente.
	// A busca pelo slash: buildPostData e propagação passam pelo MESMO caminho
	// (seleciona o item por id/folder_id, IDOR-safe).
	let itemProductSource: unknown = cfg["youtube_products"];
	const itemLibId = selected?.id || selected?.folder_id;
	if (itemLibId) {
		try {
			const libItemProducts = await opts.prisma.contentItem.findFirst({
				where: { id: itemLibId, user_id: opts.planner.user_id },
				select: { youtube_products: true },
			});
			const raw = libItemProducts?.youtube_products;
			if (typeof raw === "string" && raw.trim()) {
				itemProductSource = raw;
				// Productos do item só podem ser NOMES (CSV) — a UI da library
				// não monta {query,item?} verbatim; resolução fiel no routing.
			}
		} catch { /* SAFETY: best-effort opcional — item inexistente cai no fixo do planner */ }
	}
	const productsPayload = toYoutubeProductsJson(itemProductSource);
	let productsJson: string | null = null;
	let productNamesJson: string | null = null;
	if (productsPayload.hasItems) {
		// [{ item: <bloco verbatim do catálogo> }] — /api/shorts (products)
		productsJson = JSON.stringify(productsPayload.items);
	}
	if (productsPayload.hasNames) {
		// ["nome", ...] — /api/shorts/auto (product_names)
		productNamesJson = JSON.stringify(productsPayload.names);
	}

	// categoria e descricao: usar config quando houver, senão defaults (com
	// template resolvido — M18: a propagação antes mandava a descrição crua).
	const descriptionVal = (rawYtDescTpl ? rawYtDescTpl : opts.caption || "") as string;
	const categoryIdRaw = cfg["youtube_category_id"];
	const categoryId = categoryIdRaw !== undefined ? Number(categoryIdRaw) : undefined;
	// G4: alias youtube_pinned_comment ?? youtube_pinned_comment_text (o wizard
	// grava ambos; runtime lê o alias primeiro, config/preview idem).
	const pinnedRaw =
		(cfg["youtube_pinned_comment"] as unknown) ??
		cfg["youtube_pinned_comment_text"] ??
		selAny?.["pinned_comment_text"] ??
		selAny?.["youtube_pinned_comment"];

	const ytObj: Record<string, unknown> = {
		title: titleCandidate.slice(0, 100),
		privacy: youtubePrivacy,
		...(madeForKids !== null ? { made_for_kids: madeForKids } : {}),
		...(monetizeWithAds !== null ? { monetize_with_ads: monetizeWithAds } : {}),
	};
	if (descriptionVal) ytObj.description = String(descriptionVal).slice(0, 5000);
	if (categoryId !== undefined && Number.isInteger(categoryId))
		ytObj.category_id = categoryId;
	if (typeof pinnedRaw === "string" && pinnedRaw.trim())
		ytObj.pinned_comment_text = pinnedRaw.trim().slice(0, 10000);
	if (productsJson) ytObj.products = productsJson;
	if (productNamesJson) ytObj.product_names = productNamesJson;
	return JSON.stringify(ytObj);
}

/**
 * Monta os dados de criação de um Post (Prisma.PostUncheckedCreateInput) a partir
 * do runtime resolvido. Aplica:
 *   - STORIES .mp4 → video_url (não image_url)
 *   - CAROUSEL     → primeiro child como imagem/thumbnail
 *   - collaborators/user_tags NORMALIZADOS (array|string → comma-string)
 *   - audio_configuration   → string JSON
 *   - caption com template (índice por POST — `templateIndex` + `postOrdinal`)
 */
// ── TikTok options (A3 isolation: helper stub para A4) ─────────────────────
/**
 * Helper de TikTok: normaliza privacy_level com fallback do creator_info.
 * Exportado para A4 implementar buildTiktokOptionsForPost completo.
 */
export function getTiktokPrivacyOptions(fallback?: string[]): string[] {
	if (fallback && Array.isArray(fallback) && fallback.length > 0) return fallback;
	return [...TIKTOK_PRIVACY_FALLBACK];
}

export function normalizeTiktokPrivacyLevel(
	value: unknown,
	allowed: string[] = [...TIKTOK_PRIVACY_FALLBACK],
): string | null {
	if (value == null || value === "") return null;
	const v = String(value).trim();
	if ((allowed as readonly string[]).includes(v)) return v;
	if ((TIKTOK_PRIVACY_FALLBACK as readonly string[]).includes(v)) return v;
	return null;
}

/**
 * A3 stub: monta tiktok_options JSON para o Post.
 * A4 completará com validação via creator_info, brand eligibility, etc.
 * Retorna JSON string ou null se não for canal TikTok.
 * NÃO lança — retorna null quando não há dados.
 */
export async function buildTiktokOptionsForPost(opts: {
	prisma: PrismaLike;
	planner: { user_id: string };
	config: PlannerConfig;
	selectedContent: PlannerContentItem | null | undefined;
	channelName: string;
	now: Date;
	caption: string;
	platform?: string | null;
}): Promise<string | null> {
	const { config, caption } = opts;
	const cfg = config as Record<string, unknown>;
	const isTiktok = String(opts.platform || "").toLowerCase() === "tiktok";
	if (!isTiktok) return null;
	// Resolve privacy com fallback
	const rawPrivacy =
		(typeof cfg["tiktok_privacy_level"] === "string" ? String(cfg["tiktok_privacy_level"]) : null) ??
		(typeof cfg["tiktok_privacy"] === "string" ? String(cfg["tiktok_privacy"]) : null) ??
		(typeof cfg["privacy_level"] === "string" ? String(cfg["privacy_level"]) : null);
	const privacy_level = rawPrivacy || "SELF_ONLY";
	const disable_duet = Boolean(
		cfg["tiktok_disable_duet"] === true ||
			String(cfg["tiktok_disable_duet"]).toLowerCase() === "true" ||
			cfg["disable_duet"] === true,
	);
	const disable_stitch = Boolean(
		cfg["tiktok_disable_stitch"] === true ||
			String(cfg["tiktok_disable_stitch"]).toLowerCase() === "true" ||
			cfg["disable_stitch"] === true,
	);
	const disable_comment = Boolean(
		cfg["tiktok_disable_comment"] === true ||
			String(cfg["tiktok_disable_comment"]).toLowerCase() === "true" ||
			cfg["disable_comment"] === true,
	);
	const coverRaw =
		cfg["tiktok_video_cover_timestamp_ms"] ??
		cfg["video_cover_timestamp_ms"] ??
		cfg["tiktok_cover_timestamp_ms"];
	let video_cover_timestamp_ms: number | undefined = undefined;
	if (coverRaw !== undefined && coverRaw !== null && coverRaw !== "") {
		const n = Number(coverRaw);
		if (Number.isFinite(n) && n >= 0) video_cover_timestamp_ms = Math.floor(n);
	}
	const brand_content_toggle = Boolean(
		cfg["tiktok_brand_content_toggle"] === true ||
			String(cfg["tiktok_brand_content_toggle"]).toLowerCase() === "true" ||
			cfg["brand_content_toggle"] === true,
	);
	const brand_organic_toggle = Boolean(
		cfg["tiktok_brand_organic_toggle"] === true ||
			String(cfg["tiktok_brand_organic_toggle"]).toLowerCase() === "true" ||
			cfg["brand_organic_toggle"] === true,
	);
	// title: caption TikTok (1..2200) — usa tiktok_caption/tiktok_title ou caption resolvida
	const rawTitle =
		(typeof cfg["tiktok_caption"] === "string" ? String(cfg["tiktok_caption"]) : null) ??
		(typeof cfg["tiktok_title"] === "string" ? String(cfg["tiktok_title"]) : null);
	const title = rawTitle ? String(rawTitle).trim().slice(0, 2200) : String(caption || "").trim().slice(0, 2200);
	const payload: Record<string, unknown> = {
		title,
		privacy_level,
		disable_duet,
		disable_stitch,
		disable_comment,
		...(video_cover_timestamp_ms !== undefined ? { video_cover_timestamp_ms } : {}),
		...(brand_content_toggle ? { brand_content_toggle: true } : {}),
		...(brand_organic_toggle ? { brand_organic_toggle: true } : {}),
	};
	return JSON.stringify(payload);
}

/** Valida se o mediaType é suportado para TikTok v1 (apenas vídeo). */
export function validateTiktokMediaType(mediaType: string | undefined | null): { ok: boolean; error?: string } {
	const m = String(mediaType || "").toUpperCase();
	if (m === "REELS" || m === "VIDEO") return { ok: true };
	if (m === "IMAGE" || m === "CAROUSEL") {
		return { ok: false, error: "TikTok v1: apenas vídeo é suportado. Imagens e carrosséis serão habilitados na fase 2." };
	}
	// STORIES também bloqueado para TikTok
	if (m === "STORIES") return { ok: false, error: "TikTok v1: apenas vídeo é suportado. Stories não são suportados." };
	return { ok: true };
}

export async function buildPostData(opts: {
	prisma: PrismaLike;
	planner: { user_id: string; id: string };
	channel: { id: string; name?: string | null; platform?: string | null };
	runtime: Awaited<ReturnType<typeof resolvePlannerRuntime>>;
	config: PlannerConfig;
	now: Date;
	templateIndex: number;
	postOrdinal: number;
}): Promise<Prisma.PostUncheckedCreateInput> {
	const { runtime, config } = opts;
	const safeChildren = runtime.children || [];
	const isVideoStory =
		runtime.mediaType === "STORIES" &&
		!!runtime.mediaUrl &&
		runtime.mediaUrl.includes(".mp4");

	const caption = await applyCaptionTemplate({
		prisma: opts.prisma,
		selectedContent: runtime.selectedContent,
		planner: opts.planner,
		config,
		channelName: opts.channel.name || "",
		now: opts.now,
		templateIndex: opts.templateIndex,
		postOrdinal: opts.postOrdinal,
		// F4/M9: {post_caption} resolve a caption da plataforma deste canal.
		platform: opts.channel.platform,
	});

	// F4: primeiro comentário — SNAPSHOT do ContentItem (library) para o Post.
	// Decisão do dono: o YouTube publica automaticamente após o Short (o
	// publisher lê `post.first_comment`); IG/TikTok apenas salvam o texto (sem
	// API oficial de comentário). Mesmo caminho IDOR-safe do
	// resolveCaptionTemplateVars (item por id/folder_id do usuário).
	let firstComment: string | null = null;
	const fcLibId =
		runtime.selectedContent?.id || runtime.selectedContent?.folder_id;
	if (fcLibId) {
		try {
			const fcItem = await opts.prisma.contentItem.findFirst({
				where: { id: fcLibId, user_id: opts.planner.user_id },
				select: { first_comment: true },
			});
			const fc = (fcItem?.first_comment || "").trim();
			firstComment = fc ? fc.slice(0, 500) : null;
		} catch {
			/* SAFETY: best-effort opcional — item inexistente/ausente = sem comentário */
		}
	}

	const isYtChannel =
		(opts.channel.platform || "").toLowerCase() === "youtube";
	const ytTypeForPost =
		isYtChannel && (runtime.mediaType === "IMAGE" || runtime.mediaType === "CAROUSEL")
			? "community"
			: isYtChannel
				? "short"
				: null;

	// F2/M5/M17/M18: função ÚNICA buildYoutubeOptionsForPost — a MESMA usada
	// pela propagação. Garante que criar posts e editar um planner produzem o
	// MESMO youtube_options (products preservados, título com youtube_title
	// resolvido, description com template, pinned alias G4, herança
	// config>item>youtube_options). Sem duplicação de lógica.
	let youtubeOptions: string | null = null;
	if (ytTypeForPost === "short") {
		youtubeOptions = await buildYoutubeOptionsForPost({
			prisma: opts.prisma,
			planner: { user_id: opts.planner.user_id },
			config,
			selectedContent:
				runtime.selectedContent as PlannerContentItem | null | undefined,
			channelName: opts.channel.name || "",
			now: opts.now,
			caption,
			platform: opts.channel.platform,
		});
	}

	// ── TikTok branch (A3 isolation) ────────────────────────────────────────
	const isTiktokChannel =
		(opts.channel.platform || "").toLowerCase() === "tiktok";
	// Bloqueio v1: IMAGE/CAROUSEL não são suportados para TikTok
	if (isTiktokChannel) {
		const tiktokMediaCheck = validateTiktokMediaType(runtime.mediaType ?? "");
		if (!tiktokMediaCheck.ok) {
			throw new Error(tiktokMediaCheck.error || "TikTok v1: apenas vídeo");
		}
		// Também bloqueia tiktok_type vs youtube_type mutuamente exclusivos
		// (defesa: se config contém youtube_type, não cria post tiktok)
		const cfgAny = config as Record<string, unknown>;
		if (cfgAny["youtube_type"] && cfgAny["tiktok_type"]) {
			throw new Error("youtube_type e tiktok_type são mutuamente exclusivos");
		}
	}
	let tiktokOptions: string | null = null;
	let tiktokType: string | null = null;
	if (isTiktokChannel) {
		tiktokType = "video";
		tiktokOptions = await buildTiktokOptionsForPost({
			prisma: opts.prisma,
			planner: { user_id: opts.planner.user_id },
			config,
			selectedContent:
				runtime.selectedContent as PlannerContentItem | null | undefined,
			channelName: opts.channel.name || "",
			now: opts.now,
			caption,
			platform: opts.channel.platform,
		});
	}

	return {
		user_id: opts.planner.user_id,
		channel_id: opts.channel.id,
		status: "pending",
		media_type: runtime.mediaType,
		// YouTube é plataforma de primeira classe: vídeo → Short, imagem/carrossel
		// → Post na Comunidade (o publisher usa youtube_type para escolher o caminho).
		youtube_type: ytTypeForPost,
		youtube_options: youtubeOptions,
		tiktok_type: tiktokType,
		tiktok_options: tiktokOptions,
		tiktok_post_id: null,
		video_url:
			runtime.mediaType === "REELS" || isVideoStory ? runtime.mediaUrl : null,
		image_url:
			runtime.mediaType === "IMAGE"
				? runtime.mediaUrl
				: runtime.mediaType === "STORIES" &&
						runtime.mediaUrl &&
						!runtime.mediaUrl.includes(".mp4")
					? runtime.mediaUrl
					: runtime.mediaType === "CAROUSEL" && safeChildren.length > 0
						? safeChildren[0].url
						: null,
		thumbnail_url:
			runtime.thumbnailUrl ||
			(safeChildren.length > 0 ? safeChildren[0].url : null),
		children_urls: safeChildren.length > 0 ? JSON.stringify(safeChildren) : null,
		share_to_feed: runtime.shareToFeed,
		location_id: runtime.locationId,
		collaborators: normalizeCollaborators(runtime.collaborators),
		user_tags: normalizeUserTags(runtime.userTags),
		audio_configuration: runtime.audioConfiguration
			? JSON.stringify(runtime.audioConfiguration)
			: null,
		caption,
		first_comment: firstComment,
		scheduled_at: opts.now,
		planner_id: opts.planner.id,
	} as unknown as Prisma.PostUncheckedCreateInput;
}


/** Campos do config que impactam caption/youtube_options — usados para detectar diff. */
const CAPTION_PROPAGATION_KEYS = [
  "caption",
  "caption_templates",
  "caption_rotation",
  "caption_fallback",
  "title_fallback",
  "youtube_title",
  "youtube_description",
  "youtube_privacy",
  "youtube_made_for_kids",
  "youtube_monetize_with_ads",
  "youtube_category_id",
  "youtube_pinned_comment_text",
  "youtube_pinned_comment",
  "youtube_products",
  "tiktok_caption",
  "tiktok_title",
  "tiktok_privacy_level",
  "tiktok_disable_duet",
  "tiktok_disable_stitch",
  "tiktok_disable_comment",
  "tiktok_video_cover_timestamp_ms",
  "tiktok_brand_content_toggle",
  "tiktok_brand_organic_toggle",
  "collaborators",
  "user_tags",
] as const;

/**
 * Verifica se dois configs diferem em algum campo que afeta posts pendentes.
 * Usado para evitar propagação desnecessária quando só frequency/sleep mudou.
 */
export function shouldPropagateConfig(
  oldConfig: Record<string, unknown> | null | undefined,
  newConfig: Record<string, unknown> | null | undefined
): boolean {
  if (!oldConfig || !newConfig) return true;
  for (const k of CAPTION_PROPAGATION_KEYS) {
    const a = JSON.stringify((oldConfig as Record<string, unknown>)[k] ?? null);
    const b = JSON.stringify((newConfig as Record<string, unknown>)[k] ?? null);
    if (a !== b) return true;
  }
  // Também detecta mudança no array content[].caption individual (o wizard
  // duplica a descrição em cada entrada). Compara captions agregados.
  const oldContent = Array.isArray(oldConfig.content) ? oldConfig.content as unknown[] : [];
  const newContent = Array.isArray(newConfig.content) ? newConfig.content as unknown[] : [];
  if (oldContent.length !== newContent.length) {
    // Só considera diff se houver mudança de caption dentro dos itens
    const oldCaps = JSON.stringify(oldContent.map((c: unknown) => (c as Record<string, unknown>)?.caption ?? null));
    const newCaps = JSON.stringify(newContent.map((c: unknown) => (c as Record<string, unknown>)?.caption ?? null));
    if (oldCaps !== newCaps) return true;
  } else {
    for (let i = 0; i < oldContent.length; i++) {
      const oc = oldContent[i] as Record<string, unknown>;
      const nc = newContent[i] as Record<string, unknown>;
      if (JSON.stringify(oc?.caption ?? null) !== JSON.stringify(nc?.caption ?? null)) return true;
      if (JSON.stringify(oc?.caption_fallback ?? null) !== JSON.stringify(nc?.caption_fallback ?? null)) return true;
      if (JSON.stringify(oc?.title_fallback ?? null) !== JSON.stringify(nc?.title_fallback ?? null)) return true;
    }
  }
  return false;
}

/**
 * Propaga alterações de config (caption/youtube) para todos os posts
 * pendentes/scheduled/queued do planner.
 *
 * Decisão de produto: sobrescreve caption de TODOS os posts pendentes com a
 * nova legenda resolvida. Posts sem flag de "customização manual" (o schema
 * não distingue edição manual vs snapshot do planner) são tratados como
 * derivados do planner. Usuários que editaram caption manualmente num post
 * pendente terão a edição sobrescrita — comportamento documentado; alternativa
 * seria nunca propagar, mas o bug reportado é que editar descrição do planner
 * NÃO refletia nos posts (expectativa é global).
 *
 * Batch: atualiza em lotes de 50 para evitar transação gigante em SQLite.
 */
export async function propagatePlannerConfigToPendingPosts(
  prismaClient: {
    post: {
      findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
      update: (args: unknown) => Promise<unknown>;
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
    contentItem?: { findFirst: (args: unknown) => Promise<unknown> };
    plannerLog?: { create: (args: unknown) => Promise<unknown> };
    channel?: { findUnique: (args: unknown) => Promise<unknown>; findMany?: (args: unknown) => Promise<unknown[]> };
  } & PrismaLike,
  planner: { id: string; user_id: string },
  newConfig: PlannerConfig,
  now: Date = new Date()
): Promise<{ updated: number; total: number }> {
  const pendingStatuses = ["pending", "scheduled", "queued"];
  let posts: Array<Record<string, unknown>>;
  try {
    posts = await prismaClient.post.findMany({
      where: { planner_id: planner.id, status: { in: pendingStatuses } },
      orderBy: [{ scheduled_at: "asc" }, { created_at: "asc" }],
    } as unknown) as Array<Record<string, unknown>>;
  } catch (e) {
    console.warn("[propagate] findMany failed", e);
    return { updated: 0, total: 0 };
  }
  if (!posts || posts.length === 0) return { updated: 0, total: 0 };

  const contentList: PlannerContentItem[] = Array.isArray(newConfig.content)
    ? (newConfig.content as PlannerContentItem[])
    : [];

  // Mapa channel_id -> {name, platform} para evitar N+1 quando possível
  const channelIds = [...new Set(posts.map((p) => p.channel_id).filter(Boolean) as string[])];
  const channelMap = new Map<string, { name: string | null; platform: string | null }>();
  if (channelIds.length > 0 && prismaClient.channel?.findMany) {
    try {
      const channels = await (prismaClient.channel.findMany as (args: unknown) => Promise<Array<Record<string, unknown>>>)({
        where: { id: { in: channelIds } },
        select: { id: true, name: true, platform: true },
      });
      for (const ch of channels) channelMap.set(String(ch.id), { name: (ch.name as string) || null, platform: (ch.platform as string) || null });
    } catch { /* SAFETY: best-effort opcional — campo ausente/malformado não deve abortar o fluxo */ }
  }

  let updated = 0;
  const BATCH = 50;
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const postId = String(post.id);
    const channelId = post.channel_id ? String(post.channel_id) : null;
    let channelName = "";
    let channelPlatform: string | null = null;
    if (channelId && channelMap.has(channelId)) {
      const ch = channelMap.get(channelId)!;
      channelName = ch.name || "";
      channelPlatform = ch.platform || null;
    } else if (channelId && prismaClient.channel?.findUnique) {
      try {
        const ch = await prismaClient.channel.findUnique({ where: { id: channelId }, select: { name: true, platform: true } }) as Record<string, unknown> | null;
        channelName = (ch?.name as string) || "";
        channelPlatform = (ch?.platform as string) || null;
        if (ch) channelMap.set(channelId, { name: channelName, platform: channelPlatform });
      } catch { /* SAFETY: best-effort opcional — campo ausente/malformado não deve abortar o fluxo */ }
    }

    // Heurística para selectedContent: tenta casar post com entrada do content
    // pelo URL (video_url/image_url) quando o content tem id de library.
    // Fallback: primeira entrada do content ou objeto sintético com a caption
    // global (planners sem content ainda).
    let selectedContent: PlannerContentItem | null | undefined = null;
    const urlCandidates = [
      post.video_url ? String(post.video_url) : null,
      post.image_url ? String(post.image_url) : null,
      post.thumbnail_url ? String(post.thumbnail_url) : null,
    ].filter(Boolean) as string[];

    if (contentList.length > 0) {
      // Tenta casar por URL (quando content tem url explícito)
      let matched: PlannerContentItem | null = null;
      for (const c of contentList) {
        const cUrl = (c as Record<string, unknown>).url ? String((c as Record<string, unknown>).url) : null;
        if (cUrl && urlCandidates.includes(cUrl)) { matched = c; break; }
      }
      // Fallback: se não casou por URL, usa a entrada na posição cíclica
      // (ordem de criação dos posts = ordem do contentList em random_loop off)
      selectedContent = matched || contentList[i % contentList.length] || contentList[0];
    } else {
      // Planner sem content (caso raro): sintetiza selectedContent vazio mas com
      // caption global se houver (ex.: config.caption)
      const globalCap = (newConfig as Record<string, unknown>).caption;
      selectedContent = globalCap ? { caption: String(globalCap) } as PlannerContentItem : null;
    }

    // F4: re-deriva o primeiro comentário do item de library (MESMO caminho
    // do buildPostData). undefined = não alterar o post (falha de lookup ou
    // item sem id não sobrescreve o valor existente — regra M5/B2).
    let newFirstComment: string | null | undefined = undefined;
    const fcLibId = selectedContent?.id || selectedContent?.folder_id;
    if (fcLibId) {
      try {
        const fcItem = await (prismaClient as PrismaLike).contentItem.findFirst({
          where: { id: fcLibId, user_id: planner.user_id },
          select: { first_comment: true },
        });
        const fc = (fcItem?.first_comment || "").trim();
        newFirstComment = fc ? fc.slice(0, 500) : null;
      } catch { /* SAFETY: mantém o primeiro comentário existente do post */ }
    }

    // Resolve nova caption via applyCaptionTemplate (mesma semântica do buildPostData)
    let newCaption: string;
    try {
      newCaption = await applyCaptionTemplate({
        prisma: prismaClient as PrismaLike,
        selectedContent,
        planner: { user_id: planner.user_id },
        config: newConfig,
        channelName,
        now,
        templateIndex: 0,
        postOrdinal: i,
        // F4/M9: cada post já tem canal; a caption por plataforma vem dele.
        platform: channelPlatform,
      });
    } catch (e) {
      console.warn("[propagate] caption resolve failed for post", postId, e);
      continue;
    }

    // youtube_options: só para posts de canal YouTube com youtube_type
    const ytType = post.youtube_type ? String(post.youtube_type).toLowerCase() : null;
    const isYtChannel = channelPlatform ? channelPlatform.toLowerCase() === "youtube" : ytType !== null;
    let newYoutubeOptions: string | null | undefined = undefined; // undefined = não alterar
    if (isYtChannel && ytType === "short") {
      try {
        const rebuilt = await buildYoutubeOptionsForPost({
          prisma: prismaClient as PrismaLike,
          planner: { user_id: planner.user_id },
          config: newConfig,
          selectedContent,
          channelName,
          now,
          caption: newCaption,
          platform: channelPlatform,
        });
        // F7/QA: buildYoutubeOptionsForPost retorna null quando NENHUM título
        // é resolvível (config patológico legado: youtube_title e caption
        // vazios no post). Nesse caso NÃO apagar youtube_options existente do
        // post pendente — regra M5/B2: editar planner nunca apaga dados de
        // publicação (products/título antigos preservados); o post continua
        // pendente e a falha real (se houver) será de publicação, não de
        // propagação silenciosa.
        if (rebuilt !== null) newYoutubeOptions = rebuilt;
      } catch { /* SAFETY: best-effort opcional — campo ausente/malformado não deve abortar o fluxo */ }
    } else if (isYtChannel && ytType === "community") {
      // Comunidade não tem youtube_options (usa caption); não reescreve
      // youtube_options — propagação só toca caption nesses posts.
      newYoutubeOptions = undefined;
    }

    // tiktok_options: só para posts de canal TikTok com tiktok_type=video.
    // Re-deriva via buildTiktokOptionsForPost (MESMA função da criação — M5:
    // editar planner produz o MESMO tiktok_options). Se null (sem título
    // resolvível), preserva o existente do post pendente (regra M5/B2).
    const tkType = post.tiktok_type ? String(post.tiktok_type).toLowerCase() : null;
    const isTiktokChannel = channelPlatform ? channelPlatform.toLowerCase() === "tiktok" : tkType !== null;
    let newTiktokOptions: string | null | undefined = undefined; // undefined = não alterar
    if (isTiktokChannel && tkType === "video") {
      try {
        const rebuilt = await buildTiktokOptionsForPost({
          prisma: prismaClient as PrismaLike,
          planner: { user_id: planner.user_id },
          config: newConfig,
          selectedContent,
          channelName,
          now,
          caption: newCaption,
          platform: channelPlatform,
        });
        if (rebuilt !== null) newTiktokOptions = rebuilt;
      } catch { /* SAFETY: best-effort opcional — não abortar propagação */ }
    }

    // Monta payload de update: sempre atualiza caption; youtube_options só se Short
    const data: Record<string, unknown> = { caption: newCaption };
    if (newYoutubeOptions !== undefined) data.youtube_options = newYoutubeOptions;
    if (newTiktokOptions !== undefined) data.tiktok_options = newTiktokOptions;
    if (newFirstComment !== undefined) data.first_comment = newFirstComment;

    // M14: re-checa o status DENTRO do where — o publisher pode ter claimado
    // (pending→processing) ou o usuário cancelado este post no instante da
    // propagação; um update incondicional por id reescreveria um post que
    // saiu do conjunto pending/scheduled/queued (race propagação×publisher).
    // Quando o status mudou, o post é pulado (SKIP) com log — nunca sobrescrito.
    try {
      const res = (await prismaClient.post.updateMany({
        where: { id: postId, status: { in: pendingStatuses } },
        data,
      } as unknown)) as { count: number } | undefined;
      if (res?.count && res.count > 0) {
        updated++;
      } else {
        console.warn(
          `[propagate] post ${postId}: status mudou durante a propagação (cancelado/claimado/published) — update ignorado; estado terminal preservado`,
        );
      }
    } catch (e) {
      console.warn("[propagate] update failed for post", postId, e);
    }

    // Batch yield (evita bloqueio longo em SQLite com muitos posts)
    if ((i + 1) % BATCH === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Log em PlannerLog (best-effort, não falha a propagação)
  if (updated > 0 && prismaClient.plannerLog?.create) {
    try {
      await prismaClient.plannerLog.create({
        data: {
          planner_id: planner.id,
          level: "info",
          message: `Planner editado: ${updated}/${posts.length} post(s) pendente(s) atualizado(s) com nova descrição/título`,
          details: JSON.stringify({ updated, total: posts.length, now: now.toISOString() }),
        },
      } as unknown);
    } catch { /* SAFETY: best-effort opcional — campo ausente/malformado não deve abortar o fluxo */ }
  }

  return { updated, total: posts.length };
}

export async function resolvePlannerRuntime(
	prisma: PrismaLike,
	planner: PlannerLike | null,
	now = new Date(),
	// M15: estado de publicação alternativo (avançado) para o retry de item
	// deletado — resolve sempre seleciona a partir do estado informado em vez
	// de re-ler planner.state (que não mudou num único run).
	overrideState?: Record<string, unknown>,
) {
	const config = parsePlannerConfig(planner?.config);
	const contentList: PlannerContentItem[] = Array.isArray(config.content)
		? (config.content as PlannerContentItem[])
		: [];
	const sortOrder = String(config.sort_order || "random_loop");
	const state = overrideState || parsePlannerState(planner?.state);
	const { selectedIndex, nextState } = selectContentIndex(
		contentList,
		sortOrder,
		state,
		parseItemRotation(config),
	);
	const selectedContent = contentList[selectedIndex];

	const warnings: string[] = [];

	if (!planner) {
		return {
			ok: false,
			errors: ["Planner not found"],
			warnings,
			selectedIndex,
			nextState,
		};
	}

	if (!selectedContent) {
		return {
			ok: false,
			errors: ["Could not select content item"],
			warnings,
			selectedIndex,
			nextState,
		};
	}

	let mediaUrl = selectedContent.url || "";
	let mediaType = selectedContent.media_type || "REELS";
	let caption = selectedContent.caption || "";
	const locationId = selectedContent.location_id || null;
	// BK-23 FIX: share_to_feed deveria ser null (herdar) nao false quando nao explicitado
	const rawShareToFeed = selectedContent.share_to_feed;
	const shareToFeed: boolean | null = typeof rawShareToFeed === "boolean" ? rawShareToFeed : null;
	let thumbnailUrl = selectedContent.thumbnail_url || null;
	let children: { url: string; type: string; thumbnail_url?: string | null }[] =
		selectedContent.children_urls || selectedContent.carousel_items || [];
	const collaborators = selectedContent.collaborators || null;
	const audioConfiguration = selectedContent.audio_configuration || null;
	const userTags = selectedContent.user_tags || null;

	// library_item | config com id | legado sem type com id | legado com folder_id
	const libId = selectedContent.id || selectedContent.folder_id;
	const isLibraryEntry =
		selectedContent.type === "library_item" ||
		(selectedContent.type === "config" && !!libId) ||
		(!selectedContent.type && !!libId);

	if (isLibraryEntry && libId) {
		// IDOR guard: only resolve content items owned by the planner's user
		const libItem = await prisma.contentItem.findFirst({
			where: { id: libId, user_id: planner.user_id },
		});
		if (libItem) {
			mediaUrl = libItem.url || "";
			thumbnailUrl = libItem.thumbnail_url || thumbnailUrl;
			mediaType =
				libItem.type === "video"
					? "REELS"
					: libItem.type === "image"
						? "IMAGE"
						: libItem.type === "carousel_folder"
							? "CAROUSEL"
							: mediaType;

			if (libItem.type === "carousel_folder") {
				const subItems = await prisma.contentItem.findMany({
					where: { parent_id: libItem.id },
				});
				// Order slides alphabetically by name (A-Z; 1-10), matching how the
				// uploader sorts files into the carousel (localeCompare with numeric
				// collation). created_at cannot be trusted here: parallel uploads
				// complete out of order, so the insertion date does not mirror the
				// alphabetical order the user sees in the library.
				const sortedSubItems = [...subItems].sort((a, b) =>
					String(a.name || "").localeCompare(String(b.name || ""), undefined, {
						numeric: true,
					}),
				);
				children = sortedSubItems
					.map((c) => {
						const urlStr = c.url || "";
						const isVideo =
							c.type === "video" || (urlStr && /\.(mp4|mov)(\?.*)?$/i.test(urlStr));
						return {
							url: urlStr,
							type: isVideo ? "video" : "image",
							thumbnail_url: c.thumbnail_url || null,
						};
					})
					.slice(0, 10);

				if (subItems.length > 10) {
					warnings.push("Carrossel limitado a 10 itens");
				}
				if (!thumbnailUrl && children.length > 0) {
					thumbnailUrl = children[0].url;
				}
			}
		} else {
			warnings.push(`Library item not found: ${libId}`);
		}
	}

	// SINGLE SUBSTITUTION PATH — a caption da entrada (onde o wizard grava o
	// template digitado) é resolvida via resolveCaptionTemplateVars +
	// substituteCaptionTemplate, as MESMAS funções do lane de publicação
	// (applyCaptionTemplate com rotation=off). Isso garante:
	//   - zero chaves literais ({date}, {channel_name}, {hashtags} e
	//     desconhecidas eram vazadas por um .replace ad-hoc de só 2 variáveis);
	//   - parity preview×publicação para o mesmo estado;
	//   - que o caso "library item not found" também resolva limpo (via
	//     fallbacks) em vez de publicar o template cru.
	// NÃO re-substituir este valor em outro lugar: buildPostData/preview
	// resolvem a partir das mesmas fontes — alimentar runtime.caption de volta
	// em substituteCaptionTemplate quebraria a idempotência se um valor
	// resolvido contiver "{".
	const firstChannel = (planner.channels || [])[0];
	// M11: STORIES não existe no YouTube — o wizard auto-corrige no load/save
	// (PlannerWizard STORIES→REELS), mas configs grandfathered (nunca
	// re-salvas) chegam ao runtime ainda como STORIES. Sem a normalização o
	// post YT seria classificado como Short sem vídeo (imagem → video_url=null)
	// → falha definitiva no publisher. Normaliza aqui: STORIES → REELS (o
	// vídeo do story vira short com vídeo).
	if (
		firstChannel &&
		String(firstChannel.platform || "").toLowerCase() === "youtube" &&
		mediaType === "STORIES"
	) {
		mediaType = "REELS";
		warnings.push("STORIES convertido para REELS — o YouTube não suporta Stories");
	}
	const channelName =
		firstChannel && typeof firstChannel.name === "string"
			? firstChannel.name
			: "";
	// F4/M9: preview/runtime resolve a caption da plataforma do canal (mix é
	// bloqueado, então o 1º canal representa a plataforma do planner).
	const templateVars = await resolveCaptionTemplateVars(
		prisma,
		selectedContent,
		{ user_id: planner.user_id },
		config,
		channelName,
		now,
		firstChannel ? firstChannel.platform : null,
	);
	caption = substituteCaptionTemplate(caption || "", templateVars);

	if (!thumbnailUrl && children.length > 0) {
		thumbnailUrl = children[0].thumbnail_url || children[0].url;
	}

	const errors: string[] = [];
	if (mediaType === "CAROUSEL" && children.length === 0) {
		errors.push("Carousel item has no children");
	}
	if (!mediaUrl && children.length === 0) {
		errors.push("Media URL missing");
	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		selectedIndex,
		selectedContent,
		nextState,
		mediaUrl,
		mediaType,
		caption,
		locationId,
		shareToFeed,
		thumbnailUrl,
		children,
		collaborators,
		audioConfiguration,
		userTags,
		preview: {
			mediaUrl,
			mediaType,
			caption,
			locationId,
			shareToFeed,
			thumbnailUrl,
			children,
			collaborators,
			audioConfiguration,
			userTags,
		},
		config,
	};
}

/**
 * Executa a FASE 0 completa de um planner (compartilhada entre o cron e o
 * POST /api/planners/[id]/run):
 *
 *   1. parse + validação do config (fonte única: planner-config)
 *   2. se !force: checa due (intervalo validado), start_time, sleep_schedule
 *   3. resolve o runtime ANTES do claim (um tick não é consumido por erro
 *      de resolução — planner bloqueado NÃO avança o state; um ITEM DELETADO
 *      avança o índice e pula ao próximo — M15, nunca fica wedged)
 *   4. claim atômico em last_run (updateMany condicional — runs sobrepostos
 *      não duplicam posts)
 *   5. cria 1 post por canal publicável (buildPostData: templates por post,
 *      collaborators/user_tags normalizados, STORIES/carousel corretos)
 *   6. persiste Planner.state (NÃO o config) + last_run em transação
 *
 * NÃO loga — o caller decide (cron loga com throttle; /run loga com sessão).
 */
export async function runPlannerOnce(
	prisma: PrismaLike,
	planner: PlannerLike | null,
	now = new Date(),
	opts?: { force?: boolean },
): Promise<{
	ok: boolean;
	created?: number;
	skipped?: string;
	error?: string;
	warnings?: string[];
}> {
	if (!planner) {
		return {
			ok: false,
			skipped: "not_found",
			error: "Planner not found",
		};
	}
	const config = parsePlannerConfig(planner.config);

	const validation = validatePlannerConfig(config);
	if (!validation.ok) {
		return {
			ok: false,
			skipped: "invalid_config",
			error: `Config inválido: ${validation.errors.join("; ")}`,
		};
	}

	// ── Gate temporal (pulado com force) ───────────────────────────────────────
	if (!opts?.force) {
		if (planner.status !== "active") {
			return { ok: false, skipped: "not_active" };
		}

		const intervalMs = getPlannerIntervalMs(config);
		if (intervalMs === null) {
			return {
				ok: false,
				skipped: "invalid_frequency",
				error: "frequency.value inválido (deve ser >= 1)",
			};
		}
		const lastRun = planner.last_run ? new Date(planner.last_run) : null;
		const isDue =
			!lastRun || now.getTime() >= lastRun.getTime() + intervalMs - 15000;
		if (!isDue) {
			return { ok: false, skipped: "not_due" };
		}

		if (config.start_time && now < new Date(String(config.start_time))) {
			return {
				ok: false,
				skipped: "start_time",
				error: "start_time not reached",
			};
		}

		if (isSleepingNow(config, now)) {
			return { ok: false, skipped: "sleep", error: "Sleep schedule active" };
		}
	}

	// ── Canais ─────────────────────────────────────────────────────────────────
	const channels = planner.channels || [];
	if (channels.length === 0) {
		return {
			ok: false,
			skipped: "no_channels",
			error: "No channels connected",
		};
	}

	// Isolation A3: TikTok não pode misturar com YT/IG (3 pilares)
	{
		const platforms = new Set(
			channels
				.map((c) => String((c as { platform?: string | null }).platform || "").toLowerCase().trim())
				.filter(Boolean),
		);
		if (platforms.size > 1) {
			const hasTiktok = platforms.has("tiktok");
			const errMsg = hasTiktok
				? PLANNER_TIKTOK_MIX_ERROR
				: "Planners não podem misturar canais de YouTube e Instagram. Crie planners separados.";
			return { ok: false, skipped: "mixed_platforms", error: errMsg };
		}
	}

	const publishableChannels = channels.filter(
		(channel) => describeChannelHealth(channel, now).ok,
	);
	const blocked = channels.length - publishableChannels.length;
	if (publishableChannels.length === 0) {
		return {
			ok: false,
			skipped: "no_publishable_channels",
			error: "No publishable channels available",
		};
	}

	// ── Resolução ANTES do claim (achado: tick não é consumido por erro) ──────
	// M15: retry com avanço de índice para ITEM DELETADO — um content entry que
	// aponta para library item removido não pode travar o planner para sempre
	// (sequencial seleciona sempre o mesmo índice → nunca publica os seguintes).
	// Cada resolve avança exatamente UM passo a partir do estado informado
	// (runtime.nextState) — o avanço acontece DENTRO da re-resolução; aqui só
	// espiramos o próximo índice (selectContentIndex sobre o mesmo estado, a
	// MESMA função que resolvePlannerRuntime usa) para guardar o ciclo. Demais
	// falhas de resolução continuam NÃO consumindo tick (R3 preservado).
	const contentEntries: PlannerContentItem[] = Array.isArray(config.content)
		? (config.content as PlannerContentItem[])
		: [];
	const sortOrderKey = String(config.sort_order || "random_loop");
	let runtime = await resolvePlannerRuntime(prisma, planner, now);
	// Warnings das tentativas com item deletado (acumulados para o resultado —
	// o runtime final bem-sucedido não carrega as warnings do item pulado).
	const skippedDeletedWarnings: string[] = [];
	if (!runtime.ok && isDeletedItemFailure(runtime)) {
		// A tentativa inicial (item deletado) também contribui warnings.
		skippedDeletedWarnings.push(...(runtime.warnings || []));
		let advanceState = runtime.nextState;
		const attempted = new Set<number>([runtime.selectedIndex]);
		const maxAttempts = Math.max(contentEntries.length, 1);
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			// Peek: qual índice o PRÓXIMO resolve selecionará a partir deste estado?
			const peek = selectContentIndex(
				contentEntries,
				sortOrderKey,
				advanceState,
				parseItemRotation(config),
			);
			if (!peek || peek.selectedIndex === -1) break;
			if (attempted.has(peek.selectedIndex)) break; // ciclo completo
			attempted.add(peek.selectedIndex);
			const nextRuntime = await resolvePlannerRuntime(
				prisma,
				planner,
				now,
				advanceState,
			);
			if (!nextRuntime.ok) {
				skippedDeletedWarnings.push(...(nextRuntime.warnings || []));
			}
			runtime = nextRuntime;
			advanceState = runtime.nextState;
			if (runtime.ok || !isDeletedItemFailure(runtime)) break;
		}
	}
	if (!runtime.ok) {
		return {
			ok: false,
			skipped: "resolution_failed",
			error: runtime.errors.join("; "),
			warnings: runtime.warnings,
		};
	}

	// ── Claim atômico ──────────────────────────────────────────────────────────
	const claim = await prisma.planner.updateMany({
		where: { id: planner.id, last_run: planner.last_run },
		data: { last_run: now },
	});
	if (claim.count !== 1) {
		return {
			ok: false,
			skipped: "already_running",
			error: "Planner is already running (claim lost)",
		};
	}

	// ── Templates: índice base do state, incrementado POR POST criado ─────────
	const state = parsePlannerState(planner.state);
	const templateIndex =
		typeof state.template_index === "number" &&
		Number.isFinite(state.template_index)
			? state.template_index
			: 0;
	const rotation = config.caption_rotation || "off";
	const useTemplates =
		Array.isArray(config.caption_templates) &&
		config.caption_templates.length > 0 &&
		rotation !== "off";

	// ── Criar posts + persistir state (transação quando disponível) ───────────
	// IMPORTANTE: o $transaction do Prisma exige PrismaPromise PURAS (sem .then
	// encadeado). Resolvemos os datas primeiro (buildPostData é async por causa
	// dos templates) e só então montamos o array de operações.
	const postDatas: Prisma.PostUncheckedCreateInput[] = [];
	for (let i = 0; i < publishableChannels.length; i++) {
		postDatas.push(
			await buildPostData({
				prisma,
				planner: { user_id: planner.user_id, id: planner.id },
				channel: publishableChannels[i],
				runtime,
				config,
				now,
				templateIndex,
				postOrdinal: i,
			}),
		);
	}

	// template_index avança POR POST criado (não por ciclo) — satisfaz a rotação
	// sequencial em planners com múltiplos canais.
	const nextState = {
		...runtime.nextState,
		...(useTemplates ? { template_index: templateIndex + postDatas.length } : {}),
	};

	const ops = postDatas.map(
		(d) => prisma.post.create({ data: d }) as Prisma.PrismaPromise<unknown>,
	);
	// BK-04: state update com where last_run esperado evita clobber em edicao concorrente
	const expectedLastRun = now;
	ops.push(
		// SAFETY: PrismaPromise exigido pelo $transaction; PrismaLike tipa o
	// prisma como interface mínima — o cast mantém o contrato de transação.
	prisma.planner.updateMany({
			where: { id: planner.id, last_run: expectedLastRun },
			data: { state: JSON.stringify(nextState) },
		}) as unknown as Prisma.PrismaPromise<unknown>,
	);

	try {
		// BK-06: sempre transacionado; fallback tambem usa transaction
		// SAFETY: os ops são arrays de PrismaPromise já tipados; o $transaction do
		// PrismaLike é exposto via cast porque a interface mínima não o declara.
		await (prisma as unknown as { $transaction: (ops: unknown[]) => Promise<unknown[]> }).$transaction(ops.filter(Boolean) as never);
	} catch (err: unknown) {
		// A criação falhou depois do claim: reverta o claim (condicional) para não "comer" o
		// próximo tick e não perder o due (posts parciais não são criados via rollback).
		await prisma.planner
			.updateMany({
				where: { id: planner.id, last_run: expectedLastRun },
				data: { last_run: planner.last_run },
			})
			.catch(() => {});
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Post creation failed",
		};
	}

	return {
		ok: true,
		created: postDatas.length,
		warnings: [
			...(runtime.warnings || []),
			...skippedDeletedWarnings,
			...(blocked > 0 ? [`${blocked} channel(s) blocked`] : []),
		],
	};
}
