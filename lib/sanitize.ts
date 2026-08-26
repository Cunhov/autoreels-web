/**
 * Helpers centralizados de sanitização/validação (BK-07, BK-14, BK-16, BK-18, BK-19).
 * PUBLIC: mantém compatibilidade.
 */

export const YT_TITLE_MAX = 100;
export const CAPTION_MAX = 2200;
export const DESCRIPTION_MAX = 5000;
export const PINNED_MAX = 10000;

export const CHANNEL_NAME_MAX = 80;
export const PLANNER_NAME_MAX = 80;

// Regex IG/Youtube
export const IG_USERNAME_REGEX = /^[a-zA-Z0-9._]{1,30}$/;
export const YT_LABEL_REGEX = /^[\p{L}\p{N} \-_]{1,80}$/u;
export const YOUTUBE_TITLE_REGEX = /^[\p{L}\p{N}\p{P}\p{S} ]{1,100}$/u;

/** Escape HTML para evitar XSS em título/caption/tags. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Sanitiza texto: trim, escape HTML, limita tamanho. */
export function sanitizeText(input: unknown, maxLength: number): string {
  const str = String(input ?? "");
  const escaped = escapeHtml(str.trim());
  return escaped.slice(0, maxLength);
}

/** Sanitiza mantendo espaços internos mas removendo tags HTML perigosas e limitando. */
export function sanitizeWithLimit(input: unknown, maxLength: number): string {
  return sanitizeText(input, maxLength);
}

/** Valida e sanitiza nome (trim check, maxLength, escape). Retorna null se inválido (só espaços). */
export function validateName(
  input: unknown,
  max = CHANNEL_NAME_MAX,
): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return escapeHtml(trimmed).slice(0, max);
}

/** safeJsonParse: retorna fallback em vez de throw. */
export function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Verifica se valor é string não-vazia após trim. */
export function isNonEmptyTrimmed(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Valida MIME e tamanho para video/image (BK-15). */
export const ALLOWED_VIDEO_MIMES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/x-matroska",
  "video/3gpp",
  "video/mpeg",
];
export const ALLOWED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
];

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

export function validateFileTypeAndSize(
  file: File,
  kind: "video" | "image",
): string | null {
  if (kind === "video") {
    if (
      file.type &&
      !file.type.startsWith("video/") &&
      !ALLOWED_VIDEO_MIMES.includes(file.type)
    ) {
      return `Tipo de vídeo não suportado: ${file.type || "desconhecido"}`;
    }
    if (file.size > MAX_VIDEO_BYTES)
      return `Vídeo excede ${MAX_VIDEO_BYTES / 1024 / 1024}MB`;
  } else {
    if (
      file.type &&
      !ALLOWED_IMAGE_MIMES.includes(file.type) &&
      !file.type.startsWith("image/")
    ) {
      return `Tipo de imagem não suportado: ${file.type}`;
    }
    if (file.size > MAX_IMAGE_BYTES)
      return `Imagem excede ${MAX_IMAGE_BYTES / 1024 / 1024}MB`;
  }
  return null;
}

/** Valida community image count: retorna mensagem unificada (PT-BR plural correto) */
export function communityImageMessage(count: number): string {
  if (count === 0) return "0 imagens — post somente texto (OK)";
  if (count === 1) return "1 imagem — envio multipart";
  if (count >= 2 && count <= 10) return `${count} imagens — envio multipart`;
  return `Limite de 10 imagens — ${count - 10} descartada(s). Remova uma imagem para adicionar outra.`;
}

export function formatImageCount(count: number): string {
  return count === 1 ? "1 imagem" : `${count} imagens`;
}

/** Trunca youtube_options para null padronizado (BK-19). */
export function normalizeYoutubeOptions(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "null" || trimmed === "{}" || trimmed === "[]")
      return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        !parsed ||
        (typeof parsed === "object" && Object.keys(parsed).length === 0)
      )
        return null;
      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) return null;
    return JSON.stringify(value);
  }
  return null;
}
