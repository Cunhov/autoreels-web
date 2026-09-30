import { createHmac } from "crypto";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/ig-automation/log";

const OUTBOUND_TIMEOUT_MS = 10_000;

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
		const res = await fetch(url, {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
		});
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

export async function dispatchOutbound(
	params: DispatchOutboundParams,
): Promise<void> {
	const { userId, channelId, event } = params;
	try {
		if (!userId || !event) return;

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
		if (!targets.length) return;

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
		fireLog({
			userId,
			channelId: channelId ?? null,
			automationId: params.automationId ?? null,
			actionType: "outbound_webhook",
			status: "failed",
			error: shortError(err),
		});
	}
}
