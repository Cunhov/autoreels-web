# Audit Track API/RESILIÊNCIA — Fase 1 (agente 6)

> **Branch:** `feat/yt-products-dual-captions` · **HEAD:** `9ae5a54` (checkpoint) · **base:** `b3d5d56`
> **API externa:** `/Users/bestoptionnotebook/Projects/youtube-community-api` (`app/api/shorts.py`, `post.py`)
> **Método:** rastreio wizard → config → runtime (`buildPostData`/`applyCaptionTemplate`) → publisher → API externa, com evidência de arquivo:linha. Nenhum código alterado (somente docs).

---

## 1. Mapa função externa → callers → proxy → status

`lib/youtube.ts` — todas as chamadas à API externa `<baseUrl>` (as duas envs são obrigatórias, sem default localhost: `getYoutubeConfig` L17-46 `lib/youtube.ts`).

| Função (lib/youtube.ts) | Parâmetro proxy? | Callers | Proxy repassado? | Status |
|---|---|---|---|---|
| `youtubeFetch` L56 | `proxyUrl?` | interno | ✅ nos callers que passam | OK |
| `getHealth` L193 | `proxyUrl?` | `app/api/youtube/health/route.ts` L41 `getHealth()` | ❌ nunca passa | GAP(P1) |
| `listSessions` L206 | `proxyUrl?` | `youtube/sessions/route.ts` L27; `youtube/sessions/link/route.ts` L64 | ❌ ambos sem proxy | GAP(P1) |
| `getSession` L226 | `proxyUrl?` | publisher `route.ts` L1243 `getSession(sessionId)` | ❌ dentro do próprio publisher | GAP(P1) |
| `refreshSession` L234 | **não aceita** | `channels/[id]/youtube/refresh/route.ts` L22 | ❌ impossível | GAP(P1) |
| `deleteSession` L245 | não aceita | `youtube/sessions/link` L134, `youtube/connect` L82/L184, `channels/[id]` L282 | ❌ | GAP(P1) |
| `uploadCommunityPost` L299 | `proxyUrl?` | publisher L1123 | ✅ `getChannelProxyUrl(post.channel)` | OK |
| `createCommunityPostText` L339 | `proxyUrl?` | publisher L948-949 | ✅ | OK |
| `deleteCommunityPost` L360 | não aceita | `youtube/posts/route.ts` DELETE | ❌ | GAP(P1) |
| `createShort` L378 | `proxyUrl?` | publisher L1195-1209 | ✅ | OK |
| `listShorts` L429 / `getShort` | não aceita | sem callers ativos | n/a | — |
| `listComments` L445, `createComment`, `commentAction`, `createPinnedComment` | não aceita | `youtube/comments/route.ts` L33/91/116/123 | ❌ | GAP(P1) |
| `listProducts` L536 | não aceita | `youtube/products/route.ts` L57 | ❌ | GAP(P1) |

**Leitura:** o proxy por canal (`Channel.proxy_url`, migration 0008) é honrado **apenas no caminho do publisher** (`app/api/cron/publisher/route.ts`): community-text L948-949, community-upload L1123, short L1195-1209, IG em L1821-22/1992-96/2171-79/2283-87/2354-55/2382-83/2546-47. Todas as rotas de gerenciamento (sessions, link, health, comments, posts-delete, products, refresh) ignoram o proxy — e 5 funções nem aceitam o parâmetro. Um canal que **precisa** de proxy por bloqueio geográfico/BotGuard tem a publicação funcionando mas o refresh de sessão / health / comentários / busca de produtos caindo sem proxy.

**Contradição interna no publisher (evidência):** L1195-1209 passa proxy ao `createShort`, mas o bloco de detecção de sessão expirada L1243 chama `getSession(sessionId)` **sem** proxy — exatamente o cenário que deve falhar sem proxy.

---

## 2. Achados

### F1 — [P1] `GET /api/youtube/products` exige `videoId` e a UI fabrica um fake (pré-publicação)

- Rota: `app/api/youtube/products/route.ts` L14-22 — valida posse via `requireOwnedYoutubeChannel` (✅ `lib/youtube-channel.ts` L29-79: user_id + platform + sessionId) e devolve 400 se `videoId` ausente.
- API externa: `app/api/shorts.py` L185-234 — `video_id: str = Query(..., description="vídeo alvo da tagagem")` **obrigatório**, usado em `client.search_products(query, video_id=...)` (shorts.py L234).
- UI: `components/PlannerWizard.tsx` L694-706 — fabrica o videoId com `youtubeTitle.trim().slice(0, 50)` ou, na falta, o **id do item de biblioteca** (`sel.slice(0, 50)`). Nenhum dos dois é um video ID do YouTube (11 chars do canal). A API externa repassa esse valor ao Studio → esperado 400/502 ou resultados vazios; a UI já mostra "Informe o Título..." quando vazio (L705) e o yt-fields-track-report (L107) reconhece o risco.
- **Proposta:** fallback em `app/api/youtube/products/route.ts`: se `videoId` ausente, buscar o último Short publicado do canal em `Post` (`where: { channel_id: guard.channel.id, status: "published", youtube_video_id: { not: null } }` orderBy `published_at desc`) e usar `youtube_video_id`. Segundo fallback: `sacrifice_video_id` (o endpoint `POST /api/sessions/{id}/config` já existe na API externa — shorts.py L150-183 — e o app não tem UI nem chamada; sem ele, usar zero + mensagem clara). Manter `requireOwnedYoutubeChannel` (posse já garantida).

### F2 — [P0] Contrato de publicação de produtos afiliados: strings enviadas no campo errado → tagging silenciosamente nulo

- Wizard salva CSV de **nomes/IDs**: `PlannerWizard.tsx` L1047-1057 `youtube_products = split(',').trim().filter.join(',')`; a busca só exibe resultados como JSON cru (`JSON.stringify(pr).slice(0,120)` L1740-1743), **não há seleção de item**.
- Runtime: `lib/planner-runtime.ts` L457-469 — `productsJson = JSON.stringify(csv.split(','))` → `youtube_options.products = '["nome1","nome2"]'` (strings).
- Publisher: `app/api/cron/publisher/route.ts` L1177-1193 — `productsStr` (array string) → `createShort({ products: productsStr })` L1209.
- API externa: `create_short` (shorts.py L277-345) — `_parse_products` L75-87 **descartar tudo que não for dict**: `return [item for item in value if isinstance(item, dict)]`. `'["nome1"]'` → `[]` → `run_short_upload(products=[])` (L340) → **o Short publica normal sem nenhum produto taggeado, sem erro**. Silencioso.
- O caminho correto planejado ("auto-select por nome na publicação (product_names+filters)") existe na API externa como `POST /api/shorts/auto` (`auto_create_short` L376-515, `_parse_product_names` L90-105) e `POST /api/videos/{id}/tag-products` (L521+) — **nenhuma referência no app** (grep `shorts/auto|tag-products|product_names|sacrifice` em lib/app/components/worker = 0 hits). Os helpers `normalizeYoutubeProductsList`/`serializeYoutubeProducts`/`YoutubeProductEntry` (planner-config.ts L134-210) também são código morto (0 consumidores).
- Comunidades: `post.py` não tem tagging (grep `products` = 0) — coerente com "comunidades SEM produtos"; o app só injeta products no ramo Short de `buildPostData` (planner-runtime L457-469 dentro do bloco `ytTypeForPost === "short"`) — ✅.
- **Proposta:** no publisher, quando `youtube_options.products` for um array de strings (nomes), rotear para `POST /api/shorts/auto` com `product_names` (+ `filters` se houver); quando for `[{item:...}]` verbatim, manter `POST /api/shorts` com `products`. Validar o formato no `buildPostData` com o helper único (`toYoutubeProductsJson`) já previsto no integration-plan §3.2.

### F3 — [OK+P2] Categorias YT: publisher aceita category_id vindo do config — consistente

- Publisher `app/api/cron/publisher/route.ts` L1204-1206: `categoryId: options.category_id ?? 22` — e `options` vem de `post.youtube_options` (L1150-1156), que o `buildPostData` preenche com `ytObj.category_id = categoryId` do `config.youtube_category_id` (planner-runtime L538-549; propagação L735-746). Ou seja: **sim**, o config flui até o `createShort` — o plano "options.category_id ?? 22" já está resolvido.
- Defaults alinhados: `YOUTUBE_CATEGORY_DEFAULT = 22` (planner-config L236) = obrigatório `?? 22` do publisher = doc no `createShort` L369 (comentário explica 22 = People & Blogs vs 17 Sports do backend). A API externa tem default `category_id: int = Form(17)` (shorts.py L282) — o app **sempre** envia valor explícito, então o default "Sports" do backend nunca é atingido via planner. ✅
- P2: `YOUTUBE_CATEGORIES` (planner-config L216-234) é **código morto** — o wizard tem campo numérico cru "Categoria ID" (`PlannerWizard.tsx` L1750-1759, placeholder "22 (People & Blogs)") em vez de dropdown com o mapa; e `parseYoutubeOptions` aceita `category_id` 0..100 (youtube-post-options L103-107) enquanto `validatePlannerConfig` exige 1..100 — janela de inconsistência (0) pequena, único valor divergente.

### F4 — [P1] Proxy não cobre rotas de gerenciamento nem o materializador de imagens da Comunidade

- Coberto: publisher L948-1209/L1821-2547 (acima). `getChannelProxyUrl` (lib/proxy.ts L104-128) prefere coluna `proxy_url` e cai para `settings.proxyUrl/proxy_url`; `getProxyDispatcher` (L66-93) cria `undici.ProxyAgent` (undici 8.10.1 em package.json L28 — ✅ presente).
- Gaps (F1/F4-Wide): todas as rotas de gerenciamento sem proxy (tabela §1); `getSession` no próprio publisher sem proxy (L1243).
- `readCommunityImage` (`publisher/route.ts` L681+, fetch em ~L793) baixa imagens da Comunidade **sem proxy** — SSRF-guarded (`isHostAllowed` L757), ok para hosts públicos, mas um canal atrás de proxy que precisa dele para rede pode falhar a materialização. P2 (conteúdo é mídia, não endpoint YT).
- `resolveAccessToken` (lib/instagram.ts L78-122) usa Upstash Redis direto — correto (infra interna, não precisa de proxy).
- `exchangeInstagramCode` (L204-233) sem proxy — OK para OAuth direto (documentar).

### F5 — [OK] Autenticação server-side e segredos

- Todas as rotas `/api/youtube/*` autenticam: sessions (L15), link (L30), connect (L40), health (L14), posts-delete/comments/products via `requireOwnedYoutubeChannel` (posse + sessão do canal). Nenhuma rota youtube é admin-only — mas nenhuma vaza dados entre usuários (guard por `user_id`).
- API externa: `verify_session_access` + `require_auth` (shorts.py L290/L193 etc.) — validação do lado de lá ✅.
- Client bundle: `lib/youtube.ts` nunca importado de componente (grep "use client" + imports = 0 em components); `lib/proxy.ts` nunca importado de client. `app/api/channels/route.ts` L55-70 e `[id]/route.ts` L56-71 usam select whitelist que **remove** `access_token`, `proxy_url`, `proxy_enabled` e não expõe `settings` (portanto `sessionId` e `settings.proxy_url` legado não vazam); `proxy_url_masked` via `maskProxyUrl` (L64). `app/api/planners/route.ts` L13-20 `publicChannelSelect` (id,name,platform,account_id,username,profile_picture_url,status) e preview L203-212 whitelist — sem segredos. ✅
- P2: como `getChannelProxyUrl` aceita `settings.proxy_url` (fallback legado), qualquer rota futura que inclua `settings` no select vazaria proxy cru — recomendação: manter `settings` fora de selects públicos (regra já seguida hoje).

### F6 — [GAP, cross-track] Dual captions `caption_youtube`/`caption_instagram` = schema-only

- Migration 0009 + schema L150-151 adicionam as colunas; **0 consumidores** em runtime/wizard/API (grep `caption_youtube|caption_instagram|youtube.txt|instagram.txt` fora de prisma = 0). `app/api/content-items/route.ts` L14 whitelist só tem `caption` (L199-203 sanitize) — não grava nem devolve `caption_*`. `resolveCaptionTemplateVars` (planner-runtime L278-312) resolve `{post_caption}` de `libItem.caption` genérico, sem awareness de plataforma; `applyCaptionTemplate` (L328-390) idem. `{post_caption}` por plataforma **não existe** hoje. Conferir docs/audit-integration-plan.md §3.1 (ordem de correção T3→T4).

---

## 3. Tabela forma-de-posta → evidência → status → severidade → recomendação

| Forma de postagem | Evidência (wizard → config → runtime → publisher → API) | Status | Sev. | Recomendação |
|---|---|---|---|---|
| **YT Short (vídeo)** | `PlannerWizard` L1040-1095 `ytFields` → `config.youtube_*` → `buildPostData` L417-560 (title/privacy/category/products) → publisher L1150-1230 `createShort` (proxy ✅ L1195-1209) → `POST /api/shorts` (shorts.py L277) | OK (título vazio bloqueado L1205-1208; category 22). Produtos: **BUG F2** | P0 | Rotear nomes → `/api/shorts/auto` (product_names); `[{item}]` → `/api/shorts` |
| **YT Community (texto)** | wizard caption → `buildPostData` caption L409 → publisher L947-950 `createCommunityPostText` (mensagem vazia bloqueada L946) → `POST /api/post` | OK | — | — |
| **YT Community (imagens 1..10)** | children_urls → publisher L950-1031 (`collectCommunityImageUrls`, blur 1:1, timeout/deadline) → `uploadCommunityPost` L1115-1123 (proxy ✅) → `POST /api/post/upload` | OK | — | Proxy no materializador de imagem (P2, F4) |
| **YT Community sem imagens + carrossel só vídeo** | publisher L963-976 | OK (block definitivo com mensagem) | — | — |
| **IG Reels/Image/Carousel/Stories** | runtime mediaType L940-1010 → publisher L1821-2547, todos com `getChannelProxyUrl` (✅) | OK | — | — |
| **Busca de produtos pré-publicação** | `PlannerWizard` L694-730 → `/api/youtube/products` L14-22 (400 sem videoId, fabricado L694-706) → `listProducts` (sem proxy) L536 → `GET /api/sessions/{id}/products` (video_id obrigatório, shorts.py L189) | **BUG** | P1 | Fallback ao último `Post.youtube_video_id` publicado do canal; 2º: `sacrifice_video_id`; proxy do canal |
| **Tagging de produtos no Short** | config CSV → `youtube_options.products` strings → publisher `products: productsStr` L1209 → `_parse_products` descarta strings (shorts.py L75-87) | **BUG silencioso** | P0 | `/api/shorts/auto` + `product_names`/`filters` |
| **Comunidades com produtos** | post.py sem tagging (0 hits) + app só injeta products no ramo short | OK (ausência coerente) | — | Manter; garantir que wizard não exiba produtos p/ planner comunidade |
| **Dual captions (youtube/instagram.txt)** | migration 0009 + schema L150-151; 0 consumidores; `{post_caption}` resolve de `libItem.caption` (planner-runtime L289-293) | **GAP** | P1 | T3/T4 do integration-plan: whitelist content-items, seleção por `channel.platform`, 1 função única |
| **Categoria YT** | config.youtube_category_id → `ytObj.category_id` (L549) → publisher `options.category_id ?? 22` (L1205) → `POST /api/shorts` (backend default 17 nunca usado) | OK; P2: `YOUTUBE_CATEGORIES` morto, input numérico cru | P2 | Dropdown com `YOUTUBE_CATEGORIES`; unificar faixa 0 vs 1..100 |
| **Refresh/gestão de sessão YT** | `refreshSession` L234 sem proxy; `getSession` sem proxy no publisher L1243 | **GAP** | P1 | Adicionar `proxyUrl?` a refresh/getSession/delete/listSessions/listProducts/deleteCommunityPost/comments e repassar do canal |
| **Health YT** | `app/api/youtube/health/route.ts` L41 `getHealth()` sem proxy | GAP | P2 | Passa proxy do 1º canal com proxy ou documenta direto |
| **Auth/segredos** | guards + whitelists (§F5) | OK; settings fora de selects = regra a manter | P2 | Nada a fazer |

---

## 4. Propostas priorizadas

**P0**
1. **Tagging real de produtos (F2):** publisher → `POST /api/shorts/auto` (`product_names`+`filters`) quando `youtube_options.products` são strings (nomes); manter `POST /api/shorts` com `products: [{item}]` verbatim. Sanitizar no `buildPostData` com helper único (`toYoutubeProductsJson`) consumido também pela propagação.

**P1**
2. **videoId da busca de produtos (F1):** fallback no route ao último `Post.youtube_video_id` publicado do canal (coluna existe, schema L194/213, population em publisher L1240) e, na ausência, suporte a `sacrifice_video_id` via `POST /api/sessions/{id}/config` da API externa (shorts.py L150-183) — sem UI obrigatória, mas com mensagem PT-BR clara.
3. **Proxy nas rotas de gerenciamento (F4-Wide):** adicionar parâmetro `proxyUrl?` às funções de lib/youtube.ts que hoje não aceitam (`refreshSession`, `deleteSession`, `deleteCommunityPost`, `listProducts`, `listComments/createComment/commentAction/createPinnedComment`) e repassar `getChannelProxyUrl(channel)` nos routes que têm o canal (products, posts-delete, comments, refresh, connect/link). No publisher, `getSession` (L1243) deve usar o proxy do canal.
4. **Dual captions (F6):** seguir integration-plan T3/T4 — whitelist `caption_youtube/instagram` em content-items, seleção por plataforma num único ponto compartilhado por buildPostData/propagate/preview.

**P2**
5. **Categoria:** dropdown com `YOUTUBE_CATEGORIES` (hoje mapa morto + input numérico); alinhar faixa `parseYoutubeOptions` (0..100) vs `validatePlannerConfig` (1..100).
6. **Health/comments:** proxy opcional onde fizer sentido; documentar decisão.
7. **Materializador de imagens da Comunidade:** decidir se usa proxy do canal (hoje direto com SSRF guard).

---

## 5. Notas de integração

- `lib/planner-config.ts` estava em edição ativa durante a auditoria (diff grande não commitado, 369+/178-) — conferir antes de editar (integration-plan §1).
- Runtime tem 3 caminhos paralelos de normalização de products (integration-plan §3.2) — a correção P0-1 deve eliminar a divergência entre `buildPostData` (L457-469) e a propagação.
- **BUG [P1, perda silenciosa de dados]:** `buildYoutubeOptionsForPropagation` (planner-runtime L654-756) monta `ytObj` **sem `products`** (L739-746: title/privacy/booleans/description/category_id/pinned — nada de products) e `CAPTION_PROPAGATION_KEYS` **inclui** `youtube_products` (L595-609). Logo: editar o planner com produtos novos (ou qualquer caption/config que dispare propagation, já que `youtube_products` está nas keys) **substitui** `youtube_options` dos Shorts pendentes por uma versão SEM products → posts agendados perdem os afiliados sem aviso. Exceção: Community não mexe (L891). Corrigir junto com P0-1: propagation deve reconstruir products com o MESMO helper do buildPostData.