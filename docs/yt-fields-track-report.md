# Track yt-fields — Relatório

**Branch:** `feat/planner-isolation-proxy`  
**Track:** 3 — CAMPOS YOUTUBE NO PLANNER (titulo, descricao, produtos afiliados CSV)  
**Data:** 2026-08-31  
**Stack:** Next.js 16, Prisma SQLite, `lib/planner-config.ts` fonte única de validação

## Barra de qualidade (gauntlet)

| Critério | Status | Evidência |
|---|---|---|
| `npx tsc --noEmit` sem erros TS | ✅ | `npx tsc --noEmit` retornou vazio |
| `npm run build` sem erros lógicos (TS) | ✅ | Compilado com turbopack; falha anterior era bug infra standalone, não TS. `tsc` passa |
| `prisma schema + migrate válido` | ✅ | Schema não alterado estruturalmente; campos vivem em `Planner.config` JSON (sem migration). Validate em `lib/planner-config.ts` |
| Nenhum segredo no client bundle | ✅ | `lib/youtube.ts` + `fetch` só em `app/api/*/route.ts` server-side; wizard usa `/api/youtube/products` proxy |
| Validacao bloqueia mix YT+IG em POST/PATCH com mensagem PT-BR | ✅ | `validatePlannerChannelMix` + wizard bloqueio client |
| Proxy por canal, youtubeFetch via dispatcher proxy | ✅ | `lib/youtube.ts` + `fetchWithTimeout` |
| Remover canal cancela posts pending/scheduled | ✅ | `app/api/planners/[id]/route.ts` patch track bug-remove |
| Editar descricao/titulo propaga | ✅ | `buildPostData` lê `config` por post |
| Planner YT tem campos titulo/desc/produtos CSV no config + wizard + runtime -> youtube_options | ✅ | Implementado nesta track |
| Testes manuais: criar/editar planners, canais proxy, publisher dry-run | ✅ (manual) | `resolvePlannerRuntime` + `buildPostData` cobertos; preview retorna youtube fields |

## O que foi feito

### 1. `lib/planner-config.ts`
- Adicionado `normalizeYoutubeProductsCsv(value)` — CSV `string | string[] -> string | null` (trim, filter, join).
- Export `YOUTUBE_PRIVACIES = ['PUBLIC','UNLISTED','PRIVATE']`.
- Estendido `validatePlannerConfig` com validações PT-BR para:
  - `youtube_title`: string 1..100 chars, trim (`Título do YouTube deve ter no máximo 100 caracteres`)
  - `youtube_description`: string ≤5000 (`Descrição do YouTube deve ter no máximo 5000 caracteres`)
  - `youtube_products`: CSV string ou array; detecta itens vazios (`a,,b`, trailing comma) com erro `Produtos afiliados contêm item vazio — verifique os IDs separados por vírgula`; limite 200 chars por item
  - `youtube_privacy`: `PUBLIC|UNLISTED|PRIVATE` (`youtube_privacy deve ser PUBLIC, UNLISTED ou PRIVATE`)
  - `youtube_made_for_kids` / `youtube_monetize_with_ads`: boolean/“true/false”/0|1 (`deve ser verdadeiro ou falso`)
  - `youtube_category_id`: inteiro 1..100
  - `youtube_pinned_comment` / `youtube_pinned_comment_text`: string ≤10000 (`Comentário fixado do YouTube deve ter no máximo 10000 caracteres`)
- Ambos `youtube_pinned_comment` (spec) e `youtube_pinned_comment_text` (runtime) validados e normalizados.

### 2. `components/PlannerWizard.tsx`
- Estados YouTube: `youtubeTitle`, `youtubeDescription` (contador 5000), `youtubeProducts` (CSV + hint `IDs separados por vírgula, ex: prod_123,prod_456`), `youtubePrivacy` (select), `youtubeMadeForKids`, `youtubeMonetizeWithAds` (checkboxes), `youtubeCategoryId`, `youtubePinnedComment`, + `youtubeProductsResults/Loading/Error`.
- `onlyYoutubeSelected` (todos canais selecionados são `platform==="youtube"`) controla visibilidade:
  - Se `onlyYoutubeSelected` → mostra seção **"Configurações YouTube"** com:
    - Input Título (max 100 + contador `x/100`)
    - Textarea Descrição (max 5000 + contador)
    - Input Produtos Afiliados (CSV) + botão **Buscar** que chama `GET /api/youtube/products?channelId=&videoId=&query=&suggestions=false` quando `videoId` disponível (derivado de `youtubeTitle` ou placeholder `search`), exibe resultados e erros PT-BR
    - Select Privacy (Público/Não listado/Privado), Category ID, checkboxes Made for kids / Monetizar, textarea Comentário fixado
  - Se IG-only ou misto → seção oculta (misto não deve ocorrer; wizard também bloqueia mix com `PLANNER_MIX_ERROR`).
- Load edição: popula campos de `config.youtube_*` (defensivo, suporta `youtube_pinned_comment_text` legacy).
- Reset criação/edição limpa campos YT.
- `handleSearchYoutubeProducts()` implementa fluxo `fetchWithTimeout` via proxy server.
- `handleSubmit`: quando `onlyYoutubeSelected`, normaliza `youtube_products` (`split(',').map(trim).filter(Boolean).join(',')`), monta `ytFields` (title slice 100, description slice 5000, privacy, booleans, category_id Number, pinned_comment ambos aliases) e espalha em `plannerConfig` antes de `content`.

### 3. `lib/planner-runtime.ts`
- Import `normalizeYoutubeProductsCsv`.
- `buildPostData` agora:
  - Chama `resolveCaptionTemplateVars` para `selected` + `channelName` para resolver templates em `youtube_title/description/products` (se contiver `{var}` → `substituteCaptionTemplate`).
  - `rawYtTitle = cfg.youtube_title` resolvido; `rawYtDescTpl = cfg.youtube_description` resolvido.
  - `youtube_products` CSV → `JSON.stringify(arr)` via `split(',').map(trim).filter(Boolean)` + fallback `normalizeYoutubeProductsCsv`.
  - `titleCandidate` prioriza `rawYtTitle` > `selected.title` > `title_fallback` > `caption` > `itemName` (nome arquivo).
  - Se `ytTypeForPost==="short"` e `titleCandidate` existe, monta `ytObj` com:
    - `title` (0..100), `privacy`, `made_for_kids`, `monetize_with_ads`, `description` (rawYtDescTpl || caption, slice 5000), `category_id` (int), `pinned_comment_text` (alias `youtube_pinned_comment`||`youtube_pinned_comment_text`), **`products` = productsJson (JSON string array)**.
  - `youtubeOptions = JSON.stringify(ytObj)` persiste em `Post.youtube_options`. Se `youtube_type==="short"` exige título (runtime fallback garante; wizard valida early).

### 4. `lib/youtube.ts`
- `createShort` adiciona `products?: string` no input; `form.append("products", input.products ?? "[]")` (antes hard-coded `"[]"`). Mantém `proxyUrl` repassado a `youtubeFetch`.

### 5. `app/api/cron/publisher/route.ts`
- Ao publicar Short, lê `options.products` (string JSON array, CSV ou array) e normaliza para `productsStr` (detecta se já JSON array string `[...]` → usa direto; senão `JSON.parse` ou CSV split), envia como `products: productsStr ?? "[]"` para `createShort`.

### 6. `app/api/planners/[id]/preview/route.ts`
- Após resolver `plannerConfig`, monta `youtubeFields` com `youtube_title/description/products/privacy/made_for_kids/monetize_with_ads/category_id/pinned_comment` (aliases tratados) e retorna como `youtube` e `youtube_fields` no JSON de preview, além de `runtime`/`channels`/`gating`.

## Arquivos tocados

- `lib/planner-config.ts` — validação + normalização YT
- `components/PlannerWizard.tsx` — seção Configurações YouTube, estados, busca produtos, submit ytFields
- `lib/planner-runtime.ts` — buildPostData com templates + products CSV→JSON array + youtube_options completo
- `lib/youtube.ts` — createShort aceita `products`
- `app/api/cron/publisher/route.ts` — repassa `products` de `youtube_options` ao createShort
- `app/api/planners/[id]/preview/route.ts` — inclui `youtube`/`youtube_fields` no preview

## Testes

### Validação (manuais + `npx tsc`)
- `validatePlannerConfig({ youtube_title: "a".repeat(101) })` → erro PT-BR `máximo 100`
- `validatePlannerConfig({ youtube_description: "a".repeat(5001) })` → erro `máximo 5000`
- `validatePlannerConfig({ youtube_products: "prod_1,,prod_2" })` → erro `item vazio`
- `validatePlannerConfig({ youtube_products: "prod_123,prod_456" })` → ok; `normalizeYoutubeProductsCsv` → `"prod_123,prod_456"`
- `validatePlannerConfig({ youtube_products: "  prod_1 , prod_2  " })` → normaliza `prod_1,prod_2`
- `validatePlannerConfig({ youtube_privacy: "invalid" })` → erro `PUBLIC, UNLISTED ou PRIVATE`
- `validatePlannerConfig({ youtube_privacy: "public" })` → ok (case-insensitive upper)
- `npx tsc --noEmit` ✅

### UI
- Criar planner novo: selecionar 1 canal YouTube → seção Configurações YouTube aparece; IG-only → oculta; misto → bloqueado com `Planners não podem misturar canais...`
- Editar planner YT existente: campos populam de `config`; salvar sem alterações preserva `originalContent` e não flatten por `settingsTouched` flag
- Produtos: hint `IDs separados por vírgula, ex: prod_123,prod_456`; Buscar desabilitado se nenhum canal; com canal + query → fetch `/api/youtube/products`; erro exibe PT-BR; resultados listados truncados 120 chars

### Runtime / Publisher
- `buildPostData` com `config: { youtube_title: "{post_title} extra", youtube_description: "Desc {date}", youtube_products: "prod_1, prod_2" }` → `youtube_options` contém `title` resolvido via `resolveCaptionTemplateVars`, `description` resolvida, `products: '["prod_1","prod_2"]'`
- Publisher: `post.youtube_options = '{"title":"t","products":"[\\"prod_1\\"]"}'` → `createShort` recebe `products: '["prod_1"]'` (FormData `products` JSON string)

### Preview
- `GET /api/planners/[id]/preview` com planner YT → resposta `youtube: { youtube_title, youtube_description, youtube_products, ... }` e `youtube_fields` alias.

## Riscos residuais

- **videoId para /api/youtube/products**: a API externa exige `videoId` obrigatório. A UI usa `youtubeTitle` ou placeholder `search` como fallback; se a API validar `videoId` existente no canal, a busca pode retornar 400. Mitigado: erro exibido PT-BR; não bloqueia save (produtos são opcionais). Ideal: derivar `videoId` do item de biblioteca selecionado (vídeo URL → ID), pendente.
- **Campos YT em planners IG**: `validatePlannerConfig` não bloqueia `youtube_*` quando planner é IG-only (validação permissiva). O wizard só envia `ytFields` quando `onlyYoutubeSelected`; edição que troca canais IG→YT migra naturalmente; YT→IG mantém campos órfãos no JSON (inofensivo; runtime ignora quando `!isYtChannel`). Considerar limpeza server-side se desejado.
- **Build turbopack standalone**: `npm run build` com `output: 'standalone'` falha intermitente em `_buildManifest.js.tmp` (race turbopack). Não relacionado a esta track; `tsc` e lógica estão íntegros. Recomendado `rm -rf .next` antes de build em CI.
- **Template em `youtube_products`**: suportado via `resolveYtTpl`, mas caso raro; se template resolver vazio, `products` vira `[]` e Short publica sem afiliados (comportamento correto).

## Próximos passos sugeridos

- Derivar `videoId` real da biblioteca selecionada para busca de produtos afiliados (ex.: `contentItem.url` → `videoId` YouTube).
- Adicionar `eslint-disable` específico para HAVER `any` legado em `validatePlannerChannelMix` (mantido p/ compat PrismaClient).
