/**
 * Validação/normalização de youtube_options (Post do YouTube).
 * Compartilhado entre POST /api/posts e PATCH /api/posts/[id].
 * BK-08 centraliza YT_TITLE_MAX, BK-14 limites, BK-18 regex/limite, BK-19 null padronizado
 */

import { escapeHtml } from "./sanitize";

export const YT_TITLE_MAX = 100;
export const YT_DESCRIPTION_MAX = 5000;
export const YT_PINNED_MAX = 10000;

const VALID_YOUTUBE_TYPES = ["short", "community"];
const VALID_YOUTUBE_PRIVACY = ["PUBLIC", "UNLISTED", "PRIVATE"];

// Regex para título/descrição: permite letras unicode, números, pontuação básica; bloqueia < > para XSS
const TITLE_SAFE_REGEX = /^[^<>]{1,100}$/;
const DESCRIPTION_SAFE_REGEX = /^[^<>]{0,5000}$/;
const PINNED_SAFE_REGEX = /^[^<>]{0,10000}$/;

interface YoutubeOptionsInput {
	title?: unknown;
	description?: unknown;
	privacy?: unknown;
	made_for_kids?: unknown;
	monetize_with_ads?: unknown;
	category_id?: unknown;
	pinned_comment_text?: unknown;
}

/**
 * Valida e normaliza youtube_options (objeto ou JSON string) para a forma
 * canônica gravada no banco: string JSON com chaves conhecidas. Retorna null
 * quando vazio; lança Error com mensagem PT-BR quando inválido.
 * BK-19: padroniza vazio/undefined/""/{} para null
 */
export function parseYoutubeOptions(raw: unknown): string | null {
	if (raw == null || raw === "" ) return null;
	if (typeof raw === "string") {
		const t = raw.trim();
		if (!t || t === "null" || t === "{}" || t === "[]") return null;
	}
	let obj: YoutubeOptionsInput;
	if (typeof raw === "string") {
		try {
			obj = JSON.parse(raw) as YoutubeOptionsInput;
		} catch {
			throw new Error("youtube_options deve ser um JSON válido");
		}
	} else if (typeof raw === "object" && !Array.isArray(raw)) {
		obj = raw as YoutubeOptionsInput;
	} else {
		throw new Error("youtube_options deve ser um objeto");
	}
	const clean: Record<string, unknown> = {};
	if (obj.title !== undefined) {
		let title = String(obj.title).trim();
		if (title.length === 0) {
			// título vazio não é salvo
		} else {
			if (title.length > YT_TITLE_MAX) title = title.slice(0, YT_TITLE_MAX);
			if (title.includes("<") || title.includes(">")) title = escapeHtml(title);
			if (!TITLE_SAFE_REGEX.test(title)) {
				throw new Error("title contém caracteres inválidos ou excede 100 caracteres");
			}
			clean.title = title;
		}
	}
	if (obj.description !== undefined) {
		let desc = String(obj.description);
		if (desc.length > YT_DESCRIPTION_MAX) desc = desc.slice(0, YT_DESCRIPTION_MAX);
		if (desc.includes("<") || desc.includes(">")) desc = escapeHtml(desc);
		if (!DESCRIPTION_SAFE_REGEX.test(desc)) throw new Error("description excede 5000 caracteres ou contém < >");
		clean.description = desc;
	}
	if (obj.privacy !== undefined) {
		const privacy = String(obj.privacy).toUpperCase();
		if (!VALID_YOUTUBE_PRIVACY.includes(privacy)) {
			throw new Error(
				"privacy do YouTube inválida (use PUBLIC, UNLISTED ou PRIVATE)",
			);
		}
		clean.privacy = privacy;
	}
	for (const flag of ["made_for_kids", "monetize_with_ads"] as const) {
		if (obj[flag] !== undefined) {
			// BK-21 FIX: Boolean("false") === true (invertido). Usar comparacao estrita string === "true"
			const raw = obj[flag];
			if (typeof raw === "boolean") clean[flag] = raw;
			else if (typeof raw === "string") clean[flag] = raw.toLowerCase() === "true";
			else if (typeof raw === "number") clean[flag] = raw === 1;
			else clean[flag] = String(raw).toLowerCase() === "true";
		}
	}
	if (obj.category_id !== undefined) {
		const categoryId = Number(obj.category_id);
		if (!Number.isInteger(categoryId) || categoryId < 0 || categoryId > 100)
			throw new Error("category_id deve ser um inteiro entre 0 e 100");
		clean.category_id = categoryId;
	}
	if (obj.pinned_comment_text !== undefined) {
		let text = String(obj.pinned_comment_text);
		if (!text.trim()) {
			// vazio vira undefined -> não salva
		} else {
			if (text.length > YT_PINNED_MAX) text = text.slice(0, YT_PINNED_MAX);
			if (text.includes("<") || text.includes(">")) text = escapeHtml(text);
			if (!PINNED_SAFE_REGEX.test(text)) throw new Error("pinned_comment_text excede 10000 caracteres ou contém < >");
			clean.pinned_comment_text = text.trim() ? text : undefined;
		}
	}
	const keys = Object.keys(clean).filter(k => clean[k] !== undefined);
	if (keys.length === 0) return null;
	return JSON.stringify(clean);
}

export { VALID_YOUTUBE_TYPES, VALID_YOUTUBE_PRIVACY };
