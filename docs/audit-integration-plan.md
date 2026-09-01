# Audit Integration Plan — Fase 1 (6 tracks)

> **Agente:** Watcher — agent 7
> **Branch:** `feat/yt-products-dual-captions`
> **HEAD:** `9ae5a54` (2026-08-31 23:09:01) — wip: schema captions duplas (migration 0009) + helpers produtos/categorias YT
> **Gerado em:** 2026-08-31 ~23:12
> **Natureza:** relatório de integração (o watcher NÃO edita código)

---

## 1. Unidade de análise

A branch adiciona dois recursos interdependentes:

1. **Dual captions** — `content_items.caption_youtube` / `caption_instagram` (migration 0009). Hoje: **schema-only** (0 consumidores no runtime/wizard/API).
2. **YouTube products** — novo formato `youtube_products: YoutubeProductEntry[] {query, item?}` + `YOUTUBE_CATEGORIES` no config; convivência com CSV legacy.

`lib/planner-config.ts` tem **diff grande não commitado (369+/178-)** em edição ativa no momento da auditoria (maior parte prettier + helpers YT). Qualquer verifier que toque esse arquivo precisa coordenar com quem estiver editando.

---

## 2. Matriz arquivo × track

Legenda o formato de rastreio esperado: `docs/<track>-track-report.md` (convenção do gauntlet anterior).

| Arquivo | T1 wizard-fields | T2 runtime-products | T3 dual-caption | T4 apply-caption-template | T5 yt-products-config | T6 propagation |
|---|---|---|---|---|---|---|
| `prisma/schema.prisma` | — | — | **P** (colunas) | — | — | — |
| `prisma/migrations/0009_add_dual_captions/` | — | — | **P** (estado: aplicável?) | — | — | — |
| `app/api/content-items/route.ts` + `[id]/route.ts` | — | — | **P** (select/sanitize grava `caption_*`) | — | — | — |
| `components/PlannerWizard.tsx` (2109 ln) | **P** | — | **P** (inputs por plataforma) | **P** (preview parity) | **P** (picker products) | — |
| `lib/planner-config.ts` (741+ ln, diff ativo) | **P** (save config) | — | — | — | **P** (helpers/YOUTUBE_CATEGORIES) | — |
| `lib/planner-runtime.ts` (1326 ln) | — | **P** (buildPostData L421-564) | **P** (resolução caption por plataforma) | **P** (applyCaptionTemplate L328-390) | — | **P** (propagate L765-910) |
| `app/api/planners/[id]/route.ts` (PATCH) | — | — | — | — | — | **P** (gatilho propagate L213) |
| `app/api/planners/[id]/preview/route.ts` | — | — | — | **P** (lane de substituição c/ parity) | — | — |
| `app/api/planners/[id]/run` | — | **P** (chama buildPostData) | — | — | — | — |

**P** = papel primário (toca o arquivo). Note: `lib/planner-runtime.ts` é tocado por **4 tracks** (T2, T3, T4, T6) e `components/PlannerWizard.tsx` por 3 (T1, T3, T4, T5 na prática). Watcher recomenda serializar edições no runtime (ver §5).

---

## 3. Ordem de correção recomendada (P0 → P1 → P2)

### P0 — bloqueadores de integração (corrigir primeiro; dependências de tudo)
1. **[T3] Consumir as colunas dual caption na API de content-items.** O `select` whitelist de `app/api/content-items/route.ts` e `[id]/route.ts` (L14, whitelist de campos) **não inclui** `caption_youtube`/`caption_instagram`; sanitize só trata `caption`. Sem isso, wizard não consegue gravar/ler e runtime não consegue resolver. → base para todo o resto.
2. **[T5+T2] Unificar o formato de `youtube_products`.** Decidir o formato canônico (array `{query,item?}`) e fazer `buildPostData` (L456-481) usar UM único normalizador (hoje tem 3 caminhos: CSV split → `Array.map(String)` → `normalizeYoutubeProductsCsv`). **Bug latente:** se o wizard gravar objetos, `String(v).trim()` no ramo `Array.isArray` produz `"[object Object]"` no `youtube_options.products`. Criar helper único `toYoutubeProductsJson(config)` consumido por runtime e propagação.
3. **[T4+T3] Resolução de caption por plataforma num único ponto.** `applyCaptionTemplate` hoje recebe `selectedContent.caption` apenas. Centralizar a seleção `(channel.platform === youtube ? caption_youtube : caption_instagram) gota base_caption` numa função única chamada por `buildPostData`, `propagate` e preview — evita 3 cópias da régua.

### P1 — correção/consistência de propagação
4. **[T6] `propagatePlannerConfigToPendingPosts` deve usar o mesmo captions-por-plataforma e o mesmo normalizador de products que T2/T3/T4.** `buildYoutubeOptionsForPropagation` (~L654) re-deriva `youtube_options` do config — se o reader do runtime mudar em T2, a propagação divergirá silenciosamente (posts pending com products antigos).
5. **[T2] `youtube_options.products` por tipo de post.** Garantir que Short receba products e Comunidade **permaneça sem** `youtube_options` (L891: "Comunidade não tem youtube_options; não mexe") — a régua de T2 precisa ficar idêntica à de T6 para os dois tipos.
6. **[T4+T1] Preview parity com dual captions.** `PlannerWizard` L87 estima caption final e `preview/route.ts` reimplementa a lane de substituição. Ambos precisam conhecer a plataforma do canal selecionado, senão o preview mostrará a caption do IG para canal YT (ou a lane base global).

### P2 — higiene / UX
7. **[T5] `YOUTUBE_CATEGORIES` e helpers de normalização** — validar tipos (`commission_pct` number vs string), limpar compat CSV legacy para um único caminho de downgrade no load (migration de config), e atualizar `YT_RELATED_FIELDS` (L595-609) se o nome da chave mudar.
8. **[T1] Wizard: validação de dual captions × rotation.** Definir visual/regra quando `caption_rotation` está ativo + captions por plataforma preenchidas (o rotation sobrescreve captions base? qual vence?). Preencher no rodapé do contrato de UI (sem mudança de comportamento no runtime ainda).
9. **[T3] Migração 0009** — conferir se a migration roda em VPS (`prisma migrate deploy` — colunas aditivas, baixo risco) e se o `docker-entrypoint` já roda migrate.

---

## 4. Conflitos potenciais entre correções planejadas

### C1 — Wizard fields × Runtime products (T1 × T2) ⚠️ crítico
Wizard salvará `youtube_products` no formato novo (array de objetos com `item`); runtime (L456-481) lê com 3 ramos incompatíveis a objetos → **corrupção silenciosa** (`[object Object]`). Qualquer fix só de um lado quebra o outro. **Resolução:** contrato de shape (obj entradas) + normalizador único em `planner-config` consumido pelo runtime; wizard nunca serializa direto no Post.

### C2 — Dual caption × applyCaptionTemplate (T3 × T4) ⚠️ crítico
Migração adiciona colunas, mas `applyCaptionTemplate` (lane única) só conhece `caption`. Se T4 adicionar `platform` ao `opts` de `applyCaptionTemplate`, TODOS os callers (buildPostData, propagate, preview) precisam passar `channel.platform` — 3 assinaturas para sincronizar no mesmo commit. **Resolução:** T4 como fundação (P0-3), depois T3 consome; nunca plataforma-awareness dentro de T2/T6 por fora da lane central.

### C3 — YouTube products × Propagação (T5 × T6) ⚠️ alto
`propagate` re-deriva `youtube_options` de `config.youtube_products`; o trigger de diff usa `YT_RELATED_FIELDS` (inclui `youtube_products`). Se T5 mudar o formato do config (novo serialize) sem T2/T6 atualizarem, a propagação pode **re-escrever products com shape antigo** ou disparar updates indevidos a cada PATCH. **Resolução:** serializar/normalizar sempre via helpers T5; T6 valida contra um post "ouro" (short YT com products) nos testes.

### C4 — Overlap físico em `lib/planner-runtime.ts` (T2 ∩ T3 ∩ T4 ∩ T6) ⚠️ alto
Arquivo de 1326 linhas tocado por 4 tracks nas regiões L328-390 (template), L421-564 (buildPostData), L654-730 (buildYoutubeOptionsForPropagation), L765-910 (propagate). Edições concorrentes aqui geram merge conflitos quase certos. **Resolução (watcher recomenda):** executar na ordem T4 → T2 → T6 (T4 funda a lane; T2 usa; T6 reusa), ou delegar a um único agente se o harness não serializar. Não há git worktree paralelo confiável.

### C5 — Preview parity (T4 × T1)
Wizard + rota preview reimplementam a lane. Risco de terceira cópia da régua (já houve bug histórico de divergência preview×publicação, ver comentários L1052+ do runtime). **Resolução:** exportar um único `resolveFinalCaption()` usado por publish, propagate e preview.

### C6 — `lib/planner-config.ts` diff não commitado × T5/T1
Há 369+/178- uncommitted (prettier+helpers). Se T1 (wizard) ou T5 commitarem em cima, o diff ativo vira conflito ou é sobrescrito. **Resolução:** forçar commit/checkpoint imediato do estado atual (quem está editando) antes que qualquer track escreva nesse arquivo.

### C7 — Schema/API (T3) × rotas existentes
`app/api/content-items` tem whitelist de campos (L14 em ambos). Adicionar colunas sem adicionar ao whitelist + sanitize = API ignora silenciosamente; adicionar sem sanitize (limite 2200 como `caption`, BK-07/BK-14) = risco de payload gigante. **Resolução:** mesma régua de sanitização do campo `caption` replicada para os dois novos.

---

## 5. Roteiro de integração sugerido (sequência de merges)

| Passo | Tracks | Aceite (gate) |
|---|---|---|
| 1 | Checkpoint atual: commit do diff de `lib/planner-config.ts` (C6) | status limpo |
| 2 | T4 fundação: `resolveFinalCaption` por plataforma + applyCaptionTemplate com `platform` | preview, publish e propagate chamam a MESMA função |
| 3 | T3 API: whitelist + sanitize + persist `caption_*` em content-items | POST/PATCH content-item round-trip preserva os 2 campos |
| 4 | T5 formato: normalizador único de `youtube_products` + YOUTUBE_CATEGORIES | `toYoutubeProductsJson` usado pelo runtime; CSV legacy convertido no load |
| 5 | T2 runtime: buildPostData consome lane T3/T4 + products via T5 | post short YT com products → `youtube_options.products` JSON correto; comunidade sem youtube_options |
| 6 | T6 propagação: mesma régua de T2 | PATCH de config propaga caption-por-plataforma + products idênticos ao build |
| 7 | T1 wizard: inputs dual captions + picker products ligados às APIs | wizard→runtime round-trip end-to-end (seed de teste) |
| 8 | Q.A. final | `npm run build` + teste E2E mínimo (short YT + comunidade) |

---

## 6-bis. Resultado da auditoria (ciclo final 23:17 — 6/6 tracks)

### Artefatos reais dos verificadores (naming: `docs/audit-track-*.md`) — 6/6 LANÇADOS 🟢
| Track | Arquivo | Agente | Escopo declarado | Chegou |
|---|---|---|---|---|
| Wizard/UI | `docs/audit-track-wizard.md` | agente 4 | Wizard completo (2109 ln) | ✅ 23:15:19 |
| API/RESILIÊNCIA | `docs/audit-track-api.md` | agente 6 | proxy, products, categorias, dual captions | ✅ 23:14:14 |
| YT-SHORT | `docs/audit-track-yt-short.md` | agente 2 | fluxo Short completo | ✅ 23:14:48 |
| IG | `docs/audit-track-ig.md` | agente 1 | REELS/IMAGE/CAROUSEL/STORIES + propagation | ✅ 23:15:4 |
| YT-COMMUNITY | `docs/audit-track-yt-community.md` | verificador YT-community | texto+imagens, dual caption, products | ✅ 23:15:4 |
| EDITOR-STATE | `docs/audit-track-editor.md` | agente 5 | PATCH, run, duplicate, preview, propagação, races | ✅ 23:17 |

Todos < 6 min entre si (23:14:14 → 23:17) — NENHUM stall. Sem arquivos `.ai/watcher-audit-<track>.md` necessários.

### P0s CONFIRMADOS (consenso dos 6 tracks)
| # | P0 | Consenso (tracks) | Correção convergente |
|---|---|---|---|
| A | **Produtos = no-op silencioso** (CSV→strings→`_parse_products` descarta não-dicts; 0 tags sem erro) | api F2 · wizard W4 · yt-short #2/#3/#5 · yt-community P0-2/F15 · editor PR1/PR2 | Formato único `{query,item?}` + rotear nomes→`POST /api/shorts/auto` (`product_names`+`filters`); verbatim `{item}`→`POST /api/shorts`; helper único `toYoutubeProductsJson(config)` usado por buildPostData E propagação |
| B | **Deadlock wizard YT-only** (Caption/Templates/Fallback ocultos p/ isolamento b3d5d56, mas validação exige texto → planner Community inutilizável) | wizard W1 · yt-community P0-1/F1/F2 | Campo "Texto da Comunidade" no box YT alimentando a cadeia `applyCaptionTemplate` (resolve caption por plataforma) |
| C | **Propagação apaga products/título/description-template de Shorts pendentes** | yt-short #1/#11 · editor G1/G2/G3 · api §5 · wizard W8 | `buildYoutubeOptionsForPropagation` espelhar 100% o ytObj do `buildPostData` (products + `youtube_title` 1ª fonte + `resolveYtTpl` na description) via função única `buildYoutubeOptions(...)` |
| D | **Busca de products com videoId falso** (título/id de item) → 400/502 ou vazio | api F1 · yt-short #4 · yt-community P0-3 · editor PR4 | Fallback ao último `Post.youtube_video_id` publicado do canal; 2º: `sacrifice_video_id` (`POST /api/sessions/{id}/config`); proxy do canal (listProducts hoje sem proxy) |

### P1 s consolidados (maioria cross-track)
- **Race cancelamento×publisher** (editor R1): publisher sobrescreve `cancelled` — guard `where {id, status in processing}`.
- **Race propagação×publisher** (editor R3): propagate reescreve post já claimado — re-check status no update.
- **Wedge item deletado em sequencial** (editor R6): índice nunca avança, planner para de postar.
- **STORIES→short falha permanente** (yt-community F11 · yt-short #9 · ig #8): normalizar STORIES→REELS no runtime (só wizard faz hoje).
- **Comunidade mensagem vazia = falha definitiva sem fallback** (yt-short #8 · editor): fallback de texto ou erro claro no create.
- **Carrossel 1 item / pasta vazia** (ig #3/#4): validar 2..10 children no wizard e `POST /api/posts`.
- **Dual captions schema-only** (api F6 · wizard W6 · yt-community F14 · editor): wiring completo required (whitelist content-items → seleção por plataforma centralizada → inputs wizard) — depender de B/C.
- **Proxy não cobre rotas de gestão YT + getSession no publisher** (api F1 wide/F4): `refreshSession/deleteSession/listProducts/comments/deleteCommunityPost/health` sem `proxyUrl`.

### Conflitos cross-track (atualiza §3/§4)
- **C1/C3 products**: 4 tracks convergem no MESMO helper único — ordem de merge: T5 helpers → T2 build → T6 propagate, no mesmo PR; qualquer divergência de shape regera o bug (PR1/PR2/G2).
- **C2 dual captions**: para implementar precisa do P0-B (texto da Comunidade) e P0-A (products por plataforma) resolvidos; `{post_caption}` hoje resolve de `libItem.caption` genérico — criar caption base por plataforma num único ponto compartilhado por buildPostData/propagate/preview.
- **C4 overlap runtime**: 4 tracks (T2/T3/T4/T6) tocaram `lib/planner-runtime.ts` por leitura integral — na fase de correção, serializar edições ou delegar a 1 agente.
- **C6 planner-config diff ativo (371+/180−)**: segue NÃO commitado; 4 tracks leram o arquivo; antes de qualquer correção, commit do estado atual.

### Ajuste na ordem P0 (novo, em cima de §3)
1. (inédito) Wizard YT deadlock (W1) — gira em torno de caption visível; precede dual captions.
2. Products: helper único `toYoutubeProductsJson` + roteadores `/shorts` `/shorts/auto` (C1/C3).
3. Propagação espelha `buildPostData` 100% (inclui products; C3) — mesmos helpers.
4. Dual captions: whitelist content-items + seleção por plataforma num ponto único (C2).
5. videoId real da busca (fallback `Post.youtube_video_id` publicado → `sacrifice_video_id`).

---

## 6. Gatilhos de watch (próximos ciclos)"}]
1. **Novo `docs/*-track-report.md`** → atualizar matriz com o escopo declarado de cada verifier (confirmar ou corrigir colunas acima).
2. **Novo commit em `feat/yt-products-dual-captions`** → verificar qual arquivo foi tocado; se `lib/planner-runtime.ts` ou `components/PlannerWizard.tsx`, alertar sobre C4/C5.
3. **>6 min sem arquivo/commit** → escrever `.ai/watcher-audit-<track>.md` com o motivo (track não iniciado / sem evidência / trava).
4. **Diff de `planner-config.ts` ainda não commitado** no próximo ciclo → reabrir C6 (risco de conflito).