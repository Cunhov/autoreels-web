# Fix — Produtos afiliados por vídeo na library (REGRA ITEM > FIXO)

**Branch:** `feat/yt-products-dual-captions` · **Commit:** `90e8af6`
**Natureza:** feature completa (schema + migration + whitelists + modal + runtime + wizard + preview + smokes).

## Decisão do dono

Produtos de afiliado são **metadados editáveis por vídeo na library** (cada vídeo tem
produtos diferentes). O planner usa a REGRA **ITEM > FIXO**: se o ContentItem tem
`youtube_products` (CSV de nomes) não-vazio, ele vence o `youtube_products` fixo do
config do planner; planner só usa o fixo quando o item está vazio/ausente.

## O que mudou (arquivo:linha)

### Schema / migration

- `prisma/schema.prisma:149` — `ContentItem.youtube_products String?` (após
  `caption_youtube/caption_instagram`).
- `prisma/migrations/0010_add_item_youtube_products/migration.sql` — `ALTER TABLE
  "content_items" ADD COLUMN "youtube_products" TEXT;` (SQLite, idempotente p/ db push).

### API (whitelist + sanitize — sem mass assignment)

- `app/api/content-items/route.ts:14` — `POST_ALLOWED_FIELDS` ganha
  `youtube_products`; sanitização (bloco pós-caption): trim + limite 5000 → `p || null`.
- `app/api/content-items/[id]/route.ts:15` — `PATCH_ALLOWED_FIELDS` idem + sanitização.

### UI (edição de metadados da library)

- `components/EditContentModal.tsx` — `ContentItem.youtube_products?`, estado
  `youtubeProducts`, prefill no load, textarea na seção (após Legenda), hint
  "Nomes separados por vírgula — ex: Cadeira Gamer, Mousepad".
  - **Individual:** campo vazio → `updates.youtube_products = null` (LIMPA o item —
    remoção explícita na edição).
  - **Bulk:** só envia se digitado (vazio = manter o atual; não sobrescreve itens).
  - `slice(0,5000)` client + servidor (server é autoritativo).

### Runtime (a régua da publicação — única fonte)

- `lib/planner-config.ts` — `YoutubeProductsSource =
  string | unknown[] | null | undefined` e **`resolveYoutubeProductsSource`
  (função PURA testável)**: `itemProducts` string não-vazio → retorna item;
  senão → retorna `configProducts` (fixo).
- `lib/planner-runtime.ts` `buildYoutubeOptionsForPost` (bloco produtos L606+):
  agora resolve a fonte via `resolveYoutubeProductsSource(itemCsv, cfg[fixo])`,
  buscando o item por `selected.id || folder_id` (IDOR-safe, `select:
  { youtube_products: true }`). O item só carrega NOMES (CSV) → o routing já
  existente (`resolveShortProductsRouting`) os envia a `POST /api/shorts/auto`
  (product_names) — produtos do item nunca viram verbatim (`hasItems`).
  Propagação usa a MESMA função (herda ITEM>FIXO automaticamente — M5 preservado).

### Wizard (informativo)

- `components/PlannerWizard.tsx` — `selectedItemProducts` (map itemId→CSV) +
  `finalSelectedItemProducts` (nomes únicos dos itens selecionados, memo) + fetch
  `GET /api/content-items?limit=500` quando `selectedContentIds` muda. Na seção
  **Produtos Afiliados** (modo Short YT): aviso
  *"✨ Este vídeo tem N produto(s) marcado(s) na biblioteca — serão usados na
  publicação (prioridade do vídeo sobre este fixo)."* O fixo do planner continua
  editável (fallback p/ item vazio).

### Preview

- `app/api/planners/[id]/preview/route.ts` — `youtube_fields.item_youtube_products`
  (CSV do item selecionado; `null` quando sem item).

### Smokes

- `scripts/gauntlet/products-routing.mts` — +6 casos **ITEM>FIXO** (11–16):
  item CSV não-vazio → vence e vira nomes `/auto`; item null → fixo; item
  só-espaços → fixo; item array → fixo (item guarda só string); nomes do vídeo →
  `/shorts/auto`. Total: **20/20**.

## Mecânica de execução

1. Usuário edita o vídeo na library (modal) e preenche "Produtos Afiliados (YouTube)".
2. Wizard do planner (Short YT) mostra o aviso; o fixo continua opcional (fallback).
3. `buildYoutubeOptionsForPost` → `youtube_options.product_names` (nomes) →
   publisher → `POST /api/shorts/auto` (auto-select do MELHOR produto — API externa
   pontua preço×comissão) ou itens verbatim (`/shorts`) quando o fixo tem `{query,item?}`.

## Como testar (E2E)

1. **Editar item:** library → vídeo → editar → campo "Produtos Afiliados (YouTube)" →
   digitar `Smartwatch, Mousepad` → salvar.
2. **Planner sem fixo:** criar planner Short YT com esse vídeo, deixar Produtos
   fixos VAZIOS → aviso "tem 2 produto(s)" aparece → run → o Short é taggeado com os
   2 produtos (log `resolveShortProductsRouting` → `/shorts/auto`, `total_selected>0`).
3. **Fixo como fallback:** esvaziar os produtos do item (modal, campo vazio → salva
   null) → planner com fixo `[{"query":"fone"}]` → publicação usa o fixo.
4. **API:** `PATCH /api/content-items/:id {"youtube_products":"Cadeira Gamer, Mousepad"}`
   → 200; `PATCH` com `{"youtube_products":""}` → grava `null` (limpa).

## Riscos residuais

1. **Vírgula no nome:** separador é vírgula (mesma regra do formato legado do
   planner). Nomes com vírgula não são suportados (documentado no hint do modal).
2. **Bulk sem sobrescrever:** bulk edit não limpa produtos existentes (vazio =
   manter). Limpeza é sempre por item (individual).
3. **Propagação com item:** se o item da library mudar os produtos depois de post
   pendente, a pendência mantém o snapshot da criação (comportamento existing de
   caption — post é snapshot). Nova geração usa o novo valor (M5 não regride).
4. **Sandbox checker:** `prisma` bare não resolve no PATH sanitizado do pi-lens
   (dirs do PATH são root; repo tem diretório `prisma/`). Validação provada via
   `node module/prisma/build/index.js validate` (🚀) e `npx --no-install prisma`.
   Não afeta build/CI.
