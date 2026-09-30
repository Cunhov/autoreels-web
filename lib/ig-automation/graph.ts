import {
	GRAPH_API_VERSION,
	fetchWithTimeout,
	getGraphBaseUrl,
	resolveAccessToken,
} from "@/lib/instagram";
import type { IgButton, IgQuickReply } from "@/lib/ig-automation/types";

const GRAPH_TIMEOUT_MS = 15_000;

export interface IgGraphChannel {
	id?: string;
	account_id: string | null;
	access_token: string | null;
	proxy_url?: string | null;
	proxy_enabled?: boolean | null;
}

export interface IgGraphContext {
	token: string;
	base: string;
	version: string;
	proxyUrl?: string;
	accountId: string;
}

export interface GraphResult {
	ok: boolean;
	status: number;
	data?: unknown;
	error?: string;
	/**
	 * Sucesso PARCIAL (ex.: `dm_media` entregou a mídia mas o texto falhou):
	 * a ação segue `ok`, mas o warning fica disponível para o caller registrar.
	 */
	warning?: string;
}

export async function resolveGraphContext(
	channel: IgGraphChannel,
): Promise<IgGraphContext> {
	const token = await resolveAccessToken(channel.access_token ?? null);
	const base = getGraphBaseUrl(token);
	const proxyUrl =
		channel.proxy_enabled !== false ? channel.proxy_url ?? undefined : undefined;
	return {
		token,
		base,
		version: GRAPH_API_VERSION,
		proxyUrl,
		accountId: channel.account_id ?? "",
	};
}

/**
 * Traduz os erros mais comuns da API de Mensagens/Comentários para PT-BR
 * (janela de 24h do Direct, private reply duplicado/expirado de 7 dias).
 * Mantém o texto original entre parênteses para diagnóstico.
 */
function translateGraphError(
	message: string,
	code?: number,
	subcode?: number,
): string {
	const raw = message.replace(/\s+/g, " ").trim();
	const detail = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
	if (
		code === 2534014 ||
		subcode === 2534014 ||
		/outside (of )?(the )?.*(24.?hour|window)|messaging window|allowed window/i.test(raw)
	) {
		return `Fora da janela de 24h do Direct — o contato precisa enviar uma nova mensagem. (Meta: ${detail})`;
	}
	if (
		/private repl(y|ies)/i.test(raw) &&
		/(already|only one|expire|7.?day|older)/i.test(raw)
	) {
		return `Não foi possível enviar a resposta privada — o comentário já recebeu uma resposta privada ou passou de 7 dias. (Meta: ${detail})`;
	}
	if (/message receiving (is )?(disabled|turned off)|does not accept messages/i.test(raw)) {
		return `O contato não aceita mensagens do perfil no momento. (Meta: ${detail})`;
	}
	return message.trim();
}

function extractGraphError(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const err = (data as { error?: unknown }).error;
	if (typeof err === "string" && err.trim()) return err.trim();
	if (err && typeof err === "object") {
		const message = (err as { message?: unknown }).message;
		const code = (err as { code?: unknown }).code;
		const subcode = (err as { error_subcode?: unknown }).error_subcode;
		if (typeof message === "string" && message.trim()) {
			return translateGraphError(
				message,
				typeof code === "number" ? code : undefined,
				typeof subcode === "number" ? subcode : undefined,
			);
		}
	}
	return undefined;
}

function describeNetworkError(err: unknown): string {
	if (err instanceof Error && err.name === "AbortError") {
		return `Tempo esgotado ao chamar a Graph API (${GRAPH_TIMEOUT_MS / 1000}s).`;
	}
	const reason = err instanceof Error ? err.message : String(err ?? "");
	if (/aborted|abort/i.test(reason)) {
		return `Tempo esgotado ao chamar a Graph API (${GRAPH_TIMEOUT_MS / 1000}s).`;
	}
	return "Falha de rede ao chamar a Graph API.";
}

async function graphRequest(
	ctx: IgGraphContext,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
): Promise<GraphResult> {
	const url = `${ctx.base}/${ctx.version}/${path.replace(/^\/+/, "")}`;
	try {
		const res = await fetchWithTimeout(
			url,
			{
				method,
				headers: {
					Authorization: `Bearer ${ctx.token}`,
					...(body !== undefined
						? { "Content-Type": "application/json" }
						: {}),
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			},
			GRAPH_TIMEOUT_MS,
			ctx.proxyUrl,
		);

		const raw = await res.text();
		let data: unknown;
		try {
			data = raw ? JSON.parse(raw) : undefined;
		} catch {
			data = raw || undefined;
		}

		const apiError = extractGraphError(data);
		if (!res.ok || apiError) {
			return {
				ok: false,
				status: res.status,
				data,
				error: apiError || `A Graph API respondeu erro HTTP ${res.status}.`,
			};
		}
		return { ok: true, status: res.status, data };
	} catch (err) {
		return { ok: false, status: 0, error: describeNetworkError(err) };
	}
}

function isHttpUrl(value: unknown): value is string {
	return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function buttonTemplate(
	text: string | undefined,
	buttons: IgButton[],
	allowPostback: boolean,
): Record<string, unknown> | null {
	const mapped: Record<string, unknown>[] = [];
	for (const button of buttons) {
		if (!button || typeof button.title !== "string" || !button.title.trim())
			continue;
		// Limite da Meta para título de botão (IG): 20 caracteres.
		const title = button.title.trim().slice(0, 20);
		if (button.type === "postback" && allowPostback) {
			if (typeof button.payload !== "string" || !button.payload.trim()) continue;
			mapped.push({
				type: "postback",
				title,
				payload: button.payload.slice(0, 1000),
			});
			continue;
		}
		if (isHttpUrl(button.url)) {
			mapped.push({ type: "web_url", url: button.url.trim(), title });
		}
	}
	if (!mapped.length) return null;
	return {
		attachment: {
			type: "template",
			payload: {
				template_type: "button",
				// Limite da Meta para o texto do template: 640 caracteres.
				text: (text ?? "").slice(0, 640),
				buttons: mapped.slice(0, 3),
			},
		},
	};
}

function normalizeQuickReplies(
	quickReplies: IgQuickReply[],
): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const qr of quickReplies) {
		if (!qr || typeof qr.title !== "string" || !qr.title.trim()) continue;
		out.push({
			content_type: "text",
			title: qr.title.trim().slice(0, 20),
			payload:
				typeof qr.payload === "string" && qr.payload.trim()
					? qr.payload.trim().slice(0, 1000)
					: qr.title.trim().slice(0, 20),
		});
		if (out.length >= 13) break;
	}
	return out;
}

function isEmptyPayload(message: Record<string, unknown>): boolean {
	const text = message.text;
	return (
		typeof text !== "string" || !text.trim()
	) && !message.attachment;
}

export async function replyToComment(
	ctx: IgGraphContext,
	commentId: string,
	message: string,
): Promise<GraphResult> {
	return graphRequest(
		ctx,
		"POST",
		`${encodeURIComponent(commentId)}/replies`,
		{ message },
	);
}

export async function sendPrivateReply(
	ctx: IgGraphContext,
	commentId: string,
	msg: { text?: string; buttons?: IgButton[] },
): Promise<GraphResult> {
	const message: Record<string, unknown> = {};
	const template = msg.buttons?.length
		? buttonTemplate(msg.text, msg.buttons, false)
		: null;
	if (template) {
		Object.assign(message, template);
	} else {
		message.text = msg.text ?? "";
	}
	if (!ctx.accountId) {
		return {
			ok: false,
			status: 0,
			error: "Canal sem account_id configurado — reconecte a conta do Instagram.",
		};
	}
	if (isEmptyPayload(message)) {
		return {
			ok: false,
			status: 0,
			error: "Mensagem vazia — configure um texto ou botão válido na ação.",
		};
	}
	return graphRequest(ctx, "POST", `${ctx.accountId}/messages`, {
		recipient: { comment_id: commentId },
		message,
	});
}

export async function sendDM(
	ctx: IgGraphContext,
	igUserId: string,
	msg: {
		text?: string;
		buttons?: IgButton[];
		quickReplies?: IgQuickReply[];
		mediaUrl?: string;
	},
): Promise<GraphResult> {
	if (!ctx.accountId) {
		return {
			ok: false,
			status: 0,
			error: "Canal sem account_id configurado — reconecte a conta do Instagram.",
		};
	}
	// dm_media com texto: DUAS mensagens (attachment e depois o texto) — a API
	// do IG não aceita anexo + texto na mesma mensagem. Falha no attachment →
	// retorna o erro (nada foi entregue). Falha só no texto, com a mídia já
	// entregue → retorna OK + `warning`: retentar a ação duplicaria a mídia.
	const mediaUrl = isHttpUrl(msg.mediaUrl) ? msg.mediaUrl.trim() : "";
	const text = typeof msg.text === "string" ? msg.text : "";
	if (mediaUrl && text.trim()) {
		const mediaResult = await graphRequest(
			ctx,
			"POST",
			`${ctx.accountId}/messages`,
			{
				recipient: { id: igUserId },
				message: { attachment: { type: "image", payload: { url: mediaUrl } } },
			},
		);
		if (!mediaResult.ok) return mediaResult;
		const textResult = await graphRequest(
			ctx,
			"POST",
			`${ctx.accountId}/messages`,
			{ recipient: { id: igUserId }, message: { text } },
		);
		if (!textResult.ok) {
			const warning =
				textResult.error ||
				"Falha ao enviar o texto após a mídia (a mídia foi entregue).";
			console.warn("[ig-graph] dm_media: mídia entregue, texto falhou:", warning);
			return { ...mediaResult, warning };
		}
		return textResult;
	}
	const message: Record<string, unknown> = {};
	if (mediaUrl) {
		message.attachment = {
			type: "image",
			payload: { url: mediaUrl },
		};
	} else if (msg.buttons?.length) {
		const template = buttonTemplate(msg.text, msg.buttons, true);
		if (template) Object.assign(message, template);
		else message.text = msg.text ?? "";
	} else if (msg.quickReplies?.length) {
		const quickReplies = normalizeQuickReplies(msg.quickReplies);
		if (msg.text) message.text = msg.text;
		if (quickReplies.length) message.quick_replies = quickReplies;
	} else {
		message.text = msg.text ?? "";
	}
	if (isEmptyPayload(message)) {
		return {
			ok: false,
			status: 0,
			error: "Mensagem vazia — configure um texto, botão ou mídia na ação.",
		};
	}
	return graphRequest(ctx, "POST", `${ctx.accountId}/messages`, {
		recipient: { id: igUserId },
		message,
	});
}

export async function getSubscribedFields(
	ctx: IgGraphContext,
): Promise<GraphResult> {
	return graphRequest(ctx, "GET", "me/subscribed_apps");
}

export async function subscribeAccountFields(
	ctx: IgGraphContext,
	fields: string[] = ["comments", "messages", "messaging_postbacks"],
): Promise<GraphResult> {
	const clean = fields
		.map((field) => String(field || "").trim())
		.filter(Boolean);
	if (!clean.length) {
		return {
			ok: false,
			status: 0,
			error: "Nenhum campo informado para assinatura.",
		};
	}
	const query = `subscribed_fields=${encodeURIComponent(clean.join(","))}`;
	return graphRequest(ctx, "POST", `me/subscribed_apps?${query}`);
}
