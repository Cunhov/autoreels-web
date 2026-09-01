#!/usr/bin/env npx tsx
/**
 * Smoke F5 — AI Suggest via OpenRouter (lib/ai.ts).
 * Valida (fetch MOCKADO — nenhuma chamada sai da máquina):
 *  1. descrição → { title, products } parseado do JSON do provider;
 *  2. sem OPENROUTER_API_KEY → erro claro (kind "config") orientando .env;
 *  3. resposta não-JSON → fallback linha-a-linha ainda gera título+produtos;
 *  4. extras: título ≤100, produtos ≤5 sem duplicatas, parse de fence ```json,
 *     HTTP não-ok → erro api em PT-BR.
 */
import {
	suggestYoutubeFromDescription,
	parseSuggestionText,
	OpenRouterError,
	OPENROUTER_API_URL,
} from "@/lib/ai";

let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponses: Map<string, { status: number; body: unknown }> = new Map();
const origFetch = global.fetch as unknown as typeof fetch;

function mockFetch(url: string | URL, init?: RequestInit) {
	const u = String(url);
	fetchCalls.push({ url: u, init: (init || {}) as RequestInit });
	for (const [key, resp] of mockResponses.entries()) {
		if (u.includes(key)) {
			return Promise.resolve(
				new Response(JSON.stringify(resp.body), {
					status: resp.status,
					headers: { "Content-Type": "application/json" },
				}) as unknown as Response,
			);
		}
	}
	return Promise.resolve(
		new Response(JSON.stringify({ error: { message: "no mock for " + u } }), {
			status: 404,
		}) as unknown as Response,
	);
}

function setMock(key: string, status: number, body: unknown) {
	mockResponses.set(key, { status, body });
}

function openAiResponse(content: string) {
	return {
		choices: [{ message: { role: "assistant", content } }],
	};
}

async function run() {
	let pass = 0;
	let fail = 0;
	const check = (label: string, ok: boolean, detail = "") => {
		if (ok) {
			pass++;
			console.log(`✅ ${label}${detail ? ` — ${detail}` : ""}`);
		} else {
			fail++;
			console.error(`❌ ${label}${detail ? ` — ${detail}` : ""}`);
		}
	};

	(global as unknown as { fetch: unknown }).fetch = mockFetch as unknown as typeof fetch;

	// Salva env original p/ restaurar no final (nunca deixar poluído).
	const hadKey = process.env.OPENROUTER_API_KEY;
	const hadModel = process.env.OPENROUTER_MODEL;
	process.env.OPENROUTER_API_KEY = "sk-or-v1-smoke-test-key";
	process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";

	try {
		// ── 1) JSON válido do provider ──────────────────────────────────────
		fetchCalls = [];
		setMock("chat/completions", 200, openAiResponse(
			'{"title": "5 truques de organização que você precisa testar", "products": ["Caixa organizadora", "Etiquetadora portátil"]}',
		));
		const res1 = await suggestYoutubeFromDescription(
			"Organize seu guarda-roupa em 5 minutos com caixas e etiquetas.",
		);
		check("1. desc → {title, products} do JSON", res1.title === "5 truques de organização que você precisa testar");
		check("1b. products chegou", res1.products.length === 2, `got ${res1.products.join("|")}`);
		const call = fetchCalls[0];
		check("1c. POST /v1/chat/completions", call?.url === OPENROUTER_API_URL, String(call?.url));
		const auth = (call?.init?.headers as Record<string, string> | undefined)?.Authorization || "";
		check("1d. Authorization Bearer com a chave", auth === "Bearer sk-or-v1-smoke-test-key");
		check(
			"1e. chave NÃO vaza no request body",
			!JSON.stringify((call?.init?.body as string) || "").includes("smoke-test-key"),
		);

		// ── 2) sem chave → erro claro ───────────────────────────────────────
		delete process.env.OPENROUTER_API_KEY;
		let configErr: OpenRouterError | null = null;
		try {
			await suggestYoutubeFromDescription("qualquer descrição");
		} catch (e) {
			configErr = e as OpenRouterError;
		}
		check(
			"2. sem OPENROUTER_API_KEY → erro claro",
			configErr instanceof OpenRouterError &&
				configErr.kind === "config" &&
				configErr.message.includes("OPENROUTER_API_KEY") &&
				configErr.message.includes(".env"),
			configErr?.message?.slice(0, 80) || "nenhum erro",
		);
		process.env.OPENROUTER_API_KEY = "sk-or-v1-smoke-test-key";

		// ── 3) resposta não-JSON → fallback linha-a-linha ───────────────────
		setMock("chat/completions", 200, openAiResponse(
			"Titulo da descricao qualquer\n- Caixa organizadora\n- Fone Bluetooth\n- Suporte para celular",
		));
		const res3 = await suggestYoutubeFromDescription("Conteúdo sobre organização e acessórios.");
		check("3. não-JSON → fallback com título", res3.title === "Titulo da descricao qualquer", `got "${res3.title}"`);
		check("3b. fallback com produtos", res3.products.length === 3, `got ${res3.products.join("|")}`);

		// ── 4) extras ──────────────────────────────────────────────────────
		// fence ```json```
		const fence = parseSuggestionText('```json\n{"title": "T", "products": ["A","B"]}\n```');
		check("4a. parse de fence ```json```", fence?.title === "T" && fence.products.length === 2);
		// título >100 → cortado; duplicatas removidas; >5 produtos → 5
		const bigParsed = parseSuggestionText(
			JSON.stringify({
				title: "x".repeat(140),
				products: ["P", "P", "Q", "Q", "R", "S", "T", "U"],
			}),
		);
		check("4b. título cortado a 100", bigParsed?.title.length === 100);
		check("4c. produtos deduplicados e máx 5", bigParsed?.products.length === 5, `got ${bigParsed?.products.length}`);
		// HTTP não-ok do provider → erro api PT-BR (sem vazar chave)
		setMock("chat/completions", 429, { error: { message: "Rate limited upstream" } });
		let apiErr: OpenRouterError | null = null;
		try {
			await suggestYoutubeFromDescription("desc para erro");
		} catch (e) {
			apiErr = e as OpenRouterError;
		}
		check(
			"4d. HTTP 429 → erro api PT-BR sem chave",
			apiErr instanceof OpenRouterError &&
				apiErr.kind === "api" &&
				apiErr.message.includes("Rate limited upstream") &&
				!apiErr.message.includes("smoke-test-key"),
			apiErr?.message?.slice(0, 100) || "nenhum erro",
		);
	} finally {
		// Restaura fetch e env originais.
		(global as unknown as { fetch: unknown }).fetch = origFetch;
		if (hadKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = hadKey;
		if (hadModel === undefined) delete process.env.OPENROUTER_MODEL;
		else process.env.OPENROUTER_MODEL = hadModel;
	}

	console.log(`\nAI-SUGGEST: ${pass} pass, ${fail} fail`);
	if (fail > 0) process.exit(1);
}

run().catch((err) => {
	console.error("Erro fatal no smoke ai-suggest:", err);
	process.exit(1);
});