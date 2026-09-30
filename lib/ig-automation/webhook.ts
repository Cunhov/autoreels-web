/**
 * lib/ig-automation/webhook.ts — assinatura, parsing e persistência dos
 * webhooks da Meta (spec §7).
 *
 * - `verifySignature`: HMAC-SHA256 `sha256=<hex>` com `timingSafeEqual`.
 * - `parseWebhookPayload`: 100% defensivo (entries malformadas não lançam),
 *   ignora `read`/`delivery`/`reaction` de messaging e reações sem `mid`.
 * - `persistInboundEvents`: grava `IgEvent` com dedupe por `dedupe_key`
 *   (P2002 = replay), status `received`; echo vira `kind="echo"` e
 *   `status="paused"` + pausa do contato. Payload cru serializado sem token.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { pauseContact, upsertContact } from "@/lib/ig-automation/contacts";
import { getLimits, type IgLimits } from "@/lib/ig-automation/limits";
import type { IgInboundEvent, IgTrigger } from "@/lib/ig-automation/types";

export interface WebhookChannelRef {
	id: string;
	user_id: string;
	account_id: string | null;
	username: string | null;
}

export interface PersistInboundResult {
	stored: number;
	duplicates: number;
	unknown: number;
	/** Falhas reais de persistência (DB) — a rota responde 500 p/ retry da Meta. */
	errors: number;
	/**
	 * Eventos efetivamente gravados (não duplicados/desconhecidos) — extensão
	 * operacional para a rota processar o engine sem reprocessar replays.
	 */
	storedEvents: IgInboundEvent[];
}

function shortError(error: unknown): string {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code !== "") return code;
	}
	if (error instanceof Error && error.name) return error.name;
	return "Error";
}

function isUniqueViolation(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		(error as { code?: unknown }).code === "P2002"
	);
}

/**
 * Valida `X-Hub-Signature-256` (`sha256=<hex>`) contra o HMAC-SHA256 do body
 * cru. Sem header/segredo → false; comparação em tempo constante e apenas com
 * buffers de mesmo tamanho.
 */
export function verifySignature(
	rawBody: string,
	signatureHeader: string | undefined,
	secret: string,
): boolean {
	if (typeof rawBody !== "string") return false;
	if (typeof signatureHeader !== "string" || signatureHeader.trim() === "") {
		return false;
	}
	if (typeof secret !== "string" || secret === "") return false;

	const match = /^sha256=([a-f0-9]+)$/i.exec(signatureHeader.trim());
	if (!match) return false;

	let expected: Buffer;
	try {
		expected = createHmac("sha256", secret)
			.update(rawBody, "utf8")
			.digest();
	} catch {
		return false;
	}
	const provided = Buffer.from(match[1], "hex");
	if (provided.length === 0 || provided.length !== expected.length) return false;
	try {
		return timingSafeEqual(provided, expected);
	} catch {
		return false;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Converte o payload do webhook em `IgInboundEvent[]`. Nunca lança:
 * entradas malformadas são simplesmente ignoradas.
 */
export function parseWebhookPayload(body: unknown): IgInboundEvent[] {
	const events: IgInboundEvent[] = [];
	const root = asRecord(body);
	if (!root) return events;
	const entries = root.entry;
	if (!Array.isArray(entries)) return events;

	for (const entryRaw of entries) {
		const entry = asRecord(entryRaw);
		if (!entry) continue;
		const channelIgId = asString(entry.id);
		if (!channelIgId) continue; // entry sem id da conta = malformada

		// ── changes[]: comentários e reações ─────────────────────────────────
		if (Array.isArray(entry.changes)) {
			for (const changeRaw of entry.changes) {
				const change = asRecord(changeRaw);
				if (!change) continue;
				const field = asString(change.field);
				const value = asRecord(change.value);
				if (!field || !value) continue;

				if (field === "comments") {
					const id = asString(value.id);
					if (!id) continue;
					const from = asRecord(value.from);
					const media = asRecord(value.media);
					events.push({
						channelIgId,
						kind: "comment",
						dedupeKey: `comment:${id}`,
						igEventId: id,
						fromIgId: asString(from?.id),
						fromUsername: asString(from?.username),
						text: asString(value.text),
						mediaId: asString(media?.id),
						raw: changeRaw,
					});
					continue;
				}

				if (field === "message_reactions") {
					const mid = asString(value.mid);
					if (!mid) continue; // reação sem mid não tem dedupe
					const from = asRecord(value.from);
					events.push({
						channelIgId,
						kind: "reaction" as unknown as IgTrigger,
						dedupeKey: `reaction:${mid}`,
						igEventId: mid,
						fromIgId: asString(from?.id),
						fromUsername: asString(from?.username),
						raw: changeRaw,
					});
				}
			}
		}

		// ── messaging[]: dm/echo/story_mention/story_reply/postback ──────────
		if (!Array.isArray(entry.messaging)) continue;
		for (const itemRaw of entry.messaging) {
			const item = asRecord(itemRaw);
			if (!item) continue;
			// read/delivery/reaction de messaging são ignorados.
			if (item.read !== undefined || item.delivery !== undefined) continue;
			if (item.reaction !== undefined) continue;

			const sender = asRecord(item.sender);
			const fromIgId = asString(sender?.id);
			const fromUsername = asString(sender?.username);

			const postback = asRecord(item.postback);
			if (postback) {
				const mid = asString(postback.mid);
				if (!mid) continue; // sem mid não há dedupe
				events.push({
					channelIgId,
					kind: "postback",
					dedupeKey: `postback:${mid}`,
					igEventId: mid,
					fromIgId,
					fromUsername,
					postbackPayload: asString(postback.payload),
					raw: itemRaw,
				});
				continue;
			}

			const message = asRecord(item.message);
			if (!message) continue;
			const mid = asString(message.mid);
			if (!mid) continue;

			if (message.is_echo === true) {
				// Echo: o `sender` é a própria conta business; o humano é o
				// `recipient`. Fallback defensivo quando o recipient é a própria
				// conta (payload invertido) ou está ausente.
				const recipient = asRecord(item.recipient);
				const recipientIgId = asString(recipient?.id);
				const usesRecipient =
					recipientIgId !== undefined && recipientIgId !== channelIgId;
				const echoFromIgId = usesRecipient
					? recipientIgId
					: fromIgId !== channelIgId
						? fromIgId
						: undefined;
				const echoFromUsername = usesRecipient
					? asString(recipient?.username)
					: fromUsername;
				events.push({
					channelIgId,
					kind: "dm",
					dedupeKey: `message:${mid}`,
					igEventId: mid,
					fromIgId: echoFromIgId,
					fromUsername: echoFromUsername,
					text: asString(message.text),
					isEcho: true,
					raw: itemRaw,
				});
				continue;
			}

			const attachments = Array.isArray(message.attachments)
				? message.attachments
				: [];
			const isStoryMention = attachments.some(
				(attachment) => asRecord(attachment)?.type === "story_mention",
			);
			if (isStoryMention) {
				events.push({
					channelIgId,
					kind: "story_mention",
					dedupeKey: `story:${mid}`,
					igEventId: mid,
					fromIgId,
					fromUsername,
					raw: itemRaw,
				});
				continue;
			}

			const replyTo = asRecord(message.reply_to);
			const story = asRecord(replyTo?.story);
			if (story && (asString(story.id) || asString(story.url))) {
				events.push({
					channelIgId,
					kind: "story_reply",
					dedupeKey: `story:${mid}`,
					igEventId: mid,
					fromIgId,
					fromUsername,
					text: asString(message.text),
					mediaId: asString(story.id),
					raw: itemRaw,
				});
				continue;
			}

			if (typeof message.text === "string") {
				events.push({
					channelIgId,
					kind: "dm",
					dedupeKey: `message:${mid}`,
					igEventId: mid,
					fromIgId,
					fromUsername,
					text: message.text,
					raw: itemRaw,
				});
			}
		}
	}

	return events;
}

/** JSON.stringify defensivo do payload cru (nunca contém tokens de acesso). */
function safePayload(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		const json = JSON.stringify(value);
		return typeof json === "string" ? json.slice(0, 20_000) : undefined;
	} catch {
		return undefined;
	}
}

/** Echo: pausa o contato (human takeover) e liga o contato ao evento. */
async function pauseForEcho(
	eventRowId: string,
	event: IgInboundEvent,
	channel: WebhookChannelRef,
	limits: IgLimits,
): Promise<void> {
	const fromIgId = asString(event.fromIgId);
	if (!fromIgId) return;
	try {
		const contact = await upsertContact({
			userId: channel.user_id,
			channelId: channel.id,
			igUserId: fromIgId,
			username: event.fromUsername,
			isComment: false,
			at: new Date(),
		});
		await pauseContact(contact.id, limits.humanTakeoverPauseHours);
		await prisma.igEvent.updateMany({
			where: { id: eventRowId },
			data: { contact_id: contact.id },
		});
	} catch (error) {
		console.error("[ig-webhook] pausa por echo falhou:", shortError(error));
	}
}

/**
 * Persiste cada evento cujo canal é conhecido. Dedupe pelo `dedupe_key`
 * (P2002 é replay → `duplicates`); canal fora do mapa → `unknown`.
 * Echo gera evento `paused` e pausa o contato (não passa pelo engine).
 */
export async function persistInboundEvents(
	events: IgInboundEvent[],
	channelByIgId: Map<string, WebhookChannelRef>,
): Promise<PersistInboundResult> {
	const result: PersistInboundResult = {
		stored: 0,
		duplicates: 0,
		unknown: 0,
		errors: 0,
		storedEvents: [],
	};
	if (!Array.isArray(events) || events.length === 0) return result;

	const channelMap =
		channelByIgId instanceof Map
			? channelByIgId
			: new Map<string, WebhookChannelRef>();
	const touchedChannelIds = new Set<string>();
	let limits: IgLimits | null = null;

	for (const event of events) {
		if (!event || typeof event !== "object") {
			result.unknown += 1;
			continue;
		}
		const channelIgId =
			typeof event.channelIgId === "string" ? event.channelIgId : "";
		const dedupeKey = typeof event.dedupeKey === "string" ? event.dedupeKey : "";
		const channel = channelIgId ? channelMap.get(channelIgId) : undefined;
		if (!channel || !dedupeKey) {
			result.unknown += 1;
			continue;
		}

		const isEcho = event.isEcho === true;
		try {
			const created = await prisma.igEvent.create({
				data: {
					user_id: channel.user_id,
					channel_id: channel.id,
					kind: isEcho ? "echo" : String(event.kind || "system"),
					dedupe_key: dedupeKey,
					ig_event_id: asString(event.igEventId),
					media_id: asString(event.mediaId),
					text: typeof event.text === "string" ? event.text : undefined,
					username: asString(event.fromUsername),
					from_ig_id: asString(event.fromIgId),
					payload: safePayload(event.raw),
					status: isEcho ? "paused" : "received",
					direction: "in",
				},
				select: { id: true },
			});
			result.stored += 1;
			result.storedEvents.push(event);
			touchedChannelIds.add(channel.id);
			if (isEcho) {
				if (limits === null) limits = await getLimits();
				await pauseForEcho(created.id, event, channel, limits);
			}
		} catch (error) {
			if (isUniqueViolation(error)) {
				result.duplicates += 1;
				continue;
			}
			console.error("[ig-webhook] persistência falhou:", shortError(error));
			result.errors += 1;
		}
	}

	// Saúde do canal: marca que este canal recebeu evento persistido (upsert
	// minimalista — só `last_event_at`).
	for (const channelId of touchedChannelIds) {
		try {
			const now = new Date();
			await prisma.igChannelState.upsert({
				where: { channel_id: channelId },
				create: { channel_id: channelId, last_event_at: now },
				update: { last_event_at: now },
			});
		} catch (error) {
			console.error(
				"[ig-webhook] last_event_at falhou:",
				shortError(error),
			);
		}
	}

	return result;
}
