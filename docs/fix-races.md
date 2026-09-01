# fix-races — F5-P1: Races de robustez + M11/M10/M15

> **Fase:** F5-P1 (M13/M14/M11/M10/M15) · **Branch:** `feat/yt-products-dual-captions`
> **Fonte de verdade consultada:** `docs/PLANNER_AUDIT_REPORT.md` (§1 M13/M14/M15/M11/M10, §2 P1-2..P1-5/P1-7) · `docs/audit-track-editor.md` (§8 race cancelamento, §10 R1/R3/R6, R2) · `docs/audit-track-wizard.md` · `docs/audit-track-yt-short.md` (#9 M11) · `docs/audit-track-ig.md` (#3/#4 M10)
> **Natureza:** guards de race aditivos + normalização de runtime + validação de contagem server+client. NENHUM contrato quebrado; fluxo bug-remove/propagación/proxy/isolation intactos.

---

## Problema (antes)

1. **M13 — race cancelamento×publisher:** o publisher gravava TODO desfecho com `prisma.post.update({ where: { id } })` incondicional (`audit-track-editor.md` §8). Se o PATCH removesse o canal (bug-remove → `cancelled`) enquanto o publisher processava, a escrita final atrasada sobrescrevia `cancelled` → `published` (zombie que publica mesmo cancelado) ou revertia para `pending` (ressuscita e republica). Nenhum re-check de status antes dos calls externos.
2. **M14 — race propagação×publisher:** `propagatePlannerConfigToPendingPosts` atualizava os posts por `id` sem guard — um post claimado/pago/cancelado no mesmo instante era sobrescrito pela propagação.
3. **M11 — STORIES→REELS só no wizard:** configs grandfathered (nunca re-salvas no wizard) chegavam ao runtime como STORIES em canal YouTube → post classificado Short sem vídeo (`image → video_url=null`) → falha definitiva incontornável no publisher.
4. **M10 — carrossel 1 item passa wizard+runtime:** a API do Instagram rejeita carrossel com 1 item (definitivo). Wizard validava só "é pasta"; runtime errava só com 0 filhos; publisher montava qualquer contagem.
5. **M15 — wedge de item deletado:** em planner sequencial, um content entry apontando para library item DELETADO fazia `resolvePlannerRuntime` falhar ANTES do claim (`resolution_failed`) → `last_index` nunca avança → o planner nunca publica os itens seguintes (trava para sempre).

---

## O que mudou (arquivo:linha)

### 1. `lib/publisher-race-guard.ts` (NOVO) — guard de cancelamento×publisher (M13)
- `:15-20` — `PUBLISHABLE_IN_FLIGHT_STATUSES` = `pending/queued/processing/processing_upload/processing_children/ready_to_publish` (`scheduled` fora: nunca chega às lanes — só via claim pending→processing).
- `:25-36` — `isPostStillInFlight(postId)`: re-lê o status REAL do post; false se `cancelled`/terminal/ausente.
- `:39-69` — `finalizePostWrite(postId, plannerId, lane, data)`: `updateMany` com `where { id, status ∈ in-flight }`; `count===0` ⇒ escrita bloqueada (post cancelado/finalizado) → log diagnóstico + `false`.
- Extraído da route porque route files do Next SÓ podem exportar métodos HTTP (exportar helpers quebra `next build`); importa `@/lib/prisma` (shimável nos smokes).

### 2. `app/api/cron/publisher/route.ts` (M13)
- `:284-289` — importa os 3 símbolos do lib (remove as definições locais + os 2 `export {}` que quebrariam o build).
- **Todas as escritas que SAEM do pipeline agora passam por `finalizePostWrite`** (aprox. 20 call-sites): retry/falha (`handleRetryableFailure`), YT missing-session, YT session-expired, YT falha definitiva, IG Fase 1/2/3 falhas, escrita final de Comunidade (`status:published`), escrita final de Short, escrita final IG `media_publish` e o branch "already published".
- **Escritas EM VOO com guard** (adicionado neste ciclo — fecham a janela cancelado→`ready_to_publish`→publicado): container reuse (`processing_upload`), `processing_children`, container criado (Fase 1 e 2), `ready_to_publish` (Fase 2). Data-only writes (`children_urls`/`instagram_child_ids`) ficam sem guard: não mudam status e posts cancelados nunca são re-buscados.
- **Re-checks `isPostStillInFlight` antes de calls externos** (5 pontos): Comunidade texto (`:978`), Comunidade upload multipart (`:1155`), Short (`:1261`), pós-claim Fase 1 (`:1793`), `media_publish` Fase 3 (`:2722`).
- NÃO alterou o fluxo bug-remove (criação de `cancelled` no PATCH continua idêntica).

### 3. `lib/planner-runtime.ts`
- **M14** `:963-985` — `propagatePlannerConfigToPendingPosts`: update via `updateMany` com `where { id, status ∈ [pending,scheduled,queued] }`; `count===0` ⇒ SKIP com log (`[propagate] post X: status mudou...` — estado terminal preservado). Assinatura do tipo `post` ganhou `updateMany`.
- **M11** `:1145-1157` — `resolvePlannerRuntime`: se o 1º canal é YouTube e `mediaType === "STORIES"` → converte para `REELS` com warning (`STORIES convertido para REELS — o YouTube não suporta Stories`). Alinha com o auto-fix do wizard (`PlannerWizard STORIES→REELS` no load/save) para configs grandfathered. Preview usa o mesmo caminho.
- **M15** `:163-180` (`isDeletedItemFailure`) + `:1325-1364` (`runPlannerOnce` retry loop) + `:1015-1021` (`resolvePlannerRuntime` ganhou `overrideState?`):
  - detecta falha de resolução por "Library item not found" (item deletado);
  - avança o índice via `selectContentIndex` no estado atual e RE-RESOLVE até achar um item publicável (guardado por `attempted` + `maxAttempts`) — o runtime persistido ao final carrega o `last_index` avançado, então o item deletado fica para trás e o run PUBLICA o próximo (teste-ouro: item deletado no meio → post correto sai no MESMO run);
  - demais falhas de resolução (pasta vazia, mídia ausente não-deletada) mantêm o comportamento R3 (não consomem tick);
  - todos os itens deletados → `resolution_failed` limpo sem loop nem claim.

### 4. `app/api/posts/route.ts` (M10 server-side)
- `:152-178` — POST com `media_type === "CAROUSEL"`: valida `children_urls` 2..10 (contando só entradas com `url`); fora disso → `400` com erro PT-BR claro (`Carrossel exige entre 2 e 10 mídias (recebido: N)...`). REELS/IMAGE não afetados.

### 5. `components/PlannerWizard.tsx` (M10 client-side)
- `:1002-1073` — no `handleSubmit`, quando `isCarousel`:
  - pastas selecionadas: além de conferir que são `carousel_folder`, consulta `/api/content-items?parent_id=<folder>` por pasta e exige 2..10 filhos (erro PT-BR citando a pasta e a contagem);
  - uploads diretos junto com pastas: 1 arquivo avulso → erro (seria descartado em silêncio); >10 → erro;
  - carrossel só com uploads diretos: exige `files.length` 2..10.
- Um erro de contagem bloqueia o save ANTES do upload (validação cedo, mesma régua do server).

### 6. Mocks dos smokes antigos (updateMany do propagate)
- `.ai/f2-smoke/smoke.test.mts` `:makePrisma` · `.ai/f4-smoke/smoke.test.mts` `:makePrisma` · `.ai/f4-dual-captions/smoke.test.mts` `:makePlannerPrisma` — `post` ganhou `updateMany` (grava em `_updates`; `count` só quando o status alvo ainda é pending/scheduled/queued — simula o guard real). Sem isso os 3 smokes quebram (o propagate agora usa updateMany).

### 7. `.ai/f5-races/` (NOVO — smoke F5-P1)
- `alias-hook.mjs` (shims `@prisma/client`, `next/server`, `next-auth`, `@/lib/prisma`, `@/lib/auth`, `sharp`), `shim-prisma.mjs` (proxy dirigido por `globalThis.__PRISMA__`), `shim-*.mjs`, `smoke.test.mts` com 11 cenários (ver "Como testar").

---

## Como testar

**Barra:** `npx tsc --noEmit` (0 erros) · `npm run build` (ok — validado que a extração do guard resolve o export ilegal de route) · `node ./node_modules/prisma/build/index.js validate` (schema válido, sem migrations novas).

**Smokes:**
```bash
node --import ./.ai/f2-smoke/alias-hook.mjs .ai/f2-smoke/smoke.test.mts          # 6/6 (regressão propagação)
node --import ./.ai/f4-smoke/alias-hook.mjs .ai/f4-smoke/smoke.test.mts          # 8/8 (dual captions)
node --import ./.ai/f4-dual-captions/alias-hook.mjs .ai/f4-dual-captions/smoke.test.mts  # 12/12
node --import ./.ai/f5-races/alias-hook.mjs .ai/f5-races/smoke.test.mts          # 11/11
```

**F5-P1 (11 cenários):**
1. `finalizePostWrite` sobre `cancelled`/`failed` → bloqueado (`false`), status terminal preservado; sobre `processing`/`ready_to_publish` → grava.
2. `isPostStillInFlight`: `cancelled=false`; fila (pending/processing/ready_to_publish)=true; publicado=false.
3. Propagação com race: post cancelado no meio do lote é PULADO (updated=1 de 2; caption do cancelado intocada).
4. Propagação normal: pending/scheduled/queued atualizados; cancelled/published intocados; `total`=3.
5. Runtime YT + STORIES → `mediaType="REELS"` + warning; canal IG mantém STORIES.
6. `runPlannerOnce` com item do meio deletado (`old_to_new`) → `ok:true`, post criado com o item VÁLIDO seguinte, `last_index` avança; run 2 publica o próximo.
7. Todos os itens deletados → `resolution_failed` sem post nem claim.
8-10. `POST /api/posts` CAROUSEL com 1 e 11 itens → 400 PT-BR; 2..10 → 200; REELS com children não é afetado.
11. Meta-check: nenhuma escrita `published/failed/pending` incondicional resta no publisher; guards importados do lib.

**E2E manual:**
- **M13:** iniciar publicações (cron), remover o canal de um planner com posts `processing` → aguardar o tick → posts permanecem `cancelled` (não viram published/ready). Log do planner registra "desfecho bloqueado".
- **M14:** editar caption de planner com post `pending` + outro `scheduled` → ambos atualizados; cancelar um post no meio de um PATCH com lote grande → o cancelado não é reescrito.
- **M11:** planner YT legado com `media_type: "STORIES"` no config (editar o JSON diretamente) → run/preview mostram REELS e publicam Short com vídeo.
- **M10:** wizard em modo carrossel com pasta de 1 imagem → bloqueado no save com erro PT-BR; pasta de 5 → salva; `POST /api/posts` com 1 child → 400.
- **M15:** deletar um item de biblioteca que está no meio de um planner sequencial → run publica o próximo item no mesmo ciclo (sem travar).

---

## Riscos / observações

- **Efeito colateral aceito (M13):** quando a API externa JÁ publicou e o cancelamento vence a corrida, o banco fica `cancelled` enquanto o conteúdo existe remotamente — é o comportamento correto do race-guard (cancelamento é decisão do usuário); o log da route (`Short publicado`/`Post na Comunidade publicado`) registra o fato para auditoria.
- **M11 residual:** STORIES com mídia de IMAGEM em canal YT também vira REELS (igual ao auto-fix do wizard) — o post YT falharia no publisher com mensagem de vídeo inválido em vez do erro anterior "exige um vídeo"; configs nesse estado são misconfiguração (não há Story em YT por spec).
- **M15 escopo:** o avanço de índice só dispara para "Library item not found" (item DELETADO). Pasta de carrossel vazia / outros erros de resolução mantêm o comportamento R3 (não consomem tick, não avançam) — o usuário pode corrigir sem o planner pular o item.
- **M10 residual:** a régua 2..10 é aplicada no wizard e no `POST /api/posts`; o runtime continua errando só com 0 filhos (planner-created posts de pastas grandfathered com 1 filho ainda chegariam ao publisher — falham na API IG de forma definitiva com mensagem; correção de runtime ficou fora do escopo desta fase para não quebrar carrosséis de Comunidade YT de 1 imagem).
- **Sem efeito nas entregues:** isolation YT/IG (mix bloqueado) intocado · proxy no publisher intocado · bug-remove (cancelamento) intocado — guards são ADITIVOS, o fluxo de criação de `cancelled` não mudou · bug-desc (propagação) intocado — só ganhou o guard de status · F1-B1 (products routing) intocado · F4 (dual captions) intocado (smokes de regressão passaram).
- **Docs legados:** nenhum alterado — relatório novo em `docs/fix-races.md`.