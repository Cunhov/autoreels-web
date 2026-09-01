// app/api/ai/suggest/route.ts — F5: título + produtos YT gerados por IA via
// OpenRouter a partir da descrição do vídeo.
//
// POST { description } → { title, products: string[] }
// A chave OPENROUTER_API_KEY vive no servidor (process.env) e NUNCA é
// exposta ao cliente — o client só conversa com esta rota.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import {
	suggestYoutubeFromDescription,
	OpenRouterError,
} from "@/lib/ai";

export async function POST(req: Request) {
	const session = await getServerSession(authOptions);
	const userId = getSessionUserId(session);
	if (!userId) {
		return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json(
			{ error: "Corpo da requisição inválido — envie JSON com { description }." },
			{ status: 400 },
		);
	}
	const description =
		body && typeof body === "object" && "description" in body
			? (body as { description?: unknown }).description
			: undefined;
	if (typeof description !== "string" || !description.trim()) {
		return NextResponse.json(
			{ error: "Informe uma descrição do vídeo para gerar título e produtos." },
			{ status: 400 },
		);
	}

	try {
		const result = await suggestYoutubeFromDescription(description.trim());
		return NextResponse.json(result);
	} catch (err) {
		if (err instanceof OpenRouterError) {
			// Mensagens do OpenRouterError já são PT-BR e nunca contêm a chave.
			switch (err.kind) {
				case "config":
					return NextResponse.json(
						{ error: err.message },
						{ status: 500 },
					);
				case "timeout":
					return NextResponse.json(
						{ error: err.message },
						{ status: 502 },
					);
				case "api":
					return NextResponse.json(
						{ error: err.message },
						{ status: 502 },
					);
				case "network":
					return NextResponse.json(
						{ error: err.message },
						{ status: 502 },
					);
				case "parse":
					return NextResponse.json(
						{ error: err.message },
						{ status: 502 },
					);
			}
		}
		console.error("[ai/suggest] erro inesperado:", err);
		return NextResponse.json(
			{ error: "Erro inesperado ao gerar sugestões — tente novamente." },
			{ status: 500 },
		);
	}
}