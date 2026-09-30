import { createHmac } from "crypto";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/ig-automation/log";
import { isHostAllowed } from "@/lib/ssrf-guard";

const OUTBOUND_TIMEOUT_MS = 10_000;
/** Máximo de saltos de redirect revalidados pela guarda SSRF. */
const OUTBOUND_MAX_REDIRECTS = 3;
/** Erro canônico de bloqueio (registrado em `IgActionLog`). */
const SSRF_BLOCKED_ERROR = "URL bloqueada (SSRF)";

export interface IgOutboundContact {
	igUserId?: string | null;
	username?: string | null;
}

export interface DispatchOutboundParams {
	userId: string;
	channelId: string;
	event: string;
	automationId?: string | null;
	contact?: IgOutboundContact | null;
	text?: string | null;
	mediaId?: string | null;
	webhookId?: string | null;
}

function parseEvents(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function shortError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err ?? "");
	return message.replace(/\s+/g, " ").trim().slice(0, 500) || "Falha ao disparar webhook de saída.";
}

function fireLog(params: Parameters<typeof logAction>[0]): void {
	try {
		const result = logAction(params) as unknown;
		if (
			result &&
			typeof (result as Promise<unknown>).then === "function"
		) {
			void (result as Promise<unknown>).catch(() => {});
		}
	} catch {
		/* log jamais derruba a ação */
	}
}

type OutboundUrlCheck =
	| { ok: true; url: URL }
	| { ok: false; error: string };

/**
 * Esquema só http/https + host público (bloqueia loopback/privado/link-local/
 * metadata via `isHostAllowed`). `isHostAllowed` LANÇA em pane transitória de
 * DNS; aqui isso vira erro de entrega do webhook (o log registra failed), sem
 * retry implícito na hora.
 */
async function resolveAllowedOutboundUrl(
	rawUrl: string,
): Promise<OutboundUrlCheck> {
	let parsed: URL;
	try {
		parsed = new URL(String(rawUrl || "").trim());
	} catch {
		return { ok: false, error: "URL do webhook de saída inválida." };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, error: SSRF_BLOCKED_ERROR };
	}
	try {
		if (!(await isHostAllowed(parsed.hostname))) {
			return { ok: false, error: SSRF_BLOCKED_ERROR };
		}
	} catch {
		return {
			ok: false,
			error: "Não foi possível validar o host do webhook de saída (DNS).",
		};
	}
	return { ok: true, url: parsed };
}

async function postWebhook(
	url: string,
	event: string,
	secret: string | null,
	payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
	const body = JSON.stringify(payload);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Autoreels-Event": event,
	};
	if (secret && secret.trim()) {
		const signature = createHmac("sha256", secret)
			.update(body)
			.digest("hex");
		headers["X-Autoreels-Signature"] = `sha256=${signature}`;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
	try {
		// Redirect MANUAL: a guarda SSRF é revalidada em cada salto — o host
		// final nunca pode divergir para loopback/privado/metadata.
		let current = url;
		let method = "POST";
		let currentBody: string | undefined = body;
		for (let hop = 0; hop <= OUTBOUND_MAX_REDIRECTS; hop++) {
			const guarded = await resolveAllowedOutboundUrl(current);
			if (!guarded.ok) {
				return { ok: false, status: 0, body: "", error: guarded.error };
			}
			const res = await fetch(guarded.url, {
				method,
				headers,
				...(currentBody !== undefined ? { body: currentBody } : {}),
				redirect: "manual",
				signal: controller.signal,
			});
			if (res.status >= 300 && res.status < 400) {
				const location = res.headers.get("location");
				if (!location) {
					return {
						ok: false,
						status: res.status,
						body: "",
						error: "Webhook de saída redirecionou sem destino.",
					};
				}
				try {
					current = new URL(location, guarded.url).href;
				} catch {
					return {
						ok: false,
						status: res.status,
						body: "",
						error: "Destino de redirecionamento inválido no webhook de saída.",
					};
				}
				// Espelha o `redirect:"follow"` do fetch: 303 e POST em 301/302
				// viram GET sem corpo.
				if (
					res.status === 303 ||
					((res.status === 301 || res.status === 302) && method === "POST")
				) {
					method = "GET";
					currentBody = undefined;
				}
				continue;
			}
			const text = await res.text().catch(() => "");
			if (!res.ok) {
				return {
					ok: false,
					status: res.status,
					body: text.slice(0, 500),
					error: `Webhook de saída respondeu HTTP ${res.status}.`,
				};
			}
			return { ok: true, status: res.status, body: text.slice(0, 500) };
		}
		return {
			ok: false,
			status: 0,
			body: "",
			error: `Muitos redirecionamentos no webhook de saída (máx ${OUTBOUND_MAX_REDIRECTS}).`,
		};
	} catch (err) {
		if (controller.signal.aborted) {
			return {
				ok: false,
				status: 0,
				body: "",
				error: `Webhook de saída excedeu ${OUTBOUND_TIMEOUT_MS / 1000}s.`,
			};
		}
		return { ok: false, status: 0, body: "", error: shortError(err) };
	} finally {
		clearTimeout(timer);
	}
}

export interface DispatchOutboundResult {
	/** Webhooks que responderam HTTP 2xx. */
	delivered: number;
	/** Webhooks que falharam ou não puderam ser disparados. */
	failed: number;
}

export async function dispatchOutbound(
	params: DispatchOutboundParams,
): Promise<DispatchOutboundResult> {
	const { userId, channelId, event } = params;
	let delivered = 0;
	let failed = 0;
	try {
		if (!userId || !event) return { delivered, failed };

		const where: {
			user_id: string;
			enabled: boolean;
			id?: string;
			OR?: { channel_id: string | null }[];
		} = { user_id: userId, enabled: true };
		if (params.webhookId) where.id = params.webhookId;
		if (channelId) where.OR = [{ channel_id: null }, { channel_id: channelId }];

		const webhooks = await prisma.igOutboundWebhook.findMany({ where });
		const targets = webhooks.filter((webhook) =>
			parseEvents(webhook.events).includes(event),
		);
		if (!targets.length) return { delivered, failed };

		const payload: Record<string, unknown> = {
			event,
			automationId: params.automationId ?? null,
			channelId: channelId ?? null,
			contact: params.contact
				? {
						igUserId: params.contact.igUserId ?? null,
						username: params.contact.username ?? null,
					}
				: null,
			text: params.text ?? null,
			mediaId: params.mediaId ?? null,
			ts: new Date().toISOString(),
		};

		for (const webhook of targets) {
			const request = JSON.stringify({
				url: webhook.url,
				event,
				webhookId: webhook.id,
			});
			const result = await postWebhook(
				webhook.url,
				event,
				webhook.secret ?? null,
				payload,
			);
			if (result.ok) delivered += 1;
			else failed += 1;
			fireLog({
				userId,
				channelId: channelId ?? null,
				automationId: params.automationId ?? null,
				actionType: "outbound_webhook",
				status: result.ok ? "sent" : "failed",
				request,
				response: JSON.stringify({ status: result.status, body: result.body }),
				error: result.error,
			});
		}
	} catch (err) {
		failed += 1;
		fireLog({
			userId,
			channelId: channelId ?? null,
			automationId: params.automationId ?? null,
			actionType: "outbound_webhook",
			status: "failed",
			error: shortError(err),
		});
	}
	return { delivered, failed };
}
