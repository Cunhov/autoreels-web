/**
 * Cliente server-side da API externa youtube-community-api (FastAPI).
 *
 * REGRA: NUNCA importar este arquivo em código de cliente ("use client") —
 * a YOUTUBE_API_KEY é segredo e todas as chamadas à API externa devem ser
 * feitas exclusivamente por route handlers no servidor.
 *
 * Fonte dos paths: docs/YOUTUBE_INTEGRATION_SPEC.md + código real da API
 * (app/api/{session,post,shorts,instance}.py daquele projeto).
 */

import { fetchWithTimeout } from "@/lib/instagram";
import { safeJsonParse } from "./sanitize";

// ─── Configuração ─────────────────────────────────────────────────────────────

export function getYoutubeConfig(): { baseUrl: string; apiKey: string } {
	// AS DUAS envs são obrigatórias. Sem baseUrl explícita o app tentaria
	// http://localhost:8000 (inútil dentro do container) e a Settings
	// reportaria estado mentiroso — por isso NÃO há default localhost.
	// `trim()` (além do corte de barra final): "   "/" " são truthy para
	// Boolean() e uma env só-de-espaços quebraria o fetch com URL vazia e
	// seria classificada como configuração VÁLIDA na health — estado
	// mentiroso que queima os retries do publisher em vez de falhar
	// definitivamente. O trim mantém o critério espelhado na health.
	const baseUrl = (process.env.YOUTUBE_API_BASE_URL || "").trim().replace(/\/$/, "");
	const apiKey = (process.env.YOUTUBE_API_KEY || "").trim();
	if (!baseUrl) {
		throw new Error(
			"YOUTUBE_API_BASE_URL não configurada — defina-a no .env do servidor.",
		);
	}
	if (!apiKey) {
		throw new Error(
			"YOUTUBE_API_KEY não configurada — defina-a no .env do servidor.",
		);
	}
	return { baseUrl, apiKey };
}

/** Erro que carrega o status HTTP da resposta da API externa. */
export class YoutubeApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "YoutubeApiError";
		this.status = status;
	}
}

/**
 * Fetch autenticado para a API externa. A chave crua vai no header
 * `Authorization` (a API também aceita `X-API-Key`). Erros HTTP viram
 * `YoutubeApiError` com a mensagem de `detail` do corpo JSON.
 */
export async function youtubeFetch(
	path: string,
	init: RequestInit = {},
	timeoutMs = 15_000,
	proxyUrl?: string | null,
): Promise<unknown> {
	const { baseUrl, apiKey } = getYoutubeConfig();
	const res = await fetchWithTimeout(`${baseUrl}${path}`, {
		...init,
		headers: {
			...(init.headers || {}),
			Authorization: apiKey,
		},
		signal: init.signal,
	}, timeoutMs, proxyUrl ?? null);

	if (!res.ok) {
		let detail = `HTTP ${res.status}`;
		try {
			const body = (await res.json()) as { detail?: unknown };
			if (typeof body?.detail === "string") {
				detail = body.detail;
			} else if (body?.detail != null) {
				detail = JSON.stringify(body.detail);
			}
		} catch {
			/* corpo não-JSON (proxy/HTML): mantém "HTTP <status>" */
		}
		throw new YoutubeApiError(detail, res.status);
	}

	if (res.status === 204) return null;
	return res.json();
}

// ─── Tipos de resposta da API ─────────────────────────────────────────────────

export interface YoutubeSession {
	id: string;
	label: string;
	channel_id: string | null;
	channel_name: string | null;
	status: string; // "active" | "expired" | ...
	created_at: string;
	last_rotate_at: string | null;
}

export interface YoutubeHealth {
	ok: boolean;
	sessions_active: number;
	db_connected: boolean;
	version: string;
}

export interface YoutubeShort {
	id: number;
	session_id: string;
	channel_id?: string | null;
	video_id?: string | null;
	title: string;
	privacy: string;
	status: string; // "published" | "failed" | ...
	error_message?: string | null;
	watch_url?: string | null;
	created_at: string;
	updated_at: string;
}

export interface YoutubePostResponse {
	id: number;
	session_id: string;
	remote_post_id?: string | null;
	status: string;
	message: string;
	image_count: number;
	created_at: string;
	error_message?: string | null;
}

export interface YoutubeCommentItem {
	comment_id?: string;
	text?: string;
	author?: string;
	pinned?: boolean;
	hearted?: boolean;
	liked?: boolean;
	[key: string]: unknown;
}

export interface YoutubeProduct {
	item: Record<string, unknown>;
	[key: string]: unknown;
}

export interface YoutubeShortOptions {
	title?: string;
	description?: string;
	privacy?: "PUBLIC" | "PRIVATE" | "UNLISTED";
	made_for_kids?: boolean;
	category_id?: number;
	monetize_with_ads?: boolean;
	pinned_comment_text?: string;
	// B1: nomes/termos de produto p/ auto-select (POST /api/shorts/auto).
	// Gravado como JSON string (paridade com `products`) pelo buildPostData.
	product_names?: string[] | string;
}

// ─── Helpers de canal (Channel.settings) ─────────────────────────────────────

/** Lê o `sessionId` da sessão remota armazenado em Channel.settings (JSON). */
export function getYoutubeSessionId(settings: string | null | undefined): string {
	if (!settings) return "";
	try {
		const parsed = safeJsonParse<{ sessionId?: unknown }>(settings, { } as any) as { sessionId?: unknown };
		return typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
	} catch {
		return "";
	}
}

/** Escreve/atualiza o `sessionId` no JSON de Channel.settings. */
export function withYoutubeSessionId(
	settings: string | null | undefined,
	sessionId: string,
): string {
	let current: Record<string, unknown> = {};
	if (settings) {
		try {
			current = safeJsonParse<Record<string, unknown>>(settings, {} as Record<string, unknown>);
		} catch {
			current = {};
		}
	}
	current.sessionId = sessionId;
	return JSON.stringify(current);
}

// ─── Health ───────────────────────────────────────────────────────────────────

/** GET /api/health — único endpoint sem auth na API externa. */
export async function getHealth(proxyUrl?: string | null): Promise<YoutubeHealth> {
	const { baseUrl } = getYoutubeConfig();
	const res = await fetchWithTimeout(`${baseUrl}/api/health`, {}, 10_000, proxyUrl ?? null);
	if (!res.ok) throw new YoutubeApiError(`HTTP ${res.status}`, res.status);
	return (await res.json()) as YoutubeHealth;
}

// ─── Sessões/canais ───────────────────────────────────────────────────────────

/** GET /api/session */
/**
 * GET /api/session — lista todas as sessões da API externa.
 */
export async function listSessions(proxyUrl?: string | null): Promise<YoutubeSession[]> {
	const data = (await youtubeFetch("/api/session", {}, 15_000, proxyUrl ?? null)) as {
		sessions?: YoutubeSession[];
	};
	return data.sessions || [];
}

/** POST /api/session — cookies obrigatórios validados pela própria API. */
export async function createSession(
	cookies: Record<string, string>,
	label = "",
): Promise<YoutubeSession> {
	return (await youtubeFetch("/api/session", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ cookies, label }),
	})) as YoutubeSession;
}

/** GET /api/session/{id} — estado atual de uma sessão (status, canal etc.). */
export async function getSession(sessionId: string, proxyUrl?: string | null): Promise<YoutubeSession> {
	return (await youtubeFetch(
		`/api/session/${encodeURIComponent(sessionId)}`,
		{}, 15_000, proxyUrl ?? null
	)) as YoutubeSession;
}

/** POST /api/session/{id}/refresh — revalida cookies e renova tokens. */
export async function refreshSession(sessionId: string): Promise<YoutubeSession> {
	return (await youtubeFetch(
		`/api/session/${encodeURIComponent(sessionId)}/refresh`,
		{ method: "POST" },
	)) as YoutubeSession;
}

/**
 * Remove a sessão remota (e posts/webhooks filhos).
 * Path real verificado no projeto da API: DELETE /api/instance/{session_id} (204).
 */
export async function deleteSession(sessionId: string): Promise<void> {
	await youtubeFetch(`/api/instance/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
	});
}

// ─── Comunidade ───────────────────────────────────────────────────────────────

const COMMUNITY_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Normaliza a resposta de um post da Comunidade.
 *
 * Guard de status espelhando o `createShort`: um `remote_post_id` explícito é
 * confirmação inquestionável de publicação (aceito sempre). Sem ele, um `id`
 * numérico só é aceito quando `status === "published"` — caso contrário pode
 * ser um registro de TENTATIVA `{id, status: "failed", error_message}` e
 * persistir `published` com um id de tentativa esconderia a falha para sempre
 * (sem retry, sem notificação). Falha com status ≠ published vira
 * `YoutubeApiError` (4xx definitivo, 5xx transiente). Falha genérica (sem id
 * algum, sem status) vira `YoutubeApiError` 4xx — DEFINITIVO no publisher,
 * sem loop de retry.
 */
function normalizePostResponse(data: YoutubePostResponse): YoutubePostResponse {
	if (data.remote_post_id) {
		return { ...data, remote_post_id: data.remote_post_id };
	}
	// Sem id explícito: exige status "published" — mesma salvaguarda do Short.
	// Registro de tentativa falhada não pode virar "published" no banco.
	if (data.status && data.status !== "published") {
		const reason =
			data.error_message ||
			`Publicação na Comunidade falhou (status=${data.status})`;
		const transient = /botguard|tls|network|timeout|temporar|try again|5\d\d/i.test(
			reason,
		);
		throw new YoutubeApiError(reason, transient ? 502 : 400);
	}
	const remotePostId =
		typeof data.id === "number" && data.id > 0 ? String(data.id) : "";
	if (!remotePostId) {
		throw new YoutubeApiError(
			data.error_message ||
				"Publicação na Comunidade falhou (resposta sem id da API externa)",
			400,
		);
	}
	return { ...data, remote_post_id: remotePostId };
}

/**
 * POST /api/post/upload — multipart com até 10 imagens.
 * `images`: blobs já lidos do storage local, com nome/content-type.
 */
export async function uploadCommunityPost(input: {
	sessionId: string;
	message: string;
	images: { blob: Blob; filename: string; contentType: string }[];
	proxyUrl?: string | null;
}): Promise<YoutubePostResponse> {
	if (input.images.length < 1 || input.images.length > 10) {
		// YoutubeApiError 4xx → o publisher classifica como DEFINITIVO (sem
		// loop de retry). Error puro cairia em "transient" e queimaria os
		// 5 ciclos de retry com mensagem enganosa.
		throw new YoutubeApiError(
			"A Comunidade do YouTube exige entre 1 e 10 imagens.",
			400,
		);
	}
	const form = new FormData();
	form.append("session_id", input.sessionId);
	form.append("message", input.message);
	for (const img of input.images) {
		form.append("images", img.blob, img.filename);
	}
	const data = (await youtubeFetch(
		"/api/post/upload",
		{ method: "POST", body: form },
		COMMUNITY_UPLOAD_TIMEOUT_MS,
		input.proxyUrl ?? null,
	)) as YoutubePostResponse;
	return normalizePostResponse(data);
}

/**
 * POST /api/post — JSON ({session_id, message}).
 * Caminho para post na Comunidade SÓ de texto. Roteamento do app: imagens
 * (1..10) VÃO pelo multipart (/api/post/upload), nunca por esta função — e
 * mesmo que a API externa aceitasse `image_urls` no JSON (como documenta a
 * spec), o app nunca envia imagens por este caminho.
 * Reutiliza o mesmo helper de fetch/normalização de erro (youtubeFetch →
 * YoutubeApiError) e devolve o MESMO shape de uploadCommunityPost
 * (remote_post_id).
 */
export async function createCommunityPostText(input: {
	sessionId: string;
	message: string;
	proxyUrl?: string | null;
}): Promise<YoutubePostResponse> {
	if (!input.message.trim()) {
		// YoutubeApiError 4xx → definitivo no publisher (sem retry loop).
		throw new YoutubeApiError("Post na Comunidade exige texto.", 400);
	}
	const data = (await youtubeFetch("/api/post", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			session_id: input.sessionId,
			message: input.message,
		}),
	}, 15_000, input.proxyUrl ?? null)) as YoutubePostResponse;
	return normalizePostResponse(data);
}

/** DELETE /api/post?session_id=&remote_post_id= */
export async function deleteCommunityPost(
	sessionId: string,
	remotePostId: string,
): Promise<void> {
	const params = new URLSearchParams({ session_id: sessionId, remote_post_id: remotePostId });
	await youtubeFetch(`/api/post?${params.toString()}`, { method: "DELETE" });
}

// ─── Shorts ───────────────────────────────────────────────────────────────────

// Alinhado ao teto do upload de mídia do Instagram (300s): o cron tem budget
// de execução curto e um upload travado não pode silenciar o publisher por 10min.
const SHORT_UPLOAD_TIMEOUT_MS = 300_000;

/**
 * POST /api/shorts — multipart upload direto do vídeo (campo `video`).
 * Exatamente um de `video` OU `video_url`; aqui sempre usamos o arquivo.
 */
export async function createShort(input: {
	sessionId: string;
	video: { blob: Blob; filename: string; contentType: string };
	title: string;
	description?: string;
	privacy?: "PUBLIC" | "PRIVATE" | "UNLISTED";
	madeForKids?: boolean;
	categoryId?: number;
	monetizeWithAds?: boolean;
	pinnedCommentText?: string;
	products?: string;
	proxyUrl?: string | null;
}): Promise<YoutubeShort> {
	const form = new FormData();
	form.append("session_id", input.sessionId);
	form.append("title", input.title);
	form.append("description", input.description ?? "");
	form.append("privacy", input.privacy ?? "PUBLIC");
	form.append("made_for_kids", String(input.madeForKids ?? false));
	// Categoria neutra (22 = People & Blogs, default do próprio upload do
	// YouTube). 17 é "Sports" — default questionável para conteúdo genérico
	// e não há campo de categoria na UI nem opção no planner, então todo Short
	// sem categoria explícita ia para a seção de Esportes.
	form.append("category_id", String(input.categoryId ?? 22));
	form.append("monetize_with_ads", String(input.monetizeWithAds ?? false));
	form.append("products", input.products ?? "[]");
	if (input.pinnedCommentText) {
		form.append("pinned_comment_text", input.pinnedCommentText);
	}
	form.append("video", input.video.blob, input.video.filename);

	const data = (await youtubeFetch(
		"/api/shorts",
		{ method: "POST", body: form },
		SHORT_UPLOAD_TIMEOUT_MS,
		input.proxyUrl ?? null,
	)) as YoutubeShort;

	// A API grava a tentativa e pode responder 201 com status="failed".
	// Lança YoutubeApiError com status sintético para o publisher classificar:
	// mensagens transientes (BotGuard/TLS/rede) → 502 (retry); o resto → 400
	// (falha permanente, ex.: rejeição de política do YouTube).
	if (data.status !== "published" || !data.video_id) {
		const reason = data.error_message || `Upload do Short falhou (status=${data.status})`;
		const transient = /botguard|tls|network|timeout|temporar|try again/i.test(reason);
		throw new YoutubeApiError(reason, transient ? 502 : 400);
	}
	return data;
}

/**
 * Resposta de POST /api/shorts/auto (AutoShortResponse da API externa).
 * O upload é feito PRIMEIRO (sem products); a tagagem por nome acontece
 * depois — `tagging_error` carrega falha da etapa de tagging SEM invalidar
 * o upload. `status` é sintético (uniformidade com createShort).
 */
export interface YoutubeAutoShort {
	video_id: string;
	url: string;
	title: string;
	total_selected: number;
	per_product: Array<{
		query: string;
		found: number;
		selected: Array<Record<string, unknown>>;
		skipped_reason?: string | null;
	}>;
	tagging_error?: string | null;
	status?: string;
	watch_url?: string;
}

/**
 * POST /api/shorts/auto — multipart do vídeo + product_names + filters.
 * Espelha createShort (mesmos campos de vídeo/título/privacidade) mas NÃO
 * envia `products`: a API publica primeiro e auto-seleciona o melhor produto
 * por nome (filters controlam marketplace/comissão). `proxyUrl?` opcional —
 * o publisher repassa getChannelProxyUrl (mesma cobertura do createShort).
 * product_names viaja como JSON array STRING: preserva vírgula dentro do
 * nome (M22) e é aceito por _parse_product_names da API.
 */
export async function createAutoShort(input: {
	sessionId: string;
	video: { blob: Blob; filename: string; contentType: string };
	title: string;
	description?: string;
	privacy?: "PUBLIC" | "PRIVATE" | "UNLISTED";
	madeForKids?: boolean;
	categoryId?: number;
	monetizeWithAds?: boolean;
	pinnedCommentText?: string;
	productNames: string[];
	filters?: Record<string, unknown>;
	proxyUrl?: string | null;
}): Promise<YoutubeAutoShort> {
	if (!input.productNames.length) {
		throw new YoutubeApiError(
			"createAutoShort exige ao menos um nome de produto (product_names).",
			400,
		);
	}
	const form = new FormData();
	form.append("session_id", input.sessionId);
	form.append("title", input.title);
	form.append("description", input.description ?? "");
	form.append("privacy", input.privacy ?? "PUBLIC");
	form.append("made_for_kids", String(input.madeForKids ?? false));
	// Categoria neutra (22 = People & Blogs) — paridade com createShort.
	form.append("category_id", String(input.categoryId ?? 22));
	form.append("monetize_with_ads", String(input.monetizeWithAds ?? false));
	form.append("product_names", JSON.stringify(input.productNames));
	form.append("filters", JSON.stringify(input.filters ?? {}));
	if (input.pinnedCommentText) {
		form.append("pinned_comment_text", input.pinnedCommentText);
	}
	form.append("video", input.video.blob, input.video.filename);

	const data = (await youtubeFetch(
		"/api/shorts/auto",
		{ method: "POST", body: form },
		SHORT_UPLOAD_TIMEOUT_MS,
		input.proxyUrl ?? null,
	)) as YoutubeAutoShort;

	// /auto responde AutoShortResponse (sem `status`): falha de upload já sai
	// como YoutubeApiError (502/500). Sem video_id é falha definitiva (400).
	if (!data.video_id) {
		const reason =
			data.tagging_error ||
			"Upload do Short (auto) respondeu sem video_id — falha definitiva";
		const transient =
			/botguard|tls|network|timeout|temporar|try again/i.test(reason);
		throw new YoutubeApiError(reason, transient ? 502 : 400);
	}
	const url =
		data.url ||
		(data.video_id ? `https://youtube.com/shorts/${data.video_id}` : "");
	return { ...data, status: "published", url, watch_url: url };
}

/** GET /api/shorts?session_id= */
export async function listShorts(sessionId: string): Promise<YoutubeShort[]> {
	const params = new URLSearchParams({ session_id: sessionId });
	const data = (await youtubeFetch(`/api/shorts?${params.toString()}`)) as {
		shorts?: YoutubeShort[];
	};
	return data.shorts || [];
}

/** GET /api/shorts/{id} */
export async function getShort(shortId: number | string): Promise<YoutubeShort> {
	return (await youtubeFetch(`/api/shorts/${encodeURIComponent(String(shortId))}`)) as YoutubeShort;
}

// ─── Comentários (video_router, prefix /api/videos) ──────────────────────────

/** GET /api/videos/{video_id}/comments?session_id=&limit=20 */
export async function listComments(
	videoId: string,
	sessionId: string,
	limit = 20,
): Promise<YoutubeCommentItem[]> {
	const params = new URLSearchParams({ session_id: sessionId, limit: String(limit) });
	const data = (await youtubeFetch(
		`/api/videos/${encodeURIComponent(videoId)}/comments?${params.toString()}`,
	)) as { comments?: YoutubeCommentItem[] };
	return data.comments || [];
}

/** POST /api/videos/{video_id}/comments — cria comentário, retorna comment_id. */
export async function createComment(
	videoId: string,
	sessionId: string,
	text: string,
): Promise<{ comment_id: string }> {
	const form = new URLSearchParams({ session_id: sessionId, text });
	return (await youtubeFetch(
		`/api/videos/${encodeURIComponent(videoId)}/comments`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
		},
	)) as { comment_id: string };
}

/** POST /api/videos/{video_id}/comments/actions — like | heart | pin. */
export async function commentAction(
	videoId: string,
	sessionId: string,
	commentId: string,
	action: "like" | "heart" | "pin",
): Promise<void> {
	const form = new URLSearchParams({
		session_id: sessionId,
		comment_id: commentId,
		action,
	});
	await youtubeFetch(
		`/api/videos/${encodeURIComponent(videoId)}/comments/actions`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
		},
	);
}

/** POST /api/videos/{video_id}/comments/pinned — comenta → coração → fixa. */
export async function createPinnedComment(
	videoId: string,
	sessionId: string,
	text: string,
	opts: { like?: boolean; heart?: boolean } = {},
): Promise<Record<string, unknown>> {
	const form = new URLSearchParams({
		session_id: sessionId,
		text,
		like: String(opts.like ?? false),
		heart: String(opts.heart ?? true),
	});
	return (await youtubeFetch(
		`/api/videos/${encodeURIComponent(videoId)}/comments/pinned`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
		},
	)) as Record<string, unknown>;
}

// ─── Produtos afiliados (session_router, prefix /api/sessions) ───────────────

export interface ProductSearchParams {
	query?: string;
	suggestions?: boolean;
	title?: string;
	description?: string;
	vendors?: string;
	minCommissionPct?: number;
	sort?: "relevance" | "price_asc" | "price_desc" | "commission_desc";
	limit?: number;
}

/**
 * GET /api/sessions/{session_id}/products — catálogo de produtos taggeáveis.
 * `video_id` é obrigatório pela API (vídeo alvo da tagagem). `proxyUrl?`
 * repassa o proxy do canal (Channel.proxy_url) — rotas que têm o Channel
 * devem passar getChannelProxyUrl(channel) (B3/F3, mesma cobertura do
 * publisher).
 */
export async function listProducts(
	sessionId: string,
	videoId: string,
	params: ProductSearchParams = {},
	proxyUrl?: string | null,
): Promise<YoutubeProduct[]> {
	const qs = new URLSearchParams({ video_id: videoId });
	if (params.query) qs.set("query", params.query);
	if (params.suggestions) qs.set("suggestions", "true");
	if (params.title) qs.set("title", params.title);
	if (params.description) qs.set("description", params.description);
	if (params.vendors) qs.set("vendors", params.vendors);
	if (params.minCommissionPct != null) qs.set("min_commission_pct", String(params.minCommissionPct));
	qs.set("sort", params.sort ?? "relevance");
	qs.set("limit", String(params.limit ?? 50));
	const data = (await youtubeFetch(
		`/api/sessions/${encodeURIComponent(sessionId)}/products?${qs.toString()}`,
		{},
		15_000,
		proxyUrl ?? null,
	)) as { products?: YoutubeProduct[] };
	return data.products || [];
}
