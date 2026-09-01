// lib/ai.ts — F5: IA via OpenRouter (API compatível com OpenAI).
//
// DECISÃO DO DONO: provider OpenRouter exclusivamente. SEM SDKs pesados —
// fetch nativo com timeout. A chave vem de OPENROUTER_API_KEY (process.env)
// e o modelo de OPENROUTER_MODEL (default barato e estável).
//
// Uso: suggestYoutubeFromDescription(desc) → { title, products } a partir da
// descrição existente (youtube_description do planner / caption_youtube da
// library). NUNCA exponha a chave em logs ou respostas.

export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_DEFAULT_MODEL = "openai/gpt-4o-mini";
export const OPENROUTER_TIMEOUT_MS = 25_000;

export interface AiSuggestion {
	title: string;
	products: string[];
}

export type OpenRouterErrorKind =
	| "config" // chave ausente/em branco
	| "timeout" // fetch abortado pelo nosso timer
	| "api" // resposta HTTP não-ok do OpenRouter
	| "network" // falha de rede antes da resposta
	| "parse"; // resposta sem conteúdo interpretável

/** Erro tipado da camada de IA; `message` já vem em PT-BR amigável. */
export class OpenRouterError extends Error {
	readonly kind: OpenRouterErrorKind;
	readonly httpStatus?: number;
	constructor(kind: OpenRouterErrorKind, message: string, httpStatus?: number) {
		super(message);
		this.name = "OpenRouterError";
		this.kind = kind;
		this.httpStatus = httpStatus;
	}
}

/** Prompt do sistema — pede JSON estrito { title, products[] } em PT-BR. */
const SYSTEM_PROMPT = [
	"Você é um assistente de marketing digital para criadores de conteúdo no YouTube.",
	"A partir da DESCRIÇÃO de um vídeo Short, gere:",
	"1. Título do Short em pt-BR: curto, atraente e com gancho (1 a 100 caracteres, sem aspas, sem emojis excessivos).",
	"2. Até 5 nomes de produtos de afiliado RELEVANTES ao conteúdo do vídeo (cada nome curto, ex.: \"Smartwatch\", \"Fone Bluetooth\", \"Kit de organização\"; apenas o nome do produto, sem preço, sem marca do vídeo, sem link).",
	"Responda APENAS com JSON estrito, sem texto antes ou depois, neste formato exato:",
	'{"title": "Título aqui", "products": ["Produto 1", "Produto 2"]}',
].join("\n");

/** Lê a config do OpenRouter. Sem chave → erro claro de configuração. */
export function getOpenRouterConfig(): { apiKey: string; model: string } {
	const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
	if (!apiKey) {
		throw new OpenRouterError(
			"config",
			"OPENROUTER_API_KEY não configurada. Adicione a chave em .env (veja .env.example — https://openrouter.ai/keys) e reinicie o servidor.",
		);
	}
	const model = (process.env.OPENROUTER_MODEL || "").trim() || OPENROUTER_DEFAULT_MODEL;
	return { apiKey, model };
}

function cleanTitle(rawTitle: string): string {
	const title = String(rawTitle || "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'“”«»]+|["'“”«»]+$/g, "")
		.trim();
	return title.slice(0, 100);
}

function cleanProducts(raw: unknown): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	if (!Array.isArray(raw)) return out;
	for (const item of raw) {
		if (typeof item !== "string" && typeof item !== "number") continue;
		let name = String(item)
			.replace(/^[-*•·\d.)\s]+/, "")
			.replace(/^["'“”«»]+|["'“”«»]+$/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!name) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		// nomes curtos: ignora linhas longas (não são produtos) e corta a 60 chars
		out.push(name.slice(0, 60));
		if (out.length >= 5) break;
	}
	return out;
}

function isSuggestionShape(obj: unknown): obj is { title?: unknown; products?: unknown[] } {
	if (!obj || typeof obj !== "object") return false;
	const o = obj as Record<string, unknown>;
	return o.title != null && (o.products === undefined || Array.isArray(o.products));
}

/** Fallback quando o modelo não devolve JSON: 1ª linha = título, resto = produtos. */
function fallbackParse(content: string): { title: string; products: string[] } | null {
	const lines = String(content || "")
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return null;
	const title = cleanTitle(lines[0].replace(/^T[ií]tulo\s*:\s*/i, ""));
	if (!title) return null;
	const products = cleanProducts(
		lines.slice(1).map((l) => l.replace(/^[-*•\d.)\s]+/, "")),
	);
	return { title, products: products.length ? products : [] };
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Parse robusto: aceita JSON puro, fence ```json, bloco {…} dentro de texto e
 * fallback linha-a-linha. Normaliza title (≤100) e products (≤5, sem duplicatas).
 */
export function parseSuggestionText(content: string): { title: string; products: string[] } | null {
	if (typeof content !== "string" || !content.trim()) return null;
	const text = content.trim();

	// 1) JSON puro
	let obj = tryParseJson(text);
	// 2) fence ```json ... ```
	if (!isSuggestionShape(obj)) {
		const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fence) obj = tryParseJson(fence[1]);
	}
	// 3) bloco {…} do texto
	if (!isSuggestionShape(obj)) {
		const block = text.match(/\{[\s\S]*\}/);
		if (block) obj = tryParseJson(block[0]);
	}
	if (isSuggestionShape(obj)) {
		const o = obj as { title?: unknown; products?: unknown };
		const title = cleanTitle(typeof o.title === "string" ? o.title : "");
		const products = Array.isArray(o.products)
			? cleanProducts(o.products)
			: [];
		if (title || products.length) return { title, products };
	}

	// 4) fallback linha-a-linha (modelo ignorou o JSON)
	return fallbackParse(text);
}

/**
 * Gera título + produtos de afiliado a partir da descrição do vídeo.
 * fetch nativo com timeout ~25s; Authorization Bearer com a chave do env.
 * NUNCA registra/expõe a chave.
 */
export async function suggestYoutubeFromDescription(
	description: string,
): Promise<AiSuggestion> {
	const { apiKey, model } = getOpenRouterConfig();
	const desc = String(description || "").trim().slice(0, 5000);
	if (!desc) {
		throw new OpenRouterError("parse", "Descrição vazia — informe o texto do vídeo para gerar sugestões.");
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
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
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: `Descrição do vídeo:\n${desc}` },
				],
				temperature: 0.7,
				max_tokens: 400,
			}),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if (controller.signal.aborted) {
			throw new OpenRouterError(
				"timeout",
				`O provedor de IA demorou mais de ${OPENROUTER_TIMEOUT_MS / 1000}s — tente novamente.`,
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

	const parsed = parseSuggestionText(rawContent);
	if (!parsed || (!parsed.title && parsed.products.length === 0)) {
		throw new OpenRouterError("parse", "Não foi possível interpretar a resposta da IA (JSON esperado).");
	}
	return parsed;
}