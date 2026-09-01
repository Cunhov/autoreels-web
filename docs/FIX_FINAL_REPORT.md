# FIX_FINAL_REPORT — F7 Integração/QA Final (7 blocos consolidados)

> **Agente:** 7+8 — BUILDER+CRÍTICO (gauntlet loop) · **Fase:** F7 — INTEGRADOR/QA FINAL
> **Branch:** `feat/yt-products-dual-captions` · **HEAD inicial:** `85855ad` (base da cadeia F0–F6) → **HEAD final:** `c123820` (F7, commits `8c946b2` + `4a2ab60` + reconciliação de doc)
> **Natureza:** auditoria cross-bloco + re-verificação da barra completa + 2 correções de QA (guard M5 na propagação `8c946b2` + limpeza de import morto `4a2ab60`) + relatório de consolidação (seção 8 abaixo cobre os dois commits, incluindo a colisão entre agentes paralelos do F7). Nenhuma feature nova; nenhum contrato quebrado.

---

## 1. Cadeia de commits verificada (F0→F6, ordem cronológica)

| Bloco | Commits | docs/fix-* | Status |
|---|---|---|---|
| **F0 — deadlock planner YT-only + media type por forma** | `d2723ba` (fix) · `60fd763` (verificação pós-B1) | `docs/fix-F0-b0-deadlock-yt-community.md` | ✅ |
| **F1 — produtos afiliados (formato único + roteamento + picker)** | `881d1d5` (helper/runtime) · `233d0e8` (publisher/createAutoShort) · `67dbf6a` (wizard picker) · `521f4c9` (docs) · `72408b2` (legado CSV/junk) · `cbed454` (resolveShortProductsRouting + teste 14/14) | `docs/fix-F1-b1-produtos-afiliados.md` | ✅ |
| **F2 — propagação espelha buildPostData** | `5a4cb9c` (buildYoutubeOptionsForPost única) · `f71cf61` (smoke commitado 6→7/7) | `docs/fix-F2-b2-propagacao-espelha-buildpostdata.md` | ✅ |
| **F3 — videoId real na busca de produtos (M6)** | `7be89ef` (fallback último Short + proxy listProducts) · `aa626e0` (guard legacy + labels) | `docs/fix-F3-b3-video-id-real-busca-produtos.md` | ✅ |
| **F4 — dual captions end-to-end (M9)** | `5d56d8a` (whitelist+sanitize) · `5e70c61` (uploader youtube.txt/instagram.txt) · `06564ff` (resolveFinalCaption única) · `a6cda86` (smoke 8/8) · `a333c76` (docs) · `13443a5` (E2E de rota 12/12) | `docs/fix-F4-P1-captions-duais.md` + `docs/fix-F4-P1-dual-captions.md` | ✅ |
| **F5 — races (M13/M14/M11/M10/M15)** | `36d1ad9` (guards + normalizações) | `docs/fix-races.md` | ✅ |
| **F6 — proxy nas rotas de gestão YT (M16)** | `efdc459` (fix) · `0529a67` (docs complementar) | `docs/fix-F6-P1-proxy-gestao-yt.md` + `docs/fix-F6-P1-proxy-rotas-gestao.md` | ✅ |
| **F7 — este bloco** | commit final deste relatório | `docs/FIX_FINAL_REPORT.md` (este) | ✅ |

---

## 2. Auditoria cross-bloco — 4 pontos únicos exigidos

| Régua única | Local (arquivo:linha) | Consumidores | Veredito |
|---|---|---|---|
| **`toYoutubeProductsJson`** (products → {names, items}) | `lib/planner-config.ts:214-244` | `buildYoutubeOptionsForPost` (`planner-runtime.ts:608`) — usado por **criação** (`:704`) e **propagação** (`:945`); **preview** usa a MESMA base `normalizeYoutubeProductsList`+`serializeYoutubeProducts` (`preview/route.ts:227-235`) para formato canônico de exibição | ✅ 1 régua — zero duplicação de parser products no runtime |
| **`buildYoutubeOptionsForPost`** (opts → youtube_options JSON) | `lib/planner-runtime.ts:449-650` | Única: `buildPostData` (`:704`) e `propagatePlannerConfigToPendingPosts` (`:945`). `buildYoutubeOptionsForPropagation` **DELETADA** (F2) | ✅ 1 função — propagação nunca mais apaga products/título/template-desc |
| **`resolveFinalCaption`** (plataforma → caption final) | `lib/planner-runtime.ts:279-287` (`youtube → caption_youtube ?? caption`; `instagram → caption_instagram ?? caption`; senão `caption`) | Via `resolveCaptionTemplateVars` (`:316`) + `applyCaptionTemplate` + `buildYoutubeOptionsForPost`; plataforma por canal em buildPostData (`:704`), propagação por post (`:945`), preview 1º canal (`:1122`, `preview/route.ts:140`) | ✅ 1 régua — `??` explicito (vazio = escolha), nunca 3 cópias |
| **`createAutoShort` com proxyUrl** | `lib/youtube.ts:475-541` (`proxyUrl?` → `youtubeFetch(..., input.proxyUrl ?? null)` `:531`) | Único caller `app/api/cron/publisher/route.ts:1274-1292` — `proxyUrl: proxyForShort` (`= getChannelProxyUrl(post.channel)` `:1264`) | ✅ proxy honrado na rota `/api/shorts/auto` |

## 3. Re-verificação da barra de entregas (item a item)

| Entrega | Verificação | Evidência |
|---|---|---|
| **Isolation YT/IG** (mix bloqueado) | `validatePlannerChannelMix` + guards client/server intactos (F0 não reverteu; campo community vive dentro do box YT) | `lib/planner-config.ts:314-340`; smoke F2 T5 (post IG → youtube_options intocado) ✅ |
| **Proxy no publisher** | createShort/createAutoShort/community-text/upload/IG + getSession check expirada | `publisher:1264` (proxyForShort), `:989/:1166` (community via `ytProxy`) ✅ |
| **bug-remove (cancelamento)** | PATCH cria `cancelled`; publisher nunca mais sobrescreve (M13 guards) | `lib/publisher-race-guard.ts`; F5 T11 "nenhuma escrita incondicional por id" ✅ |
| **bug-desc (propagação)** | título/descrição/products propagam via função única (M5/M17/M18) | smoke F2 T3 (PATCH youtube_title → title muda nos pending) ✅ |
| **Dual captions** | whitelist + sanitize + uploader `youtube.txt`/`instagram.txt` + resolução por plataforma | smokes F4 8/8 + E2E rota 12/12 ✅ |
| **Produtos afiliados** | `toYoutubeProductsJson` única + roteamento `verbatim→/shorts`, `names→/auto`, `none→sem products` | `lib/planner-config.ts:284-352`; teste `products-routing.mts` 14/14 ✅ |

| Item da barra (semântico) | Status | Evidência |
|---|---|---|
| **Nada de query-only em `/shorts`** | ✅ | `resolveShortProductsRouting`: verbatim → `/shorts` com `products`; nomes → `/shorts/auto`; nomes coexistentes viram SKIP com warning (`publisher:1253-1259`); teste M4 negativo: `{query}` sem item → `/auto` |
| **Nada de template em products** | ✅ | `buildYoutubeOptionsForPost` aplica `resolveYtTpl` SÓ em `youtube_title`/`youtube_description` (`:472-479`); products passam por `toYoutubeProductsJson` sem substituição (M22) — vírgula no nome sobrevive |
| **Comunidade SEM produtos** | ✅ | Community usa `createCommunityPostText`/`uploadCommunityPost` (`publisher:990/:1166`) — sem `products`; `youtube_options` nunca reescrito na propagação de community (`:948-950`) |
| **STORIES fora de YT** | ✅ | `resolvePlannerRuntime` normaliza `STORIES→REELS` quando 1º canal é YT (`planner-runtime.ts:1145-1157`) + wizard já auto-fixa no load/save; IG mantém STORIES |
| **Proxy no createAutoShort** | ✅ | `publisher:1274` → `proxyUrl: proxyForShort` |

## 4. Barra executada no HEAD final

| Check | Resultado |
|---|---|
| `node ./node_modules/prisma/build/index.js validate` | ✅ schema válido |
| `node ./node_modules/prisma/build/index.js generate` | ✅ Prisma Client v7.4.2 gerado |
| `npm run build` | ✅ Compiled successfully (48/48 páginas) |
| `npx tsc --noEmit` | ✅ 0 erros |
| `npm run lint` | ✅ 42 erros (idêntico à baseline `85855ad`: 42/42 — todos `no-explicit-any` pré-existentes) · 78 warnings (baseline 75; +3 aceitos: 2× anon-default-export em shims de teste `.ai/f4-dual-captions/*.mjs`, 1× exhaustive-deps falso-positivo no wizard — ref estável) |
| Smokes commitados | F2 **7/7** · F4 **8/8** · F4-dual-captions **12/12** · F5-races **11/11** · products-routing **14/14** — todos verdes no HEAD final |
| **Mudança deste bloco** | remoção de import morto `PUBLISHABLE_IN_FLIGHT_STATUSES` em `app/api/cron/publisher/route.ts` (dead code de F5; -1 warning; zero runtime) |

## 5. Testes E2E sugeridos (ponta-a-ponta, não automatizáveis sem API real)

1. **Produtos:** planner Short YT com 1 item verbatim + 1 nome → publicar → conferir log `resolveShortProductsRouting` (item tem prioridade, nome vira SKIP) e Short publicado com tag do item. Segundo planner só com nomes → `/shorts/auto` → Short com `total_selected` > 0.
2. **Dual captions:** pasta `video.mp4 + youtube.txt + instagram.txt` → upload → planner YT `{post_caption}` → post comunidade/short com texto do youtube.txt; planner IG → instagram.txt; pasta só com `legenda.txt` → ambos usam a genérica; `youtube.txt` vazio → YT sai vazio (`??`).
3. **Propagação:** planner com products+título+desc template → PATCH só a caption → `youtube_options` dos pending preserva products/título/desc re-resolvida; PATCH `youtube_title` → título dos pending muda.
4. **Races:** rodar cron; remover canal (bug-remove) com post `processing` → post permanece `cancelled` após o tick (log "desfecho bloqueado").
5. **Proxy M16:** canal atrás de proxy → refresh de sessão, listar/fixar comentários, deletar post de comunidade, `GET /api/youtube/sessions?channelId=` — todos devem sair pela network do proxy (log da API externa).
6. **STORIES legado:** config com `media_type:"STORIES"` em canal YT (editar JSON direto) → run → Short REELS com vídeo, warning no preview.
7. **Carrossel M10:** wizard com pasta de 1 imagem (bloqueio 400 PT-BR) e `POST /api/posts` CAROUSEL 1/11 → 400; 2..10 → 200.
8. **Busca M6:** `GET /api/youtube/products?channelId=&query=` sem videoId → último Short publicado resolve; canal sem Short → 400 PT-BR amigável → wizard mantém nome (auto-select).
9. **Community sem produtos:** planner YT Comunidade com products preenchidos → post comunidade NÃO envia products (sem efeito colateral de tagging).

## 6. Riscos residuais (documentados nos blocos, não corrigidos por decisão de escopo)

- **R1 — Wizard sem inputs dedicados de caption por plataforma (F4-P2):** `caption_youtube`/`caption_instagram` só entram via `{post_caption}` + item de biblioteca; `resolveCaptionTextForWizard` ainda estima dos fallbacks (validação pode bloquear item que só tem `youtube.txt`).
- **R2 — Carrossel IT 1 item legado (M10 residual):** runtime continua errando só com 0 filhos; configs grandfathered com 1 filho podem chegar ao publisher → falha definitiva com mensagem da API IG (não corrigido para não quebrar comunidade YT de 1 imagem).
- **R3 — `createSession` sem proxy (M16 R2):** a sessão ainda não tem canal na criação; limpeza de órfã já usa proxy do body. P2 futuro.
- **R4 — `getHealth` direto (M16 R3):** check global sem canal; documentado (P2 usar 1º canal com proxy ou manter direto).
- **R5 — Efeito colateral M13:** quando a API JÁ publicou e o cancelamento vence a corrida, o banco fica `cancelled` com conteúdo remoto existente — comportamento correto (cancelamento é decisão do usuário), log registra o fato.
- **R6 — `video_id` dos Shorts:** fallback do B3 depende de `youtube_video_id` preenchido (publisher grava junto com `published_at`); posts publicados ANTES do F3 com id vazio são excluídos do fallback por guard `NOT equals ""`.
- **R7 — Lint baseline:** 42 erros `no-explicit-any` pré-existentes na branch (não criados pela cadeia F0-F6; igual contagem em `85855ad`). Não limpos para não arriscar regressão na fase final.

## 7. Próximos passos (fora do escopo F0–F7)

1. **F4-P2 — inputs de caption por plataforma no wizard** (fecha R1) + `resolveCaptionTextForWizard` ciente de `caption_youtube`/`caption_instagram`.
2. **Runtime M10 — régua 2..10 no runtime** para carrosséis criados fora do wizard (fecha R2).
3. **Vídeo isca (`sacrifice_video_id`)** via `POST /api/sessions/{id}/config` da API externa — documentado no F3 como fluxo futuro (busca sem nenhum Short publicado).
4. **`createSession` com proxy** (fecha R3) e **health com proxy do 1º canal** (fecha R4) se houver demanda.
5. **Limpeza de lint baseline (R7)** como separate PR sem tocar lógica.
6. **Release/deploy:** `npx prisma migrate deploy && npx prisma db push` (migration 0009 — captions duplas — necessária no banco) + restart do cron.

## 8. Commit deste bloco

- `lib/planner-runtime.ts` (`8c946b2`) — **guard M5 na propagação:** quando `buildYoutubeOptionsForPost` retorna `null` (nenhum título resolvível — config patológico legado), a propagação NÃO grava `youtube_options = null` (não apaga products/título existentes do Short pendente); `rebuilt !== null` → aplica, `null` → preserva. Fecha delta de comportamento da unificação F2 vs `buildYoutubeOptionsForPropagation` antigo.
- `.ai/f2-smoke/smoke.test.mts` (`8c946b2`) — **T7** (regressão do guard): post com `youtube_options` + config sem título resolvível → `data.youtube_options === undefined` (preservado). Smoke F2 salta para 7/7.
- `app/api/cron/publisher/route.ts` (`4a2ab60`) — remoção do import morto `PUBLISHABLE_IN_FLIGHT_STATUSES` (dead code F5; -1 warning, zero runtime).
- `docs/FIX_FINAL_REPORT.md` — este relatório (consolidação dos dois agentes do F7).
- **Barra final** (worktree, os dois commits): tsc 0 erros · build ✓ · prisma validate ✓ · smokes F2 7/7 · F4 8/8 · F4-dual 12/12 · F5-races 11/11 · products-routing 14/14.
- **NUNCA push** (decisão do dono). Arquivos untracked de outros agentes (`.ai/watcher-audit-baseline.md`, `docs/diagnose-upload-vps.md`) NÃO commitados.