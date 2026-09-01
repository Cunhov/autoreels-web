# Auditoria Fase 1 — Track IG (Agent 1): Postagem no Instagram e consistência com o Planner

- **Branch:** `feat/yt-products-dual-captions` (checkpoint `9ae5a54`; base `b3d5d56`)
- **Escopo:** fluxo completo IG — REELS, IMAGE, CAROUSEL, STORIES — do wizard ao publisher/Graph API, propagação de edição, cancelamento por remoção de canal e isolamento YT.
- **Método:** rastreio wizard → config → runtime (`buildPostData`/`applyCaptionTemplate`) → publisher → API externa, com trechos citados (`arquivo:linha`). Nenhum código alterado; apenas este documento.

---

## 0. Mapa do fluxo (evidência de cadeia)

| Etapa | Arquivo | Papel |
|---|---|---|
| Campos da UI | `components/PlannerWizard.tsx:190-215, 885-916, 1441-1810` | mediaType, caption/templates/fallbacks, share_to_feed, location, collaborators, user_tags, audio |
| Validação (server) | `lib/planner-config.ts` (`validatePlannerConfig`) + `app/api/planners/route.ts:120-138` + `app/api/planners/[id]/route.ts:41-58` | estrutura do config; **nenhuma validação específica de IG** |
| Runtime (Fase 0) | `lib/planner-runtime.ts` (`resolvePlannerRuntime` 900-1130, `buildPostData` 388-591) | resolução de item/library, caption por template, montagem do Post |
| Criação do Post | `app/api/posts/route.ts` (POST) | whitelist de campos, media_type, children_urls JSON |
| Publisher IG | `app/api/cron/publisher/route.ts` | Phase 1 (container), Phase 2 (status/children), Phase 2.5 (timeouts), Phase 3 (`media_publish`) |
| Graph API | `lib/instagram.ts` (resolveAccessToken, getGraphBaseUrl, refresh) | token/base/graph.instagram.com |
| Health check de canal | `lib/planner-runtime.ts` `getChannelHealth` 185-260 | exige status active + token (IG); sem ele `runPlannerOnce` retorna `no_publishable_channels` |

Cadeia por forma (resumo verificado):

- **REELS:** wizard mediaType=REELS (+caption/share_to_feed/location/collabs/audio) → `config.content[]` → runtime resolve library `video → "REELS"` (`planner-runtime.ts:1018`) → caption via `applyCaptionTemplate` → `buildPostData` grava `video_url` (`:620-622`), `caption`, `share_to_feed`, `location_id`, `collaborators` (comma), `audio_configuration` (JSON) → publisher: `POST /{account}/media` REELS com `video_url`+caption+share_to_feed+location+audio+collaborators (`publisher:1919-1970`) → poll → `media_publish` (`publisher:2548-2565`). **OK.**
- **IMAGE:** wizard mediaType=IMAGE (caption/location/collabs/user_tags) → runtime `image → "IMAGE"` → `image_url` (`:623-628`) → publisher IMAGE: `image_url`+caption+location+`user_tags` (`:1919-1933`) + collaborators (`:1972-1979`). **OK.**
- **CAROUSEL:** wizard exige pastas `carousel_folder` ou uploads ≥2 → runtime monta children ordenados por nome e `slice(0,10)` (`:1015-1044`) → `children_urls`+`image_url`=1º child → publisher cria containers por child (resume idempotente), normaliza 9:16, polls status e monta em ordem alfabética (`:2286-2367`) → `media_publish`. Ver GAPs em §2.
- **STORIES:** option só quando `!youtubeSelected` (`PlannerWizard.tsx:1465`) → runtime mantém STORIES → `video_url` se `.mp4`, senão `image_url` (`planner-runtime.ts:629-634`) → publisher: `media_type=STORIES`, `image_url` se sem vídeo (`:1940-1945`), **sem caption** (`:1951`), sem location/audio/share (`:1953`), sem collabs (`:1972`). Ver GAPs em §2.

---

## 1. Tabela principal: forma de postagem → evidência → status → severidade

| # | Forma / Item | Evidência (arquivo:linha) | Status | Sev. | Recomendação |
|---|---|---|---|---|---|
| 1 | **REELS** completo (wizard→runtime→publisher) | UI `PlannerWizard.tsx:1441-1476, 1792-1810`; runtime `planner-runtime.ts:1018, 620-622`; publisher `:1919-1970, 2548-2565` | OK | — | — |
| 2 | **IMAGE** completo | `PlannerWizard.tsx:1664-1680`; runtime `:623-628`; publisher `:1919-1933` | OK | — | — |
| 3 | **Carousel de 1 item** (pasta com 1 mídia): wizard só valida "é pasta" (`PlannerWizard.tsx:858-871`), runtime só erra com 0 filhos, publisher cria 1 child e monta CAROUSEL → IG rejeita (carrossel exige 2–10) | `planner-runtime.ts:1082-1084` (`errors.push("Carousel item has no children")` — só qdo 0); `publisher:2338-2363` monta com `childIds.join(",")` qualquer contagem; validação server `app/api/posts/route.ts:139-148` só exige "JSON array" | **BUG (não pode publicar; falha definitiva na API)** | **P1** | Validar no wizard (contar children da pasta via `/api/content-items?parent_id=`) e no `POST /api/posts` (`children_urls.length >= 2 && <= 10` para `media_type=CAROUSEL` IG) |
| 4 | **carousel_folder vazio**: runtime → erro "Carousel item has no children" → `runPlannerOnce` `resolution_failed` → planner ativo **nunca posta**, silenciosamente, a cada tick | `planner-runtime.ts:1082-1084` (erro) + `:1259-1264` (`skipped: "resolution_failed"`); wizard NÃO checa contagem ao salvar | **BUG (não posta)** | **P1** | Bloquear/marcar pasta vazia no wizard e logar warning no cron |
| 5 | **Carrossel de 11+ mídias**: runtime `slice(0,10)` + warning de runtime; wizard não avisa | `planner-runtime.ts:1034-1039` | OK p/ publicação (limita), GAP de UX | P2 | Avisar no wizard; usar warning existente como mensagem |
| 6 | **STORIES**: caption editável no wizard mas **nunca enviada** à API (story não tem caption); location_id visível + salva mas **não enviada** | UI `PlannerWizard.tsx:1626-1640` (Location, sem condição de STORIES); `PlannerWizard.tsx:1483-1550` (Caption, sem condição); publisher `:1951-1952` (`if (mediaType !== "STORIES")`), `:1953-1966` (location só em REELS) | **BUG de confusão (campos órfãos)** | P2 | Esconder Caption/Location para STORIES (ou documentar que são ignorados) |
| 7 | **Campo órfão server-side**: `POST /api/posts` aceita `location_id/share_to_feed/collaborators/user_tags/audio` sem checar plataforma IG do canal (só `youtube_type` tem cross-check) | `app/api/posts/route.ts:214-226` (cross-check só p/ youtube_type) — resto é whitelist cega | GAP (validação incompleta) | P2 | Para media_type STORIES/IMAGE/CAROUSEL, exigir `channel.platform === "instagram"` |
| 8 | **Mix de mídia com upload direto**: selecionar REELS com imagem (upload direto) → runtime não deriva tipo do arquivo; publisher manda `video_url=imagem` → IG rejeita (definitivo) | wizard grava `media_type` do select p/ uploads (`PlannerWizard.tsx:903, 958-975`); runtime `:1009-1011` (mediaType vem da entrada); publisher `:1946-1950` (`video_url` fica com a imagem) | **BUG (media type não muda por arquivo; falha na publicação)** | **P1** | Derivar tipo do upload no wizard e/ou validar extensão no runtime/publisher (imagem ≠ REELS) |
| 9 | **user_tags em carrossel**: widgets mostram tags p/ CAROUSEL; API só recebe tags no **1º slide imagem** | wizard `:910` (`user_tags: mediaType === "IMAGE" || isCarousel ? ...`) + UI `:1664-1680`; publisher `buildCarouselChildParams` `:238-247` (`if (opts.idx === 0 && ...)`) | GAP (comportamento parcial, não documentado) | P2 | Documentar ou aplicar tags em todos os slides imagem |
| 10 | **share_to_feed REELS**: null ⇒ `"true"` (BK-23 herda) | runtime `:976-977`; publisher `:1955-1957` | OK | — | — |
| 11 | **Caption vazia em IG**: permitida (wizard não valida p/ IG; server não valida) → publica sem caption (`caption: ""`) | publisher `:1919, 1952` (`bodyParams.append("caption", post.caption || "")`); sem bloqueio em `PlannerWizard.handleSubmit` (validações IG inexistentes) | OK (IG aceita caption vazia) — GAP documental | P2 | Documentar; opcional: avisar "sem legenda" no preview |

---

## 2. Tabela: STORIES em canal YT + isolamento

| # | Item | Evidência | Status | Sev. | Recomendação |
|---|---|---|---|---|---|
| 12 | **STORIES em planner YT — proteção existe SÓ no save do wizard** (option escondida `PlannerWizard.tsx:1465`; auto-fix `useEffect` `:269-272`; `normalizePreservedMediaType` no save `:931-941`). **O runtime não guarda**: `buildPostData` para canal YT com entry STORIES → `youtube_type="short"`; story-imagem (não .mp4) → `video_url=null` → publisher falha **"Short do YouTube exige um vídeo"** definitivo, ciclo após ciclo | `planner-runtime.ts:403-410` (`ytTypeForPost` p/ qualquer não-IMAGE/CAROUSEL → short); `publisher:1147-1149` (`if (!post.video_url) throw ... "Short do YouTube exige um vídeo"`) | **BUG residual (configs grandfathered nunca re-salvos)** | **P1** | Adicionar guard no runtime: canal YT + mediaType STORIES → converter p/ REELS ou erro explícito (não só no save) |
| 13 | Campos IG ocultos em planner YT-only: caption/templates/fallback/location/collabs/tags/audio/share — **confirmado** | `PlannerWizard.tsx:1460, 1483, 1516, 1584, 1626, 1643, 1664, 1792` (todos `!onlyYoutubeSelected`) | OK | — | — |
| 14 | **Regressão do isolamento (cross-track):** campo Caption é ocultado no planner YT-only, mas é a **única fonte do texto da Comunidade** (publisher usa `post.caption`; `buildPostData` não monta youtube_options p/ community) — validação no save exige texto não-vazio com o campo invisível ⇒ criar/editar texto de Comunidade é **impossível** no wizard YT-only | oculto: `PlannerWizard.tsx:1483-1550`; validação bloqueia: `:827-842` ("Posts na Comunidade do YouTube exigem um texto"); fonte do texto: `app/api/cron/publisher/route.ts:884` (`const message = (post.caption || "").trim()`); `planner-runtime.ts:407-409` (community → youtube_options null) | **BUG cross-track (confusão + P0-publish YT)** | **P1** | Expor texto de Comunidade (reusar campo Caption ou campo YT dedicado) quando mídia = IMAGE/CAROUSEL em YT-only |
| 15 | **Produtos Afiliados (CSV) visível em Comunidade (não deveria existir):** bloco "Configurações YouTube" é incondicional (`onlyYoutubeSelected`), incluindo o campo produtos; runtime só usa `youtube_products` no caminho short (`planner-runtime.ts:439-459`), community → `youtube_options=null` ⇒ campo **órfão** quando mídia = IMAGE/CAROUSEL | UI `PlannerWizard.tsx:1684, 1717-1750`; runtime `:439-459` (só short) | **BUG de confusão (órfão)** | **P1** | Esconder bloco Produtos quando `mediaType === "IMAGE"/"CAROUSEL"` (Comunidade não suporta produtos) |

---

## 3. Tabela: propagação / edição / cancelamento

| # | Item | Evidência | Status | Sev. | Recomendação |
|---|---|---|---|---|---|
| 16 | **Propagação de caption/título p/ pendentes** (PATCH → `shouldPropagateConfig` → `propagatePlannerConfigToPendingPosts`) — funcional | `app/api/planners/[id]/route.ts:171-196`; `planner-runtime.ts:596-766` | OK | — | — |
| 17 | **CAPTION_PROPAGATION_KEYS cobre caption/templates/rotation/fallbacks/title_fallback + youtube_\* + collabs/user_tags** — confirmado; **NÃO cobre** `location_id`, `share_to_feed`, `audio_configuration` nem os campos per-item `content[].location_id/share_to_feed/collaborators/user_tags/audio_configuration` (diferença detectada só via `content[].caption/caption_fallback/title_fallback`) | `planner-runtime.ts:596-611` (keys) e `:630-648` (compare per-item só caption/fallbacks) | **GAP (edição de local/collabs/tags/áudio não propaga para post pendente)** | **P2** | Incluir os campos per-item na comparação de diff ou propagar como o caption |
| 18 | **Propagação destrói produtos em Shorts pendentes:** `buildYoutubeOptionsForPropagation` reconstroi `youtube_options` **sem a chave `products`**; qualquer edição (ex.: caption) em planner com produtos ⇒ shorts pendentes perdem `youtube_options.products` | `planner-runtime.ts:748-756` (`ytObj` sem `products`); disparo: `:880-888`; `shouldPropagateConfig` inclui `youtube_products` `:608` | **BUG (dados perdidos em pendentes)** | **P1** | Incluir `products` na reconstrução do propagate (espelhar `buildPostData`) |
| 19 | Heurística de `selectedContent` na propagação: match por URL, fallback **posicional** `contentList[i % len]` — em `random_loop`/multi-item pode resolver `{post_caption}` do item errado | `planner-runtime.ts:814-851` | GAP (heurística frágil) | P2 | Armazenar `content_item_id` no Post (schema) e propagar por ele |
| 20 | **Cancelamento ao remover canal** — `cancellableStatuses` cobre `pending/scheduled/queued/draft/processing/processing_upload/processing_children/ready_to_publish`; posts órfãos cancelados com `channel_removed` | `app/api/planners/[id]/route.ts:129-168` | OK | — | — |
| 21 | **Reset de state ao mudar conteúdo**: identidade de conteúdo (add/remove/reorder) → `reset_state:true` → `state:'{}'`; editar caption/campo não reseta (itens preservados mantêm settings) | `PlannerWizard.tsx:1024-1037` (identity), `:1086-1091` (reset_state); PATCH `:96-99` | OK | — | — |
| 22 | Edição manual de caption em post único validada p/ YT (`posts/[id]` PATCH); p/ IG sem restrições (aceitável) | `app/api/posts/[id]/route.ts:150-188` | OK | — | — |

---

## 4. Tabela: dual caption e feature de produtos (estado da branch)

| # | Item | Evidência | Status | Sev. | Recomendação |
|---|---|---|---|---|---|
| 23 | **Dual caption schema-only:** colunas `caption_youtube`/`caption_instagram` existem (migration 0009) mas **nenhum código escreve ou lê** — uploader não processa `youtube.txt`/`instagram.txt`; `resolveCaptionTemplateVars` resolve `{post_caption}` da **única** `ContentItem.caption`; wizard salva caption única | `prisma/migrations/0009_add_dual_captions/migration.sql`; `grep caption_youtube → 0 hits em app/components/lib/worker`; runtime `:937-975` (lê só `caption`) | **GAP (plano não implementado)** | P1 (feature WIP) | Wire: upload de pasta → extrair .txt → colunas; template resolver `{post_caption}` por plataforma (IG: caption_instagram) com fallback para caption; propagação/editor precisarão do campo por plataforma. Riscos: caption IG vazia vs fallback; editor de post único (multiplataforma) |
| 24 | **Feature produtos `{query, item?}`:** `normalizeYoutubeProductsList`/`serializeYoutubeProducts` existem mas **não são usados**; wizard continua CSV → `youtube_products`; publisher envia `products` como array de strings CSV no `POST /api/shorts`; **não envia `product_names`+`filters` nem auto-select**; API externa já expõe `GET /api/session/{id}/products?query=` e `POST /api/shorts/tag-products` (product_names+filters) | `lib/planner-config.ts:136-216` (helpers órfãos); wizard `:1055-1063` (CSV), `:768-806` (busca via `/api/youtube/products` com videoId obrigatório); publisher `:1149-1165` (`createShort products`); API externa `shorts.py:277-340, 388-490` | **GAP (feature não implementada — helpers prontos, runtime/UI no formato legado CSV)** | P1 (cross-track) | Implementar lista `{query,item?}` + live search `GET /api/session/{id}/products` + `product_names` no Short (auto-select na API); comunidades sem produtos (§15) |

---

## 5. Conclusão — o que FALTA para ficar consistente (IG)

1. **Min/max de carrossel**: pasta com 1 item passa wizard+runtime e falha definitivamente no IG (2–10 exigidos); pasta vazia deixa o planner **ativo mas nunca posta** (silencioso). Faltam: validação de contagem no wizard (query parent) e no `POST /api/posts` para `media_type=CAROUSEL`.
2. **Guard runtime de STORIES→YT**: a proteção vive só no save do wizard; configs grandfathered não re-salvos podem produzir Short sem vídeo (falha permanente ciclo a ciclo). O runtime precisa converter ou rejeitar STORIES em canal YT.
3. **Media type derivada/validada por arquivo**: upload direto de imagem com REELS selecionado vai para `video_url` e falha no IG; derivar tipo no wizard ou validar extensão no publisher (definitivo imediato em vez de erro na API).
4. **Campos órfãos UI**: em STORIES, Caption e Location são exibidos/gravados mas nunca enviados; em Comunidade YT, Produtos Afiliados é exibido mas ignorado. Os dois precisam de ocultação por tipo de mídia.
5. **Propagação incompleta**: campos per-item (location/share_to_feed/collabs/tags/audio) não dispararam diff de propagação; e `buildYoutubeOptionsForPropagation` dropa `products` de Shorts pendentes (volátil a qualquer edição).
6. **Validação server-side por plataforma IG**: `POST /api/posts` valida mídia para YT mas não para IG (media_type IG-only aceito em canal YT; children_urls sem min/max).
7. **Dual caption e produtos `{query,item?}`**: schema e helpers existem; runtime/UI/uploader ainda no formato legado — etapas do plano que não foram conectadas nesta branch.
8. **Heurística de propagação por posição**: em planners random_loop multi-item, `{post_caption}` propagado pode vir do item errado; armazenar `content_item_id` no post eliminaria a adivinhação.

### Não são problemas (verificados OK)
- Campos IG ocultos em planner YT-only (§13).
- Cancelamento de posts ao remover canal (§20).
- Reset de state por mudança de conteúdo, sem reset por edição de caption (§21).
- Idempotência/retry/handling 429 no publisher IG (fora do escopo desta track, já coberto por auditorias anteriores).
- STORIES só existe para IG (option condicional + normalize no save).

---

*Nota: itens marcados "cross-track" (14, 15, 18, 23, 24) afetam o YouTube; reportados aqui por impacto na UI/consistência do planner, mas devem ser consolidados no track YT/feature (agentes 2–6).*