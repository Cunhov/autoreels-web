# Auditoria — Track YT-SHORT (gauntlet loop · Fase 1 · Agente 2)

- **Branch:** `feat/yt-products-dual-captions` (checkpoint `9ae5a54`; base `b3d5d56` → `git log -1 9ae5a54` commit "wip(planner): schema captions duplas + migration 0009 + helpers de produtos/categorias YT")
- **Escopo:** fluxo completo SHORT/COMMUNITY (YouTube) — PlannerWizard → `lib/planner-config.ts` → `lib/planner-runtime.ts` (`buildPostData`/`applyCaptionTemplate`/`propagatePlannerConfigToPendingPosts`) → `app/api/cron/publisher/route.ts` → `lib/youtube.ts` → API externa `/Users/bestoptionnotebook/Projects/youtube-community-api` (`app/api/shorts.py`, `app/services/{studio,product_selector,shorts_service}.py`).
- **Método:** rastreamento wizard→config→runtime→publisher→API com evidência `arquivo:linha`. Nenhum código editado (somente leitura + este doc).
- **Critério de severidade:** P0 = quebra/mentira na publicação (inclui tagagem de produtos silenciosamente descartada) · P1 = confusão/estado inconsistente · P2 = polish.

---

## 1. Fluxo rastreado (cadeia de evidência)

### SHORT (vídeo)

| Etapa | Onde | Evidência |
|---|---|---|
| Wizard grava `youtube_title/description/privacy/made_for_kids/monetize/category/pinned/products` | `components/PlannerWizard.tsx` | `:1054-1070` `ytFields` (somente `onlyYoutubeSelected`); produtos: `:1055` `youtubeProducts.split(",").map(trim).filter(Boolean).join(",")` |
| Validação do config | `lib/planner-config.ts` | `:440-483` `youtube_products` (CSV/array), `:447-454` título 1..100, `:456-463` descrição ≤5000, `:509-523` `youtube_category_id` 1..100, `:493-509` privacy/booleans |
| Runtime monta `youtube_options` | `lib/planner-runtime.ts` | `buildPostData` `:384-564`; `ytTypeForPost` `:411-418`; título fallback `:471-480`; `products` CSV→JSON `:456-470`; `ytObj.products` `:551` |
| Publisher (bloco Short) | `app/api/cron/publisher/route.ts` | `:1144-1231`; título `(options.title || post.caption).slice(0,100)` `:1168-1174`; products `:1176-1195`; `createShort` `:1196-1217` |
| Cliente HTTP | `lib/youtube.ts` | `createShort` `:360-396` (campos FormData; `products` `:374`, SEM `product_names`/`filters`) |
| API externa | `app/api/shorts.py` | `create_short` `:277-332` (`products` Form JSON `:299`; NÃO aceita `product_names`/`filters`); `_parse_products` `:71-78` (filtra não-dict!) |
| Tagagem no upload | `app/services/studio.py` | `upload_short` `:1344` (products aplicados `:1408-1412` via `build_products_selection` `:447-515`) |

### COMMUNITY (texto+imagens)

| Etapa | Onde | Evidência |
|---|---|---|
| Runtime classifica | `lib/planner-runtime.ts` | `:411-418` IMAGE/CAROUSEL em canal YT → `"community"` |
| Publisher (bloco Comunidade) | `app/api/cron/publisher/route.ts` | `:901-908` `message = (post.caption||"").trim()`; vazio → `MalformedDataError("Post na Comunidade exige texto")`; materializa imagens `:960-1052`; `createCommunityPostText`/`uploadCommunityPost` |
| Cliente HTTP | `lib/youtube.ts` | `createCommunityPostText` `:301-323` (`message.trim()` obrigatório), `uploadCommunityPost` `:265-297` (1..10 imagens) |
| API externa | `app/api/post.py` | POST `/api/post` / `/api/post/upload` (sem tagging — conferido: `post.py` não tem `products`) |

---

## 2. Tabela — forma de posta → evidência → status → severidade → recomendação

| # | Forma / item | Evidência | Status | Sev. | Recomendação |
|---|---|---|---|---|---|
| 1 | **Editar planner descarta produtos de posts pendentes** | `propagatePlannerConfigToPendingPosts` reescreve `youtube_options` via `buildYoutubeOptionsForPropagation` (`planner-runtime.ts:654-763`) que NUNCA inclui `products`; `buildPostData` inclui (`:551`). `shouldPropagateConfig` inclui `youtube_products` (`:609`), então editar produtos DISPARA a propagação que os apaga | **BUG** | **P0** | `buildYoutubeOptionsForPropagation` deve espelhar 100% o `ytObj` do `buildPostData` (incluir `products`). Teste: editar `youtube_products` → post pending mantém produtos |
| 2 | **Produto `{query}` SEM `item` quebra o upload inteiro (502) e deixa draft órfão** | risco da feature planejada: `studio.py:build_products_selection` `:477-486` lança `StudioUploadError` se o dict não tem `merchant_id`+`raw_merchant_offer_id` nem `{"item": dict}`; `upload_short` `:1408-1412` aplica products DENTRO do fluxo (após `wait_for_processing`, antes do publish `:1422`) → erro derruba o vídeo já enviado | **BUG** (latente da NOVA feature) | **P0** | Nunca enviar produtos sem `item` para `/api/shorts`; validar na UI e no runtime (produto sem `item` só é válido no caminho `/auto` com `product_names`) |
| 3 | **`product_names`+`filters` NÃO existem em `POST /api/shorts`** | `shorts.py: create_short` `:277-332` só tem `products`; `product_names`/`filters` existem em `POST /api/shorts/auto` `:375-…` (`:388-392`) e `/tag-products` `:521`. FastAPI ignora form fields não declarados → tagagem silenciosa | **BUG** (spec da feature descolada da API real) | **P0** | Rotear nome-based para `/api/shorts/auto` (upload+select pós-publicação); verbatim-item para `/api/shorts` com `products` |
| 4 | **videoId da busca é FALSO** | `PlannerWizard:696-707` usa `youtubeTitle.slice(0,50)` ou `selectedContentIds[0]` como videoId; API exige video `externalVideoId` do próprio canal (`studio.py search_products` `:980-1021`, `shorts.py list_products` `:185` `video_id: str = Query(...)`) | **BUG** | **P0** | Busca no wizard deve resolver videoId real (sacrifice_video_id → último short publicado → erro claro). Ver seção 5 |
| 5 | **CSV/array de IDs é descartado SILENCIOSAMENTE na API** | pipeline atual: wizard CSV `:1055` → `buildPostData` `JSON.stringify(arr)` (`:461`) → publisher re-serializa (`route.ts:1176-1195`) → `_parse_products` filtra `isinstance(item, dict)` (`shorts.py:71-78`) → `[]`; nenhum erro, nenhuma tag | **BUG** | **P1** | Feature produtos só funciona com blocos `{"item":…}`; remover formato CSV string (ou converter itemIds→`{item}` via busca) |
| 6 | **Obj format novo vira `"[object Object]"`** | `buildPostData:462-464` `Array.isArray(rawProductsCsv) → String(v)`; wizard `:507`/`:1055` faz `join(",")` de objetos; `validatePlannerConfig:455-457` idem → helpers novos `normalizeYoutubeProductsList`/`serializeYoutubeProducts` (`planner-config.ts:158-211`) são **código morto** (nenhum caller) | **BUG** | **P1** | Um único caminho canônico `youtube_products: Array<{query, item?}>` do wizard ao runtime; remover CSV |
| 7 | **Título vazio em Short — cadeia de fallbacks OK, mas 1 aresta** | `route.ts:1168-1174` lança `MalformedDataError("Short… exige título")`; `buildPostData:471-480` fallbacks título→title_fallback→caption→**nome do arquivo** cobrem itens de biblioteca; aresta: item deletado/legado SEM nome nem caption → `youtubeOptions=null` → falha permanente (sem retry) | OK (com aresta) | P2 | Manter cadeia; em `resolvePlannerRuntime`, se item não existe e título vazio, falhar cedo com mensagem clara em vez de post morto |
| 8 | **Mensagem vazia em Community → falha PERMANENTE, sem fallback** | `route.ts:906-908` `MalformedDataError`; Short tem fallback até nome de arquivo, Community NÃO. Wizard bloqueia na origem (`PlannerWizard:824-845`) mas posts legados/API podem entrar | **BUG** | **P1** | Adicionar cadeia de fallback de texto p/ Community (título do item → title_fallback → caption) OU tornar vazio um erro claro no create em vez de `MalformedDataError` genérico |
| 9 | **STORIES (imagem) em canal YT → falha permanente** | `buildPostData:411-418` STORIES → `"short"`; STORIES não-mp4 → `image_url` set, `video_url=null` (`:540-550`) → `route.ts:1166` "Short do YouTube exige um vídeo" definitivo. Wizard esconde STORIES p/ YT (`PlannerWizard:1458`) mas configs legados/API podem conter | **BUG** | P1 | STORIES em YT: ou mapear p/ COMMUNITY (se imagem) ou rejeitar no runtime com erro claro |
| 10 | **`made_for_kids=true` + products = conflito do YouTube** (kids desabilita shopping) | UI permite ambos (`PlannerWizard` checkboxes `:1773-1777`), sem guard | GAP | P2 | Guard no wizard: made_for_kids ativa → aviso/desabilita produtos + monetize |
| 11 | **Propagação não resolve templates na descrição** | `buildPostData:453` `resolveYtTpl(...)` aplica `{vars}`; `buildYoutubeOptionsForPropagation:743` usa `String(cfg…youtube_description)` CRU → post pendente recebe `{post_caption}` literal | **BUG** | P2 | Reusar o MESMO resolvedor nas duas funções (extrair helper compartilhado) |
| 12 | **Produto com vírgula no nome quebra o CSV** | wizard `:1055` split(" ,"), runtime `:460`, API `_parse_product_names` `:90-110` (CSV) | GAP | P2 | Novo formato `{query, item?}` (array JSON): vírgula e `{var}` deixam de ser problema |
| 13 | **`{var}` em products resolve vazio** | `resolveYtTpl` (`planner-runtime:453`) roda em csv de products; var desconhecida → `""` (`substituteCaptionTemplate:320-326`) → produto some | GAP | P2 | Não aplicar template em products; products são dados, não captions |
| 14 | **Privacidade/categoria/booleans — fluxo íntegro** | wizard `:1058-1068` → config `:493-523` → runtime `:480-554` → publisher `:1200-1206` → `shorts.py` `:285-300` (valida privacy, título; `_coerce_positive_int` categoria) | OK | — | — |
| 15 | **Remover canal cancela posts órfãos + reset state** | `app/api/planners/[id]/route.ts:137-191` cancela posts pending/scheduled/queued do canal removido; `reset_state` `:126-128`; wizard `hasMixSelected` bloqueia mix (`:297-307`); server `validatePlannerChannelMix` (`planner-config:314-340`) | OK | — | — |
| 16 | **`caption_youtube`/`caption_instagram` — ORFÃS (sem leitura/escrita)** | existem só em `prisma/schema.prisma:150-151` + migration `0009_add_dual_captions`; grep de `youtube.txt`/`instagram.txt`/`caption_youtube`/`caption_instagram` em components/app/lib/data = ZERO hits. Runtime lê somente `ContentItem.caption` (`planner-runtime:401-420`, `resolveCaptionTemplateVars:244-318` lê `libItem.caption`) | **BUG/GAP** | **P1** | Migração 0009 sem wiring = promessa de dual caption não entregue. Ou implementar parser youtube.txt/instagram.txt + leitura por plataforma em `resolveCaptionTemplateVars`, ou remover colunas (schema drift) |

---

## 3. Bugs de "não postar" (checklist P0)

| Cenário | Verdicto | Evidência |
|---|---|---|
| Título vazio em Short | Mitigado por cadeia de fallbacks; aresta rara (item deletado sem título) | `planner-runtime:471-480`, `route.ts:1168-1174` |
| Mensagem vazia em Community | **Falha permanente sem fallback** | `route.ts:906-908` |
| Caption vazia em IG | Fora deste track (reportado em tracks IG) | — |
| Products sem videoId | **Busca hoje usa videoId falso**; publicação não depende de videoId (usa `products`); `/auto` resolve pós-upload | `PlannerWizard:696-707`; `shorts.py:375-…` |
| Templates resolvendo vazio | Resolve "" por design (`substituteCaptionTemplate:320-326`); Short coberto, Community não | idem #8 |
| STORIES em canal YT | Falha permanente p/ STORIES imagem | `planner-runtime:411-418`, `route.ts:1166` |
| `carousel_folder` vazio | OK — erro de resolução `"Carousel item has no children"` (`planner-runtime:1122-1124`) | `:1122-1127` |
| Mix YT+IG | Bloqueado em client (`PlannerWizard:297-307,1090-1094`) e server (`planner-config:314-340`, `planners/[id]/route.ts:87-92`) | OK |

## 4. Bugs de confusão (checklist P1/P2)

- Campos IG em planner YT: escondidos via `onlyYoutubeSelected` (`PlannerWizard:1483-1664` use de `!onlyYoutubeSelected`); label "Short do YouTube"/"Post na Comunidade" (`:1451-1454`); STORIES hidden (`:1458`) → **OK na UI nova**, gap em configs legados (#9).
- Produtos na aba Comunidade (NÃO devem existir): hoje `youtube_products` é global do planner e `buildPostData` só injeta em Short (`:551`); Comunidade ignora produtos → **OK hoje**; a NOVA feature deve manter isso (comunidades SEM produtos — botão "+ Adicionar Produto Afiliado" só no modo Short).
- Media type que não muda inputs: dropdown `:1440-1458`; para YT-only as opções IG saem; captions YT usam `youtubeTitle`/`youtubeDescription` próprios — ver #11 (template), #16 (dual caption).

---

## 5. NOVA FEATURE — produtos afiliados: validação contra a API real

### 5.1 Como `create_short` combina `products` e `product_names`? → **NÃO combina**
`create_short` (`shorts.py:277-332`) aceita APENAS `products` (Form JSON array). `product_names`+`filters` existem somente em:
- `POST /api/shorts/auto` (`:375-456`) — publica com `products=[]` (`:428`) e DEPOIS roda `auto_select_products` (`:439-445`) usando o `video_id` **recém-publicado** (`:435`).
- `POST /api/shorts/tag-products` (`:521-…`) — idem em vídeo JÁ publicado (body JSON).

**Conclusão:** para "nome → auto-select", o app deve chamar `/api/shorts/auto`; se chamar `product_names` em `/api/shorts`, o FastAPI ignora o campo (não declarado) e a tagagem não acontece. Para "item verbatim escolhido na busca", `products: [{"item": …}]` em `/api/shorts` (accepted por `build_products_selection:466-475`). Não há endpoint que aceite AMBOS numa chamada — o app pode combinar `/auto` (nomes) e, se o usuário escolheu itens exatos, enviar verbatim em `products` (prioridade) OU fazer 2ª chamada `/tag-products`. **Recomendação: `product_names`/`filters` → `/auto`; `products` verbatim → `create_short`; nunca os dois no mesmo request (escolher prioridade e documentar).**

### 5.2 O que `filters` espera?
`normalize_filters` (`app/services/product_selector.py:38-65`) faz merge sobre `DEFAULT_FILTERS` (`:27-35`): `mercadolivre/shopee/amazon: bool`, `min_commission_pct`, `items_per_product`, `price_weight`, `commission_weight`. Formato: JSON object string. A UI não precisa expor tudo — defaults são bons; expor no máximo `min_commission_pct`.

### 5.3 Como guardar `item` verbatim para re-envio?
`GET /api/sessions/{id}/products` (`shorts.py:185-267`) retorna cada item com o bloco `item` verbatim do catálogo ("passe como `products: [{"item": ...}]`", docstring `:193-196`). Guardar verbatim = `youtube_products: [{query, item: <dict>}]` no config. **O pipeline atual destrói isso** (wizard CSV `:1055`; runtime `String(v)` `:462-464`; `_parse_products` filtra não-dict `:71-78`). Precisa do caminho canônico do item 6.

### 5.4 videoId obrigatório na busca — mecanismo mais seguro
Problema: `list_products` (`shorts.py:185`) e `search_products` (`studio.py:980`) exigem `externalVideoId` do próprio canal, mas antes do primeiro short publicado não existe vídeo. Estados possíveis na API:

| Fonte | Existe? | Evidência |
|---|---|---|
| `sacrifice_video_id` (session config) | Sim, se configurado via `POST /api/sessions/{id}/config` (`shorts.py:79-101`); **é o único "vídeo próprio" persistido** (token farm exige "vídeo público DO PRÓPRIO canal" — `token_farm_service.py:449-457`) | `shorts.py:79-101` |
| Lé-lo pelo app | **NÃO exposto**: `SessionResponse` (`models/session.py:92-102`) e `GET /api/session/{id}` (`session.py:141-…`) não incluem o campo | `session.py:141-175` |
| Último short publicado | Sim via `GET /api/shorts?session_id=` (campo `video_id`), já existe cliente `listShorts` (`lib/youtube.ts:398-404`) | `shorts.py:220-…` |
| Pós-publicação | `/auto` usa o `video_id` recém-publicado sem precisar resolver antes — **essa é a chave** | `shorts.py:435-445` |

**Mecanismo recomendado:**
1. **Browse/busca no wizard tem 2 estágios:** (a) nunca derivar videoId de título/ID (bug #4); (b) resolver na ordem: `sacrifice_video_id` da sessão → expor esse campo em `GET /api/session/{id}` (adicionar ao `SessionResponse`) → fallback `GET /api/shorts?session_id=` último `video_id` published → se nenhum, retornar erro PT-BR pedindo para publicar 1 short ou configurar o vídeo isca (sem chamada à API com ID fake).
2. **Publicação com nomes:** usar `POST /api/shorts/auto` — resolve o "sem videoId" estruturalmente (taggeia depois do upload).
3. **Item verbatim:** browser `list_products` retorna `item`; o usuário escolhe → guardar verbatim. Na publicação, `products: [{item}]` em `/api/shorts`.

---

## 6. Dual caption — estado real

- Schema: `caption_youtube`/`caption_instagram` (`prisma/schema.prisma:150-151`), migration `0009_add_dual_captions` aplicável.
- **Zero consumo** em runtime/UI/import: nenhum grep hit em `components/`, `app/`, `lib/`, `data/`; `resolveCaptionTemplateVars` usa `ContentItem.caption` (`planner-runtime:244-318`); `buildPostData` usa `runtime.selectedContent.caption` + `applyCaptionTemplate` (templates/rotation), sem noção de plataforma na resolução além do fallback único `{post_caption}`.
- Riscos do plano (youtube.txt/instagram.txt → colunas → `{post_caption}` por plataforma):
  1. `{post_caption}` é resolvido por **item** e por **planner** (campo global `caption` não existe mais no config — só `caption_templates`); o "plano de captions duplas" precisa definir a cadeia por plataforma: `caption_youtube` → `caption` → fallback → template, e inversa para IG.
  2. A **propagação** (`buildYoutubeOptionsForPropagation`) e o **community message** (`route.ts:906`) usam a caption única — qualquer mudança precisa propagar a caption correta da plataforma do post (o post já conhece `youtube_type`).
  3. Wizard ainda não tem UI para as duas captions (grep `captionYoutube/captionInstagram` = 0) → colunas ficarão órfãs até o wiring.
  4. Ordem de precedência IG×YT no `ContentItem` precisa ser estável (upload de pasta importa ambos os .txt; edição manual no wizard deve sobrescrever).

---

## 7. Especificação recomendada — fluxo de produtos (UI + backend)

**UI (PlannerWizard, modo Short/YT-only):**
1. Lista de produtos `YouTubeProductEntry[] {query, item?, title?, vendor?, price?, commission_pct?}`.
2. Botão "+ Adicionar Produto Afiliado" → campo `query` + busca live `GET /api/youtube/products?channelId=&videoId=<resolvido 5.4>&query=` (debounce, `limit=20`, `sort=relevance`).
3. Selecionar um resultado → guarda `item` verbatim (cache da resposta da API) + `title/vendor/price/commission_pct` para exibição; OU deixar `query` livre (auto-select na publicação via `/auto`).
4. Persistir `youtube_products: Array<{query, item?}>` NO config (usar `normalizeYoutubeProductsList`/`serializeYoutubeProducts` do `planner-config.ts`).
5. Comunidades (IMAGE/CAROUSEL em YT): seção de produtos NÃO renderizada.

**Backend:**
1. `buildPostData`: trocar o caminho CSV p/ objetos; `ytObj.products = JSON.stringify(list)` (array de `{query,item?}`). Template resolution NÃO deve rodar em products (#13).
2. `publisher` (bloco Short): separar entradas com `item` (→ `products` Form p/ `createShort`) das entradas `query`-only (→ `product_names` + `filters` p/ `POST /api/shorts/auto`); `createShort`/novo `createAutoShort` em `lib/youtube.ts` com `product_names`, `filters`, e resposta `AutoShortResponse` (video_id, `tagging_error`, `total_selected`).
3. `buildYoutubeOptionsForPropagation`: incluir `products` (fix #1).
4. Validar: `validatePlannerConfig` deve aceitar `Array<{query, item?}>` e rejeitar `{query}` sem nada no runtime só no caminho `/auto`.
5. videoId: expor `sacrifice_video_id` no `SessionResponse` da API externa + fallback último short (seção 5.4).

**Não fazer:** enviar `product_names`/`filters` no `POST /api/shorts` (campo inexistente); enviar `products` sem `item`/merchant fields (derruba o upload — `studio.py:477-486`).

---

## 8. Resumo executivo

- **P0 (4):** (#1) propagação apaga produtos; (#2) `{query}` sem `item` derruba upload; (#3) `product_names+filters` não existe em `/api/shorts`; (#4) videoId fake na busca.
- **P1 (5):** (#5) CSV de IDs descartado silenciosamente; (#6) formato objeto vira `"[object Object]"`; (#8) Community sem fallback de texto; (#9) STORIES-imagem em YT; (#16) dual caption órfã (schema-only).
- **P2 (5):** (#7) aresta título; (#10) kids×shopping; (#11) template não resolvido na propagação; (#12)/(#13) CSV e `{var}` em produtos.
- **OK:** cadeia título Short, validações config (título/descrição/categoria/booleans), mix YT+IG bloqueado, remoção de canal cancela posts, carousel_folder vazio bloqueado, Comunidade sem produtos.