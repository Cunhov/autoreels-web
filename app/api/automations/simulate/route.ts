/**
 * app/api/automations/simulate/route.ts — simulador de automação (spec §11).
 *
 * POST autenticado: valida canal do usuário e devolve `IgSimulationResult`
 * (mesmos gates/matcher/render do engine, sem efeitos colaterais).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { simulate } from "@/lib/ig-automation/engine";
import { IG_TRIGGERS } from "@/lib/ig-automation/validate";
import type { IgTrigger } from "@/lib/ig-automation/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function badRequest(message: string) {
	return NextResponse.json({ error: message }, { status: 400 });
}

function optionalString(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return value as undefined | null;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export async function POST(req: Request) {
	const session = await getServerSession(authOptions);
	const userId = getSessionUserId(session);
	if (!userId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return badRequest("Corpo da requisição inválido");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return badRequest("Corpo da requisição inválido");
	}
	const payload = body as Record<string, unknown>;

	const channelId =
		typeof payload.channelId === "string" ? payload.channelId.trim() : "";
	if (!channelId) return badRequest("Canal é obrigatório");

	const kind = payload.kind;
	if (
		typeof kind !== "string" ||
		!(IG_TRIGGERS as readonly string[]).includes(kind)
	) {
		return badRequest("Gatilho inválido");
	}

	if (typeof payload.text !== "string") {
		return badRequest("Texto é obrigatório");
	}

	const mediaId = optionalString(payload.mediaId);
	if (mediaId === undefined && payload.mediaId !== undefined && payload.mediaId !== null) {
		return badRequest("Post inválido");
	}
	const username = optionalString(payload.username);
	if (username === undefined && payload.username !== undefined && payload.username !== null) {
		return badRequest("Usuário inválido");
	}
	const igUserId = optionalString(payload.igUserId);
	if (igUserId === undefined && payload.igUserId !== undefined && payload.igUserId !== null) {
		return badRequest("ID do usuário do Instagram inválido");
	}

	try {
		const channel = await prisma.channel.findFirst({
			where: { id: channelId, user_id: userId },
			select: { id: true, platform: true },
		});
		if (!channel) {
			return NextResponse.json(
				{ error: "Canal não encontrado" },
				{ status: 404 },
			);
		}
		if (channel.platform !== "instagram") {
			return badRequest("Canal não é do Instagram");
		}

		const result = await simulate(
			{
				channelId: channel.id,
				kind: kind as IgTrigger,
				text: payload.text,
				mediaId: mediaId ?? null,
				username: username ?? null,
				igUserId: igUserId ?? null,
			},
			userId,
		);

		return NextResponse.json(result);
	} catch (error: unknown) {
		console.error("[api] simulate error:", error);
		return NextResponse.json(
			{ error: "Erro ao simular a automação" },
			{ status: 500 },
		);
	}
}
