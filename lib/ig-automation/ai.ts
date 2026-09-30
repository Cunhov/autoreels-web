import {
	OPENROUTER_API_URL,
	OpenRouterError,
	getOpenRouterConfig,
} from "@/lib/ai";

const AI_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_CHARS = 900;
const MAX_HISTORY = 10;

const SYSTEM_PROMPT = [
	"Você é o atendente virtual de um perfil no Instagram.",
	"Responda em português do Brasil, com tom natural, simpático e direto.",
	"Seja breve (até 3 frases), sem markdown e sem excesso de emojis.",
	"Nunca invente links, preços, prazos ou promessas: se não souber, diga que vai verificar.",
].join(" ");

export interface IgAiHistoryMessage {
	role?: string;
	username?: string;
	text?: string;
	content?: string;
}

export interface IgAiContact {
	username?: string | null;
	name?: string | null;
}

export interface GenerateReplyParams {
	prompt: string;
	history?: IgAiHistoryMessage[];
	contact?: IgAiContact;
	maxChars?: number;
}

export function cleanAiReply(raw: string, maxChars = DEFAULT_MAX_CHARS): string {
	let text = String(raw ?? "").trim();
	const fence = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
	if (fence) text = fence[1].trim();
	text = text.replace(/^["'“”«»]+|["'“”«»]+$/g, "").trim();
	const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
	return text.slice(0, limit).trim();
}

function buildHistoryUserMessage(
	history: IgAiHistoryMessage[],
	contact?: IgAiContact,
): string | null {
	const lines: string[] = [];
	const contactLabel =
		(contact?.username && `@${contact.username}`) || contact?.name || "";
	if (contactLabel) lines.push(`Contato: ${contactLabel}`);
	for (const item of history.slice(-MAX_HISTORY)) {
		if (!item) continue;
		const body = String(item.text ?? item.content ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (!body) continue;
		const role = String(item.role || "user").toLowerCase();
		const fallbackName = role === "assistant" || role === "bot" ? "bot" : "contato";
		const name = (item.username || fallbackName).replace(/^@/, "").trim();
		lines.push(`${name}: ${body}`);
	}
	if (!lines.length) return null;
	return `Contexto da conversa (mais antiga primeiro):\n${lines.join("\n")}`;
}

export async function generateReply(
	params: GenerateReplyParams,
): Promise<string> {
	const prompt = String(params?.prompt ?? "").trim();
	if (!prompt) {
		throw new OpenRouterError("parse", "Prompt vazio — configure o texto da resposta de IA na ação.");
	}
	const maxChars =
		params.maxChars && params.maxChars > 0 ? params.maxChars : DEFAULT_MAX_CHARS;

	const { apiKey, model } = getOpenRouterConfig();

	const messages: { role: "system" | "user"; content: string }[] = [
		{ role: "system", content: SYSTEM_PROMPT },
	];
	const historyMessage = buildHistoryUserMessage(
		Array.isArray(params.history) ? params.history : [],
		params.contact,
	);
	if (historyMessage) messages.push({ role: "user", content: historyMessage });
	messages.push({ role: "user", content: prompt.slice(0, 4000) });

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(OPENROUTER_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages,
				temperature: 0.6,
				max_tokens: Math.min(1024, Math.max(64, Math.ceil(maxChars / 3))),
			}),
			signal: controller.signal,
		});
	} catch (err) {
		if (controller.signal.aborted) {
			throw new OpenRouterError(
				"timeout",
				`O provedor de IA demorou mais de ${AI_TIMEOUT_MS / 1000}s — tente novamente.`,
			);
		}
		const reason = err instanceof Error ? err.message : String(err);
		throw new OpenRouterError("network", `Falha de rede ao chamar o provedor de IA: ${reason}`);
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) {
		let detail = `HTTP ${res.status}`;
		try {
			const body = (await res.json()) as {
				error?: { message?: string } | string;
			};
			if (typeof body?.error === "object" && typeof body.error.message === "string") {
				detail = body.error.message;
			} else if (typeof body?.error === "string") {
				detail = body.error;
			}
		} catch {
			/* corpo não-JSON: mantém "HTTP <status>" */
		}
		throw new OpenRouterError("api", `O provedor de IA respondeu com erro: ${detail}`, res.status);
	}

	let payload: { choices?: { message?: { content?: unknown } }[] } = {};
	try {
		payload = (await res.json()) as typeof payload;
	} catch {
		throw new OpenRouterError("parse", "Resposta do provedor de IA não é JSON válido.");
	}
	const rawContent = payload?.choices?.[0]?.message?.content;
	if (typeof rawContent !== "string" || !rawContent.trim()) {
		throw new OpenRouterError("parse", "O provedor de IA respondeu sem conteúdo interpretável.");
	}
	const text = cleanAiReply(rawContent, maxChars);
	if (!text) {
		throw new OpenRouterError("parse", "O provedor de IA devolveu uma resposta vazia.");
	}
	return text;
}
