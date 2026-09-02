#!/usr/bin/env npx tsx
/**
 * Smoke F6 — TAG {post_products} nos templates do planner YouTube
 *
 * O runtime resolve {post_products} com a regra ITEM > FIXO (produtos do vídeo
 * na library vencem os fixos do planner) e reduz verbatim JSON [{item:{...}}]
 * a nomes legíveis. Este smoke valida:
 *  - resolveCaptionTemplateVars: {post_products} = item quando item tem,
 *    = fixo do config quando item vazio, = "" quando ausente (nunca vaza chave)
 *  - buildPostData: product_names do item entra no youtube_options e vence o
 *    fixo do config (mesma regra da publicação)
 *
 * Runner: npx --no-install tsx scripts/gauntlet/post-products-tag.mts
 * Exit code 0 only if every scenario passes.
 */
import { buildPostData, resolveCaptionTemplateVars } from "@/lib/planner-runtime";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
	if (ok) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.error(`  ✗ ${label} ${detail}`); }
}

async function run() {
	const now = new Date("2026-09-01T12:00:00Z");

	// ── 1. resolveCaptionTemplateVars: {post_products} ITEM > FIXO ─────────────
	async function varsFor(itemRow: unknown, config: Record<string, unknown>) {
		return resolveCaptionTemplateVars(
			{
				contentItem: { findFirst: async () => itemRow },
			} as never,
			{ id: "item1" } as never,
			{ user_id: "u1" } as never,
			config,
			"Meu Canal",
			now,
			"youtube",
		);
	}

	// 1a. ITEM vence (regra ITEM > FIXO)
	{
		const v = await varsFor(
			{
				id: "item1", title: "T1", caption: "c", caption_youtube: null,
				caption_instagram: null, caption_tiktok: null, tags: null,
				youtube_products: "Tenis Running, Camiseta UV",
			},
			{ youtube_products: "Produto Fixo" },
		);
		check("ITEM > FIXO (post_products = item)",
			v["{post_products}"] === "Tenis Running, Camiseta UV",
			`got=${v["{post_products}"]}`);
	}

	// 1b. FIXO quando item vazio
	{
		const v = await varsFor(
			{
				id: "item1", title: "T1", caption: "c", caption_youtube: null,
				caption_instagram: null, caption_tiktok: null, tags: null,
				youtube_products: null,
			},
			{ youtube_products: "Smartwatch" },
		);
		check("FIXO quando item vazio",
			v["{post_products}"] === "Smartwatch",
			`got=${v["{post_products}"]}`);
	}

	// 1c. Verbatim JSON [{item:{title}}] → nomes legíveis
	{
		const v = await varsFor(
			{
				id: "item1", title: "T1", caption: "c", caption_youtube: null,
				caption_instagram: null, caption_tiktok: null, tags: null,
				youtube_products: null,
			},
			{
				youtube_products: JSON.stringify([
					{ query: "tenis", item: { title: "Tênis Voador" } },
					{ query: "camiseta", item: { title: "Camiseta Tec" } },
				]),
			},
		);
		check("verbatim → nomes",
			v["{post_products}"] === "Tênis Voador, Camiseta Tec",
			`got=${v["{post_products}"]}`);
	}

	// 1d. Ausente → vazio (nunca vaza chave)
	{
		const v = await varsFor(
			{
				id: "item1", title: "T1", caption: "c", caption_youtube: null,
				caption_instagram: null, caption_tiktok: null, tags: null,
				youtube_products: null,
			},
			{},
		);
		check("ausente → vazio",
			v["{post_products}"] === "",
			`got=${v["{post_products}"]}`);
	}

	// ── 2. buildPostData: products entram no youtube_options (ITEM > FIXO) ─────
	{
		const itemRow = {
			id: "item1", title: "Título do vídeo", caption_youtube: "cap yt",
			caption_instagram: null, caption_tiktok: null, caption: "cap",
			tags: null, youtube_products: "Tenis Running, Camiseta UV",
		};
		const postData = await buildPostData({
			prisma: { contentItem: { findFirst: async () => itemRow } } as never,
			planner: { user_id: "u1", id: "p1" },
			channel: { id: "c1", name: "Canal YT", platform: "youtube" },
			runtime: {
				mediaType: "REELS", mediaUrl: "/api/file/u1/v.mp4", thumbnailUrl: null,
				children: [] as never[],
				selectedContent: { id: "item1", title: "Título do vídeo", caption: "cap" },
				caption: "cap",
				shareToFeed: true, locationId: null, collaborators: null,
				userTags: null, audioConfiguration: null,
			} as never,
			config: { youtube_products: "Produto Fixo" } as never,
			now,
			templateIndex: 0,
			postOrdinal: 0,
		});
		check("buildPostData retornou youtube_options",
			typeof postData.youtube_options === "string" && postData.youtube_options.length > 0,
			`got=${postData.youtube_options}`);
		check("youtube_options contém product_names do item",
			typeof postData.youtube_options === "string" &&
				postData.youtube_options.includes("Tenis Running"),
			String(postData.youtube_options));
		check("youtube_options NÃO contém o fixo (ITEM venceu)",
			typeof postData.youtube_options === "string" &&
				!postData.youtube_options.includes("Produto Fixo"),
			String(postData.youtube_options));
	}

	console.log(`\n=== Smoke F6 {post_products}: ${pass} PASS, ${fail} FAIL ===`);
	if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });