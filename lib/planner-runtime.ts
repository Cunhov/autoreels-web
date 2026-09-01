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
	normalizeYoutubeProductsCsv,
	parsePlannerConfig,
	parsePlannerState,
	validatePlannerConfig,
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

function selectContentIndex(
	contentList: PlannerContentItem[],
	sortOrder: string,
	state: Record<string, unknown>,
) {
	if (contentList.length === 0) {
		return { selectedIndex: -1, nextState: state };
	}

	let selectedIndex = -1;
	const nextState = cloneState(state);

	if (sortOrder === "random_loop") {
		const published = Array.isArray(nextState.published_indexes)
			? nextState.published_indexes
			: [];
		const available = contentList
			.map((_, i) => i)
			.filter((i) => !published.includes(i));

		if (available.length === 0) {
			const lastIndex =
				published.length > 0 ? published[published.length - 1] : -1;
			let candidates = contentList.map((_, i) => i);
			if (contentList.length > 1 && lastIndex !== -1) {
				candidates = candidates.filter((i) => i !== lastIndex);
			}
			selectedIndex = candidates[Math.floor(Math.random() * candidates.length)];
			nextState.published_indexes = [selectedIndex];
		} else {
			selectedIndex = available[Math.floor(Math.random() * available.length)];
			nextState.published_indexes = [...published, selectedIndex];
		}
	} else if (sortOrder === "new_to_old") {
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

export function getChannelHealth(channel: ChannelLike, now = new Date()) {
	const issues: string[] = [];
	const warnings: string[] = [];
	const hasToken = Boolean(channel.access_token);
	// Canais YouTube não usam access_token do Instagram — a autenticação vive
	// na sessão remota da API externa (Channel.settings.sessionId).
	const isYoutube = (channel.platform || "").toLowerCase() === "youtube";

	if ((channel.status || "").toLowerCase() !== "active") {
		issues.push("inactive");
	}

	if (!hasToken && !isYoutube) {
		issues.push("missing_token");
	}

	// Canal YouTube ativo sem sessionId em settings cria posts que falham
	// sempre no publisher — sinalizar como issue, não como "Ready".
	if (isYoutube && !getYoutubeSessionId(channel.settings)) {
		issues.push("missing_session");
	}

	if (!isYoutube && channel.token_source !== "redis" && channel.token_expires_at) {
		const expiresAt = new Date(channel.token_expires_at);
		const daysLeft =
			(expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
		if (daysLeft < 0) issues.push("expired");
		else if (daysLeft < 14) warnings.push("expiring_soon");
	}

	if (!isYoutube && channel.token_source === "redis") {
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
export async function resolveCaptionTemplateVars(
	prisma: PrismaLike,
	selectedContent: PlannerContentItem | null | undefined,
	planner: { user_id: string },
	config: Record<string, unknown>,
	channelName: string,
	now: Date,
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
			select: { title: true, caption: true, tags: true },
		});
		if (libItem) {
			title = libItem.title || "";
			itemCaption = libItem.caption || "";
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
 * Monta os dados de criação de um Post (Prisma.PostUncheckedCreateInput) a partir
 * do runtime resolvido. Aplica:
 *   - STORIES .mp4 → video_url (não image_url)
 *   - CAROUSEL     → primeiro child como imagem/thumbnail
 *   - collaborators/user_tags NORMALIZADOS (array|string → comma-string)
 *   - audio_configuration   → string JSON
 *   - caption com template (índice por POST — `templateIndex` + `postOrdinal`)
 */
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
	});

	const isYtChannel =
		(opts.channel.platform || "").toLowerCase() === "youtube";
	const ytTypeForPost =
		isYtChannel && (runtime.mediaType === "IMAGE" || runtime.mediaType === "CAROUSEL")
			? "community"
			: isYtChannel
				? "short"
				: null;

	// Short de planner SEM youtube_options falhava no publisher ("exige título")
	// quando a caption resolvia vazia. Grava o título explícito usando a mesma
	// cadeia de fallbacks (título do item → title_fallback → caption resolvida)
	// e, por fim, o NOME do arquivo do item de biblioteca — uma caption
	// exclusivamente-template (ex.: "{post_caption}" de item sem caption)
	// resolveria vazio e o Short nunca mais publicaria. Com o nome como último
	// recurso o título nunca fica vazio para itens da biblioteca.
	let youtubeOptions: string | null = null;
	if (ytTypeForPost === "short") {
		const selected = runtime.selectedContent as PlannerContentItem | null | undefined;
		let itemName = "";
		const libId = selected?.id || selected?.folder_id;
		if (libId) {
			const libItem = await opts.prisma.contentItem.findFirst({
				where: { id: libId, user_id: opts.planner.user_id },
				select: { name: true },
			});
			itemName = libItem?.name
				? String(libItem.name).replace(/\.[A-Za-z0-9]+$/, "")
				: "";
		}
		// Resolve youtube_title/description/products templates (se contiver {var})
		const cfg = config as Record<string, unknown>;
		const varsForYt = await resolveCaptionTemplateVars(
				opts.prisma,
				selected as PlannerContentItem | null | undefined,
				opts.planner,
				config,
				opts.channel.name || "",
				opts.now,
			);
		const resolveYtTpl = (v: string): string => v.includes("{") ? substituteCaptionTemplate(v, varsForYt) : v;
		const rawYtTitle = typeof cfg["youtube_title"] === "string" ? resolveYtTpl(String(cfg["youtube_title"])) : "";
		const rawYtDescTpl = typeof cfg["youtube_description"] === "string" ? resolveYtTpl(String(cfg["youtube_description"])) : "";
		// Products CSV -> JSON string array via JSON.stringify(csv.split(',').filter(Boolean))
		const rawProductsCsv = cfg["youtube_products"] as unknown;
		let productsJson: string | null = null;
		if (typeof rawProductsCsv === "string" && rawProductsCsv.trim()) {
			const resolvedCsv = rawProductsCsv.includes("{") ? resolveYtTpl(rawProductsCsv) : rawProductsCsv;
			const arr = resolvedCsv.split(",").map((s: string) => s.trim()).filter(Boolean);
			productsJson = JSON.stringify(arr);
		} else if (Array.isArray(rawProductsCsv)) {
			const arr = (rawProductsCsv as unknown[]).map(v => String(v).trim()).filter(Boolean);
			if (arr.length > 0) productsJson = JSON.stringify(arr);
		}
		// also check normalized helper for safety
		if (!productsJson) {
			const normalized = normalizeYoutubeProductsCsv(rawProductsCsv);
			if (normalized) productsJson = JSON.stringify(normalized.split(",").filter(Boolean));
		}
		const titleCandidate = [
			rawYtTitle || "",
			selected?.title || "",
			selected?.title_fallback || "",
			caption || "",
			itemName,
		]
			.map((t) => String(t).trim())
			.find(Boolean);
		if (titleCandidate) {
			// BK-22 FIX: expandir para salvar youtube_options COMPLETO (privacy/made_for_kids/monetize/description)
			// antes só salvava {title}. Agora preserva youtube_options quando houver herança de config/conteúdo.
			const selAny = selected as unknown as Record<string, unknown> | null | undefined;
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
			if (typeof cfgPrivacy === "string" && ["PUBLIC","UNLISTED","PRIVATE"].includes(String(cfgPrivacy).toUpperCase())) {
				youtubePrivacy = String(cfgPrivacy).toUpperCase();
			} else if (typeof selPrivacy === "string" && ["PUBLIC","UNLISTED","PRIVATE"].includes(String(selPrivacy).toUpperCase())) {
				youtubePrivacy = String(selPrivacy).toUpperCase();
			} else {
				// tenta extrair de youtube_options do item se existir
				const rawYtOpt = selAny?.["youtube_options"];
				if (rawYtOpt != null) {
					try {
						const parsed = typeof rawYtOpt === "string" ? JSON.parse(rawYtOpt as string) as Record<string, unknown> : rawYtOpt as Record<string, unknown>;
						if (typeof parsed.privacy === "string" && ["PUBLIC","UNLISTED","PRIVATE"].includes(String(parsed.privacy).toUpperCase())) {
							youtubePrivacy = String(parsed.privacy).toUpperCase();
						}
					} catch {}
				}
			}
			let madeForKids: boolean | null = null;
			if (cfg["youtube_made_for_kids"] !== undefined) madeForKids = toStrictBool(cfg["youtube_made_for_kids"]);
			else if (selAny?.["made_for_kids"] !== undefined) madeForKids = toStrictBool(selAny?.["made_for_kids"]);
			else {
				const rawYtOpt = selAny?.["youtube_options"];
				if (rawYtOpt != null) {
					try {
						const parsed = typeof rawYtOpt === "string" ? JSON.parse(rawYtOpt as string) as Record<string, unknown> : rawYtOpt as Record<string, unknown>;
						if (parsed.made_for_kids !== undefined) madeForKids = toStrictBool(parsed.made_for_kids);
					} catch {}
				}
			}
			let monetizeWithAds: boolean | null = null;
			if (cfg["youtube_monetize_with_ads"] !== undefined) monetizeWithAds = toStrictBool(cfg["youtube_monetize_with_ads"]);
			else if (selAny?.["monetize_with_ads"] !== undefined) monetizeWithAds = toStrictBool(selAny?.["monetize_with_ads"]);
			else {
				const rawYtOpt = selAny?.["youtube_options"];
				if (rawYtOpt != null) {
					try {
						const parsed = typeof rawYtOpt === "string" ? JSON.parse(rawYtOpt as string) as Record<string, unknown> : rawYtOpt as Record<string, unknown>;
						if (parsed.monetize_with_ads !== undefined) monetizeWithAds = toStrictBool(parsed.monetize_with_ads);
					} catch {}
				}
			}
			// categoria e descricao: usar config quando houver, senão defaults (com template resolvido)
			const descriptionVal = (rawYtDescTpl ? rawYtDescTpl : (caption || "")) as string;
			const categoryIdRaw = cfg["youtube_category_id"];
			const categoryId = categoryIdRaw !== undefined ? Number(categoryIdRaw) : undefined;
			const pinnedRaw = (cfg["youtube_pinned_comment"] as unknown) ?? cfg["youtube_pinned_comment_text"] ?? selAny?.["pinned_comment_text"] ?? selAny?.["youtube_pinned_comment"];

			const ytObj: Record<string, unknown> = {
				title: titleCandidate.slice(0, 100),
				privacy: youtubePrivacy,
				...(madeForKids !== null ? { made_for_kids: madeForKids } : {}),
				...(monetizeWithAds !== null ? { monetize_with_ads: monetizeWithAds } : {}),
			};
			if (descriptionVal) ytObj.description = String(descriptionVal).slice(0, 5000);
			if (categoryId !== undefined && Number.isInteger(categoryId)) ytObj.category_id = categoryId;
			if (typeof pinnedRaw === "string" && pinnedRaw.trim()) ytObj.pinned_comment_text = pinnedRaw.trim().slice(0, 10000);
			if (productsJson) ytObj.products = productsJson;
			youtubeOptions = JSON.stringify(ytObj);
		}
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
		scheduled_at: opts.now,
		planner_id: opts.planner.id,
	} as Prisma.PostUncheckedCreateInput;
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
  "youtube_products",
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
 * Constrói youtube_options JSON para um post de Short a partir do config atualizado
 * e caption já resolvida. Espelha a lógica de buildPostData para consistência.
 * Retorna null se não houver título candidato (caption vazia + sem fallbacks).
 */
export async function buildYoutubeOptionsForPropagation(opts: {
  prisma: PrismaLike;
  planner: { user_id: string };
  config: PlannerConfig;
  caption: string;
  selectedContent: PlannerContentItem | null | undefined;
}): Promise<string | null> {
  const selected = opts.selectedContent as PlannerContentItem | null | undefined;
  let itemName = "";
  const libId = selected?.id || selected?.folder_id;
  if (libId) {
    try {
      const libItem = await opts.prisma.contentItem.findFirst({
        where: { id: libId, user_id: opts.planner.user_id },
        select: { name: true },
      });
      itemName = libItem?.name ? String(libItem.name).replace(/\.[A-Za-z0-9]+$/, "") : "";
    } catch {}
  }
  const titleCandidate = [
    selected?.title || "",
    selected?.title_fallback || "",
    opts.caption || "",
    itemName,
  ]
    .map((t) => String(t).trim())
    .find(Boolean);
  if (!titleCandidate) return null;

  const cfg = opts.config as Record<string, unknown>;
  const selAny = selected as unknown as Record<string, unknown> | null | undefined;
  const toStrictBool = (v: unknown): boolean => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v.toLowerCase() === "true";
    if (typeof v === "number") return v === 1;
    if (v == null) return false;
    return String(v).toLowerCase() === "true";
  };
  let youtubePrivacy: string = "PUBLIC";
  const cfgPrivacy = cfg["youtube_privacy"];
  const selPrivacy = selAny?.["privacy"];
  if (typeof cfgPrivacy === "string" && ["PUBLIC","UNLISTED","PRIVATE"].includes(String(cfgPrivacy).toUpperCase())) {
    youtubePrivacy = String(cfgPrivacy).toUpperCase();
  } else if (typeof selPrivacy === "string" && ["PUBLIC","UNLISTED","PRIVATE"].includes(String(selPrivacy).toUpperCase())) {
    youtubePrivacy = String(selPrivacy).toUpperCase();
  } else {
    const rawYtOpt = selAny?.["youtube_options"];
    if (rawYtOpt != null) {
      try {
        const parsed = typeof rawYtOpt === "string" ? JSON.parse(rawYtOpt as string) as Record<string, unknown> : rawYtOpt as Record<string, unknown>;
        if (typeof parsed.privacy === "string" && ["PUBLIC","UNLISTED","PRIVATE"].includes(String(parsed.privacy).toUpperCase())) {
          youtubePrivacy = String(parsed.privacy).toUpperCase();
        }
      } catch {}
    }
  }
  let madeForKids: boolean | null = null;
  if (cfg["youtube_made_for_kids"] !== undefined) madeForKids = toStrictBool(cfg["youtube_made_for_kids"]);
  else if (selAny?.["made_for_kids"] !== undefined) madeForKids = toStrictBool(selAny?.["made_for_kids"]);
  else {
    const rawYtOpt = selAny?.["youtube_options"];
    if (rawYtOpt != null) {
      try {
        const parsed = typeof rawYtOpt === "string" ? JSON.parse(rawYtOpt as string) as Record<string, unknown> : rawYtOpt as Record<string, unknown>;
        if (parsed.made_for_kids !== undefined) madeForKids = toStrictBool(parsed.made_for_kids);
      } catch {}
    }
  }
  let monetizeWithAds: boolean | null = null;
  if (cfg["youtube_monetize_with_ads"] !== undefined) monetizeWithAds = toStrictBool(cfg["youtube_monetize_with_ads"]);
  else if (selAny?.["monetize_with_ads"] !== undefined) monetizeWithAds = toStrictBool(selAny?.["monetize_with_ads"]);
  else {
    const rawYtOpt = selAny?.["youtube_options"];
    if (rawYtOpt != null) {
      try {
        const parsed = typeof rawYtOpt === "string" ? JSON.parse(rawYtOpt as string) as Record<string, unknown> : rawYtOpt as Record<string, unknown>;
        if (parsed.monetize_with_ads !== undefined) monetizeWithAds = toStrictBool(parsed.monetize_with_ads);
      } catch {}
    }
  }
  const descriptionVal = (typeof cfg["youtube_description"] === "string" ? String(cfg["youtube_description"]) : (opts.caption || "")) as string;
  const categoryIdRaw = cfg["youtube_category_id"];
  const categoryId = categoryIdRaw !== undefined ? Number(categoryIdRaw) : undefined;
  const pinnedRaw = cfg["youtube_pinned_comment_text"] ?? selAny?.["pinned_comment_text"];

  const ytObj: Record<string, unknown> = {
    title: titleCandidate.slice(0, 100),
    privacy: youtubePrivacy,
    ...(madeForKids !== null ? { made_for_kids: madeForKids } : {}),
    ...(monetizeWithAds !== null ? { monetize_with_ads: monetizeWithAds } : {}),
  };
  if (descriptionVal) ytObj.description = String(descriptionVal).slice(0, 5000);
  if (categoryId !== undefined && Number.isInteger(categoryId)) ytObj.category_id = categoryId;
  if (typeof pinnedRaw === "string" && (pinnedRaw as string).trim()) ytObj.pinned_comment_text = (pinnedRaw as string).trim().slice(0, 10000);
  return JSON.stringify(ytObj);
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
    } catch {}
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
      } catch {}
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
        newYoutubeOptions = await buildYoutubeOptionsForPropagation({
          prisma: prismaClient as PrismaLike,
          planner: { user_id: planner.user_id },
          config: newConfig,
          caption: newCaption,
          selectedContent,
        });
      } catch {}
    } else if (isYtChannel && ytType === "community") {
      // Comunidade não tem youtube_options (usa caption); não mexe
      newYoutubeOptions = undefined;
    }

    // Monta payload de update: sempre atualiza caption; youtube_options só se Short
    const data: Record<string, unknown> = { caption: newCaption };
    if (newYoutubeOptions !== undefined) data.youtube_options = newYoutubeOptions;

    try {
      await prismaClient.post.update({
        where: { id: postId },
        data,
      } as unknown);
      updated++;
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
    } catch {}
  }

  return { updated, total: posts.length };
}

export async function resolvePlannerRuntime(
	prisma: PrismaLike,
	planner: PlannerLike | null,
	now = new Date(),
) {
	const config = parsePlannerConfig(planner?.config);
	const contentList: PlannerContentItem[] = Array.isArray(config.content)
		? (config.content as PlannerContentItem[])
		: [];
	const sortOrder = String(config.sort_order || "random_loop");
	const state = parsePlannerState(planner?.state);
	const { selectedIndex, nextState } = selectContentIndex(
		contentList,
		sortOrder,
		state,
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
	const channelName =
		firstChannel && typeof firstChannel.name === "string"
			? firstChannel.name
			: "";
	const templateVars = await resolveCaptionTemplateVars(
		prisma,
		selectedContent,
		{ user_id: planner.user_id },
		config,
		channelName,
		now,
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
 *   3. resolve o runtime ANTES do claim (um tick não é consumido por erro de
 *      resolução — item deletado/planner bloqueado não avança o state)
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
	const runtime = await resolvePlannerRuntime(prisma, planner, now);
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
		prisma.planner.updateMany({
			where: { id: planner.id, last_run: expectedLastRun },
			data: { state: JSON.stringify(nextState) },
		}) as unknown as Prisma.PrismaPromise<unknown>,
	);

	try {
		// BK-06: sempre transacionado; fallback tambem usa transaction
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
			...(blocked > 0 ? [`${blocked} channel(s) blocked`] : []),
		],
	};
}
