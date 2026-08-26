/**
 * Validação/normalização de youtube_options (Post do YouTube).
 * Compartilhado entre POST /api/posts e PATCH /api/posts/[id].
 */

const VALID_YOUTUBE_TYPES = ["short", "community"];
const VALID_YOUTUBE_PRIVACY = ["PUBLIC", "UNLISTED", "PRIVATE"];

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
 */
export function parseYoutubeOptions(raw: unknown): string | null {
	if (raw == null || raw === "") return null;
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
	if (obj.title !== undefined) clean.title = String(obj.title).slice(0, 100);
	if (obj.description !== undefined)
		clean.description = String(obj.description);
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
		if (obj[flag] !== undefined) clean[flag] = Boolean(obj[flag]);
	}
	if (obj.category_id !== undefined) {
		const categoryId = Number(obj.category_id);
		if (!Number.isInteger(categoryId))
			throw new Error("category_id deve ser um inteiro");
		clean.category_id = categoryId;
	}
	if (obj.pinned_comment_text !== undefined) {
		const text = String(obj.pinned_comment_text);
		clean.pinned_comment_text = text.trim() ? text : undefined;
	}
	return Object.keys(clean).length > 0 ? JSON.stringify(clean) : null;
}

export { VALID_YOUTUBE_TYPES, VALID_YOUTUBE_PRIVACY };
