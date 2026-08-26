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
	validatePlannerConfig,
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
	share_to_feed?: boolean;
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

type PlannerConfig = Record<string, any>;

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
	state: Record<string, any> | undefined,
): Record<string, any> {
	return state ? JSON.parse(JSON.stringify(state)) : {};
}

function selectContentIndex(
	contentList: PlannerContentItem[],
	sortOrder: string,
	state: Record<string, any>,
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
	config: Record<string, any>,
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
async function applyCaptionTemplate(opts: {
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
	// cadeia de fallbacks (título do item → title_fallback → caption resolvida).
	let youtubeOptions: string | null = null;
	if (ytTypeForPost === "short") {
		const selected = runtime.selectedContent as PlannerContentItem | null | undefined;
		const titleCandidate = [
			selected?.title || "",
			selected?.title_fallback || "",
			caption || "",
		]
			.map((t) => t.trim())
			.find(Boolean);
		if (titleCandidate) {
			youtubeOptions = JSON.stringify({ title: titleCandidate.slice(0, 100) });
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

export async function resolvePlannerRuntime(
	prisma: PrismaLike,
	planner: any,
	now = new Date(),
) {
	const config = parsePlannerConfig(planner.config);
	const contentList: PlannerContentItem[] = Array.isArray(config.content)
		? config.content
		: [];
	const sortOrder = config.sort_order || "random_loop";
	const state = parsePlannerState(planner.state);
	const { selectedIndex, nextState } = selectContentIndex(
		contentList,
		sortOrder,
		state,
	);
	const selectedContent = contentList[selectedIndex];

	const warnings: string[] = [];

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
	const shareToFeed = selectedContent.share_to_feed !== false;
	let thumbnailUrl = selectedContent.thumbnail_url || null;
	let children: { url: string; type: string; thumbnail_url?: string }[] =
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
					.map((c: any) => {
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
	planner: any,
	now = new Date(),
	opts?: { force?: boolean },
): Promise<{
	ok: boolean;
	created?: number;
	skipped?: string;
	error?: string;
	warnings?: string[];
}> {
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
		(channel: any) => describeChannelHealth(channel, now).ok,
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

	const ops: any[] = postDatas.map((d) => prisma.post.create({ data: d }));
	ops.push(
		prisma.planner.update({
			where: { id: planner.id },
			data: { state: JSON.stringify(nextState) },
		}),
	);

	try {
		if (typeof prisma.$transaction === "function") {
			await prisma.$transaction(ops);
		} else {
			await Promise.all(ops);
		}
	} catch (err: any) {
		// A criação falhou depois do claim: reverta o claim para não "comer" o
		// próximo tick e não perder o due (posts parciais não são criados).
		await prisma.planner
			.update({
				where: { id: planner.id },
				data: { last_run: planner.last_run },
			})
			.catch(() => {});
		return { ok: false, error: err.message || "Post creation failed" };
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
