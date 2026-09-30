import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import {
	ensureSubscription,
	refreshAllSubscriptions,
} from "@/lib/ig-automation/subscription";
import {
	badRequest,
	readJsonBody,
	requireUserId,
	unauthorized,
} from "../shared";

export const dynamic = "force-dynamic";

function parseSubscribedFields(raw: string | null | undefined): string[] {
	if (typeof raw !== "string" || raw.trim() === "") return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((field): field is string => typeof field === "string")
			.map((field) => field.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

interface ChannelStateRow {
	subscribed_fields: string | null;
	last_checked_at: Date | null;
	last_event_at: Date | null;
	status: string;
	last_error: string | null;
}

interface WebhookStatusPayload {
	channelId: string;
	name: string;
	username: string | null;
	status: string;
	fields: string[];
	subscribedFields: string[];
	lastCheckedAt: Date | null;
	lastEventAt: Date | null;
	lastError: string | null;
}

function serializeStatus(
	channel: { id: string; name: string; username: string | null },
	state: ChannelStateRow | null,
): WebhookStatusPayload {
	const fields = parseSubscribedFields(state?.subscribed_fields);
	return {
		channelId: channel.id,
		name: channel.name,
		username: channel.username,
		status: state?.status ?? "unknown",
		fields,
		subscribedFields: fields,
		lastCheckedAt: state?.last_checked_at ?? null,
		lastEventAt: state?.last_event_at ?? null,
		lastError: state?.last_error ?? null,
	};
}

const STATE_SELECT = {
	subscribed_fields: true,
	last_checked_at: true,
	last_event_at: true,
	status: true,
	last_error: true,
} as const;

/**
 * GET /api/ig/webhook-status[?refresh=1] — estado persistido por canal IG do
 * usuário. Com `refresh=1`, re-assina/re-checa antes de responder. Nunca
 * devolve access_token/proxy.
 */
export async function GET(req: Request) {
	const userId = await requireUserId();
	if (!userId) return unauthorized();

	try {
		const { searchParams } = new URL(req.url);
		const refresh =
			searchParams.get("refresh") === "1" ||
			searchParams.get("refresh") === "true";
		if (refresh) {
			await refreshAllSubscriptions(userId);
		}

		const channels = await prisma.channel.findMany({
			where: { user_id: userId, platform: "instagram" },
			orderBy: { created_at: "asc" },
			select: {
				id: true,
				name: true,
				username: true,
				igChannelState: { select: STATE_SELECT },
			},
		});

		return NextResponse.json({
			channels: channels.map((channel) =>
				serializeStatus(channel, channel.igChannelState),
			),
		});
	} catch (error: unknown) {
		console.error("List ig webhook status error:", error);
		return NextResponse.json(
			{ error: getErrorMessage(error) },
			{ status: 400 },
		);
	}
}

/**
 * POST /api/ig/webhook-status — body `{channelId}`; valida ownership,
 * re-assina os campos e devolve o estado atualizado. Nunca devolve token.
 */
export async function POST(req: Request) {
	const userId = await requireUserId();
	if (!userId) return unauthorized();

	try {
		const body = await readJsonBody(req);
		const channelId =
			body !== null && typeof body === "object"
				? (body as { channelId?: unknown; channel_id?: unknown }).channelId ??
					(body as { channel_id?: unknown }).channel_id
				: null;
		if (typeof channelId !== "string" || !channelId.trim()) {
			return badRequest("channelId é obrigatório");
		}

		const channel = await prisma.channel.findFirst({
			where: {
				id: channelId.trim(),
				user_id: userId,
				platform: "instagram",
			},
			select: {
				id: true,
				name: true,
				username: true,
				account_id: true,
				access_token: true,
				proxy_url: true,
				proxy_enabled: true,
			},
		});
		if (!channel) {
			return NextResponse.json(
				{ error: "Canal não encontrado" },
				{ status: 404 },
			);
		}

		const result = await ensureSubscription(channel);
		const state = await prisma.igChannelState.findUnique({
			where: { channel_id: channel.id },
			select: STATE_SELECT,
		});

		return NextResponse.json({
			...serializeStatus(channel, state),
			status: result.status,
			fields: result.fields,
			subscribedFields: result.fields,
			ok: result.ok,
			error: result.error ?? state?.last_error ?? null,
		});
	} catch (error: unknown) {
		console.error("Resubscribe ig webhook error:", error);
		return NextResponse.json(
			{ error: getErrorMessage(error) },
			{ status: 400 },
		);
	}
}
