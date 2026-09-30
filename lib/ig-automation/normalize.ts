/**
 * lib/ig-automation/normalize.ts — normalização de texto, quiet hours e
 * templates. Módulo PURO (client-safe, sem DB/rede).
 *
 * Contrato (spec §6.1):
 *   normalizeText(s)              → minúsculas, NFD sem acentos, remove `[^a-z0-9]`
 *   normalizeForWordBoundary(s)   → minúsculas + sem acentos (mantém espaços)
 *   isQuietNow(quiet, at, tz?)    → janela de silêncio (cruza meia-noite)
 *   applyTemplate(text, vars)     → placeholders `{chave}`; ausente fica intacto
 */
import type { IgQuietHours, IgRenderVars } from "@/lib/ig-automation/types";

export const DEFAULT_QUIET_TZ = "America/Bahia";

/**
 * Minúsculas, sem acentos e sem NENHUM caractere não alfanumérico
 * (espaços/pontuação somem) — usado para substring matching.
 */
export function normalizeText(input: string): string {
	if (typeof input !== "string") return "";
	return input
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

/**
 * Minúsculas + sem acentos, preservando espaços/pontuação — usado para
 * word boundary (`\b`) e contains "com palavras".
 */
export function normalizeForWordBoundary(input: string): string {
	if (typeof input !== "string") return "";
	return input
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

/** "23:00" → 1380 (minutos desde 00:00); inválido → null. */
function parseHhMm(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = HHMM_RE.exec(value.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
	return hours * 60 + minutes;
}

/** Minutos desde 00:00 locais no fuso `tz`; null se o fuso for inválido. */
function localMinutes(at: Date, tz: string): number | null {
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		const parts = formatter.formatToParts(at);
		const hour = parts.find((part) => part.type === "hour")?.value;
		const minute = parts.find((part) => part.type === "minute")?.value;
		if (hour === undefined || minute === undefined) return null;
		const h = Number(hour);
		const m = Number(minute);
		if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
		return h * 60 + m;
	} catch {
		return null;
	}
}

/**
 * true quando `at` está dentro da janela de silêncio. Cruza meia-noite
 * (ex.: 23:00→07:00). `quiet` nulo/inválido → false. Fuso default
 * `America/Bahia`; fuso inválido cai para o default e, em último caso,
 * para a hora local do servidor.
 *
 * `start === end` é rejeitado na entrada (400 em validate.ts); se aparecer
 * em dado legado, é tratado defensivamente como janela vazia (sem silêncio).
 */
export function isQuietNow(
	quiet: IgQuietHours | null | undefined,
	at: Date,
	defaultTz: string = DEFAULT_QUIET_TZ,
): boolean {
	if (!quiet || typeof quiet !== "object") return false;
	const start = parseHhMm(quiet.start);
	const end = parseHhMm(quiet.end);
	if (start === null || end === null || start === end) return false;

	const when =
		at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
	const tz =
		typeof quiet.tz === "string" && quiet.tz.trim() !== ""
			? quiet.tz.trim()
			: defaultTz;

	let now = localMinutes(when, tz);
	if (now === null && tz !== defaultTz) now = localMinutes(when, defaultTz);
	if (now === null) now = when.getHours() * 60 + when.getMinutes();

	if (start < end) return now >= start && now < end;
	return now >= start || now < end;
}

function lookupVar(vars: IgRenderVars, key: string): string | undefined {
	const direct = vars[key];
	if (typeof direct === "string") return direct;
	if (!key.includes(".")) return undefined;
	let current: unknown = vars;
	for (const part of key.split(".")) {
		if (current !== null && typeof current === "object") {
			current = (current as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}
	if (typeof current === "string") return current;
	if (typeof current === "number" || typeof current === "boolean") {
		return String(current);
	}
	return undefined;
}

/**
 * Substitui placeholders `{chave}` pelos valores de `vars`. Chave resolvida
 * para `undefined`/`null` permanece como `{chave}` (intacta). Aceita chave
 * pontuada direta ("substancia.nome") ou objeto aninhado.
 */
export function applyTemplate(text: string, vars: IgRenderVars): string {
	if (typeof text !== "string" || text.length === 0) return "";
	const table: IgRenderVars =
		vars !== null && typeof vars === "object" ? vars : {};
	return text.replace(/\{([^{}]+)\}/g, (match, rawKey: string) => {
		const key = rawKey.trim();
		if (!key) return match;
		const value = lookupVar(table, key);
		return value === undefined ? match : value;
	});
}
