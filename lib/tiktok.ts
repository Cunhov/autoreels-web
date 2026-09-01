/**
 * lib/tiktok.ts — Auth & channel foundation for TikTok Content Posting API (Direct Post)
 * A1 owner: getTiktokOAuthConfig, exchangeCodeForToken, refreshTiktokToken,
 * getValidTiktokAccessToken, getTiktokOpenId, mask helpers, creator_info helper.
 * Proxy repassed via getChannelProxyUrl + getProxyDispatcher (reuses lib/proxy + lib/instagram#getPublicOrigin).
 */

import { fetchWithTimeout } from "@/lib/instagram";
import { getProxyDispatcher, getChannelProxyUrl } from "@/lib/proxy";
import { getPublicOrigin } from "@/lib/instagram";
import { prisma } from "@/lib/prisma";
import { safeJsonParse } from "@/lib/sanitize";

// ─── Types ───────────────────────────────────────────────────────────────

export interface TiktokSettings {
  tiktok_open_id?: string;
  tiktok_access_token?: string;
  tiktok_refresh_token?: string;
  /** epoch seconds */
  tiktok_expires_at?: number;
  tiktok_refresh_expires_at?: number;
  tiktok_scopes?: string;
  tiktok_token_type?: string;
  [k: string]: unknown;
}

export interface TiktokOAuthConfig {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TiktokTokenResponse {
  access_token: string;
  refresh_token: string;
  open_id: string;
  expires_in: number;
  refresh_expires_in: number;
  scope: string;
  token_type: string;
}

export interface TiktokCreatorInfo {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
  // raw passthrough
  [k: string]: unknown;
}

// ─── Helpers: settings parse ────────────────────────────────────────────

export function parseTiktokSettings(raw: string | null | undefined): TiktokSettings {
  if (!raw) return {};
  try {
    const parsed = safeJsonParse<Record<string, unknown>>(raw, {} as Record<string, unknown>);
    return (parsed as TiktokSettings) ?? {};
  } catch {
    return {};
  }
}

export function getTiktokOpenId(settings: string | null | undefined): string {
  const s = parseTiktokSettings(settings);
  const v = s.tiktok_open_id;
  return typeof v === "string" ? v : "";
}

export function maskTiktokToken(token: string | null | undefined): string {
  if (!token || typeof token !== "string" || !token.trim()) return "";
  const t = token.trim();
  if (t.length <= 8) return "***";
  return `${t.slice(0, 4)}***${t.slice(-4)}`;
}

export function maskTiktokOpenId(openId: string | null | undefined): string {
  if (!openId || typeof openId !== "string" || !openId.trim()) return "";
  const o = openId.trim();
  if (o.length <= 6) return "***";
  return `${o.slice(0, 3)}***${o.slice(-3)}`;
}

// ─── OAuth config ────────────────────────────────────────────────────────

export function getTiktokOAuthConfig(origin: string, req?: Request): TiktokOAuthConfig {
  const clientKey = (process.env.TIKTOK_CLIENT_KEY || "").trim();
  const clientSecret = (process.env.TIKTOK_CLIENT_SECRET || "").trim();
  const envRedirect = (process.env.TIKTOK_REDIRECT_URI || "").trim();

  const canonicalOrigin =
    (process.env.NEXTAUTH_URL || process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "") ||
    (req ? getPublicOrigin(req) : origin.replace(/\/$/, ""));

  // Default per spec: https://autoreels.cunhov.site/api/tiktok/oauth/callback
  const redirectUri = envRedirect || `${canonicalOrigin}/api/tiktok/oauth/callback`;

  if (!clientKey || !clientSecret) {
    throw new Error("TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be configured.");
  }

  return { clientKey, clientSecret, redirectUri };
}

// ─── Token exchange / refresh ────────────────────────────────────────────

const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";

function normalizeTokenResponse(raw: unknown): TiktokTokenResponse {
  const src = (raw as Record<string, unknown>) ?? {};
  // Some responses wrap in { data: {...} } or { access_token: ... } directly
  const d = (src.data as Record<string, unknown> | undefined) || src;
  return {
    access_token: String((d as Record<string, unknown>).access_token ?? (d as Record<string, unknown>).accessToken ?? ""),
    refresh_token: String((d as Record<string, unknown>).refresh_token ?? (d as Record<string, unknown>).refreshToken ?? ""),
    open_id: String((d as Record<string, unknown>).open_id ?? (d as Record<string, unknown>).openId ?? ""),
    expires_in: Number((d as Record<string, unknown>).expires_in ?? (d as Record<string, unknown>).expiresIn ?? 0),
    refresh_expires_in: Number((d as Record<string, unknown>).refresh_expires_in ?? (d as Record<string, unknown>).refreshExpiresIn ?? 0),
    scope: String((d as Record<string, unknown>).scope ?? ""),
    token_type: String((d as Record<string, unknown>).token_type ?? "Bearer"),
  };
}

export async function exchangeCodeForToken(
  code: string,
  origin: string,
  req?: Request,
  proxyUrl?: string | null
): Promise<TiktokTokenResponse> {
  const { clientKey, clientSecret, redirectUri } = getTiktokOAuthConfig(origin, req);
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  let dispatcher: unknown | undefined;
  if (proxyUrl) dispatcher = getProxyDispatcher(proxyUrl);

  const fetchOpts: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  } as RequestInit & { dispatcher?: unknown };
  if (dispatcher) (fetchOpts as RequestInit & { dispatcher: unknown }).dispatcher = dispatcher;

  const res = await fetch(TIKTOK_TOKEN_URL, fetchOpts as RequestInit);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`TikTok OAuth exchange failed: HTTP ${res.status}`);
  }
  const bodyJson = data as Record<string, unknown>;
  // TikTok error shape: { error, error_description, message } or { data: { error_code } }
  const errorCode = (bodyJson?.data as Record<string, unknown> | undefined)?.error_code;
  const errDesc = (bodyJson?.data as Record<string, unknown> | undefined)?.description;
  if (!res.ok || bodyJson?.error || bodyJson?.message || errorCode) {
    const msg =
      (typeof bodyJson?.error_description === "string" && bodyJson.error_description) ||
      (typeof bodyJson?.error === "string" && bodyJson.error) ||
      (typeof bodyJson?.message === "string" && bodyJson.message) ||
      (typeof errDesc === "string" && errDesc) ||
      `TikTok OAuth exchange failed: HTTP ${res.status}`;
    throw new Error(msg);
  }
  const normalized = normalizeTokenResponse(data);
  if (!normalized.access_token || !normalized.open_id) {
    throw new Error("TikTok OAuth exchange did not return access_token/open_id.");
  }
  return normalized;
}

export async function refreshTiktokToken(
  refreshToken: string,
  proxyUrl?: string | null
): Promise<TiktokTokenResponse> {
  const clean = (refreshToken || "").trim();
  if (!clean) throw new Error("refresh_token is required.");
  const clientKey = (process.env.TIKTOK_CLIENT_KEY || "").trim();
  const clientSecret = (process.env.TIKTOK_CLIENT_SECRET || "").trim();
  if (!clientKey || !clientSecret) {
    throw new Error("TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be configured.");
  }
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: clean,
  });

  let dispatcher: unknown | undefined;
  if (proxyUrl) dispatcher = getProxyDispatcher(proxyUrl);

  const fetchOpts: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  } as RequestInit & { dispatcher?: unknown };
  if (dispatcher) (fetchOpts as RequestInit & { dispatcher: unknown }).dispatcher = dispatcher;

  const res = await fetch(TIKTOK_TOKEN_URL, fetchOpts as RequestInit);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`TikTok token refresh failed: HTTP ${res.status}`);
  }
  const bodyJson = data as Record<string, unknown>;
  const errorCode = (bodyJson?.data as Record<string, unknown> | undefined)?.error_code;
  const errDesc = (bodyJson?.data as Record<string, unknown> | undefined)?.description;
  if (!res.ok || bodyJson?.error || bodyJson?.message || errorCode) {
    const msg =
      (typeof bodyJson?.error_description === "string" && bodyJson.error_description) ||
      (typeof bodyJson?.error === "string" && bodyJson.error) ||
      (typeof bodyJson?.message === "string" && bodyJson.message) ||
      (typeof errDesc === "string" && errDesc) ||
      `TikTok token refresh failed: HTTP ${res.status}`;
    throw new Error(msg);
  }
  const normalized = normalizeTokenResponse(data);
  if (!normalized.access_token) throw new Error("TikTok refresh did not return access_token.");
  return normalized;
}

// ─── Valid token with auto-refresh ───────────────────────────────────────

export async function getValidTiktokAccessToken(
  channel: { id: string; settings?: string | null; proxy_url?: string | null; proxy_enabled?: boolean | null }
): Promise<{ accessToken: string; openId: string; refreshed: boolean }> {
  const settings = parseTiktokSettings(channel.settings);
  let accessToken = typeof settings.tiktok_access_token === "string" ? settings.tiktok_access_token.trim() : "";
  const refreshToken = typeof settings.tiktok_refresh_token === "string" ? settings.tiktok_refresh_token.trim() : "";
  const openId = typeof settings.tiktok_open_id === "string" ? settings.tiktok_open_id.trim() : "";
  const expiresAt = typeof settings.tiktok_expires_at === "number" ? settings.tiktok_expires_at : Number(settings.tiktok_expires_at || 0);

  if (!accessToken) throw new Error("TikTok access_token não configurado para este canal.");
  if (!openId) throw new Error("TikTok open_id não configurado para este canal.");

  const nowSec = Math.floor(Date.now() / 1000);
  const needsRefresh = Boolean(expiresAt && expiresAt > 0 && expiresAt < nowSec + 60);

  if (!needsRefresh) {
    return { accessToken, openId, refreshed: false };
  }

  if (!refreshToken) {
    throw new Error("TikTok refresh_token ausente — reconecte o canal.");
  }

  const proxyUrl = getChannelProxyUrl(channel as unknown as { proxy_url?: string | null; settings?: string | null });
  // Only use proxy if enabled
  const effectiveProxy = (channel as unknown as { proxy_enabled?: boolean | null }).proxy_enabled === false ? null : proxyUrl;

  const refreshedData = await refreshTiktokToken(refreshToken, effectiveProxy);
  const newExpiresAt = Math.floor(Date.now() / 1000) + Number(refreshedData.expires_in || 0);
  const newRefreshExpiresAt = refreshedData.refresh_expires_in ? Math.floor(Date.now() / 1000) + Number(refreshedData.refresh_expires_in) : undefined;

  // Merge settings (não sobrescrever proxy_url column; preservar outras chaves)
  let currentRaw: string | null = null;
  try {
    const fresh = await prisma.channel.findUnique({ where: { id: channel.id }, select: { settings: true } });
    currentRaw = (fresh?.settings as string | null) ?? channel.settings ?? null;
  } catch {}
  const currentSettings = parseTiktokSettings(currentRaw);
  const merged: TiktokSettings = {
    ...currentSettings,
    tiktok_open_id: refreshedData.open_id || openId,
    tiktok_access_token: refreshedData.access_token,
    tiktok_refresh_token: refreshedData.refresh_token || refreshToken,
    tiktok_expires_at: newExpiresAt,
    tiktok_scopes: refreshedData.scope || (currentSettings.tiktok_scopes as string | undefined),
    tiktok_token_type: refreshedData.token_type,
  };
  if (newRefreshExpiresAt) merged.tiktok_refresh_expires_at = newRefreshExpiresAt;

  try {
    await prisma.channel.update({
      where: { id: channel.id },
      data: {
        settings: JSON.stringify(merged),
        token_expires_at: new Date(newExpiresAt * 1000),
        token_refreshed_at: new Date(),
      },
    });
  } catch (e) {
    console.warn("[tiktok] falha ao persistir token refreshed (não crítico):", e instanceof Error ? e.message : e);
  }

  return { accessToken: refreshedData.access_token, openId: refreshedData.open_id || openId, refreshed: true };
}

// ─── Creator info query ──────────────────────────────────────────────────

export async function fetchTiktokCreatorInfo(
  accessToken: string,
  proxyUrl?: string | null
): Promise<TiktokCreatorInfo> {
  const token = (accessToken || "").trim();
  if (!token) throw new Error("accessToken é obrigatório.");

  let dispatcher: unknown | undefined;
  if (proxyUrl) dispatcher = getProxyDispatcher(proxyUrl);

  const fetchOpts: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  } as RequestInit & { dispatcher?: unknown };
  if (dispatcher) (fetchOpts as RequestInit & { dispatcher: unknown }).dispatcher = dispatcher;

  const res = await fetch(TIKTOK_CREATOR_INFO_URL, fetchOpts as RequestInit);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Falha ao consultar creator_info: HTTP ${res.status}`);
  }
  const json = data as Record<string, unknown>;
  const err = (json?.error as Record<string, unknown> | undefined);
  const errCode = err?.code ?? (json?.data as Record<string, unknown> | undefined)?.error_code;
  if (!res.ok || json?.error || errCode) {
    const msg =
      (err?.message as string | undefined) ||
      ((json?.data as Record<string, unknown> | undefined)?.description as string | undefined) ||
      (typeof json?.message === "string" ? json.message : "") ||
      `Falha ao consultar creator_info: HTTP ${res.status}`;
    throw new Error(msg);
  }
  const payload = (json.data as Record<string, unknown> | undefined) || json;
  return {
    creator_avatar_url: String((payload as Record<string, unknown>).creator_avatar_url ?? ""),
    creator_username: String((payload as Record<string, unknown>).creator_username ?? ""),
    creator_nickname: String((payload as Record<string, unknown>).creator_nickname ?? ""),
    privacy_level_options: Array.isArray((payload as Record<string, unknown>).privacy_level_options)
      ? ((payload as Record<string, unknown>).privacy_level_options as string[])
      : [],
    comment_disabled: Boolean((payload as Record<string, unknown>).comment_disabled),
    duet_disabled: Boolean((payload as Record<string, unknown>).duet_disabled),
    stitch_disabled: Boolean((payload as Record<string, unknown>).stitch_disabled),
    max_video_post_duration_sec: Number((payload as Record<string, unknown>).max_video_post_duration_sec ?? 0),
    ...payload,
  } as TiktokCreatorInfo;
}

// Re-export proxy helpers for callers that import from tiktok module

// ─── Limites oficiais (Media Transfer Guide) ─────────────────────────────────
// Duplicatas de planner-config (single source A1/A3 usa planner-config; este é fallback para publisher)
export const TIKTOK_TITLE_MAX_LENGTH = 2200;
export const TIKTOK_MAX_VIDEO_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
export const TIKTOK_MIN_DURATION_SEC = 3;
export const TIKTOK_MAX_DURATION_DEFAULT_SEC = 600;
export const TIKTOK_SUPPORTED_VIDEO_FORMATS = ["mp4", "mov", "webm"] as const;
export const TIKTOK_SUPPORTED_CODEC_HINT = "MP4 H.264";
export const TIKTOK_PRIVACY_LEVELS = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
export type TiktokPrivacyLevel = typeof TIKTOK_PRIVACY_LEVELS[number];

// ─── Validação pré-upload ────────────────────────────────────────────────────
export interface ValidateTiktokVideoInput {
  size?: number | null;
  durationSec?: number | null;
  format?: string | null;
  titleLen?: number | null;
  title?: string | null;
  privacy?: string | null;
  maxDurationSec?: number | null;
  coverTimestampMs?: number | null;
}
export interface ValidateTiktokVideoResult { valid: boolean; error?: string; }
export function validateTiktokVideo(input: ValidateTiktokVideoInput): ValidateTiktokVideoResult {
  const maxDur = input.maxDurationSec ?? TIKTOK_MAX_DURATION_DEFAULT_SEC;
  if (typeof input.size === "number" && input.size > TIKTOK_MAX_VIDEO_SIZE_BYTES) {
    return { valid: false, error: `Vídeo excede tamanho máximo de 500 MB (${(input.size / 1024 / 1024).toFixed(1)} MB)` };
  }
  if (typeof input.durationSec === "number" && input.durationSec < TIKTOK_MIN_DURATION_SEC) {
    return { valid: false, error: `Vídeo muito curto (mínimo ${TIKTOK_MIN_DURATION_SEC} s)` };
  }
  if (typeof input.durationSec === "number" && input.durationSec > maxDur) {
    return { valid: false, error: `Vídeo excede duração máxima de ${maxDur} s para este criador` };
  }
  if (input.format) {
    const f = String(input.format).toLowerCase().replace(/^\./, "").trim();
    if (f && !(TIKTOK_SUPPORTED_VIDEO_FORMATS as readonly string[]).includes(f)) {
      return { valid: false, error: `Formato não suportado (use ${TIKTOK_SUPPORTED_CODEC_HINT})` };
    }
  }
  const titleLen = typeof input.titleLen === "number" ? input.titleLen : input.title != null ? String(input.title).length : 0;
  if (titleLen > TIKTOK_TITLE_MAX_LENGTH) {
    return { valid: false, error: `Título excede ${TIKTOK_TITLE_MAX_LENGTH} caracteres (${titleLen})` };
  }
  if (input.privacy) {
    const pv = String(input.privacy).trim();
    if (pv && !(TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(pv as typeof TIKTOK_PRIVACY_LEVELS[number])) {
      return { valid: false, error: `Privacidade inválida (use PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR ou SELF_ONLY)` };
    }
  }
  if (typeof input.coverTimestampMs === "number" && input.coverTimestampMs < 0) {
    return { valid: false, error: `Cover inválido (video_cover_timestamp_ms deve ser >= 0)` };
  }
  return { valid: true };
}

// ─── Mapeamento de erros TikTok -> PT-BR ────────────────────────────────────
export const TIKTOK_ERROR_MAP: Record<string, string> = {
  access_token_invalid: "Token do TikTok inválido ou expirado — reconecte o canal em Canais",
  access_token_expired: "Token do TikTok expirado — reconecte o canal em Canais",
  invalid_token: "Token do TikTok inválido — reconecte o canal em Canais",
  invalid_access_token: "Token do TikTok inválido — reconecte o canal em Canais",
  rate_limit: "Limite de requisições atingido no TikTok — tente novamente em instantes",
  rate_limit_exceeded: "Limite de requisições atingido no TikTok — tente novamente em instantes",
  too_many_requests: "Limite de requisições atingido no TikTok — tente novamente em instantes",
  video_too_long: "Vídeo excede duração máxima permitida para este criador",
  video_too_large: "Vídeo excede tamanho máximo de 500 MB",
  video_too_short: "Vídeo muito curto (mínimo 3 s)",
  invalid_video_format: "Formato não suportado (use MP4 H.264)",
  unsupported_format: "Formato não suportado (use MP4 H.264)",
  privacy_not_allowed: "Nível de privacidade não permitido para este criador",
  privacy_level_not_allowed: "Nível de privacidade não permitido para este criador",
  invalid_privacy_level: "Nível de privacidade inválido",
  invalid_title: "Título inválido (verifique tamanho e caracteres)",
  title_too_long: "Título excede 2200 caracteres",
  brand_content_not_allowed: "Conteúdo de marca não permitido para este criador",
  brand_not_eligible: "Conteúdo de marca não permitido para este criador",
  cover_timestamp_invalid: "Timestamp de capa inválido",
  url_not_verified: "Domínio do vídeo não verificado no app TikTok (use FILE_UPLOAD)",
  domain_not_verified: "Domínio do vídeo não verificado no app TikTok (use FILE_UPLOAD)",
  chunk_upload_failed: "Falha no upload do vídeo — tente novamente",
  upload_failed: "Falha no upload do vídeo — tente novamente",
  publish_failed: "Falha ao publicar no TikTok — tente novamente",
  internal_error: "Erro interno do TikTok — tente novamente",
  server_error: "Erro no servidor do TikTok — tente novamente",
};
export function mapTiktokErrorToPortuguese(codeOrMessage: string | null | undefined): string {
  if (!codeOrMessage) return "Erro desconhecido no TikTok";
  const lower = String(codeOrMessage).toLowerCase();
  // tenta chave exata normalizada
  const key = String(codeOrMessage).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_");
  if (TIKTOK_ERROR_MAP[key]) return TIKTOK_ERROR_MAP[key];
  for (const [k, v] of Object.entries(TIKTOK_ERROR_MAP)) {
    if (lower.includes(k) || lower.includes(k.replace(/_/g, " "))) return v;
  }
  if (/título|vídeo|privacidade|limite|token|marca|domínio/i.test(String(codeOrMessage))) {
    return String(codeOrMessage);
  }
  return String(codeOrMessage);
}
export function getTiktokErrorMessage(err: unknown): string {
  if (!err) return "Erro desconhecido no TikTok";
  if (err instanceof Error) return mapTiktokErrorToPortuguese(err.message);
  const asObj = err as Record<string, unknown>;
  const candidates = [
    asObj?.error_code,
    asObj?.code,
    (asObj?.error as Record<string, unknown>)?.code,
    (asObj?.error as Record<string, unknown>)?.message,
    asObj?.message,
    asObj?.detail,
    (asObj?.data as Record<string, unknown> | undefined)?.error_code,
  ];
  for (const c of candidates) if (typeof c === "string" && c.trim()) return mapTiktokErrorToPortuguese(c);
  return mapTiktokErrorToPortuguese(String(err));
}

// ─── Rate limit helpers ─────────────────────────────────────────────────────
export function parseRetryAfterMs(retryAfter: string | null | undefined): number | null {
  if (!retryAfter) return null;
  const s = String(retryAfter).trim();
  const asNum = Number(s);
  if (!Number.isNaN(asNum) && Number.isFinite(asNum)) return Math.max(0, Math.round(asNum * 1000));
  const asDate = Date.parse(s);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}
export function getTiktokRetryAfterMs(headers: Headers | Record<string, string | null | undefined> | null | undefined): number | null {
  if (!headers) return null;
  let raw: string | null | undefined;
  if (headers instanceof Headers) raw = headers.get("retry-after") || headers.get("Retry-After");
  else raw = (headers as Record<string, string | null | undefined>)["retry-after"] ?? (headers as Record<string, string | null | undefined>)["Retry-After"];
  return parseRetryAfterMs(raw ?? null);
}
export function getTiktokBackoffMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs != null && retryAfterMs >= 0) return Math.min(retryAfterMs, 60_000);
  const base = 2000 * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(base, 60_000);
}
export function isTiktokRateLimitError(err: unknown, status?: number | null): boolean {
  if (status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /rate_limit|too_many_requests|429|limite de requisi/i.test(msg);
}
export type TiktokErrorClass = "definitive" | "transient" | "rate-limited";
export function classifyTiktokError(err: unknown, status: number | null | undefined): TiktokErrorClass {
  const s = status ?? (err as { status?: number })?.status ?? 0;
  if (s === 429 || isTiktokRateLimitError(err, s)) return "rate-limited";
  if (s >= 500) return "transient";
  if (s >= 400 && s < 500) return "definitive";
  if (err instanceof Error && err.name === "AbortError") return "transient";
  if (err instanceof SyntaxError) return "transient";
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/TIKTOK_CLIENT_KEY|TIKTOK_CLIENT_SECRET|não configurad/i.test(msg)) return "definitive";
  return "transient";
}
export class TiktokApiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number | null;
  constructor(message: string, status: number, code?: string, retryAfterMs?: number | null) {
    super(message);
    this.name = "TiktokApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs ?? null;
  }
}
export function withTiktokStatus(message: string, status: number, code?: string): TiktokApiError {
  return new TiktokApiError(mapTiktokErrorToPortuguese(message), status, code);
}

// ─── Payload builders (para smokes + publisher) ─────────────────────────────
export interface TiktokPostOptions {
  title: string;
  privacy_level?: TiktokPrivacyLevel;
  disable_duet?: boolean;
  disable_stitch?: boolean;
  disable_comment?: boolean;
  video_cover_timestamp_ms?: number;
  brand_content_toggle?: boolean;
  brand_organic_toggle?: boolean;
}
export type TiktokSourceInfo =
  | { source: "FILE_UPLOAD"; video_size: number; chunk_size: number; total_chunk_count: number }
  | { source: "PULL_FROM_URL"; video_url: string };
export interface BuildTiktokInitPayloadInput {
  options: TiktokPostOptions;
  sourceInfo: TiktokSourceInfo;
}
export function buildTiktokInitPayload(input: BuildTiktokInitPayloadInput): Record<string, unknown> {
  const v = validateTiktokVideo({
    title: input.options.title,
    titleLen: input.options.title?.length,
    privacy: input.options.privacy_level,
    coverTimestampMs: input.options.video_cover_timestamp_ms,
    ...(input.sourceInfo.source === "FILE_UPLOAD" ? { size: input.sourceInfo.video_size } : {}),
  });
  if (!v.valid) throw withTiktokStatus(v.error!, 400);
  const privacy_level = input.options.privacy_level || "PUBLIC_TO_EVERYONE";
  const post_info: Record<string, unknown> = {
    title: input.options.title,
    privacy_level,
    disable_duet: Boolean(input.options.disable_duet),
    disable_stitch: Boolean(input.options.disable_stitch),
    disable_comment: Boolean(input.options.disable_comment),
  };
  if (typeof input.options.video_cover_timestamp_ms === "number") post_info.video_cover_timestamp_ms = input.options.video_cover_timestamp_ms;
  if (typeof input.options.brand_content_toggle === "boolean") post_info.brand_content_toggle = input.options.brand_content_toggle;
  if (typeof input.options.brand_organic_toggle === "boolean") post_info.brand_organic_toggle = input.options.brand_organic_toggle;
  const source_info: Record<string, unknown> =
    input.sourceInfo.source === "FILE_UPLOAD"
      ? { source: "FILE_UPLOAD", video_size: input.sourceInfo.video_size, chunk_size: input.sourceInfo.chunk_size, total_chunk_count: input.sourceInfo.total_chunk_count }
      : { source: "PULL_FROM_URL", video_url: input.sourceInfo.video_url };
  return { post_info, source_info };
}

// ─── Caption fallback (tiktok > caption) ────────────────────────────────────
export interface TiktokCaptionItem { caption?: string | null; caption_tiktok?: string | null; }
export function resolveTiktokCaption(item: TiktokCaptionItem | null | undefined): string {
  if (!item) return "";
  return item.caption_tiktok ?? item.caption ?? "";
}

// ─── Folder captions helper (tiktok.txt) ────────────────────────────────────
export interface FolderCaptionsTiktok { caption: string | null; captionTiktok: string | null; }
type CaptionFileLike = { name: string; text(): Promise<string> };
export async function readFolderCaptionsWithTiktok(files: CaptionFileLike[]): Promise<FolderCaptionsTiktok> {
  const byLower = new Map<string, CaptionFileLike>(files.map((f) => [f.name.toLowerCase(), f]));
  const tkFile = byLower.get("tiktok.txt");
  const genericFile = files.find((f) => {
    const lower = f.name.toLowerCase();
    return lower.endsWith(".txt") && lower !== "tiktok.txt" && lower !== "youtube.txt" && lower !== "instagram.txt";
  });
  const read = async (file: CaptionFileLike | undefined): Promise<string | null> => {
    if (!file) return null;
    try { return (await file.text()) || ""; } catch { return null; }
  };
  const [caption, captionTiktok] = await Promise.all([read(genericFile), read(tkFile)]);
  return { caption, captionTiktok };
}

// ─── Isolation helper ───────────────────────────────────────────────────────
export type ChannelPlatform = "tiktok" | "youtube" | "instagram" | string;
export function detectChannelPlatform(channel: { platform?: string | null; settings?: string | null }): ChannelPlatform | null {
  const p = (channel as { platform?: string | null })?.platform;
  if (p) {
    const lower = String(p).toLowerCase();
    if (lower === "tiktok" || lower === "youtube" || lower === "instagram") return lower;
  }
  if (channel.settings) {
    try {
      const parsed = JSON.parse(channel.settings) as Record<string, unknown>;
      if (parsed.tiktok_open_id || parsed.tiktok_access_token) return "tiktok";
      if ((parsed as Record<string, unknown>).sessionId) return "youtube";
    } catch {}
  }
  return p ? String(p).toLowerCase() : null;
}
export function isTiktokMixBlocked(channels: Array<{ platform?: string | null; settings?: string | null }>): boolean {
  if (!channels || channels.length <= 1) return false;
  const platforms = new Set(channels.map((c) => detectChannelPlatform(c)).filter(Boolean) as string[]);
  const hasTiktok = platforms.has("tiktok");
  if (hasTiktok && platforms.size > 1) return true;
  if (platforms.has("youtube") && platforms.has("instagram")) return true;
  if (platforms.size > 1) return true;
  return false;
}
export function getTiktokMixErrorMessage(): string { return "Planners TikTok não podem misturar canais de outras plataformas."; }

// ─── Upload & Publish Core (A2) ─────────────────────────────────────────────
export const TIKTOK_VIDEO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
export const TIKTOK_STATUS_FETCH_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

export interface CreateTiktokVideoInitParams {
  accessToken: string;
  title: string;
  privacyLevel?: string;
  disableDuet?: boolean;
  disableStitch?: boolean;
  disableComment?: boolean;
  videoCoverTimestampMs?: number;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
  source: TiktokSourceInfo;
}
export interface CreateTiktokVideoInitResult {
  publishId: string;
  uploadUrl: string;
}

/**
 * POST https://open.tiktokapis.com/v2/post/publish/video/init/
 * post_info {title, privacy_level, disable_duet, disable_stitch, disable_comment, video_cover_timestamp_ms, brand_content_toggle, brand_organic_toggle}
 * + source_info (FILE_UPLOAD {video_size, chunk_size, total_chunk_count} | PULL_FROM_URL {video_url})
 * Proxy é sempre repassado via getChannelProxyUrl (caller deve obter proxyUrl e passar).
 */
export async function createTiktokVideoInit(
  params: CreateTiktokVideoInitParams,
  proxyUrl?: string | null
): Promise<CreateTiktokVideoInitResult> {
  const token = (params.accessToken || "").trim();
  if (!token) throw withTiktokStatus("Token do TikTok ausente — reconecte o canal", 401);
  const title = (params.title || "").trim();
  if (!title) throw withTiktokStatus("Título do TikTok é obrigatório", 400);
  if (title.length > TIKTOK_TITLE_MAX_LENGTH) throw withTiktokStatus(`Título excede ${TIKTOK_TITLE_MAX_LENGTH} caracteres`, 400);
  const privacy_level = (params.privacyLevel || "PUBLIC_TO_EVERYONE").trim() || "PUBLIC_TO_EVERYONE";
  if (privacy_level && !(TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(privacy_level as typeof TIKTOK_PRIVACY_LEVELS[number])) {
    throw withTiktokStatus(`Privacidade inválida: ${privacy_level}`, 400);
  }
  const v = validateTiktokVideo({
    title,
    titleLen: title.length,
    privacy: privacy_level,
    coverTimestampMs: params.videoCoverTimestampMs,
    ...(params.source.source === "FILE_UPLOAD" ? { size: params.source.video_size } : {}),
  });
  if (!v.valid) throw withTiktokStatus(v.error!, 400);

  const post_info: Record<string, unknown> = {
    title,
    privacy_level,
    disable_duet: Boolean(params.disableDuet),
    disable_stitch: Boolean(params.disableStitch),
    disable_comment: Boolean(params.disableComment),
  };
  if (typeof params.videoCoverTimestampMs === "number") post_info.video_cover_timestamp_ms = params.videoCoverTimestampMs;
  if (typeof params.brandContentToggle === "boolean") post_info.brand_content_toggle = params.brandContentToggle;
  if (typeof params.brandOrganicToggle === "boolean") post_info.brand_organic_toggle = params.brandOrganicToggle;

  let source_info: Record<string, unknown>;
  if (params.source.source === "FILE_UPLOAD") {
    if (!params.source.video_size || !params.source.chunk_size || !params.source.total_chunk_count) {
      throw withTiktokStatus("source_info FILE_UPLOAD exige video_size, chunk_size e total_chunk_count", 400);
    }
    source_info = {
      source: "FILE_UPLOAD",
      video_size: params.source.video_size,
      chunk_size: params.source.chunk_size,
      total_chunk_count: params.source.total_chunk_count,
    };
  } else {
    if (!params.source.video_url) throw withTiktokStatus("source_info PULL_FROM_URL exige video_url", 400);
    source_info = { source: "PULL_FROM_URL", video_url: params.source.video_url };
  }

  const body = JSON.stringify({ post_info, source_info });
  const res = await fetchWithTimeout(
    TIKTOK_VIDEO_INIT_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    },
    30_000,
    proxyUrl ?? null
  );
  const retryAfterMs = getTiktokRetryAfterMs(res.headers as unknown as Headers);
  let data: unknown;
  try { data = await res.json(); } catch { throw withTiktokStatus(`Resposta inválida do TikTok (HTTP ${res.status})`, res.status); }
  const json = data as Record<string, unknown>;
  const errorObj = json?.error as Record<string, unknown> | undefined;
  const dataObj = json?.data as Record<string, unknown> | undefined;
  const errorCode = (errorObj?.code as string | undefined) || (dataObj?.error_code as string | undefined);
  if (!res.ok || errorObj || errorCode) {
    const rawMsg = (errorObj?.message as string | undefined) || (dataObj?.description as string | undefined) || (json?.message as string | undefined) || `Falha ao iniciar upload no TikTok (HTTP ${res.status})`;
    const mapped = mapTiktokErrorToPortuguese(errorCode || rawMsg);
    throw new TiktokApiError(mapped, res.status, errorCode, retryAfterMs);
  }
  const publishId = String((dataObj?.publish_id as string | undefined) || (json?.publish_id as string | undefined) || (json?.data as Record<string, unknown> | undefined)?.publish_id || "");
  const uploadUrl = String((dataObj?.upload_url as string | undefined) || (json?.upload_url as string | undefined) || (json?.data as Record<string, unknown> | undefined)?.upload_url || "");
  if (!publishId) throw withTiktokStatus("TikTok não retornou publish_id", res.status);
  // PULL_FROM_URL não retorna upload_url — isso é esperado
  if (params.source.source === "FILE_UPLOAD" && !uploadUrl) throw withTiktokStatus("TikTok não retornou upload_url para FILE_UPLOAD", res.status);
  return { publishId, uploadUrl };
}

/**
 * PUT chunked upload com Content-Range + retry 1x em 429/5xx.
 * Cada chunk: PUT {uploadUrl} header Content-Range: bytes X-Y/Z
 */
export async function uploadTiktokChunks(
  uploadUrl: string,
  buffer: Buffer,
  chunkSize: number,
  proxyUrl?: string | null
): Promise<void> {
  if (!uploadUrl) throw withTiktokStatus("uploadUrl é obrigatório", 400);
  if (!buffer || buffer.length === 0) throw withTiktokStatus("Buffer de vídeo vazio", 400);
  const totalSize = buffer.length;
  const cs = Math.max(1, Math.floor(chunkSize || 0) || 10 * 1024 * 1024);
  const totalChunks = Math.ceil(totalSize / cs);
  for (let idx = 0; idx < totalChunks; idx++) {
    const start = idx * cs;
    const end = Math.min(start + cs, totalSize) - 1;
    const chunk = buffer.subarray(start, end + 1);
    let attempt = 0;
    while (true) {
      const res = await fetchWithTimeout(
        uploadUrl,
        {
          method: "PUT",
          headers: {
            "Content-Range": `bytes ${start}-${end}/${totalSize}`,
            "Content-Type": "video/mp4",
            "Content-Length": String(chunk.length),
          },
          body: chunk as unknown as BodyInit,
        },
        60_000,
        proxyUrl ?? null
      );
      if (res.ok) break;
      const shouldRetry = (res.status === 429 || res.status >= 500) && attempt === 0;
      if (shouldRetry) {
        attempt++;
        const retryAfter = getTiktokRetryAfterMs(res.headers as unknown as Headers);
        const delay = retryAfter != null ? Math.min(retryAfter, 5000) : 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      let detail = `Upload de chunk falhou (HTTP ${res.status})`;
      try {
        const txt = await res.text();
        if (txt) detail = txt.slice(0, 500);
      } catch {}
      const retryAfter = getTiktokRetryAfterMs(res.headers as unknown as Headers);
      const mapped = mapTiktokErrorToPortuguese(detail);
      throw new TiktokApiError(mapped, res.status, undefined, retryAfter);
    }
  }
}

/**
 * POST https://open.tiktokapis.com/v2/post/publish/status/fetch/
 * Body: { publish_id }
 * Retorna status do processamento.
 */
export interface TiktokPublishStatusResult {
  status: string;
  failReason?: string;
  publicUrl?: string;
  videoId?: string;
  raw: unknown;
}
export async function fetchTiktokPublishStatus(
  publishId: string,
  accessToken: string,
  proxyUrl?: string | null
): Promise<TiktokPublishStatusResult> {
  const token = (accessToken || "").trim();
  if (!token) throw withTiktokStatus("Token do TikTok ausente", 401);
  const pid = (publishId || "").trim();
  if (!pid) throw withTiktokStatus("publishId é obrigatório", 400);
  const res = await fetchWithTimeout(
    TIKTOK_STATUS_FETCH_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ publish_id: pid }),
    },
    15_000,
    proxyUrl ?? null
  );
  const retryAfterMs = getTiktokRetryAfterMs(res.headers as unknown as Headers);
  let data: unknown;
  try { data = await res.json(); } catch { throw new TiktokApiError(`Resposta inválida do TikTok ao consultar status (HTTP ${res.status})`, res.status, undefined, retryAfterMs); }
  const json = data as Record<string, unknown>;
  const errorObj = json?.error as Record<string, unknown> | undefined;
  const dataObj = (json?.data as Record<string, unknown> | undefined) || json;
  const errorCode = (errorObj?.code as string | undefined) || (dataObj?.error_code as string | undefined);
  if (!res.ok || errorObj || errorCode) {
    const rawMsg = (errorObj?.message as string | undefined) || (dataObj?.description as string | undefined) || (json?.message as string | undefined) || `Falha ao consultar status do TikTok (HTTP ${res.status})`;
    const mapped = mapTiktokErrorToPortuguese(errorCode || rawMsg);
    throw new TiktokApiError(mapped, res.status, errorCode, retryAfterMs);
  }
  // TikTok returns data: { status, fail_reason, public_url, video_id, ... } or similar
  const statusRaw = String((dataObj?.status as string | undefined) || (json?.status as string | undefined) || (json?.data as Record<string, unknown> | undefined)?.status || "PROCESSING");
  const status = statusRaw.toUpperCase();
  return {
    status,
    failReason: (dataObj?.fail_reason as string | undefined) || (dataObj?.failReason as string | undefined),
    publicUrl: (dataObj?.public_url as string | undefined) || (dataObj?.share_url as string | undefined),
    videoId: (dataObj?.video_id as string | undefined) || (dataObj?.videoId as string | undefined),
    raw: data,
  };
}


// Re-export proxy helpers for callers that import from tiktok module
export { getChannelProxyUrl, getProxyDispatcher };
