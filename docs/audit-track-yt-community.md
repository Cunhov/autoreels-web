# Auditoria Track YT-COMMUNITY — Verificador YT Community (gauntlet loop)

- Branch: `feat/yt-products-dual-captions` @ `9ae5a54` (base `b3d5d56`)
- Escopo: forma de postagem YT **COMMUNITY** (texto + imagens), dual caption e produtos afiliados, com rastreio wizard → config → runtime → publisher → API externa.
- Régua: toda afirmação cita arquivo:linha do worktree atual ou do repo externo `youtube-community-api`.
- Nenhum código foi alterado (somente leitura + este doc).

---

## 1. Mapa do fluxo YT-Community (evidência do percurso completo)

```
PlannerWizard.tsx
├─ mediaType IMAGE/CAROUSEL → rótulo "Post na Comunidade" (onlyYoutubeSelected)   [PlannerWizard.tsx:57, 1454-1460]
├─ salva config { content[], caption_templates, caption_rotation, youtube_* }     [PlannerWizard.tsx:902-1079]
│   └─ ytFields: youtube_title/description/products/privacy/made_for_kids/...      [PlannerWizard.tsx:1049-1072]
└─ validação "Post na Comunidade exige texto" no submit                           [PlannerWizard.tsx:825-844]

Planner.config (JSON)  →  lib/planner-config.ts (parse/validate)                  [planner-config.ts:38-56, 253-467]

lib/planner-runtime.ts
├─ resolvePlannerRuntime: mediaType derivado (video→REELS, image→IMAGE, folder→CAROUSEL)  [planner-runtime.ts:973-1058]
├─ resolveCaptionTemplateVars: {post_caption} ← ContentItem.caption (select title/caption/tags) [planner-runtime.ts:244-326, 261]
├─ applyCaptionTemplate: templates/rotacao → caption final                         [planner-runtime.ts:328-381]
└─ buildPostData:
    ├─ ytTypeForPost = isYt && (IMAGE|CAROUSEL) ? "community" : isYt ? "short"     [planner-runtime.ts:414-418]
    ├─ youtube_options SOMENTE p/ short (community → null)                         [planner-runtime.ts:428]
    └─ Post { youtube_type: "community", image_url/children_urls, caption }        [planner-runtime.ts:560-590]

app/api/cron/publisher/route.ts
├─ sessionId = getYoutubeSessionId(channel.settings)                              [publisher/route.ts:879]
├─ isCommunityPost = youtube_type==="community" || fallback legado                 [publisher/route.ts:900-905]
├─ message = post.caption (vazio → MalformedDataError)                            [publisher/route.ts:906-907]
├─ imagens: coleta children, trunca 10, materializa, adapta 1:1 blur, upload       [publisher/route.ts:908-1137]
├─ sem imagens → createCommunityPostText (POST /api/post JSON)                     [publisher/route.ts:949]
└─ com imagens → uploadCommunityPost (POST /api/post/upload multipart)             [publisher/route.ts:1115]

lib/youtube.ts
├─ createCommunityPostText: message.trim() obrigatório (400 definitivo)            [youtube.ts:339-363]
├─ uploadCommunityPost: 1..10 imagens; FormData session_id+message+images[]       [youtube.ts:299-330]
└─ getYoutubeSessionId: sessionId de Channel.settings JSON                         [youtube.ts:162-171]

API externa youtube-community-api
├─ POST /api/post (JSON): message min_length=1, image_urls ≤10                    [models/session.py:113,116-117]
├─ POST /api/post/upload: session_id+message+images 1..10 (message NÃO validado)  [post.py:262-282]
└─ post.py NÃO tem tagging (grep tag/product/attach → só delete_post)             [post.py:47]
```

---

## 2. Tabela forma-de-posta → evidência → status → severidade

| # | Forma | Evidência | Status | Sev. | Recomendação |
|---|-------|-----------|--------|------|--------------|
| F1 | Community texto (wizard YT) | Mensagem = `post.caption` no publisher [publisher/route.ts:906]; caption só vem da cadeia caption/templates [planner-runtime.ts:328-381]; no wizard YT os campos Caption/Templates/Fallback estão **ocultos** (`{!onlyYoutubeSelected && …}`, [PlannerWizard.tsx:1483,1516,1584]) e o único texto visível é "Título do Short"/"Descrição" [PlannerWizard.tsx:1699,1708] (consumidos apenas em `ytTypeForPost==="short"` [planner-runtime.ts:429]) | **BUG** | **P0** | Adicionar campo "Texto da Comunidade" no box Configurações YouTube (ver §9) |
| F2 | Community texto (validação wizard) | Validação exige texto resolvido não-vazio [PlannerWizard.tsx:825-844], mas o usuário não tem input p/ fornecer → **dead-end** em planner novo/edição | **BUG** | **P0** | Mesma correção de F1; texto da comunidade deve entrar na cadeia `applyCaptionTemplate` |
| F3 | Community texto (runtime) | `if (!message) throw MalformedDataError("Post na Comunidade exige texto")` [publisher/route.ts:907] + `createCommunityPostText` valida trim [youtube.ts:346] + POST /api/posts valida caption [posts/route.ts:267] + wizard [PlannerWizard.tsx:842] | **OK** | — | Manter (já é guardião em 4 camadas) |
| F4 | Community >10 imagens | Trunca p/ 10 com warning [publisher/route.ts:921-926]; `uploadCommunityPost` 400 se >10 [youtube.ts:302-311]; POST /api/posts 400 [posts/route.ts:302] | **OK** | — | Manter |
| F5 | Community imagens que falham adaptação | `adaptImageToSquareWithBlur` best-effort, mantém original c/ warning [publisher/route.ts:1049-1120]; falha total materialização → definitivo se todas as falhas for definitivas [publisher/route.ts:1001-1016] | **OK** | — | Manter |
| F6 | Community sessionId ausente | `getYoutubeSessionId` vazio → failed "sem sessão vinculada" [publisher/route.ts:879-896]; health `missing_session` [planner-runtime.ts:170-174] | **OK** | — | Manter |
| F7 | Community só-texto via JSON | `createCommunityPostText` quando 0 imagens [publisher/route.ts:944-950]; `uploadCommunityPost` exige ≥1 imagem [youtube.ts:302-309] | **OK** | — | Manter |
| F8 | Community carousel_folder vazio / só-vídeos | `resolvePlannerRuntime` erro "Carousel item has no children" [planner-runtime.ts:1081-1083]; all-videos → 400 no POST posts [posts/route.ts:291-296] e publisher [publisher/route.ts:932-941] | **OK** | — | Manter |
| F9 | Community produtos | post.py sem tagging [post.py:47]; comunidade nunca envia products [publisher/route.ts:949,1115]; **mas** a UI exibe "Produtos Afiliados (CSV)" sempre, inclusive IMAGE/CAROUSEL [PlannerWizard.tsx:1717-1748] | **GAP (confusão)** | **P1** | Ocultar bloco Produtos quando mediaType é IMAGE/CAROUSEL (comunidade não taggeia); ver §8 |
| F10 | Short título vazio | Cadeia de fallbacks no buildPostData (title → title_fallback → caption → nome de arquivo) [planner-runtime.ts:470-479]; título vazio → 400 no POST posts [posts/route.ts:241-247]; wizard bloqueia [PlannerWizard.tsx:791-821]; publisher `if (!title) throw` [publisher/route.ts:1185-1187] | **OK** | — | Manter |
| F11 | Short com STORIES (legado) | Wizard normaliza STORIES→REELS no save [PlannerWizard.tsx:931-992]; runtime NÃO normaliza STORIES → `ytTypeForPost="short"` [planner-runtime.ts:414-418] c/ `image_url` em vez de `video_url` → publisher `if (!post.video_url) throw "Short exige um vídeo"` [publisher/route.ts:1146-1148] | **GAP (runtime)** | **P1** | Adicionar normalização STORIES→REELS no `resolvePlannerRuntime` (não só no wizard) |
| F12 | Mix YT+IG | `validatePlannerChannelMix` 400 nos routes POST/PATCH/duplicate [planners/route.ts:147-149; planners/[id]/route.ts:65-69; duplicate/route.ts:56-60]; wizard bloqueia submit [PlannerWizard.tsx:1086-1092]; run/página mantêm warning grandfathered [run/route.ts:62,102] | **OK** | — | Manter |
| F13 | Templates resolvendo vazio | Guardas wizard (short/community) usam valor resolvido [PlannerWizard.tsx:791-844]; `substituteCaptionTemplate` zera chaves desconhecidas [planner-runtime.ts:330-334] | **OK** | — | Manter |
| F14 | Dual caption (plano) | Schema tem columns [schema.prisma:150-151]; `resolveCaptionTemplateVars` NÃO seleciona caption_youtube/instagram [planner-runtime.ts:261]; nenhum consumidor de youtube.txt/instagram.txt no upload | **GAP** | P1 (feature pendente) | Implementar §7 |
| F15 | Produtos {query,item?} (plano) | Helpers novos mortos: `normalizeYoutubeProductsList`/`serializeYoutubeProducts` sem chamadas; wizard salva só CSV [PlannerWizard.tsx:1057]; buildPostData transforma CSV em array de strings [planner-runtime.ts:456-467]; API externa `_parse_products` filtra apenas dicts [shorts.py:75-88] → strings são **descartadas silenciosamente** | **BUG** | **P0** | Implementar §8 (product_names+filters em /api/shorts/auto, ou products=[{item}] verbatim) |

---

## 3. Achados P0 (quebra de publicação)

### P0-1 — Wizard YT esconde o único campo que alimenta a mensagem da Comunidade (GAP crítico)

O publisher usa `post.caption` como `message` ([publisher/route.ts:906]). `caption` é montado apenas pela cadeia critério/templates do planner ([planner-runtime.ts:328-381]). No wizard, quando `onlyYoutubeSelected === true`:

- **Caption** — `{!onlyYoutubeSelected && (<div>… Caption …)}` [PlannerWizard.tsx:1483-1514]
- **Caption Templates** — `{!onlyYoutubeSelected && (…)}` [PlannerWizard.tsx:1516]
- **Fallback Title/Caption** — `{!onlyYoutubeSelected && (…)}` [PlannerWizard.tsx:1584]

E o único bloco visível é "Configurações YouTube" [PlannerWizard.tsx:1684-1790] com **Título (label "Título do Short")** e **Descrição** — campos que só o `short` consome (`ytTypeForPost === "short"` [planner-runtime.ts:429]; `youtube_options` é `null` para community [planner-runtime.ts:428]). Consequências:

1. **Planner novo**: mediaType IMAGE → validação [PlannerWizard.tsx:825-844] exige texto resolvido não-vazio → `caption=""`, `captionFallback=""`, templates vazios → erro `"Posts na Comunidade do YouTube exigem um texto — informe uma legenda com texto literal, a Legenda reserva…"` [PlannerWizard.tsx:842], mensagem que referencia campos **ocultos** na tela. Não há como salvar.
2. **Edição**: caption é carregado do 1º item ([PlannerWizard.tsx:461]) mas não é editável (input oculto) → texto da comunidade congelado em `config.content[].caption`.
3. **Regressão intencional**: commit `b3d5d56` "isola planner YouTube (esconde Caption/Templates/Fallback do Instagram)" removeu os campos IG mas **não adicionou** o campo YT equivalente.

Workaround real: digitar a caption estando em modo não-YT (sem canal selecionado) e só então selecionar canal YT (o state persiste; `toggleChannel` não limpa caption). Não é um fluxo aceitável.

### P0-2 — Produtos afiliados: pipeline atual é no-op silencioso

- Wizard salva `youtube_products` como **CSV de strings** [PlannerWizard.tsx:1057] (resultado da busca só é exibido em JSON truncado [PlannerWizard.tsx:1736-1743], `item` nunca é persistido).
- `buildPostData` converte CSV → `JSON.stringify(csv.split(","))` → array de **strings** em `youtube_options.products` [planner-runtime.ts:456-467].
- Publisher repassa `productsStr` para `createShort` [publisher/route.ts:1175-1178, 1210-1227] → campo form `products` [youtube.ts:427].
- API externa `_parse_products` → `[item for item in value if isinstance(item, dict)]` [shorts.py:75-88]: strings são **filtradas** → `products=[]` → `run_short_upload` sem taggeamento.

Ou seja: o usuário digita 10 IDS no planner, o Short publica e **nenhum produto é taggeado**, sem aviso. Para a nova feature ({query,item?} + auto-select por nome) nada está ligado: `normalizeYoutubeProductsList` [planner-config.ts:150] e `serializeYoutubeProducts` [planner-config.ts:199] não têm nenhum chamador.

### P0-3 — Busca de produtos com videoId derivado/falso

- API externa `GET /api/session/{id}/products` exige `video_id` obrigatório ([shorts.py:192]) e usa-o como `externalVideoId` no innertube ([studio.py:998-1001]) — não funciona com ID aleatório.
- O app exige `videoId` na rota proxy [youtube/products/route.ts:15-19] e o wizard o deriva de `youtubeTitle` ou do id do content item selecionado [PlannerWizard.tsx:695-706] — **não do vídeo real**. Para Community, nem disso dispõe (sem vídeo). Busca com videoId falso tende a falhar/retornar vazio no innertube real, com erro não-diagnóstico.

---

## 4. Achados P1 (confusão UX / robustez)

### P1-1 — Campos órfãos na UI para Community
Com `onlyYoutubeSelected`, o box "Configurações YouTube" [PlannerWizard.tsx:1684-1790] exibe **sempre** (independente do mediaType): Título, Descrição, Produtos, Privacidade, Categoria ID, Feito p/ crianças, Monetizar, Comentário fixado. Para IMAGE/CAROUSEL (Community), nada disso é consumido: `youtube_options` só existe para short [planner-runtime.ts:428] e posts de comunidade não taggeiam [publisher/route.ts:949,1115]. → Órfãos visíveis; privacidade/categoria/monetize/pinned são conceitos de vídeo, não de community.

### P1-2 — Validação `validatePlannerConfig` não cobre o novo formato {query,item}
`youtube_products` array de objetos passa pela validação mas é achatado via `.join(",")` → `[object Object],[object Object]` [planner-config.ts:440-486] — sem shape-check do `item`/`query`.

### P1-3 — Labels ambíguos
- Select de Media Type mostra `"Carousel"` sem plataforma em YT-only [PlannerWizard.tsx:1458] enquanto IMAGE vira "Post na Comunidade" e REELS vira "Short do YouTube" — rótulo inconsistente.
- Mensagem de erro da community cita "Legenda reserva (via {post_caption})" — campo inexistente na tela YT [PlannerWizard.tsx:842].

### P1-4 — "media type não muda inputs"
Trocar REELS→IMAGE→CAROUSEL não altera o conjunto de campos YT mostrados [PlannerWizard.tsx:1460-1790]: o usuário não vê que Título/Produtos/Privacidade não se aplicam à Comunidade.

---

## 5. Editor: propagação / cancelamento / reset (verificado OK)

- **Propagação de descrição/título para posts pending/scheduled/queued**: `propagatePlannerConfigToPendingPosts` re-resolve caption via `applyCaptionTemplate` e atualiza `caption` (+ `youtube_options` só p/ short; community não mexe) [planner-runtime.ts:854-895]; gate `shouldPropagateConfig` compara `CAPTION_PROPAGATION_KEYS` [planner-runtime.ts:595-651]; rotas chamam no PATCH [planners/[id]/route.ts:205-224].
- **Cancelamento ao remover canal**: posts pending/scheduled/queued/draft/… do channel removido → `cancelled` com `failed_reason: "channel_removed"` [planners/[id]/route.ts:137-184].
- **Reset de state ao mudar conteúdo**: `reset_state: contentChanged` (identidade ordenada multiset) [PlannerWizard.tsx:1021-1043, 1088-1093] → server zera `state: "{}"`, nunca aceita state do client [planners/[id]/route.ts:128-131].

---

## 6. Dual caption — especificação e pontos de mudança

### Estado atual
- Schema: `content_items.caption_youtube`, `caption_instagram` (migration 0009, comentário "youtube.txt na pasta") [schema.prisma:150-151]; migração em `prisma/migrations/0009_add_dual_captions/migration.sql`.
- **Nada consome**: `resolveCaptionTemplateVars` seleciona só `{title, caption, tags}` [planner-runtime.ts:261]; `ContentLibrary`/`EditContentModal`/upload não lêem `.txt`; wizard não expõe os campos.

### Fluxo proposto (cap-by-platform)
1. **Ingestão**: ao importar pasta/carrossel na biblioteca, `youtube.txt`/`instagram.txt` → `caption_youtube`/`caption_instagram` do ContentItem (upload path — hoje inexistente; pasta vazia de `.txt` → mantenha `caption` legado).
2. **Resolução**: `buildPostData` conhece `opts.channel.platform` — passar `platform` para `applyCaptionTemplate` → `resolveCaptionTemplateVars`:
   - `const itemCaption = platform==="youtube" ? (libItem.caption_youtube ?? libItem.caption) : platform==="instagram" ? (libItem.caption_instagram ?? libItem.caption) : libItem.caption;`
   - fallback para `caption` genérica quando a específica for NULL (migration deixa NULL em linhas pré-existentes).
   - `PlannerContentItem` ganha `caption_youtube?/caption_instagram?` para entradas diretas.
3. **{post_caption}** resolve `itemCaption` por plataforma; `{post_title}`/`{date}`/`{hashtags}` inalterados.
4. **Propagação** (`propagatePlannerConfigToPendingPosts`) e **preview** precisam do mesmo `platform` — hoje o propagated usa `channelName` apenas [planner-runtime.ts:861-874].
5. **Publicação**: nenhuma mudança — `post.caption` continua sendo o texto final por plataforma.

### Hierarquia texto manual × caption do item (decisão de design)
Proposta (mantém o feedback-loop guard atual):
1. Wizard texto manual (base caption do entry / templates com rotação) — **vence**;
2. `{post_caption}` (se o template referenciar) → caption específica da plataforma → fallback caption genérica;
3. caption genérica do item quando não há texto manual e não há template.

### Riscos
- **Dual captions granulares quebram o content identity/reset_state**: editar só o youtube.txt de um item não muda `config.content[]` → `contentChanged=false` → estado de publicação NÃO resetado (posts futuros usam caption nova sobre conteúdo já publicado — esperado, mas documentar).
- **Drift entry-caption × DB**: o wizard grava caption snapshot do template no entry; a caption específica vive no DB. A resolução `{post_caption}` já lê do DB (guard [planner-runtime.ts:237-243]) — manter essa direção.
- **Wizard estimate** `resolveCaptionTextForWizard` [PlannerWizard.tsx:95-137] não conhece captions específicas → pode subestimar (bloquear save) ou superestimar (deixar passar vazio). Precisa consultar a biblioteca (como `selectedLibraryItemsHaveTitles`) para `{post_caption}`.
- **Comunidade exige texto**: se o texto manual vira vazio e `{post_caption}` resolve da caption do item, a validação do wizard deve resolver a caption específica da plataforma do item selecionado, senão o dead-end do P0-1 se repete com a nova feature.

---

## 7. Produtos (NOVA feature) — status recomendado

- **Comunidades SEM produtos**: confirmado — `post.py` não tem nenhum endpoint/param de tagging [post.py:12,47]; publisher não envia products na community [publisher/route.ts:949,1115]. Manter assim; ocultar UI (P1-1/F9).
- **Short com products**: migrar para `POST /api/shorts/auto` (`product_names` JSON array ou CSV + `filters` JSON) [shorts.py:388-431] porque faz auto-select **após** o upload (video_id real) e tagging_error não invalida o upload [shorts.py:455-465]; ou manter `POST /api/shorts` com `products` = array de `{item}` verbatim (vindo de `GET /api/session/{id}/products`), NUNCA array de strings ([shorts.py:75-88] descarta strings).
- **Ciclo fechado**: wizard busca em `GET /api/session/{id}/products?query=&video_id=` (exige video_id REAL — para planner, usar o video_id do último upload ou prompt pedindo vídeo publicado) → salva `[{query, item?}]` via `normalizeYoutubeProductsList/serializeYoutubeProducts` (hoje mortos [planner-config.ts:150,199]) → buildPostData emite `product_names`/`filters` ou `[{item}]` → publisher chama `createShortAuto`.
- **Legacy CSV** deve continuar aceito (normalização já prevista: cada entrada → `{query}` [planner-config.ts:170-175]).

---

## 8. Proposta do campo "texto da comunidade" (F1/F2 — correção do P0-1)

| Decisão | Valor proposto |
|---|---|
| Nome do campo (config) | `youtube_content_text` (string, template-resolvida como as demais) — ou, mais simples, **reutilizar a cadeia de caption atual** expondo "Texto da Comunidade" no wizard escrevendo em `config.content[].caption` (mesmo campo que hoje `globalSettings.caption` grava [PlannerWizard.tsx:902-917]). Recomendo esta 2ª via: zero mudança de schema/runtime. |
| Label na UI | "Texto da Comunidade" (textarea) dentro do box "Configurações YouTube", renderizado **somente** quando `onlyYoutubeSelected && (mediaType === "IMAGE" || isCarousel)` |
| Placeholder | "Escreva o texto que aparecerá no post da Comunidade… Suporta {post_title}, {post_caption}, {date}" |
| Validação wizard (espelho [PlannerWizard.tsx:825-844]) | texto resolvido não-vazio obrigatório p/ IMAGE/CAROUSEL em YT; consultar caption específica do item se for via `{post_caption}` |
| Validação servidor | espelhar em `validatePlannerConfig` [planner-config.ts](novo bloco `youtube_content_text`) e no publisher [publisher/route.ts:907] (já existe) |
| Limite | YouTube Community até 4000 chars (sem slice hoje; `EditContentModal` já limita caption a 2200 [content-items/route.ts:198-203] — avaliar slice de segurança no publisher) |
| Rótulos por plataforma | tornear select [PlannerWizard.tsx:1454-1469]: `CAROUSEL` em YT-only → "Carrossel · Post na Comunidade" |

---

## 9. Priorização resumida

| Pri | Achado | Sev | Esforço |
|-----|--------|-----|---------|
| 1 | **P0-1** campo texto da Comunidade ausente no wizard YT (bloqueia criação/edição de community planners) | P0 | M |
| 2 | **P0-2** produtos {query,item?} mortos + CSV→strings descartadas pela API (feature nunca taggeia) | P0 | M-L |
| 3 | **P0-3** busca com videoId falso (API exige videoId real) | P0/P1 | S |
| 4 | **F14** dual caption: ligar schema → runtime → ingestão .txt | P1 | L |
| 5 | **P1-1/F9** esconder Título/Produtos/Privacidade/etc em Community (órfãos na UI) | P1 | S |
| 6 | **F11** normalizar STORIES→REELS no runtime (não só no wizard) | P1 | S |
| 7 | P1-3/P1-4 labels e "media type não muda inputs" | P2 | S |

**Veredito do track**: o caminho de publicação Community (runtime → publisher → API) está **sólido** (validações em 4 camadas: wizard, POST api, publisher, lib/youtube). O **buraco está na entrada de dados**: o isolamento do commit `b3d5d56` removeu o único input de texto sem criar substituto, tornando o planejamento de postagens na Comunidade inutilizável pela UI (P0). As features novas do checkpoint (dual caption, produtos {query,item?}) estão **schema/helpers-only** — nenhum consumidor de runtime/UI/publisher ainda.