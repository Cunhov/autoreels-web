# fix-F1-B1 — Produtos afiliados: formato único + roteamento real de tagging

> **Fase:** F1-B1 (P0 M1/M2/M3/M4/M22) · **Branch:** `feat/yt-products-dual-captions`
> **Commits:** `881d1d5` (helper/runtime), `233d0e8` (publisher/createAutoShort), `67dbf6a` (wizard)
> **Base de decisão:** docs/PLANNER_AUDIT_REPORT.md P0-B1 + audit-track-api F2 + audit-track-wizard W4/W5 + audit-track-yt-short #2/#3/#5/#6/#12/#13.

---

## Problema (antes)

Wizard gravava CSV de nomes/IDs → `buildPostData` fazia `JSON.stringify(csv.split(","))` →
publisher mandava esse array **no campo `products`** de `POST /api/shorts` → a API externa
`_parse_products` (shorts.py:75-88) **descarta tudo que não for dict** → 0 produtos
taggeados, **sem erro** (M1). O caminho certo para nomes (`POST /api/shorts/auto` com
`product_names`+`filters`) existia na API mas tinha **zero referências no app** (M3).
`{query}` sem `item` enviado verbatim derrubaria o upload inteiro com 502 (M4).
Vírgula no nome do produto / template `{var}` em products quebravam tudo (M22).

## O que mudou (arquivo:linha)

### 1. `lib/planner-config.ts` — helper ÚNICO `toYoutubeProductsJson`
- Nova interface `YoutubeProductsPayload { names, items, hasNames, hasItems }` e função
  `toYoutubeProductsJson(value)` (~L214-244): consome `normalizeYoutubeProductsList`
  (que já converte CSV legacy / array de strings → `{query}`) e separa:
  **names** = entradas query-only (rota `/short/auto`) · **items** = `{ item }` verbatim
  (rota `/shorts`). Entrada com `item` nunca vira `name`; **nenhum template/CSV-split**
  no nome (M22 — vírgula no nome sobrevive, verificado em teste).
- `validatePlannerConfig` — bloco `youtube_products` reescrito: shape-check via
  `normalizeYoutubeProductsList` (aceita `Array<{query,item?}>`, array de strings, CSV
  legacy; array vazio = sem produtos; junk → erro). Limites: nome ≤500 chars, ≤50
  produtos.

### 2. `lib/planner-runtime.ts` — `buildPostData` (bloco Short)
- Produtos agora usam `toYoutubeProductsJson(cfg["youtube_products"])` (~L455-470).
  `youtube_options` carrega **separados**: `products` = JSON de `[{item}]` e
  `product_names` = JSON de `["nome"]`. Removido `resolveYtTpl` em products (M22:
  produto não é caption) e o split por vírgula.
- `buildYoutubeOptionsForPropagation` (~L760-766): reconstrói `products`/`product_names`
  com o **mesmo helper** — editar um planner não apaga mais os afiliados dos Shorts
  pendentes (correção preventiva do M5/W8; a unificação total `buildYoutubeOptions` é
  fase B2).

### 3. `lib/youtube.ts` — `createAutoShort`
- Nova `createAutoShort(input)` (~L465-540): espelha `createShort` (multipart do vídeo,
  title/description/privacy/made_for_kids/category_id/monetize/pinned_comment_text) mas
  envia `product_names` (JSON array **string** — preserva vírgula no nome, M22) e
  `filters` (JSON string) para `POST /api/shorts/auto`, **sem** `products`. `proxyUrl?`
  opcional. `YoutubeAutoShort` tipa a resposta (video_id/url/total_selected/per_product/
  tagging_error) + `status`/`watch_url` sintéticos para paridade com `createShort`.
- `YoutubeShortOptions.product_names?: string[] | string` adicionado.

### 4. `app/api/cron/publisher/route.ts` — bloco Short (rota real de tagging)
- Substituído `productsStr` por parsing separado de `options.products` + `options.product_names`
  e **decisão de roteamento documentada** (~L1180-1290):
  - **algum item verbatim** (objeto) → `POST /api/shorts` com `products=[{item}]`
    (nomes coexistentes viram **SKIP com warning** no log — nunca misturar as duas
    formas numa chamada; regra segura: item escolhido pelo usuário tem prioridade);
  - **só nomes** → `POST /api/shorts/auto` com `product_names` + `filters` default
    `{mercadolivre:true, shopee:true, amazon:true, min_commission_pct:0, items_per_product:1}`;
  - **nada** → `POST /api/shorts` com `products="[]"`;
  - **legado**: strings em `products` (ex. `["nome"]`) e CSV cru colapsam em nomes → `/auto`
    (antes: descartados silenciosamente — M1); junk pré-B1 `"[object Object]"` descartado.
- `createAutoShort` recebe `proxyUrl: getChannelProxyUrl(post.channel)` — mesma cobertura
  de proxy do `createShort` (entrega proxy preservada).

### 5. `components/PlannerWizard.tsx` — picker real (modo Short YT)
- Substituído input CSV + "Buscar" (JSON cru read-only) por **lista dinâmica**:
  botão "+ Adicionar Produto Afiliado", "X" remove, input por entrada com **busca live
  (debounce 600ms)** em `GET /api/youtube/products?channelId=&query=&videoId=`.
- **videoId vazio nesta fase (F1)**: rota responde 400 → mensagem amigável
  "Publique um Short primeiro para buscar o catálogo…" e a entrada **continua como nome**
  (auto-select `/short/auto` busca na publicação, com o vídeo real).
- Dropdown de resultados (title/vendor/price/commission_pct) → clique **fixa o item
  verbatim** (status `selected`); "trocar" volta a nome-only (status `name`).
- Submit: `config.youtube_products = serializeYoutubeProducts(entries {query,item?})`
  (nunca CSV). Load: aceita CSV legacy, array de strings e array `{query,item?}` via
  `normalizeYoutubeProductsList`. Anti-race: resultado só aplica se o query ainda é o atual.
- Timer de busca limpo no unmount.

### 6. `app/api/planners/[id]/preview/route.ts`
- `youtube_products` exposto no formato canônico `Array<{query,item?}>` (helper normalize+
  serialize) — nunca CSV cru.

## Como testar (E2E — exige session YT ativa + vídeo)

1. **query-only:** config `youtube_products = [{"query":"smartwatch"}]` → publica Short →
   publisher chama `POST /api/shorts/auto` → log "[YouTube] Short enviado via
   /api/shorts/auto (auto-select 1 produto(s))" → resposta `total_selected >= 1` e
   `tagging_error = null` (produto aparece no vídeo).
2. **verbatim:** `[{"query":"x","item":{...}}]` (item copiado da busca live) → publisher
   usa `POST /api/shorts` → log "/api/shorts (1 produto(s) verbatim)" → `_parse_products`
   mantém o dict → tag aplicada (studio.py:1408-1412).
3. **negativo (M4):** `[{"query":"sem item"}]` **NUNCA** passa por `/api/shorts` — com essa
   config, o publisher vai para `/auto` (verificado por teste de roteamento 8/8 casos).
4. **mixed (decisão):** `[{query:"nome"},{query:"v",item:{...}}]` → vai `/shorts` com o
   item; o nome vira warning de SKIP no log do planner.
5. **M22:** produto com vírgula no nome (ex. "Garrafa 1L, térmica") via picker → `names`
   intacto (JSON array string no `/auto`).

## Riscos / observações

- **Posts pendentes antigos** com `youtube_options.products='["nome"]'` agora vão a
  `/auto` (comportamento novo e correto) — candidatos a `total_selected=0` se o nome não
  bater com o catálogo; não quebram o upload.
- **Relaxamento de validação:** CSV "a,,b" deixa de dar erro (antes sim) — formato novo é
  objeto-based; CSV legacy só existe em configs antigos e é normalizado para `{query}`.
- **Propagação** reconstrói products com o mesmo helper (W8 parcial): a unificação total
  de `buildYoutubeOptions` (título/templates) permanece fase B2.
- **Busca live** exige "Publique um Short primeiro" (400) até a fase F3 (B3) resolver o
  `videoId` real (último Short publicado do canal / sacrifice_video_id).
- Filtros do `/auto` ficaram com default (todos marketplaces) — expor os filtros na UI
  (min_commission_pct/items_per_product/preço×comissão) é evolução posterior.