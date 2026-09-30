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

function extractGraphError(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const err = (data as { error?: unknown }).error;
	if (typeof err === "string" && err.trim()) return err.trim();
	if (err && typeof err === "object") {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) return message.trim();
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
		const title = button.title.trim().slice(0, 80);
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
				text: text ?? "",
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
	const message: Record<string, unknown> = {};
	if (isHttpUrl(msg.mediaUrl)) {
		message.attachment = {
			type: "image",
			payload: { url: msg.mediaUrl.trim() },
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
