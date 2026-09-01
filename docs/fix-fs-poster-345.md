# Fix FS — F3 (rotação) + F4 (primeiro comentário) + F5 (título IA)

Consolidado em `fixes-monolith` a partir de `1182b74`, via merges `--no-ff` na ordem
`trab-f3-rotation → trab-f4-comment → trab-f5-ai`. Nenhum conflito manual foi necessário
(o único arquivo compartilhado, `lib/planner-runtime.ts`, fez auto-merge limpo).

## Commits integrados

| Commit (merge em fixes-monolith) | Branche | Conteúdo |
|---|---|---|
| `332df55` | trab-f3-rotation | F3: rotação com dedupe + reinício |
| `a3f8cef` | trab-f4-comment | F4: primeiro comentário YT automático |
| `3c90b13` | trab-f5-ai | F5: título+produtos via OpenRouter + páginas públicas Termos/Privacidade |

## F3 — Rotação de biblioteca com dedupe + reinício automático

**O que mudou:** a seleção de itens do planner passou a respeitar `item_rotation`
(`sequential`/`random` com `repeat`), com dedupe por ciclo e reset automático ao esgotar
o acervo — nunca mais "travou" numa library que encolheu.

- `lib/planner-runtime.ts:185` — `selectContentIndex`: cursor persistido em
  `Planner.state` (`published_indexes`/`last_index`); dedupe + wrap/clamp; reset limpo
  em índices órfãos.
- `lib/planner-runtime.ts:129` / `:155` — `parseItemRotation` / `resolveRotationStrategy`
  (retrocompat com `random_loop` legado e `old_to_new`/`new_to_old`).
- `lib/planner-config.ts:646-648` — `validatePlannerConfig` aceita/rejeita `item_rotation`.
- `components/PlannerWizard.tsx` — UI de configuração da rotação.

**Como testar:** `npx --no-install tsx scripts/gauntlet/rotation-repeat.mts`
(36 cenários, todos passando) — exercita dedupe, reset, wrap/clamp e shrink sem banco.

## F4 — Primeiro comentário automático no YouTube

**O que mudou:** cada item de biblioteca pode carregar `first_comment`; o publisher
postou o comentário após o vídeo no canal YT vinculado, com sanitização de texto.

- `prisma/migrations/0014_add_first_comment/migration.sql` — coluna `first_comment` no
  ContentItem (decisão do dono: campo vive na library).
- `lib/first-comment.ts:51` — `publishYoutubeFirstComment` (insere comentário via API YT).
- `lib/planner-runtime.ts` — seleção expõe `first_comment` ao publisher.
- `app/api/cron/publisher/route.ts:1714,1723` — publisher lê o texto do snapshot
  `Post.first_comment` (cópia do ContentItem) e chama o publish do comentário.
- `app/api/content-items/route.ts` / `[id]/route.ts` — CRUD inclui o campo.
- `components/EditContentModal.tsx` — edição do `first_comment` na UI.
- `lib/sanitize.ts` — saneamento antes de enviar.

**Como testar:** `npx --no-install tsx scripts/gauntlet/first-comment.mts`
(22 cenários, todos passando).

## F5 — Título + produtos sugeridos por IA (OpenRouter)

**O que mudou:** botão "sugerir" no wizard chama `lib/ai.ts` via `app/api/ai/suggest`
(OpenRouter), que devolve título e lista de produtos parseados; páginas públicas
Termos/Privacidade (i18n) foram liberadas no AuthGuard.

- `lib/ai.ts:50` — `getOpenRouterConfig` (chave/modelo); `:126` — `parseSuggestionText`;
  `:160` — `suggestYoutubeFromDescription`.
- `app/api/ai/suggest/route.ts:16` — endpoint `POST` que orquestra a sugestão.
- `components/PlannerWizard.tsx` — UI de sugestão para título/produtos.
- `app/termos/page.tsx` / `app/privacidade/page.tsx` — páginas públicas em PT-BR.
- `components/AuthGuard.tsx:15-16` — `/termos` e `/privacidade` entram em `isPublicPage`
  (resolução final do conflito local pendente da rodada anterior).

**Como testar:** `npx --no-install tsx scripts/gauntlet/ai-suggest.mts`
(12 cenários, todos passando). Abrir `/termos` e `/privacidade` deslogado → não redireciona.

## Validação executada

- `npx tsc --noEmit` ✅
- `npm run build` ✅ (rotas estáticas `/termos` e `/privacidade` geradas)
- `node ./node_modules/prisma/build/index.js validate` ✅
- Smokes não-visuais: `rotation-repeat` (36/36), `first-comment` (22/22),
  `ai-suggest` (12/12), `products-routing` (20/20), `tiktok-isolation` (16/16),
  `tiktok-captions` (24/24), `tiktok-publishing` (70/70), `tiktok-a2-smoke` (16/16) ✅
- Nenhum smoke visual/Playwright/gauntlet-runs foi incluído em commit.