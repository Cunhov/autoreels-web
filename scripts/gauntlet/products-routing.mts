#!/usr/bin/env node
/**
 * Produtos afiliados — teste de ROTEAMENTO real (B1, M1/M2/M3/M4/M22).
 *
 * Roda a ÚNICA fonte da regra de decisão (resolveShortProductsRouting em
 * lib/planner-config.ts — extraída do bloco inline do publisher) contra o
 * contrato da API externa (~/Projects/youtube-community-api/app/api/shorts.py):
 *   - create_short  tem `products`  (só aceita dicts — _parse_products filtra strings)
 *   - /auto         tem `product_names`+`filters`
 *   - NUNCA misturar as duas formas na MESMA chamada
 *   - {query} sem item NUNCA pode ir a /shorts (build_products_selection lança — 502)
 *
 * Runner: npx --no-install tsx scripts/gauntlet/products-routing.mts
 * Exit code 0 only if every scenario passes.
 */
import { resolveShortProductsRouting } from "../../lib/planner-config";

let failures = 0;
let passed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.error(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`);
  }
}

// ─── casos ───────────────────────────────────────────────────────────────────

// 1. verbatim (formato novo B1): products = '[{"item":{...}}]' -> /shorts
{
  const r = resolveShortProductsRouting({
    products: JSON.stringify([{ item: { produto_id: "mlb-1", title: "Smartwatch" } }]),
  });
  check("verbatim: 1 item {item} -> route verbatim", r.route === "verbatim");
  check("verbatim: items mantêm o dict preservado",
    r.items.length === 1 &&
    Boolean((r.items[0] as Record<string, unknown>)?.item) &&
    (r.items[0] as { item: { produto_id: string } }).item?.produto_id === "mlb-1");
}

// 2. query-only (formato novo B1): product_names = '["smartwatch"]' -> /auto
{
  const r = resolveShortProductsRouting({
    product_names: JSON.stringify(["smartwatch", "Garrafa 1L, térmica"]),
  });
  check("query-only: route auto (NUNCA /shorts — M4)", r.route === "auto");
  check("query-only: names passam intactos (M22 — vírgula no nome)",
    r.names.length === 2 && r.names[1] === "Garrafa 1L, térmica");
}

// 3. legado M1: products = '["nome"]' (strings) -> vira nome -> /auto
{
  const r = resolveShortProductsRouting({
    products: JSON.stringify(["relogio"]),
  });
  check("legado M1: strings em products -> /auto (antes: descartadas silenciosamente)",
    r.route === "auto" && r.names.includes("relogio") && r.items.length === 0);
}

// 4. legado: CSV cru não-JSON pós-B1 ("relogio,tenis") -> nomes -> /auto
{
  const r = resolveShortProductsRouting({ products: "relogio,tenis" });
  check("legado: CSV cru -> nomes -> /auto",
    r.route === "auto" && r.names.join("|") === "relogio|tenis");
}

// 5. lixo pré-B1: products = '"[object Object]"' -> NUNCA nome de busca
{
  const r = resolveShortProductsRouting({
    products: JSON.stringify("[object Object]".split(",")), // mais fiel: JSON string junk
  });
  check("lixo '[object Object]' descartado -> none", r.route === "none" && r.names.length === 0);
}
{
  const r = resolveShortProductsRouting({ products: "[object Object]" });
  check("lixo CSV cru '[object Object]' descartado -> none",
    r.route === "none" && r.names.length === 0);
}

// 6. mistura: verbatim + nomes -> verbatim vence, nomes viram SKIP
{
  const r = resolveShortProductsRouting({
    products: JSON.stringify([{ item: { produto_id: "x" } }]),
    product_names: JSON.stringify(["smartwatch"]),
  });
  check("misto: verbatim tem prioridade (nunca misturado na mesma chamada)",
    r.route === "verbatim" && r.items.length === 1);
  check("misto: nomes coerentes viram skippedNames=1",
    r.skippedNames === 1 && r.names.length === 1 && r.names[0] === "smartwatch");
}

// 7. nada: nenhum campo -> /shorts com products vazio (route none)
{
  const r = resolveShortProductsRouting({});
  check("nada: route none (createShort manda products '[]')",
    r.route === "none" && r.items.length === 0 && r.names.length === 0);
}

// 8. product_names como ARRAY (pós-B1 publish de buildPostData é JSON string,
//    mas suportar array direto) -> /auto
{
  const r = resolveShortProductsRouting({ product_names: ["relogio"] });
  check("product_names em array -> /auto", r.route === "auto" && r.names[0] === "relogio");
}

// 9. missão do wizard: {query,item} via toYoutubeProductsJson -> /shorts verbatim
import { toYoutubeProductsJson } from "../../lib/planner-config";
{
  const payload = toYoutubeProductsJson([
    { query: "smartwatch", item: { produto_id: "mlb-2" } },
    { query: "só nome" },
  ]);
  check("toYoutubeProductsJson: item -> items, query-only -> names",
    payload.hasItems && payload.hasNames &&
    payload.items.length === 1 && payload.names.length === 1 &&
    payload.names[0] === "só nome");
}

// 10. negativo absoluto (M4): query-only NUNCA em route verbatim, nunca em items
{
  const r = resolveShortProductsRouting({
    product_names: JSON.stringify(["sem item"]),
  });
  check("negativo M4: {query:\"sem item\"} -> /auto, NUNCA /shorts",
    r.route === "auto" && r.items.length === 0);
}

console.log(`\nroteamento F1-B1: ${passed} passaram, ${failures} falharam`);
if (failures > 0) process.exit(1);
// ─── REGRA ITEM > FIXO (funcionalidade nova — produtos por vídeo na library) ──
// resolveYoutubeProductsSource: CSV de nomes do ContentItem vence o
// youtube_products fixo do config quando NÃO-vazio; senão usa o config.
import { resolveYoutubeProductsSource } from "../../lib/planner-config";

// 11. item com produtos CSV -> item vence o fixo do planner
{
  const src = resolveYoutubeProductsSource(
    "Smartwatch, Mousepad",
    "produto fixo do planner",
  );
  check("ITEM>FIXO: item não-vazio vence o fixo (string CSV preservada)",
    src === "Smartwatch, Mousepad");
  const payload = toYoutubeProductsJson(src);
  check("ITEM>FIXO: CSV do item vira nomes (auto-select /shorts/auto)",
    payload.hasNames && payload.names[0] === "Smartwatch" &&
    payload.names.length === 2 && !payload.hasItems);
}

// 12. item vazio/null -> usa o fixo do planner
{
  const src = resolveYoutubeProductsSource(null, "produto fixo do planner");
  check("ITEM>FIXO: item null -> fixo do planner",
    src === "produto fixo do planner");
}

// 13. item strings-only (espaços) -> considera vazio -> fixo
{
  const src = resolveYoutubeProductsSource("   ", "fixo");
  check("ITEM>FIXO: item só-espaços -> fixo", src === "fixo");
}

// 14. item não-string (ex.: array legacy no item?) -> não é CSV -> fixo
{
  const src = resolveYoutubeProductsSource(["x"], "fixo");
  check("ITEM>FIXO: item array (não-CSV) -> fixo (item guarda só string)",
    src === "fixo");
}

// 15. routing final com item: nomes do item -> /auto (nunca /shorts verbatim)
{
  const r = resolveShortProductsRouting({
    product_names: JSON.stringify(["Smartwatch", "Mousepad"]),
  });
  check("ITEM>FIXO: nomes do vídeo vão a /shorts/auto",
    r.route === "auto" && r.names.length === 2 && r.items.length === 0);
}

console.log(`\nroteamento F1-B1 + ITEM>FIXO: ${passed} passaram, ${failures} falharam`);
if (failures > 0) process.exit(1);
