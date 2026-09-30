/**
 * app/api/webhooks/instagram/route.ts — webhook da Meta (spec §7).
 *
 * GET: verificação do desafio (hub.mode/hub.verify_token/hub.challenge).
 * POST: lê o body CRU, valida `X-Hub-Signature-256` (HMAC-SHA256 com
 * INSTAGRAM_CLIENT_SECRET || META_APP_SECRET), parseia, persiste com dedupe e
 * responde 200 imediatamente; o engine roda em background via `after()`.
 * Echo nunca passa pelo engine (a persistência já pausa o contato).
 */
import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { safeEqual } from "@/lib/secret";
import { handleInboundEvent } from "@/lib/ig-automation/engine";
import {
	parseWebhookPayload,
	persistInboundEvents,
	verifySignature,
	type WebhookChannelRef,
} from "@/lib/ig-automation/webhook";
import type { IgInboundEvent } from "@/lib/ig-automation/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function shortError(error: unknown): string {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code !== "") return code;
	}
	if (error instanceof Error && error.name) return error.name;
	return "Error";
}

function plainText(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

/** GET — verificação do webhook pela Meta. */
export async function GET(req: Request): Promise<Response> {
	const { searchParams } = new URL(req.url);
	const mode = searchParams.get("hub.mode");
	const token = searchParams.get("hub.verify_token");
	const challenge = searchParams.get("hub.challenge") ?? "";

	if (mode !== "subscribe" || !token) {
		return plainText("Forbidden", 403);
	}

	let expected = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() ?? "";
	if (!expected) {
		try {
			const row = await prisma.appConfig.findUnique({
				where: { key: "meta_webhook_verify_token" },
				select: { value: true },
			});
			expected = row?.value?.trim() ?? "";
		} catch (error) {
			console.error("[ig-webhook] verify token falhou:", shortError(error));
		}
	}

	if (!expected || !safeEqual(token, expected)) {
		return plainText("Forbidden", 403);
	}
	return plainText(challenge, 200);
}

/** POST — recebe eventos da Meta. */
export async function POST(req: Request): Promise<Response> {
	const rawBody = await req.text();
	const signature = req.headers.get("x-hub-signature-256") ?? undefined;
	const secret = (
		process.env.INSTAGRAM_CLIENT_SECRET ||
		process.env.META_APP_SECRET ||
		""
	).trim();

	if (!secret) {
		console.error(
			"[ig-webhook] segredo ausente (INSTAGRAM_CLIENT_SECRET/META_APP_SECRET).",
		);
		return NextResponse.json(
			{ error: "Webhook não configurado." },
			{ status: 500 },
		);
	}
	if (!verifySignature(rawBody, signature, secret)) {
		return NextResponse.json(
			{ error: "Assinatura inválida." },
			{ status: 401 },
		);
	}

	let body: unknown = null;
	try {
		body = rawBody.trim() === "" ? null : JSON.parse(rawBody);
	} catch {
		return NextResponse.json(
			{ error: "Payload inválido." },
			{ status: 400 },
		);
	}

	const events = parseWebhookPayload(body);

	const channelByIgId = new Map<string, WebhookChannelRef>();
	const igIds = [
		...new Set(
			events
				.map((event) => event.channelIgId)
				.filter((id): id is string => typeof id === "string" && id !== ""),
		),
	];
	if (igIds.length > 0) {
		try {
			const channels = await prisma.channel.findMany({
				where: { platform: "instagram", account_id: { in: igIds } },
				select: { id: true, user_id: true, account_id: true, username: true },
			});
			for (const channel of channels) {
				if (channel.account_id) {
					channelByIgId.set(channel.account_id, channel);
				}
			}
		} catch (error) {
			console.error("[ig-webhook] canais falharam:", shortError(error));
		}
	}

	const result = await persistInboundEvents(events, channelByIgId);

	// Engine em background; echo já foi tratado na persistência (pausa).
	const toProcess: IgInboundEvent[] = result.storedEvents.filter(
		(event) => event.isEcho !== true,
	);
	if (toProcess.length > 0) {
		const run = async (): Promise<void> => {
			for (const event of toProcess) {
				try {
					await handleInboundEvent(event, { source: "webhook" });
				} catch (error) {
					console.error(
						"[ig-webhook] handleInboundEvent falhou:",
						shortError(error),
					);
				}
			}
		};
		try {
			after(run);
		} catch {
			// Fora do escopo de request (ex.: testes): processa em microtask.
			void run().catch(() => {});
		}
	}

	if (result.errors > 0) {
		// Falha real de persistência: a Meta refaz o POST (dedupe evita duplicar).
		return NextResponse.json(
			{ error: "persist_failed", errors: result.errors },
			{ status: 500 },
		);
	}

	return NextResponse.json({
		received: events.length,
		stored: result.stored,
		duplicates: result.duplicates,
		unknown: result.unknown,
	});
}
