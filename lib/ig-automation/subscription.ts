/**
 * lib/ig-automation/subscription.ts — saúde/assinatura do webhook por canal
 * (spec §8).
 *
 * - `getChannelSubscriptionState`: consulta `GET /me/subscribed_apps` e
 *   classifica em `ok | partial | missing | token_invalid | error`.
 * - `ensureSubscription`: re-assina de forma idempotente
 *   (`POST /me/subscribed_apps`) e persiste `IgChannelState`.
 * - `refreshAllSubscriptions`: varre os canais IG do usuário (best-effort —
 *   um canal com token inválido não impede os outros).
 *
 * Nunca devolve/loga token.
 */
import { prisma } from "@/lib/prisma";
import {
	getSubscribedFields,
	resolveGraphContext,
	subscribeAccountFields,
	type GraphResult,
} from "@/lib/ig-automation/graph";

export const REQUIRED_SUBSCRIPTION_FIELDS = [
	"comments",
	"messages",
	"messaging_postbacks",
] as const;

export type IgSubscriptionStatus =
	| "ok"
	| "partial"
	| "missing"
	| "token_invalid"
	| "error";

export interface IgSubscriptionChannel {
	id: string;
	account_id: string | null;
	access_token: string | null;
	proxy_url?: string | null;
	proxy_enabled?: boolean | null;
}

export interface ChannelSubscriptionState {
	fields: string[];
	status: IgSubscriptionStatus;
	error?: string;
}

export interface EnsureSubscriptionResult {
	ok: boolean;
	fields: string[];
	status: IgSubscriptionStatus;
	error?: string;
}

export interface ChannelSubscriptionSummary {
	channelId: string;
	name: string;
	status: IgSubscriptionStatus;
	fields: string[];
	error?: string;
}

function shortError(error: unknown): string {
	if (error instanceof Error && error.message.trim()) {
		return error.message.trim().slice(0, 300);
	}
	return "Erro inesperado.";
}

/** Code 190 / OAuthException / 401 = token inválido (não é falha de rede). */
function isTokenInvalid(result: GraphResult): boolean {
	if (result.ok) return false;
	if (result.status === 401) return true;
	const data = result.data;
	if (data !== null && typeof data === "object") {
		const apiError = (data as { error?: unknown }).error;
		if (apiError !== null && typeof apiError === "object") {
			const code = (apiError as { code?: unknown }).code;
			if (code === 190 || code === "190") return true;
			const type = (apiError as { type?: unknown }).type;
			if (typeof type === "string" && /OAuthException/i.test(type)) return true;
		}
	}
	const message = result.error ?? "";
	return /oauthexception|access token|session has expired|invalid oauth|reauthorization/i.test(
		message,
	);
}

/** Extrai `subscribed_fields` da resposta `{data:[{subscribed_fields:[...]}]}`. */
function extractSubscribedFields(data: unknown): string[] {
	const found = new Set<string>();
	const collect = (item: unknown): void => {
		if (item === null || typeof item !== "object") return;
		const fields = (item as { subscribed_fields?: unknown }).subscribed_fields;
		if (!Array.isArray(fields)) return;
		for (const field of fields) {
			if (typeof field === "string" && field.trim() !== "") {
				found.add(field.trim());
			}
		}
	};
	if (data !== null && typeof data === "object" && !Array.isArray(data)) {
		const list = (data as { data?: unknown }).data;
		if (Array.isArray(list)) {
			for (const item of list) collect(item);
		} else {
			collect(data);
		}
	}
	return [...found];
}

function classifyFields(fields: string[]): IgSubscriptionStatus {
	const present = REQUIRED_SUBSCRIPTION_FIELDS.filter((field) =>
		fields.includes(field),
	).length;
	if (present === REQUIRED_SUBSCRIPTION_FIELDS.length) return "ok";
	if (present > 0) return "partial";
	return "missing";
}

/**
 * Estado real da assinatura na Graph API. Nunca lança.
 */
export async function getChannelSubscriptionState(
	channel: IgSubscriptionChannel,
): Promise<ChannelSubscriptionState> {
	try {
		const ctx = await resolveGraphContext(channel);
		const result = await getSubscribedFields(ctx);
		if (!result.ok) {
			return {
				fields: [],
				status: isTokenInvalid(result) ? "token_invalid" : "error",
				error:
					result.error ||
					"Falha ao consultar a assinatura do webhook na Graph API.",
			};
		}
		const fields = extractSubscribedFields(result.data);
		return { fields, status: classifyFields(fields) };
	} catch (error) {
		return {
			fields: [],
			status: "error",
			error: shortError(error),
		};
	}
}

/** Campos já persistidos (token_invalid não pode apagar o histórico). */
async function loadStoredFields(channelId: string): Promise<string[] | null> {
	try {
		const row = await prisma.igChannelState.findUnique({
			where: { channel_id: channelId },
			select: { subscribed_fields: true },
		});
		if (typeof row?.subscribed_fields !== "string") return null;
		try {
			const parsed: unknown = JSON.parse(row.subscribed_fields);
			if (!Array.isArray(parsed)) return null;
			return parsed
				.filter((field): field is string => typeof field === "string")
				.map((field) => field.trim())
				.filter(Boolean);
		} catch {
			return null;
		}
	} catch {
		return null;
	}
}

async function persistChannelState(
	channelId: string,
	fields: string[],
	status: IgSubscriptionStatus,
	error: string | null,
): Promise<void> {
	try {
		await prisma.igChannelState.upsert({
			where: { channel_id: channelId },
			create: {
				channel_id: channelId,
				subscribed_fields: JSON.stringify(fields),
				last_checked_at: new Date(),
				status,
				last_error: error,
			},
			update: {
				subscribed_fields: JSON.stringify(fields),
				last_checked_at: new Date(),
				status,
				last_error: error,
			},
		});
	} catch (persistError) {
		console.error(
			"[ig-automation] persistChannelState falhou:",
			persistError instanceof Error ? persistError.name : "Error",
		);
	}
}

/**
 * Garante a assinatura (`comments,messages,messaging_postbacks`), re-checa o
 * estado real e persiste em `IgChannelState`. Nunca lança; erro vira status.
 */
export async function ensureSubscription(
	channel: IgSubscriptionChannel,
): Promise<EnsureSubscriptionResult> {
	const required = [...REQUIRED_SUBSCRIPTION_FIELDS];
	try {
		const ctx = await resolveGraphContext(channel);
		const post = await subscribeAccountFields(ctx, required);
		if (!post.ok) {
			const status: IgSubscriptionStatus = isTokenInvalid(post)
				? "token_invalid"
				: "error";
			const error = post.error || "Falha ao assinar os campos do webhook.";
			// F-14: com token inválido, preserva os campos já persistidos.
			const fields =
				status === "token_invalid"
					? ((await loadStoredFields(channel.id)) ?? [])
					: [];
			await persistChannelState(channel.id, fields, status, error);
			return { ok: false, fields, status, error };
		}

		const state = await getChannelSubscriptionState(channel);
		const ok = state.status === "ok";
		// F-14: token_invalid não pode zerar os campos já persistidos.
		const fields =
			state.status === "token_invalid" && state.fields.length === 0
				? ((await loadStoredFields(channel.id)) ?? [])
				: state.fields;
		await persistChannelState(
			channel.id,
			fields,
			state.status,
			state.error ?? null,
		);
		return {
			ok,
			fields,
			status: state.status,
			error: state.error,
		};
	} catch (error) {
		const message = shortError(error);
		await persistChannelState(channel.id, [], "error", message);
		return { ok: false, fields: [], status: "error", error: message };
	}
}

/**
 * Re-checa/re-assina todos os canais IG do usuário. Best-effort: nunca lança e
 * um canal com token inválido não interrompe os demais.
 */
export async function refreshAllSubscriptions(
	userId: string,
): Promise<ChannelSubscriptionSummary[]> {
	let channels: Array<{
		id: string;
		name: string;
		account_id: string | null;
		access_token: string | null;
		proxy_url: string | null;
		proxy_enabled: boolean | null;
	}>;
	try {
		channels = await prisma.channel.findMany({
			where: { user_id: userId, platform: "instagram" },
			orderBy: { created_at: "asc" },
			select: {
				id: true,
				name: true,
				account_id: true,
				access_token: true,
				proxy_url: true,
				proxy_enabled: true,
			},
		});
	} catch (error) {
		console.error(
			"[ig-automation] refreshAllSubscriptions falhou:",
			shortError(error),
		);
		return [];
	}

	const summaries: ChannelSubscriptionSummary[] = [];
	for (const channel of channels) {
		try {
			const result = await ensureSubscription(channel);
			summaries.push({
				channelId: channel.id,
				name: channel.name,
				status: result.status,
				fields: result.fields,
				error: result.error,
			});
		} catch (error) {
			summaries.push({
				channelId: channel.id,
				name: channel.name,
				status: "error",
				fields: [],
				error: shortError(error),
			});
		}
	}
	return summaries;
}
