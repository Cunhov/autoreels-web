import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { lstat, readFile } from "fs/promises";
import { extname, resolve, sep } from "path";
import { prisma } from "@/lib/prisma";
import {
	fetchWithTimeout,
	getGraphBaseUrl,
	GRAPH_API_VERSION,
	refreshInstagramToken,
	resolveAccessToken,
	classifyTokenRefreshError,
} from "@/lib/instagram";
import { runPlannerOnce } from "@/lib/planner-runtime";
import { resolveShortProductsRouting } from "@/lib/planner-config";
import { sendNotification } from "@/lib/notify";
import { normalizeCarouselChild } from "@/lib/carousel-normalize";
import {
	adaptImageToSquareWithBlur,
	type AdaptOutput,
} from "@/lib/youtube-community-image";
import {
	YoutubeApiError,
	createAutoShort,
	createCommunityPostText,
	createShort,
	getSession,
	getYoutubeSessionId,
	uploadCommunityPost,
	type YoutubePostResponse,
	type YoutubeShortOptions,
} from "@/lib/youtube";
import { isHostAllowed } from "@/lib/ssrf-guard";
import { getChannelProxyUrl } from "@/lib/proxy";
import {
  createTiktokVideoInit,
  uploadTiktokChunks,
  fetchTiktokPublishStatus,
  getValidTiktokAccessToken,
  mapTiktokErrorToPortuguese,
  classifyTiktokError,
  TiktokApiError,
} from "@/lib/tiktok";
import { resolveFinalCaption } from "@/lib/planner-runtime";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the public base URL used to build absolute media URLs sent to the
 * Instagram Graph API. The IG API must be able to download the media from this
 * URL, so it CANNOT be a Docker-internal hostname (e.g. http://app:3000).
 *
 * Priority:
 *   1. PUBLIC_BASE_URL  (explicit, recommended — e.g. https://autoreels.example.com)
 *   2. NEXTAUTH_URL     (fallback — used as-is, even if it looks local, but warns)
 *   3. ''               (relative URLs + error log — the IG API will reject them,
 *                       but the cron run itself does not crash)
 */
function resolveSystemBaseUrl(): string {
	const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
	if (publicBaseUrl) {
		if (publicBaseUrl.includes("localhost") || publicBaseUrl.includes("app:")) {
			console.warn(
				`[Cron] PUBLIC_BASE_URL looks internal (${publicBaseUrl}). ` +
					"The Instagram API must be able to reach this URL to download media.",
			);
		}
		return publicBaseUrl;
	}

	const envUrl = (process.env.NEXTAUTH_URL || "").replace(/\/$/, "");
	if (envUrl) {
		if (envUrl.includes("localhost") || envUrl.includes("app:")) {
			console.warn(
				`[Cron] NEXTAUTH_URL is "${envUrl}" — the Instagram API will not be able to reach media URLs. ` +
					"Set PUBLIC_BASE_URL to the public domain (e.g. https://your-domain.com).",
			);
		}
		return envUrl;
	}

	console.error(
		"[Cron] Neither PUBLIC_BASE_URL nor NEXTAUTH_URL is set — media URLs will be relative and " +
			"the Instagram API cannot download them. Set PUBLIC_BASE_URL to the public domain.",
	);
	return "";
}

function makeAbsoluteUrl(
	baseOut: string,
	path: string | null | undefined,
): string {
	if (!path) return "";
	if (path.startsWith("http")) return path;
	const cleanPath = path.startsWith("/") ? path : `/${path}`;
	return `${baseOut}${cleanPath}`;
}

/** JSON.parse with a fallback — never throws on malformed stored data. */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** Error marker for malformed persisted data (children_urls, instagram_child_ids...). */
class MalformedDataError extends Error {}

/** Posts that exhaust transient retries are failed instead of retried forever. */
const MAX_TRANSIENT_ATTEMPTS = 5;
const MAX_TRANSIENT_AGE_MS = 48 * 60 * 60 * 1000;

function isPostTooOld(post: { created_at?: Date | null }, now: Date): boolean {
	const created = post.created_at?.getTime() || 0;
	return created > 0 && now.getTime() - created > MAX_TRANSIENT_AGE_MS;
}

/**
 * Classify an error as:
 *   - 'definitive'    → permanent (4xx IG validation/OAuth, missing credentials, malformed data) → fail the post now
 *   - 'transient'     → temporary (network, timeouts, 5xx, non-JSON body) → keep status, retry next tick
 *   - 'rate-limited'  → 429 → keep status, retry next tick, and stop the current batch
 */
function classifyError(
	e: unknown,
	lastStatus: number,
): "definitive" | "transient" | "rate-limited" {
	if (e instanceof MalformedDataError) return "definitive";
	if (e instanceof Error && e.name === "AbortError") return "transient";

	const igStatus = (e as { igStatus?: number })?.igStatus;
	const status = igStatus || lastStatus || 0;
	if (status === 429) return "rate-limited";
	if (status >= 500) return "transient";
	if (status >= 400 && status < 500) return "definitive";

	// res.json() throwing on a non-JSON body (proxy error page, HTML) is transient
	if (e instanceof SyntaxError) return "transient";

	const msg = e instanceof Error ? e.message : String(e || "");
	// Config ausente (ex.: getYoutubeConfig lança "YOUTUBE_API_KEY não
	// configurada") é permanente: sem isso posts YT viram transient, ocupam o
	// lote do cron a cada tick e starving publicações válidas.
	if (
		/YOUTUBE_API_KEY|YOUTUBE_API_BASE_URL|não configurada|missing credentials/i.test(
			msg,
		)
	)
		return "definitive";
	if (/carousel has no media items/i.test(msg)) return "definitive";

	// Unknown/network errors: retry rather than burn the post
	return "transient";
}

/** Build an Error that carries the HTTP status of the IG API response. */
function withIgStatus(
	message: string,
	status: number,
): Error & { igStatus: number } {
	const e = new Error(message) as Error & { igStatus: number };
	e.igStatus = status;
	return e;
}

// ─── Carousel child-id store (index-aware, backward compatible) ─────────────
//
// instagram_child_ids is a JSON array of child container ids. Legacy rows (the
// pre-2026 all-or-nothing code) are a plain positional array of id strings: the
// array index is the child index. New writes use index-aware entries so a
// PARTIAL set (some children created, some failed) keeps its gaps reconcileable
// — child 0 and 2 can exist while child 1 is still missing, and the retry only
// ever creates the missing one. Reads accept both encodings.

/** Parse the stored child-id JSON into an index → id map (throws on bad shape). */
function parseChildIdEntries(
	raw: string | null | undefined,
): Map<number, string> {
	const entries = new Map<number, string>();
	if (!raw) return entries;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new MalformedDataError("Malformed instagram_child_ids");
	}
	if (!Array.isArray(parsed))
		throw new MalformedDataError("Malformed instagram_child_ids");

	const firstItem = parsed[0];
	const indexAware =
		firstItem !== null &&
		typeof firstItem === "object" &&
		typeof (firstItem as { index?: unknown }).index === "number" &&
		typeof (firstItem as { id?: unknown }).id === "string";

	if (indexAware) {
		// { index, id } entries written by the current code (gaps are allowed).
		for (const item of parsed) {
			const entry = item as { index?: unknown; id?: unknown } | null;
			if (
				!entry ||
				typeof entry !== "object" ||
				typeof entry.index !== "number" ||
				typeof entry.id !== "string"
			) {
				throw new MalformedDataError("Malformed instagram_child_ids");
			}
			entries.set(entry.index, entry.id);
		}
	} else {
		// Legacy positional string array: array index i → child i's id.
		for (let i = 0; i < parsed.length; i++) {
			if (typeof parsed[i] !== "string")
				throw new MalformedDataError("Malformed instagram_child_ids");
			entries.set(i, parsed[i] as string);
		}
	}
	return entries;
}

/** Serialize the index → id map as index-aware entries (stable, sorted). */
function serializeChildIdEntries(entries: Map<number, string>): string {
	return JSON.stringify(
		[...entries.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([index, id]) => ({ index, id })),
	);
}

/** Child ids in child-index order (the order the carousel API expects). */
function sortedChildIds(entries: Map<number, string>): string[] {
	return [...entries.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
}

/** Build the request body for one carousel child container (shared by both phases). */
function buildCarouselChildParams(opts: {
	child: { url: string; type: string };
	idx: number;
	mediaUrlAbsolute: string;
	accessToken: string;
	postUserTags?: string | null;
}): URLSearchParams {
	const params = new URLSearchParams();
	params.set("is_carousel_item", "true");
	params.set("access_token", opts.accessToken);
	params.set(
		opts.child.type === "video" ? "video_url" : "image_url",
		opts.mediaUrlAbsolute,
	);
	if (opts.child.type === "video") params.append("media_type", "VIDEO");
	if (opts.idx === 0 && opts.child.type !== "video" && opts.postUserTags) {
		const usernames = opts.postUserTags
			.split(",")
			.map((u: string) => u.trim())
			.filter(Boolean);
		if (usernames.length > 0) {
			const tagsJson = usernames.map((username: string) => ({
				username,
				x: 0.5,
				y: 0.5,
			}));
			params.append("user_tags", JSON.stringify(tagsJson));
		}
	}
	return params;
}

/** Fire a failure notification for a post (Telegram/webhook via AppConfig). Never throws. */
async function notifyPostFailed(
	post: { caption?: string | null; channel?: { name?: string | null } | null },
	errMsg: string,
): Promise<void> {
	const caption = (post.caption || "No caption")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60);
	const channel = post.channel?.name || "canal desconhecido";
	await sendNotification(
		`❌ Publicação falhou (${channel}): ${caption} — ${errMsg.slice(0, 200)}`,
	);
}

// ─── Race guard cancelamento×publisher (M13) ────────────────────────────────
//
// Implementação em lib/publisher-race-guard.ts (extraída para teste): status
// NÃO-terminais em que o publisher pode gravar o desfecho de um post; um post
// `cancelled` (bug-remove) ou já `published`/`failed` NÃO pode ser sobrescrito
// por uma escrita final atrasada. `scheduled` fica fora: posts scheduled nunca
// chegam às lanes (só entram via claim pending→processing).
// F5/M13: finalizePostWrite e isPostStillInFlight vêm do lib (extraído para
// teste); PUBLISHABLE_IN_FLIGHT_STATUSES é usado internamente pelo lib.
import {
	finalizePostWrite,
	isPostStillInFlight,
} from "@/lib/publisher-race-guard";

/** Minimal shape of a Post that flows through retry/throttle helpers. */
interface RetryablePost {
	id: string;
	caption?: string | null;
	attempts?: number;
	created_at?: Date | null;
	channel?: {
		id?: string;
		name?: string | null;
		settings?: string | null;
	} | null;
}

/** Minimal shape of the counters the retry helper updates. */
interface PublishResults {
	errors: number;
	published: number;
	transient: number;
	rate_limited: number;
	throttled: number;
}

/**
 * Record a retryable failure: bump attempts/last_attempt_at and either keep the
 * post in a retryable status or fail it once retries are exhausted
 * (MAX_TRANSIENT_ATTEMPTS attempts or MAX_TRANSIENT_AGE_MS since creation).
 */
async function handleRetryableFailure(opts: {
	post: RetryablePost;
	errMsg: string;
	revertToStatus?: string | null; // null/undefined = keep the current status
	countAs?: "transient" | "rate_limited";
	plannerId: string;
	now: Date;
	results: PublishResults;
}): Promise<void> {
	const {
		post,
		errMsg,
		revertToStatus,
		countAs = "transient",
		plannerId,
		now,
		results,
	} = opts;
	const attemptNumber = (post.attempts || 0) + 1;
	const tooLong =
		attemptNumber >= MAX_TRANSIENT_ATTEMPTS || isPostTooOld(post, now);

	const data: Prisma.PostUncheckedUpdateInput = {
		attempts: { increment: 1 },
		last_attempt_at: now,
	};
	if (tooLong) {
		data.status = "failed";
		data.error_message = errMsg;
		data.failed_reason = "Transient errors for too long";
	} else if (revertToStatus) {
		data.status = revertToStatus;
	}

	// M13: escrita de retry/falha com guard de status — um post cancelado no
	// meio do pipeline não pode ser revertido para `pending` (= ressuscitado)
	// nem sobrescrito para `failed`. Quando bloqueado, pula todo o bookkeeping
	// (contadores/log/notificação): cancelamento é decisão deliberada do usuário.
	const wrote = await finalizePostWrite(post.id, opts.plannerId, "Retry", data);
	if (!wrote) {
		await logPlanner(
			opts.plannerId,
			`Post ${post.id}: cancelado durante o processamento — tentativa final ignorada (estado terminal preservado)`,
			"warning",
		).catch(() => {});
		return;
	}

	if (tooLong) {
		results.errors++;
		await logPlanner(
			plannerId,
			`Post ${post.id} failed after ${attemptNumber} transient attempts: ${errMsg}`,
			"error",
		);
		await notifyPostFailed(post, errMsg);
	} else {
		results[countAs]++;
		await logPlanner(
			plannerId,
			`Post ${post.id} ${countAs === "rate_limited" ? "rate limited (429)" : "transient error"}: ${errMsg} — retrying later (attempt ${attemptNumber})`,
			"error",
		);
	}
}

// ─── Publish throttle (per channel + global) ───────────────────────────────────

/** Global minimum interval between publishes, from AppConfig (seconds → ms). 0 = off. */
async function getGlobalPublishIntervalMs(): Promise<number> {
	try {
		const row = await prisma.appConfig.findUnique({
			where: { key: "PUBLISH_MIN_INTERVAL_SECONDS" },
		});
		const secs = Number(row?.value || 0);
		return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
	} catch {
		return 0;
	}
}

/** Per-channel interval from Channel.settings.max_posts_per_hour (ms). 0 = off. */
async function getChannelIntervalMs(
	channel: { settings?: string | null } | null | undefined,
): Promise<number> {
	const settings = safeJsonParse<{ max_posts_per_hour?: number } | null>(
		channel?.settings,
		null,
	);
	const perHour = Number(settings?.max_posts_per_hour);
	if (Number.isFinite(perHour) && perHour > 0)
		return Math.round(3_600_000 / perHour);
	return 0;
}

/** True when the channel published within the last `minIntervalMs` ms. BK-03: inclui processing no burst. */
async function isChannelThrottled(
	channel: { id?: string } | null | undefined,
	now: Date,
	minIntervalMs: number,
): Promise<boolean> {
	if (minIntervalMs <= 0 || !channel?.id) return false;
	const lastPublished = await prisma.post.findFirst({
		where: {
			channel_id: channel.id,
			status: "published",
			published_at: { not: null },
		},
		orderBy: { published_at: "desc" },
		select: { published_at: true },
	});
	if (
		lastPublished?.published_at &&
		now.getTime() - lastPublished.published_at.getTime() < minIntervalMs
	)
		return true;
	// BK-03: burst inclui posts EM VOÔ (processing_*) dentro da janela — já contam
	// no intervalo mesmo sem published_at. ready_to_publish NÃO entra aqui: posts
	// enfileirados ainda não publicados não podem travar o próprio canal (senão
	// nenhum post da fila sai — regressão P7); o throttling pós-publicação é
	// coberto pelo check de lastPublished acima.
	const recentProcessing = await prisma.post.count({
		where: {
			channel_id: channel.id,
			status: {
				in: [
					"processing",
					"processing_upload",
					"processing_children",
				],
			},
			created_at: { gte: new Date(now.getTime() - minIntervalMs) },
		},
	});
	if (recentProcessing > 0) return true;
	// also consider last published fallback if no published found
	if (!lastPublished?.published_at) return false;
	return now.getTime() - lastPublished.published_at.getTime() < minIntervalMs;
}

/** Insert a planner log entry. */
async function logPlanner(
	plannerId: string,
	message: string,
	level: "info" | "error" | "warning" = "info",
	details: unknown = {},
) {
	if (!plannerId || plannerId === "unknown") return;
	console.log(
		`[PlannerLog][${level.toUpperCase()}] ${plannerId}: ${message}`,
		details,
	);
	try {
		await prisma.plannerLog.create({
			data: {
				planner_id: plannerId,
				message,
				level,
				details: JSON.stringify(details),
			},
		});
	} catch {
		/* Don't crash on log failures */
	}
}

/**
 * Log de rotina com throttle (ex.: 'start_time not reached', 'Sleep schedule
 * active') — evita ~1440 linhas/dia/planner. Loga no máximo 1x a cada TTL.
 */
const lastThrottledLogAt = new Map<string, number>();
const LOG_THROTTLE_MS = 30 * 60 * 1000; // 30 min

async function throttledLog(
	plannerId: string,
	message: string,
	level: "info" | "error" | "warning" = "info",
	details: unknown = {},
) {
	const key = `${plannerId}:${message}`;
	const last = lastThrottledLogAt.get(key) || 0;
	if (Date.now() - last < LOG_THROTTLE_MS) return;
	lastThrottledLogAt.set(key, Date.now());
	await logPlanner(plannerId, message, level, details);
}

async function refreshDueChannelTokens(
	now: Date,
	startTime: number,
	maxExecMs: number,
) {
	const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const fourteenDaysFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

	const channels = await prisma.channel.findMany({
		where: {
			platform: "instagram",
			status: "active",
			access_token: { not: null },
			NOT: { access_token: { startsWith: "token_" } },
			OR: [
				{ token_refreshed_at: null },
				{ token_refreshed_at: { lte: sevenDaysAgo } },
				{ token_expires_at: { lte: fourteenDaysFromNow } },
			],
		},
		take: 10,
	});

	let refreshed = 0;
	for (const channel of channels) {
		// Respect the execution budget even inside the refresh loop
		if (Date.now() - startTime > maxExecMs) break;
		try {
			const proxyForRefresh = getChannelProxyUrl(channel as any);
			const tokenData = await refreshInstagramToken(channel.access_token || "", proxyForRefresh);
			await prisma.channel.update({
				where: { id: channel.id },
				data: {
					access_token: tokenData.token,
					token_expires_at: new Date(Date.now() + tokenData.expiresIn * 1000),
					token_refreshed_at: now,
					token_source: channel.token_source || "manual",
				},
			});
			refreshed++;
		} catch (err) {
			const message =
				err instanceof Error ? err.message : String(err ?? "Unknown error");
			if (classifyTokenRefreshError(err) === "permanent") {
				// Permanent: never retry every tick. A rejected token deactivates
				// the channel (reconnect via OAuth flips status back to 'active');
				// missing server credentials only pause the refresh, the channel
				// itself is fine.
				const missingCredentials = /must be configured to refresh/i.test(message);
				await prisma.channel
					.update({
						where: { id: channel.id },
						// token_expires_at: null on ANY permanent failure — the selection
						// query ORs `token_expires_at <= now+14d`, so a channel whose token
						// is within 14 days of expiry would otherwise be re-selected EVERY
						// tick and spam [ChannelRefresh]. NULL never matches `<=`, and it
						// means 'no known expiry — needs manual reconnect'; both reconnect
						// paths (OAuth callback, manual refresh) restore it on success.
						data: missingCredentials
							? { token_refreshed_at: now, token_expires_at: null }
							: {
									status: "inactive",
									token_refreshed_at: now,
									token_expires_at: null,
								},
					})
					.catch(() => {
						/* best-effort: the log line below is the source of truth */
					});
				console.error(
					`[ChannelRefresh] ${channel.id}: ${message} — ${
						missingCredentials
							? "server credentials missing; refresh paused (fix INSTAGRAM_CLIENT_ID/SECRET)"
							: "access token rejected; channel deactivated (reconnect it)"
					}`,
				);
			} else {
				// Transient (network/5xx/timeout): retry next tick.
				console.error(`[ChannelRefresh] ${channel.id}: ${message}`);
			}
		}
	}
	return refreshed;
}


// ─── TikTok ─────────────────────────────────────────────────────────────────
const TIKTOK_MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB (Media Transfer Guide)
const TIKTOK_CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB por chunk (5–10 MB spec)
const TIKTOK_POLL_ATTEMPTS = 3;
const TIKTOK_POLL_BACKOFF_MS = 2000;
const TIKTOK_PULL_DOMAIN = "autoreels.cunhov.site";

interface TiktokPublishPost {
  id: string;
  caption?: string | null;
  video_url?: string | null;
  image_url?: string | null;
  children_urls?: string | null;
  tiktok_type?: string | null;
  tiktok_options?: string | null;
  tiktok_publish_id?: string | null;
  attempts?: number;
  created_at?: Date | null;
  channel?: {
    id?: string;
    name?: string | null;
    settings?: string | null;
    platform?: string | null;
    proxy_url?: string | null;
    proxy_enabled?: boolean | null;
  } | null;
}

function isTiktokPULLFromUrl(mediaUrlAbsolute: string): boolean {
  if (!mediaUrlAbsolute) return false;
  // Usa domínio verificado do spec: https://autoreels.cunhov.site/api/file/...
  return mediaUrlAbsolute.includes(`${TIKTOK_PULL_DOMAIN}/api/file/`);
}

async function publishTiktokPost(opts: {
  post: TiktokPublishPost;
  plannerId: string;
  now: Date;
  results: PublishResults;
  startTime: number;
  maxExecMs: number;
}): Promise<void> {
  const { post, plannerId, now, results, startTime, maxExecMs } = opts;

  // Guard tiktok_type: só video em v1; photo -> MalformedDataError
  if (post.tiktok_type && post.tiktok_type !== "video") {
    const msg = `TikTok v1: apenas vídeo suportado (recebido: ${post.tiktok_type})`;
    const wrote = await finalizePostWrite(post.id, plannerId, "Tiktok", {
      status: "failed",
      error_message: msg,
      failed_reason: "Malformed Data",
    });
    if (!wrote) return;
    results.errors++;
    await logPlanner(plannerId, `Post ${post.id}: ${msg}`, "error");
    await notifyPostFailed(post as RetryablePost, msg);
    return;
  }

  // Parse tiktok_options JSON
  let tiktokOptions: {
    title?: string;
    privacy_level?: string;
    disable_duet?: boolean;
    disable_stitch?: boolean;
    disable_comment?: boolean;
    video_cover_timestamp_ms?: number;
    brand_content_toggle?: boolean;
    brand_organic_toggle?: boolean;
  } = {};
  if (post.tiktok_options) {
    try {
      tiktokOptions = JSON.parse(post.tiktok_options) as typeof tiktokOptions;
    } catch {
      const msg = "Malformed tiktok_options";
      const wrote = await finalizePostWrite(post.id, plannerId, "Tiktok", {
        status: "failed",
        error_message: msg,
        failed_reason: "Malformed Data",
      });
      if (!wrote) return;
      results.errors++;
      await logPlanner(plannerId, `Post ${post.id}: ${msg}`, "error");
      await notifyPostFailed(post as RetryablePost, msg);
      return;
    }
  }

  // Resolve caption via resolveFinalCaption('tiktok', item) (import de lib/planner-runtime.ts)
  // Fallback: tiktok_options.title > post.caption
  // Tenta buscar ContentItem caption_tiktok se post tiver relação com library? Best-effort via post.caption
  let resolvedCaption = "";
  try {
    // post.caption já é final do planner (buildPostData), mas para TikTok tentamos tiktok fallback
    const itemForCaption: { caption?: string | null; caption_tiktok?: string | null } = { caption: post.caption };
    // Se tiktok_options tem título explícito, ele vence; senão usa resolveFinalCaption
    if (tiktokOptions.title && String(tiktokOptions.title).trim()) {
      resolvedCaption = String(tiktokOptions.title).trim();
    } else {
      // Se post tem caption_tiktok persistido (quando A4 completar), prioriza; senão caption
      const withTk = post as unknown as { caption_tiktok?: string | null };
      if (withTk.caption_tiktok) itemForCaption.caption_tiktok = withTk.caption_tiktok;
      resolvedCaption = resolveFinalCaption("tiktok", itemForCaption);
      if (!resolvedCaption) resolvedCaption = (post.caption || "").trim();
    }
  } catch {
    resolvedCaption = (tiktokOptions.title || post.caption || "").trim();
  }
  const title = (tiktokOptions.title?.trim() || resolvedCaption || (post.caption || "").trim()).slice(0, 2200);
  if (!title) {
    const msg = "TikTok exige título/legenda (tiktok_options.title ou caption)";
    const wrote = await finalizePostWrite(post.id, plannerId, "Tiktok", {
      status: "failed",
      error_message: msg,
      failed_reason: "Malformed Data",
    });
    if (!wrote) return;
    results.errors++;
    await logPlanner(plannerId, `Post ${post.id}: ${msg}`, "error");
    await notifyPostFailed(post as RetryablePost, msg);
    return;
  }

  // Token válido (refresh automático se expires_at < now+60s) — proxy sempre via getChannelProxyUrl
  let tokenData: { accessToken: string; openId: string };
  try {
    tokenData = await getValidTiktokAccessToken(post.channel as { id: string; settings?: string | null; proxy_url?: string | null; proxy_enabled?: boolean | null });
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e ?? "Unknown error");
    const pt = mapTiktokErrorToPortuguese(raw);
    const wrote = await finalizePostWrite(post.id, plannerId, "Tiktok", {
      status: "failed",
      error_message: pt,
      failed_reason: /Token|não configurado|reconectar/i.test(pt) ? "Missing Credentials" : "Publishing Failed",
    });
    if (!wrote) return;
    results.errors++;
    await logPlanner(plannerId, `[Tiktok] Post ${post.id}: ${pt}`, "error");
    await notifyPostFailed(post as RetryablePost, pt);
    return;
  }

  // Resolve proxy (sempre repassado)
  const proxyUrl = getChannelProxyUrl(post.channel as unknown as { proxy_url?: string | null; settings?: string | null }) ?? null;

  // Determinar mediaUrl (TikTok v1 só vídeo)
  const mediaUrl = (post.video_url || "").trim();
  if (!mediaUrl) {
    const msg = "TikTok exige vídeo (video_url ausente)";
    const wrote = await finalizePostWrite(post.id, plannerId, "Tiktok", {
      status: "failed",
      error_message: msg,
      failed_reason: "Malformed Data",
    });
    if (!wrote) return;
    results.errors++;
    await logPlanner(plannerId, `Post ${post.id}: ${msg}`, "error");
    await notifyPostFailed(post as RetryablePost, msg);
    return;
  }

  // M13: re-checa antes do call externo
  if (!(await isPostStillInFlight(post.id))) {
    await logPlanner(plannerId, `[Tiktok] Post ${post.id} cancelado antes do init — nada foi publicado`, "warning").catch(() => {});
    return;
  }

  try {
    // Determinar source_info: PULL_FROM_URL quando mediaUrl já é https://autoreels.cunhov.site/api/file/... (evita reupload); default FILE_UPLOAD
    const systemBaseUrl = resolveSystemBaseUrl();
    const mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, mediaUrl);
    const usePull = isTiktokPULLFromUrl(mediaUrlAbsolute);

    let publishId = "";
    let uploadUrl = "";

    if (usePull) {
      await logPlanner(plannerId, `[Tiktok] Init PULL_FROM_URL para ${mediaUrlAbsolute}`, "info");
      const init = await createTiktokVideoInit(
        {
          accessToken: tokenData.accessToken,
          title,
          privacyLevel: tiktokOptions.privacy_level,
          disableDuet: tiktokOptions.disable_duet,
          disableStitch: tiktokOptions.disable_stitch,
          disableComment: tiktokOptions.disable_comment,
          videoCoverTimestampMs: tiktokOptions.video_cover_timestamp_ms,
          brandContentToggle: tiktokOptions.brand_content_toggle,
          brandOrganicToggle: tiktokOptions.brand_organic_toggle,
          source: { source: "PULL_FROM_URL", video_url: mediaUrlAbsolute },
        },
        proxyUrl
      );
      publishId = init.publishId;
      uploadUrl = init.uploadUrl; // pode ser vazio em PULL
    } else {
      // FILE_UPLOAD: ler arquivo local, calcular chunks
      const file = await readLocalUploadFile(mediaUrl, TIKTOK_MAX_FILE_BYTES);
      const videoSize = file.buffer.length;
      const chunkSize = TIKTOK_CHUNK_SIZE;
      const totalChunkCount = Math.ceil(videoSize / chunkSize);
      await logPlanner(plannerId, `[Tiktok] Init FILE_UPLOAD size=${videoSize} chunk=${chunkSize} chunks=${totalChunkCount}`, "info");
      const init = await createTiktokVideoInit(
        {
          accessToken: tokenData.accessToken,
          title,
          privacyLevel: tiktokOptions.privacy_level,
          disableDuet: tiktokOptions.disable_duet,
          disableStitch: tiktokOptions.disable_stitch,
          disableComment: tiktokOptions.disable_comment,
          videoCoverTimestampMs: tiktokOptions.video_cover_timestamp_ms,
          brandContentToggle: tiktokOptions.brand_content_toggle,
          brandOrganicToggle: tiktokOptions.brand_organic_toggle,
          source: { source: "FILE_UPLOAD", video_size: videoSize, chunk_size: chunkSize, total_chunk_count: totalChunkCount },
        },
        proxyUrl
      );
      publishId = init.publishId;
      uploadUrl = init.uploadUrl;
      if (!publishId || !uploadUrl) throw new Error("TikTok não retornou publish_id/upload_url para FILE_UPLOAD");
      // M13: re-checa antes do upload chunked
      if (!(await isPostStillInFlight(post.id))) {
        await logPlanner(plannerId, `[Tiktok] Post ${post.id} cancelado antes do upload — nada foi enviado`, "warning").catch(() => {});
        return;
      }
      await logPlanner(plannerId, `[Tiktok] Upload chunks para ${publishId} (${totalChunkCount} chunks)`, "info");
      await uploadTiktokChunks(uploadUrl, file.buffer, chunkSize, proxyUrl);
    }

    // Poll status 3x backoff 2s
    let lastStatus = "";
    let published = false;
    let failedReasonPt: string | null = null;
    let videoIdOrUrl: string | null = null;
    for (let attempt = 0; attempt < TIKTOK_POLL_ATTEMPTS; attempt++) {
      // M13: re-checa antes de cada poll
      if (!(await isPostStillInFlight(post.id))) {
        await logPlanner(plannerId, `[Tiktok] Post ${post.id} cancelado durante polling — abortando`, "warning").catch(() => {});
        return;
      }
      // Backoff 2s após primeiro attempt (spec: poll status 3x backoff 2s)
      if (attempt > 0) await new Promise((r) => setTimeout(r, TIKTOK_POLL_BACKOFF_MS));
      // Verifica orçamento do tick antes de poll (evita estourar MAX_EXEC_MS)
      if (Date.now() - startTime > maxExecMs - 3000) {
        await logPlanner(plannerId, `[Tiktok] Orçamento do tick esgotado antes do poll ${attempt + 1} — retry no próximo ciclo`, "warning").catch(() => {});
        throw new Error("Orçamento do tick esgotado durante polling do TikTok — retry no próximo ciclo");
      }
      try {
        const statusRes = await fetchTiktokPublishStatus(publishId, tokenData.accessToken, proxyUrl);
        lastStatus = statusRes.status;
        const s = statusRes.status.toUpperCase();
        if (s.includes("PUBLISHED") || s.includes("SUCCESS") || s === "PUBLISH_COMPLETE" || s === "PUBLISHED_SUCCESS") {
          published = true;
          videoIdOrUrl = statusRes.videoId || statusRes.publicUrl || publishId;
          break;
        }
        if (s.includes("FAILED") || s.includes("FAIL") || s === "ERROR") {
          failedReasonPt = statusRes.failReason ? mapTiktokErrorToPortuguese(statusRes.failReason) : "Falha ao publicar no TikTok";
          break;
        }
        // PROCESSING / PUBLISHING -> continua polling
        await logPlanner(plannerId, `[Tiktok] Status poll ${attempt + 1}/${TIKTOK_POLL_ATTEMPTS}: ${s}`, "info").catch(() => {});
      } catch (e: unknown) {
        // Se falhar o fetch status com 429/5xx, tenta novamente no próximo loop (já tem backoff)
        const isLast = attempt === TIKTOK_POLL_ATTEMPTS - 1;
        if (isLast) throw e;
        await logPlanner(plannerId, `[Tiktok] Poll ${attempt + 1} falhou (tentando novamente): ${e instanceof Error ? e.message : String(e)}`, "warning").catch(() => {});
      }
    }

    if (failedReasonPt) {
      const wrote = await finalizePostWrite(post.id, plannerId, "Tiktok", {
        status: "failed",
        error_message: failedReasonPt,
        failed_reason: "Publishing Failed",
        tiktok_publish_id: publishId,
      });
      if (!wrote) return;
      results.errors++;
      await logPlanner(plannerId, `[Tiktok] Post ${post.id} falhou: ${failedReasonPt} (publish_id=${publishId})`, "error");
      await notifyPostFailed(post as RetryablePost, failedReasonPt);
      return;
    }

    if (published) {
      const wrote = await finalizePostWrite(post.id, plannerId, "Tiktok", {
        status: "published",
        published_at: now,
        tiktok_post_id: videoIdOrUrl || publishId,
        tiktok_publish_id: publishId,
      });
      if (!wrote) return;
      results.published++;
      await logPlanner(plannerId, `[Tiktok] Post ${post.id} publicado (publish_id=${publishId} ${videoIdOrUrl ? `video=${videoIdOrUrl}` : ""})`, "info");
      return;
    }

    // Ainda PROCESSING após 3 polls -> deixa em pending para retry próximo tick (transient)
    throw new Error(`TikTok ainda em processamento após ${TIKTOK_POLL_ATTEMPTS} polls (último status: ${lastStatus || "UNKNOWN"})`);
  } catch (e: unknown) {
    const rawMsg = e instanceof Error ? e.message : String(e ?? "Unknown error");
    const status = e instanceof TiktokApiError ? e.status : 0;
    const kind = e instanceof Error && e.message.includes("Malformed") ? "definitive" : classifyTiktokError(e, status);
    const ptMsg = mapTiktokErrorToPortuguese(rawMsg);

    if (kind === "rate-limited") {
      await handleRetryableFailure({
        post: post as unknown as RetryablePost,
        errMsg: `Rate limited (429): ${ptMsg}`,
        revertToStatus: "pending",
        countAs: "rate_limited",
        plannerId,
        now,
        results,
      });
      return;
    }
    if (kind === "transient") {
      await handleRetryableFailure({
        post: post as unknown as RetryablePost,
        errMsg: ptMsg,
        revertToStatus: "pending",
        plannerId,
        now,
        results,
      });
      return;
    }
    // Erro definitivo
    await logPlanner(plannerId, `[Tiktok] Erro definitivo post=${post.id}: ${ptMsg}`, "error");
    const wrote = await finalizePostWrite(post.id, plannerId, "Tiktok", {
      status: "failed",
      error_message: ptMsg,
      failed_reason: e instanceof Error && /Malformed/i.test(e.message) ? "Malformed Data" : "Publishing Failed",
    });
    if (!wrote) return;
    results.errors++;
    await notifyPostFailed(post as RetryablePost, ptMsg);
  }
}


// ─── YouTube (Shorts + Comunidade) ──────────────────────────────────────

// Só trata como sessão-expirada quando o sinal é inequívoco. "expirad/expired"
// genérico NÃO entra: a API externa retorna 502 "attestation BotGuard expirada..."
// para tokens BotGuard transientes (auto-renováveis) e erros TLS falam em
// "certificate has expired" — nenhum dos dois significa cookies inválidos.
const YT_SESSION_EXPIRED_RE = /cookies may be invalid|session expired/i;

interface YoutubePublishPost {
	id: string;
	caption?: string | null;
	video_url?: string | null;
	image_url?: string | null;
	children_urls?: string | null;
	youtube_type?: string | null;
	youtube_options?: string | null;
	attempts?: number;
	created_at?: Date | null;
	channel?: {
		id?: string;
		name?: string | null;
		settings?: string | null;
		platform?: string | null;
		// M16: proxy por canal (Channel.proxy_url) — o include: {channel:true}
		// já traz a coluna; declarar aqui evita o `as any` no getChannelProxyUrl.
		proxy_url?: string | null;
	} | null;
}

/** MIME types aceitos no upload para a API externa. */
const YT_MIME_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

// Imagens de post da Comunidade vindas de URL absoluta (item da biblioteca
// importado por URL): timeout por imagem + teto de bytes para o cron não
// travar num host lento nem carregar arquivos gigantes em memória.
const COMMUNITY_REMOTE_IMAGE_TIMEOUT_MS = 30_000;
const COMMUNITY_REMOTE_IMAGE_MAX_BYTES = 30 * 1024 * 1024; // ~30 MB

// Teto do arquivo de vídeo de Short aceito pelo cron: o upload é síncrono
// (lê o vídeo em memória + transmite via multipart) DENTRO do tick do
// publisher, cujo orçamento total é MAX_EXEC_MS (~45s) e o heartbeat do
// worker é 60s. Um arquivo gigante estouraria a janela e/ou o pico de
// memória. 512 MB é folgado para um Short real (<60s); um vídeo maior é
// quase certamente um arquivo completo erroneamente roteado como Short.
const SHORT_MAX_FILE_BYTES = 512 * 1024 * 1024; // ~512 MB

/**
 * Lê um arquivo de mídia do storage local usando o MESMO mecanismo de
 * `app/api/file/[...path]/route.ts`: URLs `/api/file/<relpath>` são
 * resolvidas contra data/uploads e public/uploads.
 */
async function readLocalUploadFile(
	mediaUrl: string,
	maxBytes?: number,
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
	const relative = mediaUrl.startsWith("/api/file/")
		? mediaUrl.slice("/api/file/".length)
		: mediaUrl.replace(/^\//, "");
	if (relative.includes("..") || relative.includes("\\")) {
		throw new MalformedDataError(`Caminho de mídia inválido: ${relative}`);
	}
	// Colapsa segmento duplicado de registros antigos (admin/admin/arquivo.mp4)
	const parts = relative.split("/");
	const deduped =
		parts.length >= 2 && parts[0] === parts[1] ? parts.slice(1).join("/") : null;

	const roots = [
		resolve(process.cwd(), "data", "uploads"),
		resolve(process.cwd(), "public", "uploads"),
	];
	for (const root of roots) {
		for (const rel of [relative, ...(deduped ? [deduped] : [])]) {
			const candidate = resolve(root, rel);
			if (!candidate.startsWith(root + sep)) continue;
			try {
				const stat = await lstat(candidate); // lstat: rejeita symlinks
				if (!stat.isFile()) continue;
				// Teto de bytes (opcional): aplicado ANTES de ler o arquivo para
				// não carregar gigantes em memória. Erro definitivo, propagado —
				// NÃO tenta os outros roots (o arquivo existe; só é grande demais).
				if (maxBytes != null && stat.size > maxBytes) {
					throw new MalformedDataError(
						`Arquivo de mídia excede o limite de ${Math.round(maxBytes / 1024 / 1024)} MB: ${mediaUrl}`,
					);
				}
				const buffer = await readFile(candidate);
				const ext = extname(rel).toLowerCase();
				return {
					buffer,
					contentType: YT_MIME_TYPES[ext] || "application/octet-stream",
					filename: rel.split("/").pop() || "midia",
				};
			} catch (err) {
				if (err instanceof MalformedDataError) throw err;
				/* arquivo ausente/perm: tenta o próximo candidato */
			}
		}
	}
	throw new MalformedDataError(
		`Arquivo de mídia não encontrado no storage local: ${mediaUrl}`,
	);
}

/**
 * Vista sem cópia do Buffer para uso como BlobPart. `new Uint8Array(buffer)`
 * DUPLICARIA o pico de memória (buffer + cópia) em vídeos grandes; a view usa
 * o mesmo ArrayBuffer (readFile nunca usa SharedArrayBuffer — cast seguro).
 */
function bufferView(buf: Buffer): Uint8Array<ArrayBuffer> {
	return new Uint8Array(
		buf.buffer as ArrayBuffer,
		buf.byteOffset,
		buf.byteLength,
	);
}

async function readCommunityImage(
	mediaUrl: string,
	remainingBudgetMs?: number,
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
	// URL absoluta http(s) — conteúdo da biblioteca importado por URL/de
	// terceiros: baixa no servidor (com guarda SSRF e teto de bytes) para o
	// multipart não depender de o storage local conter o arquivo.
	if (/^https?:\/\//i.test(mediaUrl)) {
		const res = await downloadRemoteImageWithRedirectGuard(
			mediaUrl,
			remainingBudgetMs,
		);
		if (!res.ok) {
			// 5xx = servidor de origem/trânsito falhou — TRANSITENTE (retry no
			// próximo tick; o cliente pode ter recuperado). 4xx = o recurso não
			// existe mais (404) — DEFINITIVO.
			if (res.status >= 500) {
				throw new Error(
					`Falha ao baixar imagem externa (HTTP ${res.status}): ${mediaUrl}`,
				);
			}
			throw new MalformedDataError(
				`Falha ao baixar imagem externa (HTTP ${res.status}): ${mediaUrl}`,
			);
		}
		const arrayBuffer = await res.arrayBuffer();
		if (arrayBuffer.byteLength > COMMUNITY_REMOTE_IMAGE_MAX_BYTES) {
			throw new MalformedDataError(
				`Imagem externa excede o limite de ${Math.round(COMMUNITY_REMOTE_IMAGE_MAX_BYTES / 1024 / 1024)} MB: ${mediaUrl}`,
			);
		}
		const contentType =
			(res.headers.get("content-type") || "").split(";")[0].trim() ||
			"application/octet-stream";
		// Valida o conteúdo baixado: um content item com URL pública apontando
		// para HTML/não-imagem geraria falha DEFINITIVA confusa na API externa
		// (o multipart repassaria o content-type cru). Rejeita aqui com
		// MalformedDataError claro, citando a URL. octet-stream (sem tipo) é
		// tolerado — host pode servir a imagem sem content-type.
		const lowerType = contentType.toLowerCase();
		if (
			lowerType &&
			lowerType !== "application/octet-stream" &&
			!lowerType.startsWith("image/")
		) {
			throw new MalformedDataError(
				`Conteúdo baixado não é uma imagem (content-type ${contentType}): ${mediaUrl}`,
			);
		}
		const rawName = mediaUrl.split("/").pop()?.split("?")[0] || "imagem-externa";
		let filename = rawName;
		try {
			filename = decodeURIComponent(rawName);
		} catch {
			/* nome com escape inválido — mantém o valor cru */
		}
		return {
			buffer: Buffer.from(arrayBuffer),
			contentType: lowerType || "application/octet-stream",
			filename: filename || "imagem-externa",
		};
	}
	// URL local (/api/file/... ou relativa) → storage local, path atual. Aplica
	// o MESMO teto de bytes das URLs remotas: o multipart carrega até 10
	// imagens simultaneamente em memória, e sem teto um arquivo local gigante
	// entraria no pico de memória do tick sem nenhuma proteção.
	return readLocalUploadFile(mediaUrl, COMMUNITY_REMOTE_IMAGE_MAX_BYTES);
}

/**
 * Baixa uma URL de imagem remota seguindo redirecionamentos MANUALMENTE,
 * revalidando a guarda SSRF (`isHostAllowed`) em CADA salto — o host final
 * pós-redirect nunca pode divergir para loopback/privado. A guarda do host
 * original sozinha era contornável por um 302 → http://169.254.169.254/...
 * (paridade com app/api/import-url, que revalida o alvo do redirect).
 * Erros de DNS/resolver de `isHostAllowed` PROPAGAM (transientes no
 * publisher); host efetivamente privado/bloqueado → MalformedDataError.
 */
async function downloadRemoteImageWithRedirectGuard(
	mediaUrl: string,
	remainingBudgetMs?: number,
): Promise<Response> {
	const maxRedirects = 5;
	let current = mediaUrl;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		let url: URL;
		try {
			url = new URL(current);
		} catch {
			throw new MalformedDataError(
				`URL de imagem da Comunidade inválida: ${current}`,
			);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new MalformedDataError(
				`URL de imagem da Comunidade inválida: ${current}`,
			);
		}
		if (!(await isHostAllowed(url.hostname))) {
			throw new MalformedDataError(
				`Host da imagem não é publicamente acessível: ${current}`,
			);
		}
		// Timeout por requisicao: min(30s, orçamento restante do tick) — o
		// materializador em paralelo não pode estourar o budget do cron.
		const perRequestTimeout =
			remainingBudgetMs != null
				? Math.max(
						1_000,
						Math.min(COMMUNITY_REMOTE_IMAGE_TIMEOUT_MS, remainingBudgetMs),
					)
				: COMMUNITY_REMOTE_IMAGE_TIMEOUT_MS;
		const res = await fetchWithTimeout(
			current,
			{ redirect: "manual" },
			perRequestTimeout,
		);
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) {
				throw new MalformedDataError(
					`Redirecionamento sem destino ao baixar imagem: ${current}`,
				);
			}
			try {
				current = new URL(location, url).href;
			} catch {
				throw new MalformedDataError(
					`Destino de redirecionamento inválido ao baixar imagem: ${location}`,
				);
			}
			continue;
		}
		return res;
	}
	throw new MalformedDataError(
		`Muitos redirecionamentos ao baixar a imagem: ${mediaUrl}`,
	);
}

/**
 * Um erro de materialização de imagem é TRANSITENTE (retry) ou DEFINITIVO
 * (malformado)? DNS/resolver, timeout, 5xx e erros de rede genéricos são
 * transitórios; MalformedDataError (arquivo ausente, URL inválida, teto de
 * bytes, host bloqueado, 404 remoto) é definitivo.
 */
function isTransientCommunityImageError(err: unknown): boolean {
	if (err instanceof MalformedDataError) return false;
	if (err instanceof YoutubeApiError) return err.status >= 500;
	if (err instanceof Error && err.name === "AbortError") return true;
	if (err instanceof Error && /HTTP [5-9]\d\d/.test(err.message)) return true;
	return true; // rede/DNS/resolver genérico → transiente
}

/** Coleta as imagens de um post da Comunidade (vídeos são descartados com contagem). */
function collectCommunityImageUrls(post: YoutubePublishPost): {
	urls: string[];
	droppedVideos: number;
} {
	const urls: string[] = [];
	let droppedVideos = 0;
	if (post.children_urls) {
		try {
			const children = JSON.parse(post.children_urls) as {
				url?: string;
				type?: string;
			}[];
			for (const child of children) {
				if (!child?.url) continue;
				if (child.type === "video") {
					droppedVideos++;
				} else {
					urls.push(child.url);
				}
			}
		} catch {
			throw new MalformedDataError("Malformed children_urls");
		}
	}
	// Fallback legado (post sem children_urls): só quando NENHUM child foi
	// vídeo — se o carrossel continha apenas vídeos, image_url aponta para o
	// primeiro child (vídeo) e não pode virar "imagem".
	if (!urls.length && !droppedVideos && post.image_url)
		urls.push(post.image_url);
	return { urls, droppedVideos };
}

/** Publica um post YouTube (Short ou Comunidade) e persiste o resultado. */
async function publishYoutubePost(opts: {
	post: YoutubePublishPost;
	plannerId: string;
	now: Date;
	results: PublishResults;
	startTime: number;
	maxExecMs: number;
}): Promise<void> {
	const { post, plannerId, now, results, startTime, maxExecMs } = opts;

	const sessionId = getYoutubeSessionId(post.channel?.settings);
	if (!sessionId) {
		// M13: escrita final com guard de status — post cancelado durante o
		// processamento não pode ser sobrescrito para "failed".
		const wrote = await finalizePostWrite(post.id, plannerId, "YouTube", {
			status: "failed",
			error_message:
				"Canal YouTube sem sessão vinculada — reconecte em Canais",
			failed_reason: "Missing Credentials",
		});
		if (!wrote) return;
		results.errors++;
		await logPlanner(
			plannerId,
			`Post ${post.id}: canal YouTube sem sessão vinculada`,
			"error",
		);
		await notifyPostFailed(post, "Canal YouTube sem sessão vinculada");
		return;
	}

	try {
		const isCommunityPost =
			post.youtube_type === "community" ||
			(!post.youtube_type &&
				!post.video_url &&
				!!(post.image_url || post.children_urls));
		if (isCommunityPost) {
			const message = (post.caption || "").trim();
			if (!message) throw new MalformedDataError("Post na Comunidade exige texto");
			const { urls: rawImageUrls, droppedVideos } =
				collectCommunityImageUrls(post);
			const imageUrls = [...rawImageUrls];
			if (droppedVideos > 0) {
				await logPlanner(
					plannerId,
					`[YouTube] Post na Comunidade contém ${droppedVideos} vídeo(s) — a Comunidade do YouTube não suporta vídeos; descartados (publicando apenas imagens)`,
					"warning",
				).catch(() => {});
			}
			// A API externa aceita no máximo 10 imagens — trunca com aviso no log
			// do planner em vez de descartar silenciosamente.
			if (imageUrls.length > 10) {
				await logPlanner(
					plannerId,
					`[YouTube] Post na Comunidade tem ${imageUrls.length} imagens; publicando apenas as 10 primeiras`,
					"warning",
				).catch(() => {});
				imageUrls.length = 10;
			}
			// Carrossel roteado para a Comunidade contendo APENAS vídeos: sem
			// imagens sobraria um post só de texto descartando TODA a mídia —
			// falha definitiva com mensagem clara em vez de descarte silencioso.
			// O backend de criação (POST /api/posts) e o wizard já bloqueiam
			// este estado na origem; o publisher é a última barreira (o post
			// pode ter sido criado antes da validação ou via API de terceiros).
			if (imageUrls.length === 0 && droppedVideos > 0) {
				throw new MalformedDataError(
					"Post na Comunidade do YouTube não suporta vídeos — o conteúdo selecionado contém apenas vídeos",
				);
			}
			// Sem imagens → post SÓ de texto via POST /api/post (JSON), que a API
			// externa aceita; com imagens mantém o multipart (/api/post/upload).
			let created: YoutubePostResponse;
			if (imageUrls.length === 0) {
				await logPlanner(
					plannerId,
					`[YouTube] Publicando post na Comunidade (apenas texto) do canal ${post.channel?.name || post.id}`,
					"info",
				);
				// M13: re-checa o status antes do call externo — o usuário pode ter
				// cancelado o post enquanto as imagens eram materializadas.
				if (!(await isPostStillInFlight(post.id))) {
					await logPlanner(
						plannerId,
						`[YouTube] Post ${post.id} cancelado antes do call externo — nada foi publicado`,
						"warning",
					).catch(() => {});
					return;
				}
				const ytProxy = getChannelProxyUrl(post.channel as any);
				created = await createCommunityPostText({ sessionId, message, proxyUrl: ytProxy });
			} else {
				// Materializa as imagens EM PARALELO (Promise.allSettled) com
				// deadline global do tick: o loop sequencial antigo baixava até 10
				// imagens × 30s — ~5 min contra um orçamento de MAX_EXEC_MS (~45s)
				// e heartbeat do worker de 60s, matando o resto do lote (inclusive
				// IG) ou sendo morto no meio de um upload. Agora o tempo por
				// imagem é limitado a min(30s, orçamento restante) e a falha é
				// DEGRADADA: uma mídia ruim não derruba o post inteiro — só falha
				// quando NENHUMA imagem materializa.
				const images: { buffer: Buffer; contentType: string; filename: string }[] =
					[];
				const failures: { url: string; error: unknown }[] = [];
				// Margem reservada para o upload multipart + persistência no banco.
				const materializeDeadline = startTime + maxExecMs - 15_000;
				if (Date.now() > materializeDeadline) {
					// Já estourou antes de começar: não vale a pena iniciar — reverte
					// para pending (transiente) e o próximo tick publica.
					throw new Error(
						"Orçamento do tick esgotado antes de materializar as imagens da Comunidade — retry no próximo ciclo",
					);
				}
				const settled = await Promise.allSettled(
					imageUrls.map((url) =>
						readCommunityImage(url, materializeDeadline - Date.now()),
					),
				);
				settled.forEach((result, idx) => {
					if (result.status === "fulfilled") {
						images.push(result.value);
					} else {
						failures.push({ url: imageUrls[idx], error: result.reason });
					}
				});
				if (failures.length > 0) {
					const detail = failures
						.map(
							(f) =>
								`${f.url}: ${f.error instanceof Error ? f.error.message : String(f.error)}`,
						)
						.join("; ");
					await logPlanner(
						plannerId,
						`[YouTube] ${failures.length === 1 ? "1 imagem" : `${failures.length} imagens`} da Comunidade não materializaram (publicando as demais): ${detail}`,
						"warning",
					).catch(() => {});
				}
				if (images.length === 0) {
					// Nenhuma imagem materializou. Se TODAS as falhas forem
					// definitivas (arquivo ausente, URL inválida, teto de bytes,
					// host bloqueado, 404 remoto) → malformado, sem retry. Se
					// houver falha TRANSITENTE (DNS/resolver em pane, timeout,
					// 5xx do host de origem) → retry no próximo tick, citando a
					// imagem exata.
					const allDefinitive = failures.every(
						(f) => !isTransientCommunityImageError(f.error),
					);
					const detail = failures
						.map(
							(f) =>
								`[${f.url}] ${f.error instanceof Error ? f.error.message : String(f.error)}`,
						)
						.join("; ");
					if (allDefinitive) {
						throw new MalformedDataError(
							`Nenhuma imagem do post na Comunidade pôde ser lida: ${detail}`,
						);
					}
					throw new Error(
						`Falha transitória ao materializar as imagens do post na Comunidade: ${detail}`,
					);
				}
				// Adaptação automática para 1:1 com blur (somente Comunidade).
				// Toda imagem não-quadrada vira 1080x1080 com fundo em blur da própria imagem.
				// Best-effort com observabilidade: falha loga warning e mantém original; 1:1 já quadrada não é tocada.
				// Paralelizada + checagem de deadline por imagem para não estourar MAX_EXEC_MS.
				// Sem duplicar arquivo no storage, sem cache em disco — só em memória para o upload.
				let adaptedImages: AdaptOutput[] = [];
				try {
					// Concorrência limitada a 3 para evitar pico de memória com 10 imagens (até 30 pipelines sharp)
					const adaptResults: AdaptOutput[] = [];
					const CONCURRENCY = 3;
					for (let start = 0; start < images.length; start += CONCURRENCY) {
						const chunk = images.slice(start, start + CONCURRENCY);
						const chunkResults = await Promise.all(
							chunk.map(async (original, chunkIdx) => {
								const idx = start + chunkIdx;
								// Margem de 4s: evita iniciar sharp quando orçamento quase esgotado
								if (materializeDeadline - Date.now() < 4000) {
									await logPlanner(
										plannerId,
										`[YouTube] orçamento esgotado — imagem ${idx + 1} mantida original sem blur`,
										"warning",
									).catch(() => {});
									return { ...original, wasAdapted: false } as AdaptOutput;
								}
								try {
									const adapted = await adaptImageToSquareWithBlur(original, idx);
									if (adapted.wasAdapted) {
										const origLabel =
											adapted.origWidth && adapted.origHeight
												? `${adapted.origWidth}x${adapted.origHeight}`
												: "original";
										await logPlanner(
											plannerId,
											`[YouTube] imagem ${idx + 1} adaptada para 1:1 com blur (${origLabel} -> 1080x1080)`,
											"info",
										).catch(() => {});
										return adapted;
									}
									if (adapted.fallbackReason) {
										await logPlanner(
											plannerId,
											`[YouTube] imagem ${idx + 1} blur ignorado (${adapted.fallbackReason}), mantendo original`,
											"warning",
										).catch(() => {});
									}
									return adapted;
								} catch (e: unknown) {
									const msg = (
										e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)
									).replace(/\n/g, " ");
									await logPlanner(
										plannerId,
										`[YouTube] imagem ${idx + 1} blur falhou (${msg}), mantendo original`,
										"warning",
									).catch(() => {});
									console.warn(`[YouTube] blur falhou imagem ${idx + 1}: ${msg}`);
									return {
										...original,
										wasAdapted: false,
										fallbackReason: msg,
									} as AdaptOutput;
								}
							}),
						);
						adaptResults.push(...chunkResults);
					}
					adaptedImages = adaptResults;
				} catch (e: unknown) {
					const msg = (
						e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)
					).replace(/\n/g, " ");
					console.warn(`[YouTube] falha geral no blur paralelo: ${msg}`);
					adaptedImages = images.map(
						(img) => ({ ...img, wasAdapted: false }) as AdaptOutput,
					);
				}
				const imagesToUpload =
					adaptedImages.length > 0
						? adaptedImages
						: images.map((img) => ({ ...img, wasAdapted: false }) as AdaptOutput);
				// Orçamento ANTES do upload: um multipart pode levar até 120s na
				// API externa; se o tick já está no limite, não inicia o upload —
				// reverte para pending (retry no próximo ciclo) em vez de arriscar
				// o worker matar o processo no meio (resposta parcial perdida).
				if (Date.now() > materializeDeadline) {
					throw new Error(
						"Orçamento do tick esgotado antes do upload da Comunidade — retry no próximo ciclo",
					);
				}
				await logPlanner(
					plannerId,
					`[YouTube] Publicando post na Comunidade (${imagesToUpload.length} imagem(ns)${failures.length > 0 ? `; ${failures.length} falharam` : ""}) do canal ${post.channel?.name || post.id}`,
					"info",
				);
				// M13: re-checa o status antes do call externo (upload multipart) — um
				// cancelamento durante materialização/adaptação não publica nada.
				if (!(await isPostStillInFlight(post.id))) {
					await logPlanner(
						plannerId,
						`[YouTube] Post ${post.id} cancelado antes do upload da Comunidade — nada foi publicado`,
						"warning",
					).catch(() => {});
					return;
				}
				created = await uploadCommunityPost({
					sessionId,
					message,
					images: imagesToUpload.map((img) => ({
						blob: new Blob([bufferView(img.buffer)], { type: img.contentType }),
						filename: img.filename,
						contentType: img.contentType,
					})),
					proxyUrl: getChannelProxyUrl(post.channel as any),
				});
			}
			await logPlanner(
				plannerId,
				`[YouTube] Post na Comunidade publicado (id remoto ${created.remote_post_id})`,
				"info",
			);
			// M13: escrita final com guard — se o post foi cancelado durante o
			// upload (a API externa publicou, o banco mantém cancelled).
			const wroteCommunity = await finalizePostWrite(post.id, plannerId, "YouTube", {
				status: "published",
				published_at: now,
				youtube_post_id: created.remote_post_id || String(created.id),
			});
			if (!wroteCommunity) return;
			results.published++;
			await logPlanner(
				plannerId,
				`[YouTube] Post na Comunidade publicado (id remoto ${created.remote_post_id})`,
				"info",
			);
			return;
		}

		// ── Short ──
		if (post.youtube_type && post.youtube_type !== "short") {
			throw new MalformedDataError(`youtube_type inválido: ${post.youtube_type}`);
		}
		if (!post.video_url) {
			throw new MalformedDataError("Short do YouTube exige um vídeo");
		}
		// Opções do Short salvas na criação do post (JSON em youtube_options)
		let options: YoutubeShortOptions & { products?: unknown } = {};
		if (post.youtube_options) {
			try {
				options = JSON.parse(post.youtube_options) as typeof options;
			} catch {
				throw new MalformedDataError("Malformed youtube_options");
			}
		}
		await logPlanner(
			plannerId,
			`[YouTube] Enviando Short (${post.video_url}) para a API externa`,
			"info",
		);
		const videoFile = await readLocalUploadFile(
			post.video_url,
			SHORT_MAX_FILE_BYTES,
		);
		// Título: opção salva ou caption (limite de 100 chars da API)
		const title = (options.title?.trim() || (post.caption || "").trim()).slice(
			0,
			100,
		);
		if (!title) {
			throw new MalformedDataError("Short do YouTube exige título");
		}
		// products (B1, M1/M2/M3/M4): youtube_options agora carrega SEPARADOS:
		//   products      = itens verbatim [{ item: <catálogo> }] -> POST /api/shorts
		//   product_names = nomes/termos p/ auto-select          -> POST /api/shorts/auto
		// Decisão de roteamento (fonte: shorts.py da API externa — create_short
		// tem `products`, /auto tem `product_names`+`filters`; NUNCA os dois na
		// MESMA chamada) — extraída em resolveShortProductsRouting
		// (lib/planner-config.ts), única fonte da regra, coberta por testes em
		// scripts/gauntlet/products-routing.mts.
		//   - algum item verbatim -> /shorts com products; nomes coexistentes
		//     viram SKIP com warning (regra segura documentada em
		//     docs/fix-F1-b1-produtos-afiliados.md: item escolhido pelo usuário
		//     tem prioridade — nomes só viajam sozinhos por /auto);
		//   - só nomes -> /shorts/auto (product_names + filters default);
		//   - nada -> /shorts sem products ("[]").
		// Legacy: products como '["nome"]' / CSV cru / lixo "[object Object]"
		// de configs pré-B1 são colapsados em nomes ou descartados pela função
		// (antes a API _parse_products descartava strings silenciosamente — M1).
		const productsRouting = resolveShortProductsRouting(options);
		const productsRoute = productsRouting.route;
		const verbatimItems = productsRouting.items;
		const namesArr = productsRouting.names;
		if (productsRoute === "verbatim" && productsRouting.skippedNames > 0) {
			await logPlanner(
				plannerId,
				`[YouTube] ${productsRouting.skippedNames} nome(s) de produto ignorado(s) (SKIP) — itens verbatim selecionados têm prioridade; products e product_names nunca são misturados na mesma chamada.`,
				"warning",
			).catch(() => {});
		}

		const proxyForShort = getChannelProxyUrl(post.channel as any);
		// M13: re-checa o status antes do call externo (upload do vídeo) — o
		// usuário pode ter cancelado o post enquanto o arquivo era lido.
		if (!(await isPostStillInFlight(post.id))) {
			await logPlanner(
				plannerId,
				`[YouTube] Post ${post.id} cancelado antes do upload do Short — nada foi publicado`,
				"warning",
			).catch(() => {});
			return;
		}
		const short =
			productsRoute === "auto"
				? await createAutoShort({
						sessionId,
						title,
						description: options.description ?? "",
						privacy: options.privacy ?? "PUBLIC",
						madeForKids: options.made_for_kids ?? false,
						// Categoria neutra (22 = People & Blogs, default do próprio YouTube).
						categoryId: options.category_id ?? 22,
						proxyUrl: proxyForShort,
						monetizeWithAds: options.monetize_with_ads ?? false,
						pinnedCommentText: options.pinned_comment_text || undefined,
						// default de filtros = todos os marketplaces habilitados
						productNames: namesArr,
						filters: {
							mercadolivre: true,
							shopee: true,
							amazon: true,
							min_commission_pct: 0,
							items_per_product: 1,
						},
						video: {
							blob: new Blob([bufferView(videoFile.buffer)], {
								type: videoFile.contentType,
							}),
							filename: videoFile.filename,
							contentType: videoFile.contentType,
						},
					})
				: await createShort({
						sessionId,
						title,
						description: options.description ?? "",
						privacy: options.privacy ?? "PUBLIC",
						madeForKids: options.made_for_kids ?? false,
						// Categoria neutra (22 = People & Blogs, default do próprio YouTube).
						categoryId: options.category_id ?? 22,
						proxyUrl: proxyForShort,
						monetizeWithAds: options.monetize_with_ads ?? false,
						pinnedCommentText: options.pinned_comment_text || undefined,
						products:
							productsRoute === "verbatim"
								? JSON.stringify(verbatimItems)
								: "[]",
						video: {
							blob: new Blob([bufferView(videoFile.buffer)], {
								type: videoFile.contentType,
							}),
							filename: videoFile.filename,
							contentType: videoFile.contentType,
						},
					});
		const productNote =
			productsRoute === "auto"
				? `auto-select ${namesArr.length} produto(s)`
				: productsRoute === "verbatim"
					? `${verbatimItems.length} produto(s) verbatim`
					: "sem produtos";
		await logPlanner(
			plannerId,
			`[YouTube] Short enviado via ${productsRoute === "auto" ? "/api/shorts/auto" : "/api/shorts"} (${productNote}) para a API externa`,
			"info",
		).catch(() => {});
		await logPlanner(
			plannerId,
			`[YouTube] Short publicado: ${short.title}${short.watch_url ? ` — ${short.watch_url}` : ""}`,
			"info",
		);
		// M13: escrita final com guard — post cancelado durante o upload do
		// vídeo permanece cancelled no banco (a API externa pode ter publicado;
		// o desfecho registrado no log acima deixa o estado audível).
		const wroteShort = await finalizePostWrite(post.id, plannerId, "YouTube", {
			status: "published",
			published_at: now,
			youtube_video_id: short.video_id || null,
			youtube_type: post.youtube_type ?? "short",
		});
		if (!wroteShort) return;
		results.published++;
	} catch (e: unknown) {
		const rawMsg = e instanceof Error ? e.message : String(e ?? "Unknown error");

		// O regex NÃO é um sinal inequívoco: na API externa a mesma mensagem é
		// lançada sempre que o bootstrap HTML não rende um channelId — inclusive
		// em falhas transitórias (página de consentimento/bot-check do YouTube).
		// Antes de falhar permanentemente, confirma o estado real da sessão via
		// GET /api/session/{id}: só trata como expirada se status === "expired".
		if (YT_SESSION_EXPIRED_RE.test(rawMsg)) {
			// M16: confirma o estado da sessão pela MESMA rede do canal — um canal
			// atrás de proxy não enxerga a API na chamada direta (contradição
			// documentada no audit-track-api F1/F4: L1195-1209 publica via proxy
			// mas a confirmação de expiração caía na rota sem ele).
			const sessionStatus = sessionId
				? await getSession(sessionId, getChannelProxyUrl(post.channel))
						.then((s) => String(s.status || ""))
						.catch(() => "")
				: "";
			if (sessionStatus === "expired") {
				const friendly = "Sessão do YouTube expirada — reconecte em Canais";
				// M13: guard de status — cancelado no meio do processamento segue
				// cancelado (sem overwrite para "failed").
				const wrote = await finalizePostWrite(post.id, plannerId, "YouTube", {
					status: "failed",
					error_message: friendly,
					failed_reason: "Session Expired",
				});
				if (!wrote) return;
				await logPlanner(
					plannerId,
					`[YouTube] Post ${post.id}: ${friendly}`,
					"error",
				);
				if (post.channel?.id) {
					await prisma.channel
						.update({
							where: { id: post.channel.id },
							data: { status: "inactive" },
						})
						.catch(() => {});
				}
				results.errors++;
				await notifyPostFailed(post, friendly);
				return;
			}
			// Status não-confirmado (rede instável ao consultar a sessão) ou ainda
			// "active": cai no caminho transiente abaixo e tenta de novo depois.
		}

		// Reaproveita a classificação permanente/transiente do Instagram
		// mapeando o status HTTP da API externa para igStatus. O `instanceof
		// MalformedDataError` é avaliado ANTES de envolver com withIgStatus:
		// envolver primeiro criaria um Error puro e o ramo definitivo (linha
		// ~209 do classifyError) nunca dispararia para o lane YouTube — posts
		// malformados (Short sem título, arquivo ausente no storage, children
		// inválidos) seriam retentados até MAX_TRANSIENT_ATTEMPTS em vez de
		// falharem imediatamente como no lane IG.
		const ytStatus = e instanceof YoutubeApiError ? e.status : 0;
		const kind =
			e instanceof MalformedDataError
				? "definitive"
				: classifyError(withIgStatus(rawMsg, ytStatus), ytStatus);
		const errMsg =
			e instanceof Error && e.name === "AbortError"
				? "API do YouTube expirou o tempo limite"
				: rawMsg;

		if (kind === "rate-limited") {
			await handleRetryableFailure({
				post,
				errMsg: `Rate limited (429): ${errMsg}`,
				revertToStatus: "pending",
				countAs: "rate_limited",
				plannerId,
				now,
				results,
			});
			return;
		}
		if (kind === "transient") {
			// Limitação conhecida (trade-off documentado, não-resolvido nesta
			// rodada): sem chave de idempotência na API externa, um retry após
			// falha transiente pós-confirmação (resposta perdida) PODERIA
			// republicar o mesmo Short/post — o lane IG mitiga com container
			// reutilizado; o lane YT não tem GET confiável de reconciliação por
			// título/frame. O que ESTÁ mitigado: o deadline de materialização + a
			// checagem de orçamento antes do upload (acima) reduzem bastante a
			// janela de "resposta perdida no meio do multipart", e o
			// revertToStatus:"pending" garante que a falha não vira dead-letter.
			// Reconciliar de verdade exige idempotency-key/consulta de existência
			// na API externa — fora do escopo desta rodada.
			await handleRetryableFailure({
				post,
				errMsg,
				revertToStatus: "pending",
				plannerId,
				now,
				results,
			});
			return;
		}

		// Erro definitivo → falha imediata
		await logPlanner(
			plannerId,
			`[YouTube] Erro definitivo post=${post.id}: ${errMsg}`,
			"error",
		);
		// M13: guard de status na falha definitiva — post cancelado permanece
		// cancelado (sem overwrite para "failed") e não gerar notificação.
		const wroteDefinitive = await finalizePostWrite(post.id, plannerId, "YouTube", {
			status: "failed",
			error_message: errMsg,
			failed_reason:
				e instanceof MalformedDataError ? "Malformed Data" : "Publishing Failed",
		});
		if (!wroteDefinitive) return;
		results.errors++;
		await notifyPostFailed(post, errMsg);
	}
}

// ─── Route Handler ────────────────────────────────────────────────────────────

// BK-01: Distributed lock via DB (cron_locks) + in-process fallback para multi-pod.
// Lock TTL = 60s (max exec 45s + margem). Atomic via AppConfig/CronLock row.
let publisherRunning = false;
const PUBLISHER_LOCK_KEY = "publisher";
const PUBLISHER_LOCK_TTL_MS = 60_000;

async function tryAcquireDistributedLock(): Promise<boolean> {
	const now = new Date();
	const expiresAt = new Date(now.getTime() + PUBLISHER_LOCK_TTL_MS);
	try {
		const existing = await prisma.cronLock.findUnique({
			where: { key: PUBLISHER_LOCK_KEY },
		});
		if (!existing) {
			await prisma.cronLock.create({
				data: {
					key: PUBLISHER_LOCK_KEY,
					locked_at: now,
					expires_at: expiresAt,
					owner: "publisher",
				},
			});
			return true;
		}
		if (existing.expires_at.getTime() < now.getTime()) {
			const res = await prisma.cronLock.updateMany({
				where: { key: PUBLISHER_LOCK_KEY, expires_at: existing.expires_at },
				data: { locked_at: now, expires_at: expiresAt, owner: "publisher" },
			});
			return res.count === 1;
		}
		return false;
	} catch {
		// race on create -> another pod won
		return false;
	}
}

async function releaseDistributedLock(): Promise<void> {
	try {
		await prisma.cronLock.deleteMany({ where: { key: PUBLISHER_LOCK_KEY } });
	} catch (err) {
		console.warn("[publisher] release lock falhou:", err);
	}
}

export async function GET(request: Request) {
	return handler(request);
}

export async function POST(request: Request) {
	return handler(request);
}

async function handler(request: Request) {
	try {
		// Auth check
		const cronSecret =
			request.headers.get("x-cron-auth") ||
			new URL(request.url).searchParams.get("secret");
		const expectedSecret = process.env.CRON_SECRET;
		if (!expectedSecret || cronSecret !== expectedSecret) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		// BK-01: distributed lock + in-process guard
		if (publisherRunning) {
			return NextResponse.json({
				skipped: true,
				reason: "Another run is still in progress",
			});
		}
		const distributedAcquired = await tryAcquireDistributedLock();
		if (!distributedAcquired) {
			return NextResponse.json({
				skipped: true,
				reason: "Another run is still in progress (distributed lock)",
			});
		}
		publisherRunning = true;

		try {
			const systemBaseUrl = resolveSystemBaseUrl();

			const startTime = Date.now();
			const MAX_EXEC_MS = 45_000; // Leave 10-15s buffer for the 60s worker heartbeat

			interface PublisherResults {
				pending: number;
				processing: number;
				published: number;
				errors: number;
				cleaned: number;
				tokens_refreshed: number;
				planners_processed: number;
				claimed: number;
				skipped: number;
				transient: number;
				rate_limited: number;
				throttled: number;
				timeout?: boolean;
			}

			const results: PublisherResults = {
				pending: 0,
				processing: 0,
				published: 0,
				errors: 0,
				cleaned: 0,
				tokens_refreshed: 0,
				planners_processed: 0,
				claimed: 0,
				skipped: 0,
				transient: 0,
				rate_limited: 0,
				throttled: 0,
			};
			const now = new Date();
			results.tokens_refreshed = await refreshDueChannelTokens(
				now,
				startTime,
				MAX_EXEC_MS,
			);

			// ═══════════════════════════════════════════════════════════════════════
			// PHASE -1: Cleanup — instantly fail posts with no media
			// ═══════════════════════════════════════════════════════════════════════
			const cleanupPosts = (
				await prisma.post.findMany({
					where: {
						status: "pending",
						video_url: null,
						image_url: null,
						children_urls: null,
					},
					select: {
						id: true,
						caption: true,
						youtube_type: true,
					},
				})
			).filter((p) => {
				// Posts da Comunidade do YouTube podem ser SÓ texto (sem mídia) — o
				// publisher publica via POST /api/post (JSON). O predicado usa
				// `youtube_type` diretamente (e não a relação `channel`, que vira
				// null quando o canal é DELETADO e deixaria o post texto-sem-mídia
				// cair aqui com "Missing Media" enganoso). Igual o pre-flight da
				// Fase 1; posts IG (youtube_type NULL) continuam sendo limpos.
				return p.youtube_type !== "community";
			});
			if (cleanupPosts.length > 0) {
				await prisma.post.updateMany({
					where: {
						id: { in: cleanupPosts.map((p) => p.id) },
						status: "pending",
					},
					data: {
						status: "failed",
						error_message: "No media URL — content item missing",
						failed_reason: "Missing Media",
					},
				});
				results.cleaned = cleanupPosts.length;
				for (const p of cleanupPosts) {
					await notifyPostFailed(
						{ caption: p.caption, channel: null },
						"No media URL — content item missing",
					);
				}
			}

			// ═══════════════════════════════════════════════════════════════════════
			// PHASE 0: Planner Processing — create Posts from active Planners
			// ═══════════════════════════════════════════════════════════════════════

			const planners = await prisma.planner.findMany({
				where: { status: "active" },
				include: { channels: true },
			});

			for (const planner of planners) {
				if (Date.now() - startTime > MAX_EXEC_MS) {
					results.timeout = true;
					break;
				}
				try {
					const outcome = await runPlannerOnce(prisma, planner, now);

					if (outcome.ok) {
						results.planners_processed++;
						results.claimed++;
						await logPlanner(
							planner.id,
							`[Phase0] Created ${outcome.created ?? 0} post(s)`,
							"info",
						);
					} else if (outcome.skipped) {
						if (outcome.skipped === "not_due") {
							// Rotina normal — silêncio total (sem spam)
						} else if (
							outcome.skipped === "start_time" ||
							outcome.skipped === "sleep"
						) {
							// Rotina com throttle de 30 min (não ~1440/dia)
							await throttledLog(
								planner.id,
								`[Phase0] ${outcome.error || outcome.skipped}`,
								"info",
							);
						} else if (outcome.skipped === "already_running") {
							results.skipped++;
						} else {
							// Erros reais: config inválido, sem canais, resolução falhou...
							await logPlanner(
								planner.id,
								`[Phase0] ${outcome.error || outcome.skipped}`,
								"error",
							);
						}
					} else {
						await logPlanner(
							planner.id,
							`[Phase0] ${outcome.error || "Planner skipped"}`,
							"error",
						);
					}
				} catch (err: unknown) {
					const errMsg =
						err instanceof Error ? err.message : String(err ?? "Unknown error");
					const errStack = err instanceof Error ? err.stack : undefined;
					await logPlanner(
						planner.id,
						`[Phase0] Uncaught error: ${errMsg}`,
						"error",
						{ stack: errStack },
					);
				}
			}

			// PHASE 1: Pending → Processing (create IG media containers)
			// ═══════════════════════════════════════════════════════════════════════

			// BK-02: Claim atomico via transacao + verificacao de retorno (multi-pod)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let claimedPosts: any[] = [];
			{
				const pendingPosts = await prisma.post.findMany({
					where: {
						status: "pending",
						OR: [{ scheduled_at: { lte: now } }, { scheduled_at: null }],
					},
					include: { channel: true },
					orderBy: { scheduled_at: "asc" },
					take: 5,
				});
				if (pendingPosts.length > 0) {
					const ids = pendingPosts.map((p) => p.id);
					await prisma.$transaction(async (tx) => {
						await tx.post.updateMany({
							where: { id: { in: ids }, status: "pending" },
							data: { status: "processing" },
						});
					});
					claimedPosts = await prisma.post.findMany({
						where: { id: { in: ids }, status: "processing" },
						include: { channel: true },
					});
				} else {
					claimedPosts = [];
				}
				results.claimed = claimedPosts.length;
			}

			const globalPublishIntervalMs = await getGlobalPublishIntervalMs();

			for (const post of claimedPosts) {
				if (Date.now() - startTime > MAX_EXEC_MS) {
					results.timeout = true;
					break;
				}
				const plannerId = post.planner_id || "unknown";
				let lastStatus = 0;
				try {
					// Pre-flight: abort immediately with no external calls
					// Posts da Comunidade do YouTube podem ser só texto (sem mídia).
					// `youtube_type === "community"` é marcador confiável MESMO com
					// canal deletado (relação channel null) — sem isso um post
					// texto-sem-mídia de canal removido falharia "Missing Media" em
					// vez de chegar ao publisher com a mensagem correta. Também
					// deixa posts YT sem mídia (Short sem vídeo) chegarem ao
					// publisher, que reporta "Short do YouTube exige um vídeo".
					const hasMedia = post.video_url || post.image_url || post.children_urls;
					if (!hasMedia && !post.youtube_type) {
						// M13: guard de status — cancelado durante o processamento segue
						// cancelado (sem overwrite para "failed").
						const wrote = await finalizePostWrite(post.id, plannerId, "IG", {
							status: "failed",
							error_message: "No media URL",
							failed_reason: "Missing Media",
						});
						if (!wrote) continue;
						results.errors++;
						await notifyPostFailed(post, "No media URL");
						continue;
					}

					// Publish throttle: skip (and revert the claim) when the channel published too recently
					const minIntervalMs = Math.max(
						globalPublishIntervalMs,
						await getChannelIntervalMs(post.channel),
					);
					if (await isChannelThrottled(post.channel, now, minIntervalMs)) {
						results.throttled++;
						await prisma.post.updateMany({
							where: { id: post.id, status: "processing" },
							data: { status: "pending" },
						});
						continue;
					}

					// M13: re-checa o status após o claim — o usuário pode ter cancelado
					// o post (bug-remove) entre a claim e o início do trabalho externo.
					// Nenhum container IG é criado, nenhum vídeo é subido, para um post
					// cancelado; os lanes YT re-checam de novo antes do call externo.
					if (!(await isPostStillInFlight(post.id))) {
						await logPlanner(
							plannerId,
							`Post ${post.id} cancelado após o claim — nenhuma chamada externa foi feita`,
							"warning",
						).catch(() => {});
						continue;
					}

					// ─── YouTube (Short ou Comunidade): publicação direta ───
					// `post.channel?.platform === "youtube"` sozinho falharia com o
					// canal DELETADO (relação null) — `post.youtube_type` é marcador
					// confiável de post YouTube independente da relação; IG nunca
					// tem youtube_type. O pre-flight deixa passar (só texto/YT
					// sem mídia) e o publishYoutubePost falha com a mensagem certa
					// (ex.: "Canal YouTube sem sessão vinculada").
					// ─── TikTok: publicação Direct Post (FILE_UPLOAD / PULL_FROM_URL) ───
					if (post.channel?.platform === "tiktok" || !!(post as unknown as { tiktok_type?: string | null }).tiktok_type) {
						await publishTiktokPost({
							post: post as unknown as TiktokPublishPost,
							plannerId,
							now,
							results,
							startTime,
							maxExecMs: MAX_EXEC_MS,
						});
						if (Date.now() - startTime > MAX_EXEC_MS) {
							results.timeout = true;
							break;
						}
						continue;
					}

					if (post.channel?.platform === "youtube" || !!post.youtube_type) {
						await publishYoutubePost({
							post,
							plannerId,
							now,
							results,
							startTime,
							maxExecMs: MAX_EXEC_MS,
						});
						// O upload do Short lê o vídeo em memória e o transmite via
						// multipart DENTRO deste tick (ao contrário do lane IG, que
						// envia só a URL) — um arquivo grande (ou host lento) pode
						// estourar o budget de MAX_EXEC_MS. Encerra o lote cedo para
						// o heartbeat do worker (60s) não matar o processamento no
						// meio do próximo post.
						if (Date.now() - startTime > MAX_EXEC_MS) {
							results.timeout = true;
							break;
						}
						continue;
					}

					// A previous attempt may have created an IG container already (e.g. the
					// response was lost after a successful POST). Reuse it instead of creating
					// a duplicate container.
					if (post.instagram_container_id) {
						// M13: escrita em voo com guard — um post cancelado (bug-remove)
						// não pode ser ressuscitado para processing_upload (a Fase 2
						// publicaria um container reciclado).
						const wrote = await finalizePostWrite(
							post.id,
							plannerId,
							"IG",
							{ status: "processing_upload" },
						);
						if (!wrote) continue;
						results.pending++;
						continue;
					}

					const accessToken = await resolveAccessToken(
						post.channel?.access_token || null,
					);
					const accountId = (post.channel?.account_id || "").trim();
					if (!accessToken || !accountId) throw new Error("Missing credentials");

					const baseUrl = getGraphBaseUrl(accessToken);
					const mediaType = post.media_type || "REELS";
					const igHeaders = {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/x-www-form-urlencoded",
					};

					// CAROUSEL
					if (mediaType === "CAROUSEL") {
						let childrenData: { url: string; type: string }[] = [];
						if (post.children_urls) {
							try {
								childrenData = JSON.parse(post.children_urls);
							} catch {
								throw new MalformedDataError("Malformed children_urls");
							}
						}

						if (childrenData.length === 0) {
							throw new Error("Carousel has no media items");
						}

						// Resume: a previous attempt may already have created some
						// child containers (partial failure). Only create the ones we
						// do not have an id for — never duplicate existing children.
						const existingChildren = parseChildIdEntries(
							post.instagram_child_ids ?? null,
						);

						// Normalize out-of-range aspect ratios (e.g. 9:16) BEFORE
						// creating containers: Instagram crops every slide to the
						// FIRST slide's ratio and rejects ratios outside 3:4…1.91:1.
						// Normalizing is best-effort — failures fall back to the
						// original URL so the post is never blocked.
						const normalizedChildren = await Promise.all(
							childrenData.map(async (child, idx) => {
								if (child.type === "video") return { child, idx, note: undefined };
								const res = await normalizeCarouselChild({
									url: child.url,
									userId: post.user_id,
								});
								return {
									child: res.normalized ? { ...child, url: res.url } : child,
									idx,
									note: res.note,
								};
							}),
						);
						for (const { idx, note } of normalizedChildren) {
							if (note) {
								await logPlanner(
									plannerId,
									`[Phase1] Carousel child[${idx}] normalized: ${note}`,
									"info",
								);
							}
						}

						// Persist the normalized child URLs onto the post. A later
						// reconcile (Phase 2) normalizes the stored URLs again; when the
						// result differs from what is stored, the existing IG container
						// was created from stale media (raw 9:16 or padded) and gets
						// re-created with the fresh crop.
						const persistedChildren = normalizedChildren.map(({ child }) => child);
						const newChildrenUrls = JSON.stringify(persistedChildren);
						if (newChildrenUrls !== post.children_urls) {
							await prisma.post.update({
								where: { id: post.id },
								data: { children_urls: newChildrenUrls },
							});
						}

						// Parallelize creation of the missing carousel child containers
						const childResults = await Promise.all(
							normalizedChildren
								.filter(({ idx }) => !existingChildren.has(idx))
								.map(
									async ({
										child,
										idx,
									}): Promise<{
										idx: number;
										id?: string;
										error?: string;
										status?: number;
									}> => {
										const mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, child.url);
										const childParams = buildCarouselChildParams({
											child,
											idx,
											mediaUrlAbsolute,
											accessToken,
											postUserTags: post.user_tags ?? null,
										});

										await logPlanner(
											plannerId,
											`[Phase1] Sending Carousel Child[${idx}] to IG: type=${child.type}, url=${mediaUrlAbsolute}`,
											"info",
										);

										const igProxy = getChannelProxyUrl(post.channel as any);
										const res = await fetchWithTimeout(
											`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`,
											{
												method: "POST",
												headers: igHeaders,
												body: childParams.toString(),
											},
											300_000,
											igProxy,
										); // 5 minutes for large videos
										const data = await res.json();

										if (data.id) {
											return { idx, id: data.id };
										} else {
											const err = `Child[${idx}] failed: ${data.error?.message || JSON.stringify(data)}`;
											await logPlanner(plannerId, err, "error", data);
											return { idx, error: err, status: res.status };
										}
									},
								),
						);

						// Merge the new successes into any previously-stored ids.
						// The merged set only ever grows — never re-creates a child.
						const mergedChildren = new Map(existingChildren);
						for (const result of childResults) {
							if (result.id) mergedChildren.set(result.idx, result.id);
						}
						const failedChildren = childResults.filter((r) => r.error);

						if (failedChildren.length > 0) {
							// Partial failure: keep the children that succeeded so the
							// retry only creates the missing ones (no orphans, no dupes).
							if (mergedChildren.size > 0) {
								const worstStatus = Math.max(
									0,
									...failedChildren.map((f) => f.status || 0),
								);
								const errMsg = `Carousel failed: ${failedChildren.length} children failed to initialize (${mergedChildren.size} OK). First error: ${failedChildren[0].error}`;
								const countAs = worstStatus === 429 ? "rate_limited" : "transient";
								await prisma.post.update({
									where: { id: post.id },
									data: {
										instagram_child_ids: serializeChildIdEntries(mergedChildren),
									},
								});
								// Revert the claim; the retry (pending) resumes from the
								// stored ids and creates only the missing children.
								await handleRetryableFailure({
									post,
									errMsg,
									revertToStatus: "pending",
									countAs,
									plannerId,
									now,
									results,
								});
								if (countAs === "rate_limited") break;
								continue;
							}
							// No child at all succeeded — the whole attempt failed.
							const worstStatus = Math.max(
								0,
								...failedChildren.map((f) => f.status || 0),
							);
							throw withIgStatus(
								`Carousel failed: ${failedChildren.length} children failed to initialize. First error: ${failedChildren[0].error}`,
								worstStatus,
							);
						}

						if (
							mergedChildren.size > 0 &&
							mergedChildren.size === childrenData.length
						) {
							// M13: escrita em voo com guard — cancelado no meio da Fase 1
							// permanece cancelado (sem ressuscitar para processing_children).
							const wrote = await finalizePostWrite(
								post.id,
								plannerId,
								"IG",
								{
									status: "processing_children",
									instagram_child_ids: serializeChildIdEntries(mergedChildren),
									container_created_at: now,
								},
							);
							if (!wrote) continue;
							results.pending++;
						} else {
							throw new Error("No carousel child containers created (unknown reason)");
						}
						continue;
					}

					// SINGLE MEDIA
					const bodyParams = new URLSearchParams({ access_token: accessToken });
					let mediaUrlAbsolute = "";
					if (mediaType === "IMAGE") {
						mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, post.image_url);
						bodyParams.append("image_url", mediaUrlAbsolute);
						bodyParams.append("caption", post.caption || "");
						if (post.location_id) bodyParams.append("location_id", post.location_id);
						if (post.user_tags) {
							const usernames = post.user_tags
								.split(",")
								.map((u: string) => u.trim())
								.filter(Boolean);
							if (usernames.length > 0) {
								const tagsJson = usernames.map((username: string) => ({
									username,
									x: 0.5,
									y: 0.5,
								}));
								bodyParams.append("user_tags", JSON.stringify(tagsJson));
							}
						}
					} else {
						bodyParams.append(
							"media_type",
							mediaType === "STORIES" ? "STORIES" : "REELS",
						);
						if (mediaType === "STORIES" && !post.video_url) {
							// Image stories must be sent via image_url, not video_url
							mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, post.image_url);
							bodyParams.append("image_url", mediaUrlAbsolute);
						} else {
							mediaUrlAbsolute = makeAbsoluteUrl(
								systemBaseUrl,
								post.video_url || post.image_url,
							);
							bodyParams.append("video_url", mediaUrlAbsolute);
						}
						if (mediaType !== "STORIES")
							bodyParams.append("caption", post.caption || "");
						if (mediaType === "REELS") {
							bodyParams.append(
								"share_to_feed",
								post.share_to_feed === false ? "false" : "true",
							);
							if (post.location_id) bodyParams.append("location_id", post.location_id);
							if (post.audio_configuration) {
								const audioConfig = safeJsonParse<{
									audio_id?: string;
									audio_volume?: number;
									video_volume?: number;
								} | null>(post.audio_configuration, null);
								if (audioConfig && audioConfig.audio_id) {
									bodyParams.append("audio_configuration", JSON.stringify(audioConfig));
								}
							}
						}
					}

					if (post.collaborators && mediaType !== "STORIES") {
						const list = post.collaborators
							.split(",")
							.map((c: string) => c.trim())
							.filter(Boolean);
						if (list.length > 0) {
							// IG requires [{"username":"..."}] — not a plain string array
							bodyParams.append(
								"collaborators",
								JSON.stringify(list.map((u: string) => ({ username: u }))),
							);
						}
					}

					await logPlanner(
						plannerId,
						`[Phase1] Sending to IG: mediaType=${mediaType}, url=${mediaUrlAbsolute}`,
						"info",
					);

					const apiRes = await fetchWithTimeout(
						`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`,
						{ method: "POST", headers: igHeaders, body: bodyParams.toString() },
						300_000,
						getChannelProxyUrl((post as any).channel as any),
					); // 5 minutes for large videos
					lastStatus = apiRes.status;
					const data = await apiRes.json();

					if (data.id) {
						// M13: escrita em voo com guard — cancelado no meio do POST do
						// container permanece cancelado (o container existe na API mas o
						// post não entra na Fase 2 — cancelamento vence).
						const wrote = await finalizePostWrite(
							post.id,
							plannerId,
							"IG",
							{
								status: "processing_upload",
								instagram_container_id: data.id,
								container_created_at: now,
							},
						);
						if (!wrote) continue;
						results.pending++;
					} else {
						await logPlanner(
							plannerId,
							`Media creation failed for post ${post.id}`,
							"error",
							data,
						);
						const err = withIgStatus(
							data.error?.message || "Media creation failed",
							apiRes.status,
						);
						throw err;
					}
				} catch (e: unknown) {
					const kind = classifyError(e, lastStatus);
					const isAbort = e instanceof Error && e.name === "AbortError";
					const errMsg = isAbort
						? "Instagram API timed out (5m)"
						: e instanceof Error
							? e.message
							: String(e ?? "Unknown error");

					if (kind === "rate-limited") {
						// Revert claim so the post is retried on a later tick, and stop the batch
						await handleRetryableFailure({
							post,
							errMsg: `Rate limited (429): ${errMsg}`,
							revertToStatus: "pending",
							countAs: "rate_limited",
							plannerId,
							now,
							results,
						});
						break;
					}

					if (kind === "transient") {
						// Revert the claim — the post will be retried on the next tick
						await handleRetryableFailure({
							post,
							errMsg,
							revertToStatus: "pending",
							plannerId,
							now,
							results,
						});
						continue;
					}

					// Definitive error → fail the post
					await logPlanner(
						plannerId,
						`Phase1 Error post=${post.id}: ${errMsg}`,
						"error",
					);
					// M13: guard de status — cancelado segue cancelado (sem overwrite).
					const wrote = await finalizePostWrite(post.id, plannerId, "IG", {
						status: "failed",
						error_message: errMsg,
						failed_reason:
							e instanceof MalformedDataError
								? "Malformed Data"
								: "Initialization Failed",
					});
					if (!wrote) continue;
					results.errors++;
					await notifyPostFailed(post, errMsg);
				}
			}

			// ═══════════════════════════════════════════════════════════════════════
			// PHASE 2: Processing → Ready (check IG container status)
			// ═══════════════════════════════════════════════════════════════════════

			const processingPosts = await prisma.post.findMany({
				where: { status: { in: ["processing_upload", "processing_children"] } },
				include: { channel: true },
				orderBy: { created_at: "asc" }, // oldest first — avoids starvation
				take: 10,
			});

			for (const post of processingPosts) {
				if (Date.now() - startTime > MAX_EXEC_MS) {
					results.timeout = true;
					break;
				}
				let lastStatus = 0;
				try {
					const accessToken = await resolveAccessToken(
						post.channel?.access_token || null,
					);
					const baseUrl = getGraphBaseUrl(accessToken);
					const igHeaders = {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/x-www-form-urlencoded",
					};

					if (post.status === "processing_children") {
						// Index-aware child-id store (gaps allowed); legacy positional
						// string arrays are accepted too. Never re-create a child whose
						// container id we already hold.
						const childEntries = parseChildIdEntries(
							post.instagram_child_ids ?? null,
						);
						if (childEntries.size === 0) {
							throw new MalformedDataError("No child container IDs stored");
						}

						// Reconcile: (re)create containers for children that have no
						// stored id yet OR whose media changed since the container was
						// created (pre-fix carousels hold raw 9:16 or padded media —
						// normalize() now returns the cropped URL). Existing children
						// with fresh media are kept untouched.
						let childrenData: { url: string; type: string }[] = [];
						if (post.children_urls) {
							try {
								childrenData = JSON.parse(post.children_urls);
							} catch {
								throw new MalformedDataError("Malformed children_urls");
							}
						}
						const reconcileTargets: {
							idx: number;
							child: { url: string; type: string };
						}[] = [];
						const reconcileNotes: string[] = [];
						for (let idx = 0; idx < childrenData.length; idx++) {
							const stored = childrenData[idx];
							if (stored.type === "video") {
								if (!childEntries.has(idx))
									reconcileTargets.push({ idx, child: stored });
								continue;
							}
							const res = await normalizeCarouselChild({
								url: stored.url,
								userId: post.user_id,
							});
							const child = res.normalized ? { ...stored, url: res.url } : stored;
							if (!childEntries.has(idx) || child.url !== stored.url) {
								reconcileTargets.push({ idx, child });
								if (res.note)
									reconcileNotes.push(`Child reconcile[${idx}] normalized: ${res.note}`);
							}
						}
						for (const note of reconcileNotes) {
							await logPlanner(post.planner_id || "unknown", note, "info");
						}
						if (reconcileTargets.length > 0) {
							const created: { idx: number; id: string }[] = [];
							for (const { child, idx } of reconcileTargets) {
								const mediaUrlAbsolute = makeAbsoluteUrl(systemBaseUrl, child.url);
								const childParams = buildCarouselChildParams({
									child,
									idx,
									mediaUrlAbsolute,
									accessToken,
									postUserTags: post.user_tags ?? null,
								});
								try {
									const res = await fetchWithTimeout(
										`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media`,
										{
											method: "POST",
											headers: igHeaders,
											body: childParams.toString(),
										},
										300_000,
										getChannelProxyUrl((post as any).channel as any)
									); // 5 minutes for large videos
									const data = await res.json();
									if (data.id) {
										created.push({ idx, id: data.id });
									} else {
										await logPlanner(
											post.planner_id || "unknown",
											`Child reconcile[${idx}] failed: ${data.error?.message || JSON.stringify(data)}`,
											"error",
											data,
										);
									}
								} catch (reconcileErr: unknown) {
									await logPlanner(
										post.planner_id || "unknown",
										`Child reconcile[${idx}] error: ${reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)}`,
										"error",
									);
								}
							}
							for (const { idx, id } of created) childEntries.set(idx, id);
							if (created.length > 0) {
								await prisma.post.update({
									where: { id: post.id },
									data: {
										instagram_child_ids: serializeChildIdEntries(childEntries),
									},
								});
							}
							// Persist the reconciled (possibly cropped) URLs so a later
							// run sees already-normalized media and stops re-creating.
							const persistedChildren = childrenData.map((c, idx) => {
								const target = reconcileTargets.find((t) => t.idx === idx);
								return target?.child ?? c;
							});
							const newChildrenUrls = JSON.stringify(persistedChildren);
							if (newChildrenUrls !== post.children_urls) {
								await prisma.post.update({
									where: { id: post.id },
									data: { children_urls: newChildrenUrls },
								});
							}
							// Still incomplete (some reconciled children failed): the
							// carousel cannot be assembled yet — retry on a later tick. Bump
							// the attempt bookkeeping like every other retryable lane so an
							// eternal failure is bounded by MAX_TRANSIENT_ATTEMPTS / the 2h
							// dead-letter instead of spinning forever.
							const stillMissing = childrenData.some(
								(_, idx) => !childEntries.has(idx),
							);
							if (stillMissing) {
								const reconcileMsg = `Carousel ${post.id}: children missing or failed to initialize — reconcile incomplete`;
								await logPlanner(post.planner_id || "unknown", reconcileMsg, "info");
								await handleRetryableFailure({
									post,
									errMsg: reconcileMsg,
									plannerId: post.planner_id || "unknown",
									now,
									results,
								});
								continue;
							}
						}

						// Mount the carousel in ALPHABETICAL slide order (A-Z; 1-10).
						// Posts created before the alphabetical-order fix carry
						// children_urls in created_at order; resolve the original file
						// names from content_items and order the child ids by name.
						const namesByUrl = new Map<string, string>();
						try {
							const urlList = [
								...new Set(childrenData.map((c) => c.url).filter(Boolean)),
							];
							if (urlList.length > 0) {
								const known = await prisma.contentItem.findMany({
									where: { url: { in: urlList } },
									select: { url: true, name: true },
								});
								for (const item of known) {
									if (item.name && item.url) {
										namesByUrl.set(item.url, String(item.name));
									}
								}
							}
						} catch {
							// name resolution is best-effort — fall back to stored order
						}
						// Fall back to the stored order when any slide has no resolvable
						// name (external/import-url children) — never guess on partial data.
						const childIds = childrenData.some((c) => !namesByUrl.has(c.url))
							? sortedChildIds(childEntries)
							: childrenData
									.map((c, idx) => ({ idx, name: namesByUrl.get(c.url) || "" }))
									.sort(
										(a, b) =>
											a.name.localeCompare(b.name, undefined, {
												numeric: true,
											}) || a.idx - b.idx,
									)
									.map((e) => childEntries.get(e.idx))
									.filter((id): id is string => Boolean(id));
						// Parallelize child status checks
						const statusPromises = childIds.map(async (cid) => {
							const res = await fetchWithTimeout(
								`${baseUrl}/${GRAPH_API_VERSION}/${cid}?fields=status_code&access_token=${accessToken}`,
								{},
								15_000,
								getChannelProxyUrl((post as any).channel as any),
							);
							return { status: res.status, body: await res.json() };
						});
						const statusResults = await Promise.all(statusPromises);

						// Stuck legacy row: child ids stored but NO child urls resolvable
						// (children_urls null/vazio) → childIds vazio → allFinished() é
						// vacuously true e montaria um CAROUSEL sem children (404 no IG).
						// Fica processing_children: o dead-letter 2h (Fase 2.5) converte em
						// failed/"Processing Timeout" como esperado no P1 do gauntlet.
						if (childIds.length === 0) {
							await logPlanner(
								post.planner_id || "unknown",
								`Carousel ${post.id}: no child urls stored — waiting (2h dead-letter applies)`,
								"info",
							);
							continue;
						}

						// Any child still processing → keep waiting. Any child ERROR → fail the post.
						const errored = statusResults.find(
							(r) => r.body?.status_code === "ERROR",
						);
						if (errored) {
							const msg = `IG Processing Error: ${errored.body?.error?.message || JSON.stringify(errored.body)}`;
							await logPlanner(
								post.planner_id || "unknown",
								msg,
								"error",
								errored.body,
							);
							// M13: guard de status — cancelado segue cancelado (sem overwrite).
							const wrote = await finalizePostWrite(
								post.id,
								post.planner_id || "unknown",
								"IG",
								{
									status: "failed",
									error_message: msg,
									failed_reason: "Processing Failed",
								},
							);
							if (!wrote) continue;
							results.errors++;
							await notifyPostFailed(post, msg);
							continue;
						}

						const allFinished = statusResults.every(
							(r) => r.body?.status_code === "FINISHED",
						);
						if (allFinished) {
							// Reuse guard (parity with the single-media guard in the phase-1
							// lane): if this post already holds a carousel container id, do
							// NOT assemble a second group container. IG child containers are
							// single-use — a second CAROUSEL create would burn the children
							// and orphan the first container. Hand the existing container to
							// the poll lane instead.
							if (post.instagram_container_id) {
								// M13: escrita em voo com guard — cancelado (bug-remove) não
								// entra na Fase 3 mesmo com container existente.
								const wrote = await finalizePostWrite(
									post.id,
									post.planner_id || "unknown",
									"IG",
									{ status: "processing_upload" },
								);
								if (!wrote) continue;
								continue;
							}
							const body = new URLSearchParams({
								media_type: "CAROUSEL",
								children: childIds.join(","),
								caption: post.caption || "",
								access_token: accessToken,
							});
							if (post.location_id) body.append("location_id", post.location_id);
							if (post.collaborators) {
								const list = post.collaborators
									.split(",")
									.map((c: string) => c.trim())
									.filter(Boolean);
								if (list.length > 0) {
									body.append(
										"collaborators",
										JSON.stringify(list.map((u: string) => ({ username: u }))),
									);
								}
							}
							const igProxyCarousel = getChannelProxyUrl((post as any).channel as any);
							const res = await fetchWithTimeout(
								`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media`,
								{ method: "POST", headers: igHeaders, body: body.toString() },
								15_000,
								igProxyCarousel,
							);
							lastStatus = res.status;
							const data = await res.json();
							if (data.id) {
								// M13: escrita em voo com guard — cancelado no meio do POST
								// do container (Fase 2) permanece cancelado.
								const wrote = await finalizePostWrite(
									post.id,
									post.planner_id || "unknown",
									"IG",
									{
										status: "processing_upload",
										instagram_container_id: data.id,
										container_created_at: now,
									},
								);
								if (!wrote) continue;
							} else {
								const err = withIgStatus(
									data.error?.message || "Carousel container creation failed",
									res.status,
								);
								throw err;
							}
						}
					} else {
						// Single media — check status
						const igProxyStatus = getChannelProxyUrl((post as any).channel as any);
						const res = await fetchWithTimeout(
							`${baseUrl}/${GRAPH_API_VERSION}/${post.instagram_container_id}?fields=status_code&access_token=${accessToken}`,
							{},
							15_000,
							igProxyStatus,
						);
						lastStatus = res.status;
						const data = await res.json();
						if (data.status_code === "FINISHED") {
							// Delay publishing for 3 minutes from container creation
							// (container_created_at, set in Phase 1/2). Falls back to created_at
							// for legacy posts that predate the column.
							const createdRef = post.container_created_at ?? post.created_at;
							const timeSinceCreation = Date.now() - (createdRef?.getTime() || 0);
							if (timeSinceCreation > 3 * 60 * 1000) {
								// M13: escrita em voo com guard — cancelado (bug-remove) não
								// entra na Fase 3 (a Fase 3 tem re-check próprio, mas o
								// ready_to_publish em si não pode ressuscitar o post).
								const wrote = await finalizePostWrite(
									post.id,
									post.planner_id || "unknown",
									"IG",
									{ status: "ready_to_publish" },
								);
								if (!wrote) continue;
							} else {
								// Leave in processing state temporarily
								await logPlanner(
									post.planner_id || "unknown",
									`Media ${post.id} is FINISHED but waiting 3 min safety delay.`,
									"info",
								);
							}
						} else if (data.status_code === "ERROR") {
							const msg = `IG Processing Error: ${data.error?.message || JSON.stringify(data)}`;
							await logPlanner(post.planner_id || "unknown", msg, "error", data);
							// M13: guard de status — cancelado segue cancelado (sem overwrite).
							const wrote = await finalizePostWrite(
								post.id,
								post.planner_id || "unknown",
								"IG",
								{
									status: "failed",
									error_message: msg,
									failed_reason: "Processing Failed",
								},
							);
							if (!wrote) continue;
							results.errors++;
							await notifyPostFailed(post, msg);
							continue;
						}
						// else: still processing — will retry next tick
					}
					results.processing++;
				} catch (e: unknown) {
					const kind = classifyError(e, lastStatus);
					const isAbort = e instanceof Error && e.name === "AbortError";
					const errMsg = isAbort
						? "Instagram API timed out (15s)"
						: e instanceof Error
							? e.message
							: String(e ?? "Unknown error");

					if (kind === "rate-limited") {
						// Keep processing_* status — retried on the next tick; stop the batch
						await handleRetryableFailure({
							post,
							errMsg: `Rate limited (429): ${errMsg}`,
							countAs: "rate_limited",
							plannerId: post.planner_id || "unknown",
							now,
							results,
						});
						break;
					}

					if (kind === "transient") {
						// Keep the current processing_* status — retried on the next tick
						await handleRetryableFailure({
							post,
							errMsg,
							plannerId: post.planner_id || "unknown",
							now,
							results,
						});
						continue;
					}

					// Definitive error → fail the post
					await logPlanner(
						post.planner_id || "unknown",
						`Phase2 Error post=${post.id}: ${errMsg}`,
						"error",
					);
					// M13: guard de status — cancelado segue cancelado (sem overwrite).
					const wrote = await finalizePostWrite(
						post.id,
						post.planner_id || "unknown",
						"IG",
						{
							status: "failed",
							error_message: errMsg,
							failed_reason:
								e instanceof MalformedDataError
									? "Malformed Data"
									: "Processing Exception",
						},
					);
					if (!wrote) continue;
					results.errors++;
					await notifyPostFailed(post, errMsg);
				}
			}

			// ═══════════════════════════════════════════════════════════════════════
			// PHASE 2.5: Timeout posts stuck in processing for > 2 hours,
			// and revert posts claimed by Phase 1 but stuck in 'processing' for > 15 min
			// (process crash / aborted run) back to pending so they are retried.
			// ═══════════════════════════════════════════════════════════════════════

			const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
			// Dead-letter: prefer last_attempt_at (most accurate proxy for when the cron
			// last touched the post); fall back to created_at for legacy rows.
			await prisma.post.updateMany({
				where: {
					status: { in: ["processing_upload", "processing_children"] },
					OR: [
						{ last_attempt_at: { lte: twoHoursAgo } },
						{ last_attempt_at: null, created_at: { lte: twoHoursAgo } },
					],
				},
				data: {
					status: "failed",
					error_message: "Timed out: still processing after 2 hours",
					failed_reason: "Processing Timeout",
				},
			});

			const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
			await prisma.post.updateMany({
				where: { status: "processing", created_at: { lte: fifteenMinutesAgo } },
				data: { status: "pending" },
			});

			// ═══════════════════════════════════════════════════════════════════════
			// PHASE 3: Ready → Published
			// ═══════════════════════════════════════════════════════════════════════

			const readyPosts = await prisma.post.findMany({
				where: { status: "ready_to_publish" },
				include: { channel: true },
				orderBy: { created_at: "asc" }, // oldest first — avoids starvation
				take: 5,
			});

			for (const post of readyPosts) {
				if (Date.now() - startTime > MAX_EXEC_MS) {
					results.timeout = true;
					break;
				}
				let lastStatus = 0;
				try {
					// Publish throttle: skip (keep ready_to_publish) when the channel published too recently
					const minIntervalMs = Math.max(
						globalPublishIntervalMs,
						await getChannelIntervalMs(post.channel),
					);
					if (await isChannelThrottled(post.channel, now, minIntervalMs)) {
						results.throttled++;
						continue;
					}

					const accessToken = await resolveAccessToken(
						post.channel?.access_token || null,
					);
					const baseUrl = getGraphBaseUrl(accessToken);

					// M13: re-checa o status no lane ready_to_publish — um post
					// cancelado (bug-remove) não é publicado na API do IG.
					if (!(await isPostStillInFlight(post.id))) {
						await logPlanner(
							post.planner_id || "unknown",
							`[IG] Post ${post.id} cancelado antes do media_publish — nada foi publicado`,
							"warning",
						).catch(() => {});
						continue;
					}

					const igProxyPublish = getChannelProxyUrl((post as any).channel as any);
					const res = await fetchWithTimeout(
						`${baseUrl}/${GRAPH_API_VERSION}/${post.channel?.account_id}/media_publish`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${accessToken}`,
								"Content-Type": "application/x-www-form-urlencoded",
							},
							body: new URLSearchParams({
								creation_id: post.instagram_container_id || "",
								access_token: accessToken,
							}).toString(),
						},
						15_000,
						igProxyPublish,
					);
					lastStatus = res.status;
					const data = await res.json();

					if (data.id) {
						// M13: escrita final com guard — post cancelado durante o
						// media_publish permanece cancelled no banco (a API pode ter
						// publicado; o log de bloqueio deixa o estado audível).
						const wrote = await finalizePostWrite(
							post.id,
							post.planner_id || "unknown",
							"IG",
							{
								status: "published",
								published_at: new Date(),
								instagram_media_id: data.id,
							},
						);
						if (!wrote) continue;
						results.published++;
					} else {
						const msg = data.error?.message || "Publishing Failed";
						if (msg.toLowerCase().includes("already published")) {
							// M13: guard de status — idem (já publicado externamente em
							// tentativa anterior; o banco só é marcado se ainda em voo).
							const wroteAlready = await finalizePostWrite(
								post.id,
								post.planner_id || "unknown",
								"IG",
								{ status: "published", published_at: new Date() },
							);
							if (wroteAlready) results.published++;
						} else {
							const err = withIgStatus(msg, res.status);
							throw err;
						}
					}
				} catch (e: unknown) {
					const kind = classifyError(e, lastStatus);
					const isAbort = e instanceof Error && e.name === "AbortError";
					const errMsg = isAbort
						? "Instagram API timed out (15s)"
						: e instanceof Error
							? e.message
							: String(e ?? "Unknown error");

					if (kind === "rate-limited") {
						// Keep ready_to_publish — retried on the next tick; stop the batch
						await handleRetryableFailure({
							post,
							errMsg: `Rate limited (429): ${errMsg}`,
							countAs: "rate_limited",
							plannerId: post.planner_id || "unknown",
							now,
							results,
						});
						break;
					}

					if (kind === "transient") {
						// Keep ready_to_publish — retried on the next tick
						await handleRetryableFailure({
							post,
							errMsg,
							plannerId: post.planner_id || "unknown",
							now,
							results,
						});
						continue;
					}

					// Definitive error → fail the post
					await logPlanner(
						post.planner_id || "unknown",
						`Phase3 Error post=${post.id}: ${errMsg}`,
						"error",
						{ igStatus: lastStatus },
					);
					// M13: guard de status — cancelado segue cancelado (sem overwrite).
					const wrote = await finalizePostWrite(
						post.id,
						post.planner_id || "unknown",
						"IG",
						{
							status: "failed",
							error_message: errMsg,
							failed_reason: "Publishing Failed",
						},
					);
					if (!wrote) continue;
					results.errors++;
					await notifyPostFailed(post, errMsg);
				}
			}

			// Summarize failures — digest notification only for batches with
			// several failures (single post failures already notify individually
			// via notifyPostFailed, avoiding double alerts on the common case).
			if (results.errors > 3) {
				await sendNotification(
					`⚠️ ${results.errors} publicação(ões) falharam no último ciclo do publisher.`,
				);
			}

			return NextResponse.json(results);
		} finally {
			publisherRunning = false;
			await releaseDistributedLock();
		}
	} catch (err: unknown) {
		const errMsg =
			err instanceof Error ? err.message : String(err ?? "Unknown error");
		return NextResponse.json({ error: errMsg }, { status: 500 });
	}
}
