import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

const BASE62 =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SLUG_LENGTH = 8;
const MAX_SLUG_ATTEMPTS = 5;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

/** Allowlist de destino: só http/https pode virar link curto ou redirecionar. */
export function isHttpUrl(url: unknown): boolean {
	return typeof url === "string" && HTTP_URL_RE.test(url.trim());
}

export interface IgUtmParams {
	source?: string;
	medium?: string;
	campaign?: string;
	content?: string;
	term?: string;
}

export interface CreateClickLinkParams {
	userId: string;
	channelId?: string | null;
	automationId?: string | null;
	contactId?: string | null;
	targetUrl: string;
	utm?: IgUtmParams;
}

function generateSlug(length = SLUG_LENGTH): string {
	const bytes = randomBytes(length);
	let slug = "";
	for (let i = 0; i < length; i++) {
		slug += BASE62[bytes[i] % BASE62.length];
	}
	return slug;
}

function publicBaseUrl(): string {
	const base = (process.env.PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || "")
		.trim()
		.replace(/\/+$/, "");
	return base;
}

function isUniqueViolation(err: unknown): boolean {
	return (
		!!err &&
		typeof err === "object" &&
		(err as { code?: unknown }).code === "P2002"
	);
}

export async function createClickLink(
	params: CreateClickLinkParams,
): Promise<string> {
	const targetUrl = String(params.targetUrl || "").trim();
	if (!targetUrl) {
		throw new Error("URL de destino vazia — configure o link na ação.");
	}
	// Alvo não http(s) não ganha slug: devolve a própria URL (sem tracking).
	if (!isHttpUrl(targetUrl)) return targetUrl;

	let slug = "";
	let created = false;
	for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !created; attempt++) {
		slug = generateSlug();
		try {
			await prisma.igClick.create({
				data: {
					user_id: params.userId,
					channel_id: params.channelId || null,
					automation_id: params.automationId || null,
					contact_id: params.contactId || null,
					slug,
					target_url: targetUrl,
					utm_source: params.utm?.source || null,
					utm_medium: params.utm?.medium || null,
					utm_campaign: params.utm?.campaign || null,
				},
			});
			created = true;
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
		}
	}
	if (!created) {
		throw new Error("Não foi possível gerar um link curto único — tente novamente.");
	}

	const base = publicBaseUrl();
	return base ? `${base}/r/${slug}` : `/r/${slug}`;
}

export function appendUtm(url: string, utm: IgUtmParams): string {
	const raw = String(url || "").trim();
	if (!raw) return raw;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return raw;
	}
	const entries: [string, string | undefined][] = [
		["utm_source", utm.source],
		["utm_medium", utm.medium],
		["utm_campaign", utm.campaign],
		["utm_content", utm.content],
		["utm_term", utm.term],
	];
	for (const [key, value] of entries) {
		if (typeof value !== "string" || !value.trim()) continue;
		if (parsed.searchParams.has(key)) continue;
		parsed.searchParams.set(key, value.trim());
	}
	return parsed.toString();
}
