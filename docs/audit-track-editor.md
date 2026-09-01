# Audit Track Editor-State — Agent 5 (verificador editor/propagação/state)

> **Branch:** `feat/yt-products-dual-captions`
> **Checkpoint:** `9ae5a54` (base `b3d5d56`)
> **Régua:** toda afirmação tem trecho de código citado (arquivo:linha). Nenhum código foi editado — somente esta doc.
> **Área:** PATCH `/api/planners/[id]`, `runPlannerOnce`, duplicate, preview, propagação (bug-desc), race de cancelamento com o publisher, dual captions e produtos YT.
> **Arquivos verificados:**
> - `app/api/planners/[id]/route.ts` (273 ln)
> - `lib/planner-runtime.ts` (1326 ln)
> - `lib/planner-config.ts` (550 ln)
> - `app/api/planners/[id]/duplicate/route.ts`, `preview/route.ts`, `run/route.ts`
> - `app/api/cron/publisher/route.ts` (2662 ln)
> - `components/PlannerWizard.tsx`
> - `app/api/content-items/route.ts`, `lib/youtube-post-options.ts`, `lib/youtube.ts`
> - API externa `~/Projects/youtube-community-api/app/api/shorts.py` e `post.py`

---

## 1. PATCH `/api/planners/[id]` — tabela ação → código → status

| # | Ação | Código (evidência) | Status | Severidade | Recomendação |
|---|---|---|---|---|---|
| P1 | Whitelist de campos (name/status; config via JSON validado; `state` NUNCA aceito do client; `reset_state` é flag limpo no server) | `route.ts:38-44` (`safeRest`); `:52-60` (`validatePlannerConfig`); `:127-128` (`...(reset_state === true ? { state: '{}' } : {})`) | **OK** | — | — |
| P2 | Validação de config na escrita (fonte única) | `route.ts:52-60` | **OK** | — | — |
| P3 | Isolamento YT×IG: mix validation no server (defesa além do wizard) | `route.ts:71,86-88` (`channel_ids.length > 1` ⇒ `validatePlannerChannelMix`); `planner-config.ts:318-334` | **OK** | — | — |
| P4 | `beforeChannelIds`/`oldConfigRaw` capturados ANTES do update | `route.ts:96-104` (findFirst prev com `channels` + `config`), `:108-115` (branch config-only) | **OK** | — | — |
| P5 | Cancelamento de posts de canal removido (inclui processing) | `route.ts:140-165`; `cancellableStatuses` = pending, scheduled, queued, draft, processing, processing_upload, processing_children, ready_to_publish (`:145-153`); `updateMany` → cancelled + `failed_reason: 'channel_removed'` (`:155-165`) | **OK parcial** (cancela no DB) | **P1** | ver §5 — publisher sobrescreve o cancelled depois |
| P6 | Propagação bug-desc disparada por diff de config | `route.ts:208-225` → `shouldPropagateConfig` + `propagatePlannerConfigToPendingPosts` | **BUG parcial** | **P1** | ver §3 (título/products NÃO propagam) |
| P7 | Ordem: update → cancel → propagate (post-update não falha o PATCH) | `route.ts:97` update; `:121` cancel; `:166` propagate (cada um com try/catch próprio) | **OK** | — | — |
| P8 | `channel_ids: []` válido (desconectar tudo) — itens órfãos cancelados | `route.ts:61-68` + `:124-163` | **OK** | — | — |
| P9 | Busca de `existing` fora do mix-check → planner inexistente com mix inválido devolve 400 em vez de 404 | `route.ts:86-88` antes do `:96-104` | **GAP** | P2 | validar existência antes do mix |

---

## 2. `runPlannerOnce` — gates, claim atômico, state, bloqueios ("não postar")

| # | Item | Evidência | Status |
|---|---|---|---|
| R1 | Gate temporal (status/frequency/start_time/sleep) | `planner-runtime.ts:1202-1220` (`!opts?.force`; `not_active`, `invalid_frequency`, `not_due`, `start_time`, `sleep`) | **OK** |
| R2 | Gate de canais: usa `describeChannelHealth` (token/sessão/status) | `planner-runtime.ts:1128-1133`; health em `planner-config.ts` upstream (YT sem sessionId ⇒ `missing_session`) | **OK** |
| R3 | Resolução ANTES do claim — erro de item não consome tick | `planner-runtime.ts:1224-1231` | **OK com efeito colateral → R6** |
| R4 | Claim atômico em `last_run` (updateMany condicional) | `planner-runtime.ts:1236-1245` (`where: { id, last_run: planner.last_run }`, `claim.count !== 1` ⇒ `already_running`) | **OK** |
| R5 | State persistido em transação com `where last_run = now` (não clobber) | `planner-runtime.ts:1292-1300`; reversão do claim em falha pós-claim `:1304-1311` | **OK** |
| R6 | **WEDGE: item deletado em planner sequencial** — `old_to_new`/`new_to_old` selecionam sempre o mesmo índice; `resolvePlannerRuntime` falha `"Media URL missing"` (`:1081-1086`) / `"Library item not found"` (`:1045`); como o runtime resolve ANTES do claim, `last_index` nunca avança (`:1224-1231`) → o planner fica para sempre apontando para o item deletado e nunca publica os itens seguintes. Em `random_loop` o índice nunca entra em `published_indexes`, então volta cíclica ao deletado (falha intermitente). | `planner-runtime.ts:150-157` (`selectedIndex = (base + 1) % contentList.length`) + `:1224-1231` | **BUG P1 (não posta)** |
| R7 | State corrompido (JSON inválido, tipos errados) NÃO wedge: `parsePlannerState`→`{}`, `published_indexes` não-array→`[]`, `last_index` com `Number.isFinite` guard, `new_to_old` clamp | `planner-config.ts:76-86`; `planner-runtime.ts:118-157` | **OK** |
| R8 | Template index: avança POR POST criado | `planner-runtime.ts:1256-1285` (`template_index: templateIndex + postDatas.length`) | **OK** |
| R9 | Cron chama com planner recém-buscado (status active + channels) | `app/api/cron/publisher/route.ts:1529-1542` | **OK** |

---

## 3. Propagação bug-desc — divergências runtime × `propagatePlannerConfigToPendingPosts`

`CAPTION_PROPAGATION_KEYS` (`planner-runtime.ts:596-616`): `caption, caption_templates, caption_rotation, caption_fallback, title_fallback, youtube_title, youtube_description, youtube_privacy, youtube_made_for_kids, youtube_monetize_with_ads, youtube_category_id, youtube_pinned_comment_text, youtube_products, collaborators, user_tags`.

`shouldPropagateConfig` (`:618-649`) também compara `content[].caption / caption_fallback / title_fallback` por item (`:631-644`).

| # | Divergência | Evidência (~linha) | Severidade |
|---|---|---|---|
| G1 | **Título do Short NÃO propaga.** `buildYoutubeOptionsForPropagation` monta `titleCandidate` = `[selected.title, title_fallback, caption, itemName]` (`:673-680`) — SEM `config.youtube_title` (e sem template-resolve), enquanto `buildPostData` usa `[rawYtTitle(resolvido), title, title_fallback, caption, itemName]` (`:453, :471-479`). Editar `youtube_title` dispara propagate (chave na lista) mas re-grava `youtube_options` com o título ANTIGO. Contradiz a intenção do fix bug-desc ("editar **título** propaga"). | `planner-runtime.ts:673-680` vs `:471-479` | **P1** (bug de edição) |
| G2 | **Products são REMOVIDOS de posts pendentes ao propagar.** `ytObj` em `buildYoutubeOptionsForPropagation` tem só `title/privacy/made_for_kids/monetize_with_ads/description/category_id/pinned_comment_text` (`:740-742`) — **não serializa `config.youtube_products`** (0 ocorrências de `products` em `:654-745`). Qualquer edit (ex.: só a caption) re-grava `youtube_options` de todos os shorts pending SEM products → perda silenciosa. | `planner-runtime.ts:654-745` (ytObj `:740`) + `:880-890` (`newYoutubeOptions` aplicado) | **P1** (data loss em pending) |
| G3 | **Description sem template-resolve na propagação.** `buildPostData` resolve `{var}` em `youtube_description` (`:453-455` via `resolveYtTpl`); a propagação grava a string crua (`:734`). | `:453-455` vs `:734` | **P1** |
| G4 | **Pinned comment diverge.** buildPostData lê `youtube_pinned_comment ?? youtube_pinned_comment_text` (`:500-501`); propagação lê só `youtube_pinned_comment_text` (`:738`). Config legado com só a 1ª chave ⇒ propagação remove o pinned. | `:500-501` vs `:738` | P2 |
| G5 | **`caption_youtube`/`caption_instagram` fora da propagação** — ver §6 (schema-only hoje; se o wizard passar a gravar per-item, `shouldPropagateConfig` não detecta a mudança). | `:596-649` | P2 (latente) |

---

## 4. Duplicate `POST /api/planners/[id]/duplicate`

| Ação | Evidência | Status |
|---|---|---|
| Config copiado verbatim (novos campos YT sobrevivem) | `duplicate/route.ts:64-74` (`config: source.config`) | **OK** |
| State zerado, status `paused`, canais reconectados com posse re-validada pelo source lookup | `:65-73` | **OK** |
| Mix validation (só >1 canal) | `:48-56` | **OK** |
| Config NÃO é validado no clone (`validatePlannerConfig` ausente) — config inválido é clonado e só falha ao rodar | `:60-74` | **GAP P2** |
| Conflito com novos campos YT (products/dual captions)? | nenhum — config é string JSON opaca | **OK** |

---

## 5. Preview `GET /api/planners/[id]/preview`

| # | Observação | Evidência | Status |
|---|---|---|---|
| V1 | Retorna: planner meta, `youtube_fields`, runtime resolvido, channels+health, publishable_channels, platform_type, isolation_warning, gating | `preview/route.ts:196-262` | **OK** |
| V2 | **Não expõe `youtube_type` do PRÓXIMO post** (Short vs Comunidade) — o wizard não consegue saber pela API se o próximo conteúdo vira Short ou Community; só inferindo por `runtime.mediaType` | `preview/route.ts:196-262` (sem `youtube_type` em lugar nenhum) | **GAP P2** (confusão) |
| V3 | `youtube_fields.youtube_products`: string CSV ou `Array.join(",")` — com o novo formato `{query,item?}` viraria `"[object Object],..."` no preview (mesmo bug do load no wizard `PlannerWizard.tsx:507`) | `preview/route.ts:219` | **GAP P1** (conforme novo formato) |
| V4 | Sem preview de products do próximo Short (o que seria taggado) | `:219` (só raw string) | **GAP P2** |
| V5 | `getTimeInTimeZone` duplicada localmente (divergência futura com `lib/planner-config.ts`) | `preview/route.ts:9-26` vs `planner-config.ts:283-296` | **GAP P2** |
| V6 | Gating estimado espelha cron Phase 0 (interval/start_time/sleep) | `preview/route.ts:60-123` | **OK** |
| V7 | Wizard também estima caption com lógica PRÓPRIA e divergente (`{date}`/`{channel_name}`→`"1"`, `{hashtags}`→`""`) — já não bate com o runtime | `PlannerWizard.tsx:99-127` (`resolveCaptionTextForWizard`) | **GAP P2** |

---

## 6. Dual captions (youtube.txt/instagram.txt → `ContentItem.caption_youtube/instagram` → `{post_caption}`)

Estado: **schema/migration-only, 0 consumidores.**

- Colunas existem: `prisma/schema.prisma:150-151` + `prisma/migrations/0009_add_dual_captions/migration.sql`.
- **0 referências de código** fora do schema: `grep -rn "caption_youtube\|caption_instagram"` em `app/ components/ lib/ worker/` → só schema.prisma.
- `resolveCaptionTemplateVars` (`planner-runtime.ts:204-274`) lê somente `libItem.caption` (`:212`, `:265-268`) — nunca `caption_youtube`/`caption_instagram`.
- API de content-items não grava: whitelist `POST_ALLOWED_FIELDS` = `["name","title","caption","tags","type","size","duration","parent_id","url","thumbnail_url"]` (`app/api/content-items/route.ts:13-19`) — sem os 2 campos; sanitize só trata `caption`.
- Uploader não lê `youtube.txt`/`instagram.txt` (grep `.txt` em `app/api/upload*`, `data/`, `lib/upload*` → 0 matches).
- `CAPTION_PROPAGATION_KEYS` não inclui; compare per-item em `shouldPropagateConfig` (`:631-644`) não inclui.

| Julgamento | Severidade |
|---|---|
| Feature declarada no plano (docs/integration-plan) mas **não implementada de ponta a ponta** — risco de "dual caption" virar campo órfão (aparece em schema mas não é usado) | **P1** (feature incompleta; não é regressão porque nunca funcionou) |

---

## 7. Produtos afiliados — nova feature `{query, item?}` — cadeia completa

### 7.1 Cadeia atual (wizard → config → runtime → publisher → API externa)

| Etapa | Código | O que acontece |
|---|---|---|
| Wizard (UI) | `PlannerWizard.tsx:1047-1057` | Grava `youtube_products` como **CSV string**: `youtubeProducts.split(",").map(trim).filter(Boolean).join(",")`. Input é campo de texto (`:1720-1721`) com placeholder "IDs separados por vírgula". |
| Wizard (busca live) | `:683-735` | `handleSearchYoutubeProducts` chama `/api/youtube/products?channelId&videoId&query`; exige `videoId` derivado de `youtubeTitle` ou `selectedContentIds[0]` (`:696-705`); resultados são exibidos como `JSON.stringify(...)` read-only (`:1736-1744`) — **não há botão de selecionar produto** (nenhum `{query, item?}` é montado). |
| Validação | `planner-config.ts:441-476` | Valida como CSV (`typeof !== string && !Array.isArray` → erro "string com IDs separados por vírgula"). O helper novo `normalizeYoutubeProductsList` (`:150-197`) e `serializeYoutubeProducts` (`:199-214`) e `YoutubeProductEntry` (`:136-148`) e `YOUTUBE_CATEGORIES` (`:216-233`) são **dead code: 0 consumidores** (grep em app/components/lib). |
| Runtime | `planner-runtime.ts:456-470` | 3 caminhos divergentes: CSV string → `split(",")`; **array → `String(v).trim()` por item → objeto vira `"[object Object]"`** (`:462-466`); fallback `normalizeYoutubeProductsCsv` (legacy). Grava `youtube_options.products` como JSON string array de ids. |
| Publisher | `publisher/route.ts:1177-1195` → `lib/youtube.ts:397` | Monta `productsStr` e envia `products` (form field) para **POST `/api/shorts`** (nunca `/api/shorts/auto` nem `/tag-products`; `grep "shorts/auto\|tag-products"` na web → 0 matches). |
| API externa | `shorts.py:75-88` | `_parse_products`: `return [item for item in value if isinstance(item, dict)]` — **strings CSV são descartadas silenciosamente** → `products=[]` → `run_short_upload(products=[])` → **nada é taggado**. |
| API externa auto | `shorts.py:376-513` | `/api/shorts/auto` (product_names+filters) e `/api/shorts/tag-products` existem na externa mas **nunca são chamados pela web app**. |

### 7.2 Julgamentos

| # | Achado | Evidência | Severidade |
|---|---|---|---|
| PR1 | **Produtos NUNCA chegam a ser taggados**: `products: '["prod_123"]'` → `_parse_products` filtra não-dicts → `[]`. O fluxo `{query, item?}` + `product_names` não existe na web app. | `shorts.py:75-88`; `lib/youtube.ts:397`; publisher `:1209`; 0 refs a `/shorts/auto` | **P0** (feature não funciona) |
| PR2 | Formato novo `{query, item?}` (spec da branch) **não é consumido por ninguém**: helpers dead code + wizard salva CSV + runtime quebraria objetos em `"[object Object]"` | `planner-config.ts:150-214` (dead); `planner-runtime.ts:462-466`; `PlannerWizard.tsx:1047-1057` | **P0** (inconsistência wizard×runtime se alguém seguir a spec) |
| PR3 | Picker sem seleção: resultados read-only impedem compor `{query, item?}` | `PlannerWizard.tsx:1736-1744` | **P0** (feature incompleta) |
| PR4 | Produtos exigem `videoId` para busca, mas planner não tem videoId (post nem existe) → busca impossível no fluxo de edição sem título/vídeo selecionado | `PlannerWizard.tsx:696-705` | **P1** (dead-end UX) |
| PR5 | `youtube_options.products` é descartado por `parseYoutubeOptions` (whitelist de keys sem `products`) em POST/PATCH `/api/posts` | `lib/youtube-post-options.ts:23-92` (clean só com keys conhecidas) | P2 (manual posts) |
| PR6 | Comunidade **não** tem tagging (externo `post.py` sem `product` — grep 0 matches) — consistente com spec "comunidades SEM produtos". Mas o wizard mostra o campo Produtos para planner YT **independente do mediaType** (`PlannerWizard.tsx:1684-1744`, sem condição de media) → campo visível mas ignorado no runtime para conteúdo imagem/carrossel (community) | `buildPostData` só grava products em `ytTypeForPost === "short"` (`planner-runtime.ts:456-470` dentro do ramo short) | **P1** (confusão wizard: "media type não muda inputs") |

---

## 8. Race de cancelamento (PATCH × publisher) — janela real

### Defesa existente
PATCH cancela posts com `status ∈ cancellableStatuses` incluindo `processing/processing_upload/processing_children/ready_to_publish` (`route.ts:145-153`). O próprio comentário da rota confirma que o publisher busca por `Post.channel_id`, não `planner.channels` (`route.ts:134-137`).

### Gap confirmado (publisher NÃO re-checa planner.channels)
- Claim: `publisher/route.ts:1594-1622` — `findMany { status: "pending", ... }` → transação → `status: "processing"`; **sem** join/verificação de `planner.channels` (0 ocorrências de `planner.findUnique/findFirst` em todo o arquivo).
- Publicação prossegue sem re-checar o status do post: o pre-flight só checa mídia (`:1644-1651`).
- **Toda escrita final é `prisma.post.update({ where: { id }, data })` incondicional** — sem guard de status:
  - Short YT: `:1216-1222` (`status: "published"`).
  - Community YT: `:1128-1135`.
  - IG publish: `:2570-2581`.
  - Retry transiente: `handleRetryableFailure` `:302-345` (`update where { id }`).
  - (exceção: throttle reverte com `where: { id, status: "processing" }` em `:1666-1668`).

### Consequência
Post claimado (`processing`) que tem o canal removido no PATCH é setado `cancelled`, **mas se o publisher já estiver no meio do fluxo externo ele publica mesmo assim (zombie) e a escrita final sobrescreve `cancelled` → `published`**. A janela é de ~1 tick (60s de worker; MAX_EXEC_MS ~45s). O cancelamento **só é eficaz** para posts ainda `pending/scheduled/queued/draft` (não claimados).

| Julgamento | Severidade |
|---|---|
| Race real; defesa parcial (cancelamento cobre processing no DB, mas publisher não re-confere e sobrescreve). | **P1** |

---

## 9. Forma-de-posta → evidência → status (wizard → config → runtime → publisher → API externa)

| Forma | Wizard (config) | Runtime (buildPostData) | Publisher | API externa | Status |
|---|---|---|---|---|---|
| IG REELS | `{type:"library_item", media_type: REELS}` (`PlannerWizard.tsx:880-900`) | `mediaType REELS ⇒ video_url`; audio/collabs/tags normalizados (`planner-runtime.ts:558-571`) | container IG Graph API `/:accountId/media` (`publisher:1823,1993,2172,2356`) + publish `:2540-2560` | Instagram Graph API | **OK** |
| IG IMAGE | idem com IMAGE | `image_url` (`:564-566`) | idem | idem | **OK** |
| IG CAROUSEL (carousel_folder) | folder → `parent_id` findMany | children ordenados A-Z numerico, max 10 (`:911-940`); `carousel_folder` vazio ⇒ erro "Carousel item has no children" (`:1083-1084`) → skip (não consome tick) | children containers + publish | idem | **OK** (vazio bloqueia com erro claro) |
| IG STORIES | media_type STORIES | `.mp4 → video_url`, imagem → image_url (`:562-570`) | idem | idem | **OK** |
| YT SHORT | `onlyYoutubeSelected` + media REELS | `youtube_type="short"` + `youtube_options` completo (title/privacy/mfk/monetize/category/pinned/products) (`:411-475`) | download local + `createShort` → POST `/api/shorts` (`:1196-1214`) | `shorts.py:277-345` | **OK exceto products (PR1)** |
| YT COMMUNITY | media IMAGE/CAROUSEL | `youtube_type="community"`, **sem** youtube_options (`:411-414`) | texto→`POST /api/post`; com imagens→ upload multipart (`publisher:905-960, 949, 1105-1122`) | `app/api/post.py` (sem tagging — OK c/ spec) | **OK**; caption vazia → falha definitiva (`:905-907`) |
| YT mix (planner misto) | bloqueado no wizard (`PlannerWizard.tsx:1052-1057`) e server (`route.ts:57-62`) | — | — | — | **OK** |
| STORIES em canal YT | wizard auto-fixa STORIES→REELS (`PlannerWizard.tsx:262-274`) | — | — | — | **OK** |

---

## 10. Races / gaps consolidados + recomendações (sem aplicar)

### Races
1. **R1 (P1)** Cancelação × publisher: escrita final incondicional sobrescreve `cancelled`; publisher nunca re-checa `planner.channels`.
   → Recomendação: guard nas escritas finais com `where: { id, status: { in: processing-statuses } }` + re-check `status !== "cancelled"` antes do call externo; opcional: marcar `cancelled` no momento do claim via transação com `where { id, status pending }` único (já existe) + verificação pós-claim.
2. **R2 (P2)** PATCH reset_state × runPlannerOnce em concorrência: PATCH grava `state: '{}'` incondicional; se cair entre o claim e a txn do runtime, o updateMany condicional (`where last_run = now`) do runtime mantém o `nextState` velho → estado ressuscitado por 1 tick. Baixo risco (janela ms), sem wedge (selectContentIndex clampa).
3. **R3 (P1)** Propagação × publisher: propagate atualiza `pending/scheduled/queued` e o publisher pode ter claimado um deles no mesmo instante → o update do publisher vence ou o propagate reescreve um post que acabou de virar processing (update por id sem guard). Janela pequena; propagação não re-checa status no `update` (`:893-898`).

### Gaps prioritários (ordem de correção sugerida)
1. **P0 – products**: conectar a cadeia ao formato `{query,item?}` + chamar `/api/shorts/auto` (product_names+filters) ou `/tag-products` pós-upload; ou converter ids → itens via busca no publish. Fazer `toYoutubeProductsJson(config)` único consumido por `buildPostData` e propagação (G2).
2. **P0 – picker**: seleção real de produto no wizard (montar `{query, item?}`), resolver videoId para community/short preview.
3. **P1 – propagação**: incluir `youtube_title` (template-resolve) no `titleCandidate` da propagação; serializar products; resolver templates em description; alinhar `youtube_pinned_comment` alias. Unificar com `buildPostData` (função única `buildYoutubeOptions(...)` compartilhada).
4. **P1 – wedge de item deletado**: em `selectContentIndex`/runtime, upon `resolution_failed` marcar o índice como tentado (state pending `attempted_indexes`) para pular ao próximo em sequencial.
5. **P1 – race cancelamento**: guards de status nas escritas do publisher (R1).
6. **P1 – community vazia**: falhar na criação do post (planner run) com mensagem clara em vez de falha definitiva no publish — ou garantir fallback de caption (ex.: título).
7. **P1 – dual captions**: só faz sentido após wiring completo (content-items whitelist+sanitize; resolução por plataforma centralizada; wizard inputs). Hoje é schema-only.
8. **P2**: validate config no duplicate; retirar duplicação de `getTimeInTimeZone` no preview; expor `youtube_type` no preview; produtos visíveis só para conteúdo Short na UI; `resolveCaptionTextForWizard` delegar ao runtime.

---

## 11. Cross-checks de outros tracks (referência)
- Watcher confirmou: `caption_youtube/instagram` schema-only; whitelist content-items sem os campos; conflito C1/C2/C3 do plano de integração batem com PR2/G2/G1 acima (`docs/audit-integration-plan.md` §3, §4).
- Este relatório acrescenta à base do watcher: **prova de que a API externa descarta strings em `products`** (`shorts.py:75-88` — fim-de-cadeia do PR1) e **prova da race de cancelamento com linhas exatas do publisher** (§8).