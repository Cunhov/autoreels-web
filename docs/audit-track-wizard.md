# Audit Track WIZARD/UI — Fase 1 (agente 4)

> **Branch:** `feat/yt-products-dual-captions` · **HEAD:** `9ae5a54` (checkpoint) · **base:** `b3d5d56`
> **API externa:** `/Users/bestoptionnotebook/Projects/youtube-community-api` (`app/api/shorts.py`, `post.py`)
> **Método:** rastreio por FORMA de postagem: wizard (`components/PlannerWizard.tsx`, 2109 linhas, leitura integral) → config (JSON salvo) → runtime (`lib/planner-runtime.ts` `buildPostData`/`applyCaptionTemplate`) → `app/api/planners*` → publisher (`app/api/cron/publisher/route.ts`) → API externa. Nenhum código alterado (somente docs).
> **Arquivos correlatos:** `docs/audit-track-api.md` (agente 6 — produtos/categorias/proxy), `docs/audit-integration-plan.md` (plano T5).

---

## 0. Resumo executivo

| # | Achado | Severidade |
|---|---|---|
| W1 | Planner YT-only: campo **Caption/Caption Templates/Fallbacks ocultos** (isolamento b3d5d56) mas validação e runtime **exigem caption** → **deadlock**: não há campo visível para texto de Comunidade; Short com upload novo + Título preenchido é bloqueado | **P0** |
| W2 | Validação de Short **ignora `youtube_title`** (o guard usa só caption/fallback/library titles) — contradiz a cadeia de títulos do runtime (`rawYtTitle` é a 1ª fonte) | **P1** |
| W3 | **Media Type não muda os inputs** no planner YT: "Short do YouTube"/"Post na Comunidade" trocam só o label; a seção "Configurações YouTube" (Título*, Produtos, Privacidade, Categoria, Monetizar, Comentário) aparece igual nas duas formas; e **Produtos aparece em Comunidade** (spec: comunidades SEM produtos) | **P1** |
| W4 | **Produtos E2E = no-op silencioso**: wizard salva CSV de strings → runtime `youtube_options.products` (array de strings) → publisher manda campo `products` → API externa `_parse_products` **descarta não-dicts** → 0 produtos taggeados, sem erro (corrobora audit-track-api F2) | **P0 (feature)** |
| W5 | Busca de produtos fabrica `videoId` fake (título do planner / id de library item) e renderiza resultado como **JSON cru** (sem seleção de item → sem `{query,item}`) | P1 |
| W6 | **Captions duplas (youtube.txt/instagram.txt)**: colunas `caption_youtube`/`caption_instagram` criadas (migration 0009) mas **mortas** — whitelist de escrita não as aceita, runtime resolve só `caption`, `UploadContext` lê apenas o 1º `.txt` da pasta | P1 |
| W7 | Categoria YT = **input numérico cru**; `YOUTUBE_CATEGORIES` (dropdown) existe em planner-config mas é código morto (corrobora audit-track-api F3) | P2 |
| W8 | Propagação de edição (PATCH) perde `youtube_title` e **products** ao reconstruir `youtube_options` dos posts pendentes (`buildYoutubeOptionsForPropagation` não usa `cfg["youtube_title"]` nem products) | P1 |
| W9 | Labels EN vs PT-BR misturados; chips de variáveis (`{post_title}`/`{post_caption}`…) só existem no bloco IG, enquanto o placeholder da Descrição YT promete templates | P2 |

---

## 1. Inventário de campos do wizard (campo → condição visível → consumo → status)

Base: `PlannerWizard.tsx`. Estados-chave: `onlyYoutubeSelected` (L252-266), `youtubeSelected` (L239-250), `mediaType` (L190-192), `isCarousel` (L193), `contentTab` (L187), `preservedCount` (L218), `settingsTouched` (L229).

| Campo (estado) | Condição visível | Onde é consumido | Status |
|---|---|---|---|
| `name` | sempre (step 0) | POST/PATCH `/api/planners` | OK |
| `startTime` | sempre (step 0) | config.start_time → gate runtime `planner-runtime.ts` L1189 | OK |
| `selectedChannels` | step 1 (com isolamento YT/IG, L329-340) | channel_ids → `validatePlannerChannelMix` | OK |
| `mediaType` REELS/IMAGE/CAROUSEL/STORIES | select L1438-1458; STORIES **oculta se youtubeSelected** (L1457); auto-fix STORIES→REELS L269-272 | globalSettings.media_type → entry.media_type → runtime mediaType → `youtube_type` (L414-416) / publish path IG | OK (mas ver W3) |
| `isCarousel` | toggle "Group as Carousel" só aparece se files+content > 1 (L1424-1432) | entry.media_type CAROUSEL; runtime children (L1024-1035) | OK |
| `caption` | **`!onlyYoutubeSelected`** (L1483-1516) | entry.caption → `applyCaptionTemplate` → **única fonte da mensagem da Comunidade** (publisher L907) e do caption IG | **P0: oculto no planner YT (W1)** |
| `captionTemplates`/`captionRotation` | **`!onlyYoutubeSelected`** (L1516-1582) | config.caption_templates/rotation → runtime templates (L362-388) | P0 no YT (W1); OK no IG |
| `titleFallback`/`captionFallback` | **`!onlyYoutubeSelected`** (L1584-1624) | config `title_fallback`/`caption_fallback` → vars de template (L266-272) | P0 no YT (W1); OK no IG |
| `location` | `!onlyYoutubeSelected` (L1626-1641) | entry.location_id → Post.location_id | OK |
| `collaborators` | `mediaType !== STORIES && !onlyYoutubeSelected` (L1643-1661) | entry.collaborators → normalize → Post | OK |
| `userTags` | `(IMAGE\|CAROUSEL) && !onlyYoutubeSelected` (L1664-1682) | entry.user_tags (null para REELS, L964) | OK |
| `audioId/audioVolume/videoVolume` | `REELS && !onlyYoutubeSelected` (L1792-1878) | entry.audio_configuration → Post | OK |
| `youtubeTitle` | `onlyYoutubeSelected` (L1690-1701) | config.youtube_title → `ytObj.title` 1ª fonte título Short (planner-runtime L452-453 rawYtTitle, L471-474 titleCandidate) | **P1 (W2): validação ignora, runtime usa** |
| `youtubeDescription` | `onlyYoutubeSelected`, **qualquer mediaType** (L1703-1715) | config.youtube_description → **só Short** (`ytObj.description`); **NÃO usada na Comunidade** | P1 (W3) |
| `youtubeProducts` (CSV) | `onlyYoutubeSelected`, **qualquer mediaType** (L1717-1758) | config.youtube_products → runtime products (string array) → publisher `products` → API (no-op) | **P0 feature (W4, W5)** |
| `youtubePrivacy` | `onlyYoutubeSelected` (L1746-1757) | config → `ytObj.privacy` → publisher | OK |
| `youtubeCategoryId` (numérico cru) | `onlyYoutubeSelected` (L1761-1771) | config → `ytObj.category_id` → publisher `?? 22` | P2 (W7) |
| `youtubeMadeForKids`/`youtubeMonetizeWithAds` | `onlyYoutubeSelected` (L1773-1778) | config → `ytObj.*` → publisher | OK |
| `youtubePinnedComment` | `onlyYoutubeSelected` (L1780-1789) | config salva **os dois aliases** `youtube_pinned_comment` + `youtube_pinned_comment_text` (L1065-1066) → runtime lê ambos (planner-runtime L540) → publisher `pinned_comment_text` | OK (duplicação consciente) |
| `frequencyValue/Unit` | step 3 | config.frequency → `getPlannerIntervalMs`; guard NaN<1 (L789-791) | OK |
| `timezone` | step 3 | config.timezone → runtime/caption {date} | OK |
| `sleepEnabled/Start/End` | step 3; validação start==end (L783-786 + mensagem inline L1946) | config.sleep_schedule → `isSleepingNow` | OK (dupla validação client/server) |
| `sortOrder` | step 4 | config.sort_order → `selectContentIndex` | OK |
| `contentTab`/`files`/`selectedContentIds`/`preservedCount` | step 2 chips (L1183-1200) | merge originalContent/generated no save (L1031-1049) com `reset_state` por identidade (L1017-1030) | OK; `preservedCount` legacy (L218) preserva entradas não representáveis |

---

## 2. Matriz forma-de-posta → evidência → status

| Forma | Cadeia | Evidência | Status | Sev. | Recomendação |
|---|---|---|---|---|---|
| IG REELS | wizard→entry media_type REELS → runtime `mediaType=REELS` (libItem.type video, L1002-1005) → Post.video_url (L565) → publisher IG | `PlannerWizard.tsx` L943-992 (generated), `planner-runtime.ts` L429-565 | OK | — | — |
| IG IMAGE | idem; `user_tags` quando IMAGE (L964) → Post.user_tags | `PlannerWizard.tsx` L964, `planner-runtime.ts` L583-584 | OK | — | — |
| IG CAROUSEL | pastas `carousel_folder` → children (L1019-1035, ordem alfabética, limite 10) ou uploads ≥2 → `{type:"config", children_urls}` (L962-968) | `PlannerWizard.tsx` L938-968, `planner-runtime.ts` L1002-1035 | OK | — | validação de pastas client L849-868 (best-effort) |
| IG STORIES | select oculto se youtubeSelected (L1457); auto-fix STORIES→REELS (L269-272) + `normalizePreservedMediaType` (L935) | `PlannerWizard.tsx` L269-272, L930-940 | OK | — | — |
| YT SHORT (vídeo) | Título/Descrição/Produtos/Privacidade/etc → `ytObj` → `youtube_options` → publisher createShort → `POST /api/shorts` | `planner-runtime.ts` L429-561 (titleCandidate L471; products L457-469→L551), `publisher/route.ts` L1146-1230 (createShort L1196), `lib/youtube.ts` L378-424 (campo `products` L403) | **PARCIAL**: video publica, **produtos nunca taggeiam** (W4); validação exclui `youtubeTitle` (W2) | P0/P1 | W2 fix no guard; W4 rotear `/api/shorts/auto` p/ nomes |
| YT COMMUNITY (imagem/carrossel → texto+imagens) | `youtube_type="community"` (L414-416, gravado L563); **SEM `youtube_options`**; mensagem = caption resolvida; imagens = children_urls (carrossel) até 10 (publisher L920-926); fallback só-texto via `createCommunityPostText` (L949) | `publisher/route.ts` L900-949 (`exige texto` L907), L920-926 (limit 10); `planner-runtime.ts` captions | **BUG P0 (W1)**: campo texto oculto; deadlock; Descrição visível não alimenta a mensagem | P0 | Ver W1 fix: campo "Texto da publicação" visível no planner YT |
| STORIES em canal YT | auto-fix efeito colateral + normalização no save | `PlannerWizard.tsx` L269-272, L930-940 | OK (defesa em 2 camadas) | — | — |
| Mix YT+IG | bloqueado client (L1090-1096 `hasMixSelected`) + server (`validatePlannerChannelMix`) | `PlannerWizard.tsx` L297-306 (def), L1090-1096 (submit), `planner-config.ts` L688-730 | OK | — | — |

---

## 3. Bugs "não postar" — verificação individual

| Bug | Análise | Evidência | Status |
|---|---|---|---|
| Título vazio em Short | Guard do wizard exige caption resolvida OU titleFallback OU library titles — **não considera `youtubeTitle`** (que é a 1ª fonte no runtime). Upload direto (sem library) + Título preenchido → bloqueado com erro apontando campos invisíveis. | guard L804-819; `resolveCaptionTextForWizard` L95-135 (placeholders desconhecidos→"" L126); runtime titleCandidate L471-474 (rawYtTitle L452-453); publisher `Short do YouTube exige título` L1172-1174 | **BUG P1/P0 (W2)** — bloquear por excesso |
| Mensagem vazia em Community | Wizard bloqueia texto vazio (L825-847) e publisher rejeita (`Post na Comunidade exige texto` L907) — **mas o único campo que alimenta caption está oculto** no planner YT (C1). Usuário não consegue preencher → deadlock total. | L1483/1516/1584 (`!onlyYoutubeSelected`), L842 (erro), publisher L907 | **BUG P0 (W1)** |
| Caption vazia em IG | IG permite caption vazia (sem validação server p/ IG; runtime resolve "" e publica). OK por design. | `planner-runtime.ts` caption resolve; wizard sem guard IG | OK |
| Products sem videoId | Busca exige videoId = `youtubeTitle.slice(0,50)` ou item id (L694-706) — **não é um video_id do YouTube** (11 chars do canal) → busca falsa (corrobora audit-track-api F1). Além disso o fluxo completo é no-op (W4). | L694-706; `app/api/youtube/products/route.ts` L14-22 | **BUG P1** |
| Templates resolvendo vazio | Wizard conservador: desconhecidos→"" (L95-135), espelhado com runtime `substituteCaptionTemplate` L320-338 → bloqueia publicar caption que resolve vazia. | L95-135; `planner-runtime.ts` L320-338 | OK (conservador correto) |
| STORIES em YT | Auto-fix na UI (L269-272) + normalização no save (L930-940) + publisher sem caminho STORIES p/ YT | acima | OK |
| carousel_folder vazio | Wizard check client (L849-868) busca `?types=carousel_folder`; runtime erro "Carousel item has no children" (L1083) | L849-868, runtime L1083 | OK (best-effort + runtime) |
| Mix YT+IG | Bloqueio client + server (400) | acima | OK |

---

## 4. Bugs de confusão

| Bug | Evidência | Status |
|---|---|---|
| **Media Type no planner YT não muda os inputs** (report do usuário) | Select troca só o label das options (L1451-1458: "Short do YouTube"/"Post na Comunidade"); a seção "Configurações YouTube" (L1684-1790) é renderizada por `onlyYoutubeSelected` SEM gate de mediaType. Selecionar Short ↔ Comunidade não muda NENHUM input abaixo. | **P1 (W3)** |
| **Produtos em Comunidade** (spec: SEM produtos) | Bloco Produtos L1717-1758 dentro de `onlyYoutubeSelected` sem mediaType check; runtime só injeta products no ramo short (planner-runtime L457-469 dentro do bloco `ytTypeForPost === "short"` L429); API `post.py` não tem tagging. | **P1 (W3)** |
| Campos IG visíveis em planner YT | Todos gateados por `!onlyYoutubeSelected` (L1483, 1516, 1584, 1626, 1643, 1664, 1792) — **nenhum campo IG vazou**; porém o inverso ocorre (campos Short visíveis em Comunidade). | OK parcial / P1 |
| Labels EN vs PT-BR | EN: "Planner Name" L1158, "Start When?" L1174, "Post Configuration" L1413, "Upload New"/"From Library" L1188-1200, "Media Type" L1438, "Caption" L1487, "Caption Templates" L1520, "Fallback Title"/"Fallback Caption" L1588/1606, "Share to Feed" L1467, "Location ID (Optional)" L1630, "Collaborators (Optional)" L1646, "User Tags (Optional)" L1669, "Meta Audio Settings" L1795, "Posting Interval" L1886, "Sort Order"/"Preview" L1996/L2017. PT: "Configurações YouTube" L1688, "Título" L1694, "Produtos Afiliados" L1717, "Privacidade" L1748, "Feito para crianças" L1774, "Comentário fixado" L1781. | **P2 (W9)** |
| Chips de variáveis ausentes no YT | Chips `{post_title}/{post_caption}/{date}/{channel_name}/{hashtags}` só no bloco Caption Templates IG (L1552-1574) — oculto no YT; Descrição YT promete "Suporta templates {post_title}, {post_caption}..." (placeholder L1712) mas não tem chip; runtime RESOLVE em youtube_title/description (`resolveYtTpl` L452). | **P2 (W9)** |
| Categoria numérica cru vs dropdown | Input numérico (L1761-1771, `.replace(/[^0-9]/g,"")`); `YOUTUBE_CATEGORIES` L216-234 (default L236) em planner-config sem consumidores (0 imports). | **P2 (W7)** |
| Produtos CSV vs "Adicionar Produto Afiliado" | Não existe botão de adicionar; só input CSV + "Buscar" (L1717-1735) que renderiza JSON cru (`JSON.stringify(pr).slice(0,120)` L1741) — impossível escolher item → sem `{query,item}`. | **P1 (W5)** |
| `plannerMediaLabel` misto | Rótulo misto IG·YT (L36-60) mas mix bloqueado → rótulo morto para planners novos (só grandfathered) | P2 |

---

## 5. Editor (editar planner existente)

| Comportamento esperado | Verificação | Evidência | Status |
|---|---|---|---|
| Propagação descrição/título → posts pendentes | PATCH propaga `caption` + `youtube_options` via `propagatePlannerConfigToPendingPosts` quando `shouldPropagateConfig` (chaves L596-609 incluem `youtube_*` e `caption_*`) | `app/api/planners/[id]/route.ts` L205-229; `planner-runtime.ts` L596-609 (chaves), L654-760 (buildYoutubeOptionsForPropagation), L765-935 (propagate) | OK parcial — **BUG (W8)**: na propagação, `buildYoutubeOptionsForPropagation` NÃO usa `cfg["youtube_title"]` no titleCandidate (L673-680 ausente vs buildPostData L471-474) e **não serializa products** → editar título/produtos não reflete nos posts pendentes; products são perdidos nos updates |
| Cancelamento ao remover canal | PATCH cancela posts pending/scheduled/queued/draft/processing/ready_to_publish do channel_id removido (status cancelled + failed_reason channel_removed) | `planner/[id]/route.ts` L147-196 | OK |
| Reset de state ao mudar conteúdo | Wizard calcula `contentChanged` por identidade ordenada (L1013-1031) e manda `reset_state:true` (L1109); PATCH limpa `state:'{}'` (L126-128) | acima | OK |
| NÃO desmarcar itens em edição | Guard por open-key `loadedForRef` (L296-330) | L295-337 | OK |
| Heterogeneidade preservada | `originalItemSettings` + `settingsTouched=false` mantém settings por item (L937-1004) | L929-1004 | OK |

---

## 6. Dual caption (youtube.txt/instagram.txt) — estado real

| Camada | Estado | Evidência | Risco |
|---|---|---|---|
| Schema | Colunas `caption_youtube`/`caption_instagram` adicionadas | `prisma/migrations/0009_add_dual_captions/migration.sql`; `schema.prisma` L150-151 | — |
| Escrita (upload) | `POST /api/content-items` whitelist **não inclui** as colunas → qualquer envio é dropado silenciosamente | `app/api/content-items/route.ts` L13-16 `POST_ALLOWED_FIELDS` | captions duplas nunca gravam |
| Upload de pasta | `UploadContext.addFolderFiles` lê **apenas o 1º `.txt`** (`groupFiles.find(...)` L472-478) e joga o conteúdo inteiro em `caption` (L471-479; consumido em L496/512/539). Com `youtube.txt` + `instagram.txt` na mesma pasta, **um é perdido**; texto único vira `ContentItem.caption` (único) | `contexts/UploadContext.tsx` L468-548 | parse é `find` (ordem não determinística) |
| Biblioteca edição | `EditContentModal` só tem campo `caption` único (L66, L172-188, L416-428) | `components/EditContentModal.tsx` | sem UI de captions por plataforma |
| Runtime | `resolveCaptionTemplateVars` resolve `{post_caption}` SOMENTE de `ContentItem.caption` (planner-runtime L244-305) — plataforma-agnóstico; `applyCaptionTemplate`/`buildPostData` não recebem `platform` do canal | `planner-runtime.ts` L244-305, L328-387, L384-590 | `{post_caption}` não diferencia IG/YT |
| Wizard | Nenhum campo de caption por plataforma; caption única oculta no YT (W1) | `PlannerWizard.tsx` L1483-1516 | sobrepõe-se a W1 |
| Propagação | `CAPTION_PROPAGATION_KEYS` não contempla `caption_youtube/instagram` (não lidas) | `planner-runtime.ts` L596-609 | — |

**Riscos (plano):** (1) resolver `{post_caption}` por plataforma exige injetar `platform`/canal em `applyCaptionTemplate` (assinatura atual não tem — L328-387) e escolher `caption_youtube` (YT: mensagem da Comunidade + descrição default) vs `caption_instagram` (IG); (2) retrocompatibilidade: itens existentes só têm `caption` → fallback para coluna única; (3) prioridade de arquivo: `youtube.txt`/`instagram.txt` vs `caption.txt` genérico (hoje o genérico existe de fato); (4) `POST_ALLOWED_FIELDS` + o multipart de upload-chunk `complete` precisam aceitar as colunas (hoje manda `caption` único — `UploadContext.tsx` L842); (5) editor de biblioteca e preview precisam de UI dual; (6) como o planner é single-platform (isolamento), a necessidade real é por ITEM compartilhado entre planners IG e YT.

---

## 7. NOVA feature: produtos afiliados `{query, item?}` — estado real no app

| Peça do plano | Estado | Evidência |
|---|---|---|
| Helpers `normalizeYoutubeProductsList`/`serializeYoutubeProducts`/`YoutubeProductEntry` | **Código morto** (0 consumidores em app/lib/components) — branche 9ae5a54 | `lib/planner-config.ts` L134-210; grep global só em docs |
| Wizard: lista de `{query,item?}` + busca live | **Não existe**: input CSV cru + botão "Buscar" que chama `GET /api/youtube/products` e renderiza JSON cru; impossível selecionar item | `PlannerWizard.tsx` L1717-1758, L683-741 (`handleSearchYoutubeProducts`) |
| Auto-select por nome na publicação (`product_names`+`filters` no POST /api/shorts) | **Referência zero no app**: `POST /api/shorts/auto` e `/tag-products` existem na API externa mas não há chamada; `createShort` do app usa `POST /api/shorts` com campo `products` | `lib/youtube.ts` L378-424 (L403 `form.append("products", ...)`); shorts.py L376-515 (`auto_create_short`) |
| Formato enviado hoje | CSV de strings → `youtube_options.products = '["a","b"]'` → API `_parse_products` filtra não-dicts → **[] → 0 produtos taggeados SEM erro** | `planner-runtime.ts` L457-469; `publisher/route.ts` L1177-1193; shorts.py L75-87 |
| Comunidades SEM produtos | Runtime só injeta products no ramo short (L457-469 dentro de `ytTypeForPost==="short"` L429); API `post.py` sem tagging (grep products=0) — **OK no runtime**, mas UI mostra produtos em Comunidade (W3) | `planner-runtime.ts`; shorts.py L31-47 |

---

## 8. GAPS de UX (síntese)

1. **[P0] Deadlock YT-only**: campos de texto (Caption/Templates/Fallbacks) ocultos no planner YT, mas validação (Short L804-819, Comunidade L825-847) e publisher (L907) exigem texto → nova Comunidade YT e novo Short YT com upload direto **não podem ser salvos**, mesmo com o Título visível preenchido. O erro aponta 3 campos que não estão na tela e omite o único campo visível que resolve (Descrição — que nem é consumido pela Comunidade).
2. **[P1] O usuário não tem "GUI por forma"**: Media Type é um `<select>` com label que muda, mas o formulário (campos YT) não se adapta à forma escolhida. Shorts-only e Comunidade-only precisam de blocos distintos.
3. **[P1] Produtos não são selecionáveis**: busca→JSON cru, sem checkbox/select, sem `{query,item}`, sem "Adicionar Produto Afiliado"; e o videoId da busca é fabricado.
4. **[P1] Comunidade sem editor de texto visível** + sem indicação de limite de imagens (10) e sem aviso de "pastas com vídeo" (o aviso existe L1364-1376 mas só quando `isCarousel`).
5. **[P2] Idioma misto** e **campo de categoria cru**.
6. **[P2] Chips de variáveis incompletos**: existem só no bloco IG; Descrição/título YT aceitam templates (runtime resolve) mas não têm chips UI.
7. **[P1-P2] Propagação de edição incompleta**: título/products do config não chegam aos posts pendentes.
8. **[P1] Dual caption sem pipeline**: schema pronto, consumidores zero.

---

## 9. Especificação do novo Media Type selector por plataforma (proposta)

### 9.1 IG-only (como hoje, com polimento)
- Cards: **Reels** (`REELS`) · **Post/Imagem** (`IMAGE`) · **Carrossel** (`CAROUSEL`, exige pastas) · **Story** (`STORIES`).
- Abaixo do card: campos IG existentes (Caption/Templates/Fallbacks/Location/Collabs/Tags/Audio) — inalterados.

### 9.2 YT-only
- **Remover** o `<select>` (L1438-1458) e substituir por 2 cards **exclusivos**:
  - **Short do YouTube** (vídeo) — habilitado quando houver vídeo selecionado/upado (ou aviso "selecione um vídeo").
  - **Post na Comunidade** (texto + imagens 1..10) — em vez de depender de `isCarousel`, a seleção de múltiplas imagens vira o modo natural do card (folders/imagens múltiplas; limite 10 com contador; pasta com **só** vídeos → erro inline).
- **Sem Story** e **sem label "Carousel"** em planner YT (o carrossel de imagens É a Comunidade).
- **Forma → campos (GUI por forma)**:
  - Short: `Título*` (com guard incluindo `youtubeTitle` — fix W2), `Descrição` (com chips de variáveis), `Produtos Afiliados` (busca live + seleção → `{query,item?}`), `Privacidade`, `Categoria` (dropdown `YOUTUBE_CATEGORIES`), `Feito para crianças`, `Monetizar`, `Comentário fixado`.
  - Comunidade: **`Texto da publicação*`** — novo campo visível que grava `caption` (config-level, é o que o runtime/publisher lê em L907); **hide** Título/Produtos/Privacidade/Categoria/Monetizar/Comentário (nenhum é consumido na Comunidade); manter apenas booleans de privacidade se desejado no futuro (hoje: ocultar).
- `plannerMediaLabel` (L36-60): manter para preview, agora coerente porque a UI garante a forma.

### 9.3 Validação (alinhar wizard ↔ runtime)
- **Short:** `title = youtubeTitle || resolveCaptionTextForWizard(...) || titleFallback || library item name` — incluir `youtubeTitle` no guard (L804-819, fix W2). Não exigir caption oculta.
- **Comunidade:** exigir `caption` não-vazia **e** exibir o campo (fix W1). Manter publisher L907 como última barreira.
- **Produtos:** mostrar só no card Short; validar formato `{query,item?}` com `normalizeYoutubeProductsList` no save; rotear no publisher: strings→`POST /api/shorts/auto` (`product_names`), dicts com `item`→`POST /api/shorts` (`products`) (fix W4; alinhar com audit-track-api F2).
- **Categoria:** dropdown com `YOUTUBE_CATEGORIES` (fix W7) e faixa única 1..100 (ver F3 do audit-track-api).

---

## 10. Checklist final

- [x] Leitura integral do wizard (2109 linhas) e mapeamento de estados/chips/condicionais
- [x] Rastreio por forma (IG/YT × REELS/IMAGE/CAROUSEL/STORIES/SHORT/COMMUNITY) com arquivo:linha
- [x] Órfãos, faltantes, validação incorreta, inconsistências wizard↔runtime
- [x] Bugs "não postar" (título/mensagem/caption/produtos/templates/STORIES/carousel_folder/mix)
- [x] Bugs de confusão (campos, labels, media type, produtos em Comunidade)
- [x] Editor (propagação, cancelamento de canal, reset de state)
- [x] Dual caption + nova feature produtos
- [x] Nenhum código alterado (somente `docs/audit-track-wizard.md`)