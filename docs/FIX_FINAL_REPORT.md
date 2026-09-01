# FIX_FINAL_REPORT — F7 Integração Final QA (gauntlet loop)

> **Agente:** 7/8 — BUILDER+CRÍTICO · **Fase:** F7 — Integrador/QA final
> **Branch:** `feat/yt-products-dual-captions` · **Base da verificação:** `85855ad` (pré-F0) → HEAD `0529a67` (F6)
> **Fonte de verdade:** `docs/PLANNER_AUDIT_REPORT.md` + `docs/audit-track-*.md` + `docs/fix-{F0..F6}-*.md` (todos lidos antes de editar)
> **Natureza:** auditoria cross-bloco (4 invariantes) + barra completa + 1 correção de integração (guard M5 na propagação) + relatório. NENHUM doc legado editado.

---

## 0. Veredito

**INTEGRAÇÃO OK — com 1 correção de QA.** A cadeia F0→F6 está íntegra: as 4 invariantes cross-bloco se verificam no código, a barra completa passa (tsc/build/prisma/lint-baseline) e **todas as 5 suítes commitadas passam (52/52 cenários + regressão)**. Foi encontrado e corrigido **1 gap real de integração na propagação** (apagar `youtube_options` quando o título não resolve — violação da garantia M5). Commit final desta fase no HEAD da branch, sem push (decisão do dono).

---

## 1. Matriz bloco → arquivos → status (F0–F6, re-verificado no worktree)

| Bloco | Problemas (PLANNER_AUDIT) | Arquivos principais | Status no F7 |
|---|---|---|---|
| **F0-B0** deadlock + media type por forma | M7/M19/M23/M8 | `components/PlannerWizard.tsx` (guard Short, texto da Comunidade, label carrossel, campos YT só em REELS), `lib/planner-config.ts` (`resolveCaptionTextForWizard`, `validateYtCommunityText`, `YT_CONFIG_KEYS`) | ✅ wizard `:1937-1995` — Produtos Afiliados só no bloco `REELS`; Comunidade sem produtos com aviso textual (`:1930-1933`) |
| **F1-B1** produtos | M1/M2/M3/M4/M22 | `lib/planner-config.ts` (`toYoutubeProductsJson` `:241`, `resolveShortProductsRouting` `:264-352`), `lib/planner-runtime.ts` (`:603-616`), `lib/youtube.ts` (`createAutoShort` `:475`), `app/api/cron/publisher/route.ts` (`:1180-1320`), `PlannerWizard.tsx` (picker live), `preview/route.ts` (`:227-233`) | ✅ helper único; roteamento 14/14; query-only **NUNCA** em `/shorts` (teste negativo M4); nenhum template `{var}` em products; vírgula no nome preservada |
| **F2-B2** propagação | M5/M17/M18/G4 | `lib/planner-runtime.ts` (`buildYoutubeOptionsForPost` `:449`, callers `:704`/`:945`; `CAPTION_PROPAGATION_KEYS` `:696-712`) | ✅ função ÚNICA (ambos os callers verificados; nome antigo `buildYoutubeOptionsForPropagation` = 0 hits); community NÃO reescrita (`:956-960`) |
| **F3-B3** videoId real | M6 | `app/api/youtube/products/route.ts` (`:22-41` fallback último Short + 400 PT-BR; `:75-95` proxy), `lib/youtube.ts` (`listProducts` `:633-657`) | ✅ canal sem Short → 400 claro; wizard sem derivação de videoId (`:687-689`); proxy repassado |
| **F4-P1** dual captions | M9 | `lib/sanitize.ts` (`sanitizeCaption` `:131-144`), `content-items/route.ts` whitelists+sanitize, `lib/folder-captions.ts`, `contexts/UploadContext.tsx`, `upload-chunk/complete/route.ts`, `lib/planner-runtime.ts` (`resolveFinalCaption` `:279`, usada só em `:316`) | ✅ régua ÚNICA `resolveFinalCaption` (1 def, 1 uso); uploader youtube.txt/instagram.txt; round-trip 12/12 + 8/8 |
| **F5-P1** races + robustez | M13/M14/M11/M10/M15 | `lib/publisher-race-guard.ts` (`finalizePostWrite`, `isPostStillInFlight`), publisher (guard nas escritas finais), `planner-runtime.ts` (M14 updateMany `:963-985`, M11 STORIES→REELS `:1145-1157`, M15 retry loop `:1325-1364`), `app/api/posts/route.ts` (M10), `PlannerWizard.tsx` (M10) | ✅ 11/11; STORIES fora de YT no runtime (configs grandfathered); carrossel 2..10 client+server |
| **F6-P1** proxy gestão | M16 | `lib/youtube.ts` (7 funções com `proxyUrl?`), rotas refresh/comments/posts/sessions/link/connect/channels, publisher `getSession` `:1366` | ✅ proxy nos callers; `createAutoShort` com `proxyUrl: proxyForShort` (`publisher:1274-1282`) |

### Invariantes cross-bloco (pedido explícito da tarefa) — verificação com grep/leitura
1. **`toYoutubeProductsJson` 1 régua** — def `planner-config.ts:241`; consumido por `buildYoutubeOptionsForPost` (usado por build+propagação). Preview expõe o formato canônico via `normalizeYoutubeProductsList`+`serializeYoutubeProducts` (o MESMO normalizador por baixo do helper — `preview/route.ts:227-233`); não publica, não precisa do split names/items. Sem CSV cru em nenhum caminho.
2. **`buildYoutubeOptionsForPost` única** — def `planner-runtime.ts:449`; callers: `:704` (buildPostData) e `:945` (propagação). `buildYoutubeOptionsForPropagation` deletada (0 hits). Cadeia de título M17, products M5, description M18, pinned G4 nos dois caminhos.
3. **`resolveFinalCaption` única** — def `planner-runtime.ts:279`; único uso `:316` dentro de `resolveCaptionTemplateVars` (consumido por build/propagate/preview). Nenhuma cópia em components/contexts.
4. **`createAutoShort` com proxy nos callers** — único caller `publisher:1274` recebe `proxyUrl: proxyForShort` (`:1282`), mesma cobertura do `createShort`. `product_names` serializado via `JSON.stringify` (vírgula no nome preservada — M22).

### Barra feature (item 4 da tarefa) — re-verificada
| Regra | Evidência no worktree |
|---|---|
| Nada de query-only em `/shorts` | `resolveShortProductsRouting` (`planner-config.ts:264-352`): query-only → `route:"auto"` (`createAutoShort`); teste negativo M4 em `products-routing.mts` (14/14) |
| Nada de template em products | `toYoutubeProductsJson`: `normalizeYoutubeProductsList` + split names/items; sem `substituteCaptionTemplate`; `buildYoutubeOptionsForPost` resolve template só em title/description (`:455-468`) |
| Comunidade SEM produtos | `buildPostData`: `ytTypeForPost==="community"` → `youtubeOptions=null` (`:694-716`); propagação: ramo community `newYoutubeOptions=undefined` (`:956-960`); wizard: bloco produtos só em `mediaType==="REELS"` |
| STORIES fora de YT | `resolvePlannerRuntime` `:1145-1157` (canal YT + STORIES → REELS com warning, preview incluso); wizard auto-fix no load/save; select STORIES oculto com canal YT |
| Proxy no `createAutoShort` | `publisher:1274-1282` — `proxyUrl: getChannelProxyUrl(post.channel)` |

---

## 2. Correção desta fase (F7/QA) — guard M5 na propagação

**Gap encontrado (crítico, dentro da garantia M5 "editar planner nunca apaga dados de publicação"):**
`buildYoutubeOptionsForPost` retorna `null` quando NENHUM título é resolvível (config patológico legado: `youtube_title` e caption vazios + content sem título/fallback/item). A unificação F2 fez a propagação gravar `youtube_options = null` nesse caso — **apagava** products/título existentes de um Short pendente (o código antigo `buildYoutubeOptionsForPropagation` nunca retornava null; era um delta de comportamento da unificação).

**Correção — `lib/planner-runtime.ts:945-970`:** no ramo Short da propagação, `rebuilt !== null` → aplica; `null` → mantém `undefined` (youtube_options existente **preservado**). O post segue pendente; a falha real, se existir, será de publicação com mensagem clara — não propagação silenciosa destruindo dados.

**Teste de regressão commitado — `.ai/f2-smoke/smoke.test.mts` T7 (agora 7/7):** post `p9` com `youtube_options` (título+products) + config sem título resolvível → assert `upd.data.youtube_options === undefined` (não zerado) e post atualizado.

**Verificado sem regressão:** tsc 0 erros · build ✓ · prisma validate ✓ · smokes f2 7/7, f4 8/8, f4-dual 12/12, f5-races 11/11, products-routing 14/14.

---

## 3. Barra executada (HEAD pós-correção)

| Check | Resultado |
|---|---|
| `node ./node_modules/prisma/build/index.js validate` (+ `generate`) | ✅ schema válido, generate OK |
| `npm run build` | ✅ Compiled successfully (48/48 páginas + rotas) |
| `npx tsc --noEmit` | ✅ 0 erros |
| `npm run lint` | ✅ 42 erros / 79 warnings — **idêntico à baseline `85855ad`** (comparado via worktree temporário: 41×`no-explicit-any` + 1×`ban-ts-comment` em ambos; diff de linhas é só shift de edição). Nenhum novo |
| Suítes commitadas | ✅ products-routing 14/14 · f2 7/7 · f4 8/8 · f4-dual 12/12 · f5-races 11/11 (52 cenários, 0 falhas) |
| Git | ✅ commits F0..F7 na branch; sem push |

---

## 4. Testes E2E sugeridos (contra API externa real + banco)

1. **Cadeia Short completa:** planner YT Short com título+descrição com `{var}` + 1 produto verbatim + 1 query-only para o mesmo vídeo → `run` → esperado: 1 post ao `/shorts` (verbatim, com SKIP-warning do nome) OU campo separado em `/auto`; conferir log do planner (`Short enviado via /api/shorts/auto` vs `/api/shorts (N produto(s) verbatim)`).
2. **Busca de produto:** canal com 1 Short publicado → `GET /api/youtube/products?channelId&query=x` sem `videoId` → 200 com `video_id` real; canal sem Short → 400 PT-BR "publique um Short primeiro".
3. **Propagação (M5/M17/M18 + F7 guard):** planner Short com products → PATCH só caption → pending preservam products/título/desc re-resolvida; PATCH `youtube_title` → título muda (teste-ouro bug-desc); config patológico sem título (PATCH via API direta) → `youtube_options` de pending NÃO é zerado.
4. **Dual captions round-trip:** pasta `video.mp4`+`youtube.txt`+`instagram.txt` → item com as 3 captions; planner YT `{post_caption}` → youtube.txt; planner IG → instagram.txt; só `legenda.txt` → fallback genérico nas duas.
5. **Races (M13/M14):** disparar cron com posts `processing` e remover o canal (PATCH bug-remove) no meio → posts permanecem `cancelled`; PATCH grande de propagação com post cancelado no meio do lote → cancelado não é reescrito.
6. **Comunidade sem produtos (M8/M19):** planner YT IMAGE → só "Texto da Publicação"; sem box de produtos; run → post community com `message` não-vazio e `youtube_options` nulo.
7. **Proxy (M16):** canal com `proxy_url` morto → rotas de gestão (refresh/comments/posts/products) falham com erro de rede (prova do repasse) vs sucesso direto sem proxy; publicar Short de canal com proxy → cria via proxy.
8. **STORIES legado (M11):** config grandfathered com `media_type:"STORIES"` em planner YT → run/preview mostram REELS e publicam Short com vídeo.
9. **Carrossel 2..10 (M10):** wizard carrossel com pasta de 1 imagem → bloqueado com erro PT-BR; `POST /api/posts` com 1 child → 400 PT-BR.

---

## 5. Riscos residuais (aceitos)

1. **`createSession` sem proxy** (connect): primeira sessão via chamada direta — canal que SÓ alcança a API via proxy não cria sessão. P2 futuro documentado (F6 R2).
2. **Health global sem proxy** (F6 R3) e **`listSessions` sem `channelId`** (multi-sessão sem canal único) — diretos por natureza.
3. **Wizard sem inputs próprios de caption por plataforma (F4-P2):** o uso é via `{post_caption}` + arquivos da biblioteca; item com só `youtube.txt` (sem genérica) pode ser bloqueado no save do wizard mesmo resolvendo bem no runtime.
4. **`sacrifice_video_id` (vídeo isca) não implementado** (F3): fallback cobre último Short publicado; sem Short → 400 (UX cobre com mensagem amigável).
5. **Filtros do `/shorts/auto` com default** (todos marketplaces, `min_commission_pct:0`, `items_per_product:1`): expor na UI é evolução.
6. **F7-guard é janela estreita:** só protege o caso título-não-resolvível; demais ramos da propagação (caption vazia para community) permanecem contrato pré-existente.
7. **Legado fora do branch:** `.ai/watcher-audit-baseline.md` e `docs/diagnose-upload-vps.md` seguem **untracked** (artefatos de fases anteriores / template de diagnóstico do dono — não editados, não commitados por decisão).
8. **API externa fora do controle da branch:** contrato `/shorts/auto`, `_parse_products`, `video_id` obrigatório estão congelados pela spec; mudanças lá quebram a web silenciosamente.

---

## 6. Próximos passos (dona/dono decide)

1. **F4-P2:** inputs visuais de `caption_youtube`/`caption_instagram` no wizard (único P1 da spec ainda sem UI) + atualizar `resolveCaptionTextForWizard` para aceitar item com só caption por plataforma.
2. **P2 higiene (M21/M27):** dropdown `YOUTUBE_CATEGORIES` no wizard; faixa 1..100 (`parseYoutubeOptions`); pinned alias único; duplicate+validate; chips `{var}` na descrição YT (já há placeholder prometendo — falta UI).
3. **Sacrifice video** na rota de produtos (`POST /api/sessions/{id}/config` já existe na externa) quando UX exigir canal sem Shorts.
4. **UI de filtros do auto-select** (min_commission_pct/items_per_product/price_weight/commission_weight) — hoje default.
5. **Deploy/QA em VPS (Easypanel):** rodar `docs/diagnose-upload-vps.md` para o erro "No uploaded chunks found" (réplicas sem volume compartilhado é a causa mais provável — fora desta branch).
6. **Push e PR** — decisão do dono (nada foi pushado pela cadeia).