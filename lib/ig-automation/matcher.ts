/**
 * lib/ig-automation/matcher.ts — matching de keywords/substâncias e rotação
 * de variants. Módulo PURO (client-safe, sem DB/rede).
 *
 * Contrato (spec §5/§6.2):
 *   matchText(text, keywords, mode, matchType, negatives?) → boolean
 *     - contains/exact/starts_with: texto e keyword normalizados (sem acento,
 *       minúsculos); exact usa o normalizado "colado" (ignora pontuação),
 *       contains/starts_with preservam espaços.
 *     - regex: `new RegExp(keyword, "i")` no texto ORIGINAL; regex inválida
 *       simplesmente não casa (nunca lança).
 *     - negatives: contains normalizado; qualquer negativa que case → false.
 *     - keyword vazia / lista vazia = match universal.
 *   matchSubstance(text, substances) → primeiro item que casar + campos PT
 *     - keyword normalizada com >= 4 chars → substring no texto normalizado;
 *     - < 4 chars → word boundary (`\b`) no texto sem acento (com espaços).
 *   parseSubstanceKeywords(raw) → string[]
 *   pickVariant(variants, lastUsed?) → string (aleatória, evita a última)
 */
import {
	normalizeForWordBoundary,
	normalizeText,
} from "@/lib/ig-automation/normalize";
import type {
	IgMatchMode,
	IgMatchType,
	IgSubstanceInput,
	IgSubstanceMatch,
} from "@/lib/ig-automation/types";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function negativeMatches(text: string, negative: string): boolean {
	if (typeof negative !== "string") return false;
	const normalized = normalizeForWordBoundary(negative).trim();
	if (normalized === "") return false;
	return normalizeForWordBoundary(text).includes(normalized);
}

function keywordMatches(
	text: string,
	keyword: string,
	matchType: IgMatchType,
): boolean {
	if (typeof keyword !== "string") return false;
	if (keyword === "") return true; // keyword vazia = match universal

	if (matchType === "regex") {
		try {
			return new RegExp(keyword, "i").test(text);
		} catch {
			return false; // regex inválida nunca casa
		}
	}

	const normalizedText = normalizeForWordBoundary(text);
	const normalizedKeyword = normalizeForWordBoundary(keyword).trim();
	if (normalizedKeyword === "") return true;

	if (matchType === "exact") {
		return normalizeText(text) === normalizeText(keyword);
	}
	if (matchType === "starts_with") {
		return normalizedText.trim().startsWith(normalizedKeyword);
	}
	return normalizedText.includes(normalizedKeyword); // contains (default)
}

/**
 * Mode "any": ≥1 keyword casa; "all": todas casam. Negativas são avaliadas
 * antes (qualquer negativa que case derruba o match).
 */
export function matchText(
	text: string,
	keywords: string[],
	mode: IgMatchMode,
	matchType: IgMatchType,
	negatives?: string[],
): boolean {
	const source = typeof text === "string" ? text : "";

	if (Array.isArray(negatives)) {
		for (const negative of negatives) {
			if (negativeMatches(source, negative)) return false;
		}
	}

	const list = Array.isArray(keywords) ? keywords : [];
	if (list.length === 0) return true; // sem keywords = universal

	const type: IgMatchType =
		matchType === "exact" ||
		matchType === "starts_with" ||
		matchType === "regex"
			? matchType
			: "contains";

	if (mode === "all") {
		return list.every((keyword) => keywordMatches(source, keyword, type));
	}
	return list.some((keyword) => keywordMatches(source, keyword, type));
}

function splitSubstanceList(raw: string): string[] {
	return raw
		.split(/[,;\n|]+/)
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

/**
 * Interpreta o campo `keywords` da substância (JSON string[]). Aceita também
 * string simples separada por vírgula/; /linha/| — nunca lança.
 */
export function parseSubstanceKeywords(
	raw: string | string[] | null | undefined,
): string[] {
	if (Array.isArray(raw)) {
		return raw
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter((item) => item !== "");
	}
	if (typeof raw !== "string") return [];
	const trimmed = raw.trim();
	if (trimmed === "") return [];
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (Array.isArray(parsed)) {
			return parsed
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter((item) => item !== "");
		}
		if (typeof parsed === "string") return splitSubstanceList(parsed);
	} catch {
		// não é JSON — cai no split tolerante abaixo
	}
	return splitSubstanceList(trimmed);
}

function substanceTermMatches(
	term: string,
	normalizedText: string,
	boundaryText: string,
): boolean {
	if (typeof term !== "string") return false;
	const normalized = normalizeText(term);
	if (normalized === "") return false;

	if (normalized.length >= 4) {
		return normalizedText.includes(normalized);
	}

	const boundary = normalizeForWordBoundary(term).trim();
	if (boundary === "") return false;
	try {
		return new RegExp(`\\b${escapeRegExp(boundary)}\\b`).test(boundaryText);
	} catch {
		return false;
	}
}

/**
 * Regra n8n: primeiro item do catálogo que casar vence. Cada item é testado
 * pela keyword principal e pelos sinônimos (`keywords`).
 */
export function matchSubstance(
	text: string,
	substances: IgSubstanceInput[],
): IgSubstanceMatch | null {
	const source = typeof text === "string" ? text : "";
	if (source.trim() === "") return null;
	if (!Array.isArray(substances) || substances.length === 0) return null;

	const normalizedText = normalizeText(source);
	const boundaryText = normalizeForWordBoundary(source);

	for (const substance of substances) {
		if (!substance || typeof substance !== "object") continue;
		const terms = [
			substance.keyword,
			...parseSubstanceKeywords(substance.keywords),
		];
		const matched = terms.some((term) =>
			substanceTermMatches(term, normalizedText, boundaryText),
		);
		if (!matched) continue;
		return {
			...substance,
			nome: substance.name ?? "",
			url: substance.url ?? "",
			descricao: substance.description ?? "",
			acao: substance.action ?? "",
			dosagem: substance.dosage ?? "",
			duracao: substance.duration ?? "",
		};
	}
	return null;
}

/**
 * Rotação aleatória de variants evitando repetir `lastUsed` quando houver
 * mais de uma opção utilizável. Sem variants → "".
 */
export function pickVariant(
	variants: string[],
	lastUsed?: string | null,
): string {
	if (!Array.isArray(variants)) return "";
	const usable = variants.filter(
		(variant): variant is string =>
			typeof variant === "string" && variant.length > 0,
	);
	if (usable.length === 0) return "";
	if (usable.length === 1) return usable[0];

	const candidates =
		typeof lastUsed === "string"
			? usable.filter((variant) => variant !== lastUsed)
			: usable;
	const pool = candidates.length > 0 ? candidates : usable;
	return pool[Math.floor(Math.random() * pool.length)];
}
