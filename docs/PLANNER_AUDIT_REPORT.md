# PLANNER_AUDIT_REPORT — Fonte Única (Fase 2 · Integração e Veredito)

> **Agente:** 7 — INTEGRADOR/QA (gauntlet loop) · **Fase:** 2 — Integração e veredito
> **Branch:** `feat/yt-products-dual-captions` · **HEAD:** `9ae5a54` (checkpoint; base `b3d5d56`)
> **Gerado em:** 2026-09-01 (após ciclo 23:14–23:17 dos 6 verifiers)
> **Natureza:** consolidação — NENHUM código editado. Este arquivo é a fonte única; os `docs/audit-track-*.md` são as provas.
> **Inputs:** `docs/audit-track-{ig,yt-short,yt-community,wizard,editor,api}.md` + `docs/audit-integration-plan.md` (matriz/watcher) + feature reports entregues (`isolation`, `proxy`, `bug-remove`, `bug-desc`).
> **Verificação de fatos pelo integrador:** whitelist `app/api/content-items/route.ts:13-19` SEM `caption_*` ✅ · `grep caption_youtube|caption_instagram` em app/lib/components = 0 hits ✅ · `buildYoutubeOptionsForPropagation` (`planner-runtime.ts:700-760`) SEM `products` ✅ · `_parse_products` (`shorts.py:71-88`) descarta strings ✅ · `lib/planner-config.ts` com diff não commitado (C6 ativo) ✅.

---

## 0. Veredito harsh contra a barra (asked: cada track citou código? GAPS≠BUGS? nada "achou" sem citar?)

| Critério da barra | Resultado | Evidência |
|---|---|---|
| 6/6 tracks entregues com evidência `arquivo:linha` | ✅ **PASSOU** | Todos os 6 docs têm tabelas com coluna "Evidência" citando `arquivo:linha` do worktree E da API externa (`shorts.py`, `post.py`, `studio.py`, `product_selector.py` do `~/Projects/youtube-community-api`) |
| GAPS **claramente separados** de BUGS | ✅ **PASSOU** | Todos os tracks usam coluna Status com `OK`/`GAP`/`BUG` + Sev `P0/P1/P2`; GAP = comportamento ausente/parcial, BUG = quebra/mentira. Ex.: IG #3 (BUG carrossel 1 item) vs IG #5 (GAP UX 11+); Wizard W4 (BUG) vs W7 (GAP/P2) |
| Nada "achou" sem citar | ✅ **PASSOU** (com 2 ressalvas) | O integrador re-verificou 5 alegações críticas no worktree/API externa — todas batem (ver header). Ressalvas: (1) tracks propõem recomendações além da evidência (ex.: "criar `createAutoShort`"), mas **os achados em si** são todos citados; (2) heurísticas de linha ("~L471") em 2 docs editor/wizard variam ±3 linhas entre tracks — irrelevante, o código bate |
| Consenso cross-track nos P0 | ✅ **FORTE** | Os 4 P0 são reportados por 4–6 tracks independentes com evidências complementares de ponta-de-cadeia (ex.: descarte de strings só é provável citando `shorts.py:75-88`, que 4 tracks fizeram) |
| Veredito final | **PASSOU — integrável para a fase de correção.** A auditoria é confiável; a branch está em estado "promessa schema/helpers" + 1 regressão de wizard (deadlock YT). Nada bloqueia começar as correções na ordem §2. |

---

## 1. Matriz completa — forma de postagem × (wizard → config → runtime → publisher → API) × status × sev × evidência

Legenda: ✅ OK · ⚠️ GAP (ausente/parcial) · 🔴 BUG (comportamento errado/mentira). Nº de colchetes = nº de tracks que reportaram o mesmo item (consenso).

| # | Forma · Achado | Wizard | Config | Runtime | Publisher | API ext | Status | Sev | Evidência (arquivo:linha) |
|---|---|---|---|---|---|---|---|---|---|
| M1 | **YT SHORT — produtos afiliados = no-op silencioso** (CSV→strings→`_parse_products` descarta não-dicts→0 tags, sem erro) | 🔴 CSV cru (`PlannerWizard.tsx:1047-1057`) | 🔴 valida CSV (`planner-config.ts:440-486`) | 🔴 `JSON.stringify(csv.split(","))` (`planner-runtime.ts:456-469`) | 🔴 envia strings p/ `/api/shorts` (`publisher:1177-1209`) | 🔴 `_parse_products` filtra strings (`shorts.py:75-88`→`[]`) | **BUG** | **P0** | api F2 · wizard W4 · yt-short #2/#3/#5 · yt-community P0-2/F15 · editor PR1/PR2 [6] |
| M2 | **YT SHORT — formato novo `{query,item?}` quebraria p/ `"[object Object]"`** (helpers mortos; runtime `String(v)`) | 🔴 sem picker (JSON cru read-only `:1736-1744`) | ⚠️ helpers dead code (`planner-config.ts:136-214`, 0 callers) | 🔴 `String(v).trim()` p/ objetos (`planner-runtime.ts:462-466`) | 🔴 preview/load `join(",")` (`preview/route.ts:219`, `Wizard:507`) | 🟢 `products:[{item}]` aceito (`shorts.py:277-332`) | **BUG** | **P0** | yt-short #6 · editor PR2/V3 · wizard W4/W5 [3] |
| M3 | **YT SHORT — `product_names`+`filters` não existem em `POST /api/shorts`** (routa correta é `/auto`) | — | — | — | 🔴 nunca chama `/shorts/auto` (grep 0) | ⚠️ sem campo `product_names` em create_short; existe em `/auto` (`shorts.py:376-513`) | **BUG** | **P0** | yt-short #3 · api F2 · wizard §7 [3] |
| M4 | **YT SHORT — `{query}` sem `item` derruba o upload inteiro (502)** se for enviado verbatim (spec nova) | ⚠️ sem validação de "query-only" | — | ⚠️ idem | ⚠️ idem | 🔴 `build_products_selection` lança se sem merchant/item (`studio.py:477-486`) | **BUG** (latente) | **P0** | yt-short #2 [1+api consistency] |
| M5 | **YT SHORT — propagação apaga products/título/template-desc de posts pendentes** | — | ⚠️ keys incluem `youtube_products` (`:595-609`) | 🔴 `buildYoutubeOptionsForPropagation` sem products/`youtube_title`/resolveYtTpl (`planner-runtime.ts:654-745` vs `:453-479`) | — | — | **BUG** | **P0** | yt-short #1/#11 · editor G1/G2/G3 · api §5 · wizard W8 · ig #18 [5] |
| M6 | **YT SHORT — busca de produtos com videoId falso** (título/id de item ≠ 11-char video) | 🔴 `youtubeTitle.slice(0,50)`/item id (`PlannerWizard:694-706`) | — | — | — | 🔴 `video_id` obrigatório (`shorts.py:185,192`; innertube exige real `studio.py:980-1021`) | **BUG** | **P0** (feature) | api F1 · yt-short #4 · yt-community P0-3 · editor PR4 [4] |
| M7 | **YT COMMUNITY — deadlock wizard YT-only**: campo Caption/Templates/Fallback ocultos (isolamento b3d5d56) mas validação+runtime exigem texto | 🔴 `!onlyYoutubeSelected` esconde tudo (`PlannerWizard:1483,1516,1584`); guard exige texto (`:825-844`); "Configurações YouTube" só tem Título/Descrição (consumidos só p/ short) | 🔴 sem `youtube_content_text` | 🔴 community → `youtube_options=null` (`planner-runtime:428`) e mensagem = `post.caption` (`publisher:906`) | — | 🟢 POST /api/post valida min len (`post.py/models:113-117`) | **BUG** | **P0** | wizard W1 · yt-community P0-1/F1/F2 · ig #14 [3] |
| M8 | **YT COMMUNITY — produtos/campos YT visíveis mas ignorados** (não existem em community) | 🔴 bloco "Configurações YouTube" incondicional (`PlannerWizard:1684-1790`, produtos `:1717-1758`) | — | 🟢 products só no ramo short (`planner-runtime:456-470`) | 🟢 community sem tagging (`post.py` 0 hits) | 🟢 idem | **GAP** (confusão) | **P1** | wizard W3 · yt-community F9/P1-1/P1-4 · ig #15 · editor PR6 [4] |
| M9 | **YT SHORT/COMMUNITY — dual captions schema-only** (migration 0009; 0 consumidores) | 🔴 sem inputs/campo (`PlannerWizard` grep 0) | 🔴 whitelist `POST_ALLOWED_FIELDS` sem `caption_*` (`content-items/route.ts:13-19`) | 🔴 `resolveCaptionTemplateVars` lê só `caption` (`planner-runtime:244-318`); `applyCaptionTemplate` sem `platform` | — | — | **GAP** (promessa não entregue) | **P1** | api F6 · wizard W6 · yt-community F14 · editor §6 · ig #23 [5] |
| M10 | **IG CAROUSEL — 1 item passa wizard+runtime e falha no IG** (carrossel exige 2–10) | ⚠️ valida só "é pasta" (`PlannerWizard:858-871`) | — | ⚠️ erra só com 0 filhos (`planner-runtime:1082-1084`) | 🔴 monta com qualquer contagem (`publisher:2338-2363`) | 🔴 IG rejeita definitivo | **BUG** | **P1** | ig #3/#4 · editor §10.7 [2] |
| M11 | **IG STORIES → canal YT → short sem vídeo** (configs grandfathered nunca re-salvos) | 🟢 auto-fix STORIES→REELS (`PlannerWizard:269-272,931-941`) | — | 🔴 STORIES→`"short"`; imagem→`video_url=null` (`planner-runtime:403-418,540-550`) | 🔴 "Short exige um vídeo" definitivo (`publisher:1146-1149`) | — | **BUG** | **P1** | ig #12 · yt-short #9 · yt-community F11 [3] |
| M12 | **YT COMMUNITY — mensagem vazia = falha permanente sem fallback** | 🟢 bloqueia na origem (`PlannerWizard:824-845`) | — | — | 🔴 `MalformedDataError` (`publisher:906-908`) sem cadeia tipo short | — | **BUG** | **P1** | yt-short #8 · editor §10.6 [2] |
| M13 | **GLOBAL — race cancelamento×publisher**: publisher sobrescreve `cancelled` (escrita final incondicional) | — | — | — | 🔴 `prisma.post.update({where:{id}})` sem guard (`publisher:1216-1222,1128-1135,2570-2581`); nunca re-checa planner (grep 0) | — | **BUG** | **P1** | editor R1 [1; verificável] |
| M14 | **GLOBAL — race propagação×publisher** (propagate reescreve post claimado) | — | — | ⚠️ update por id sem guard (`planner-runtime:893-898`) | — | — | **GAP** | **P1** | editor R3 [1] |
| M15 | **GLOBAL — wedge: item deletado em planner sequencial** (índice nunca avança) | — | — | 🔴 resolve antes do claim (`planner-runtime:1224-1231` + `:150-157`) | — | — | **BUG** (não posta) | **P1** | editor R6 [1] |
| M16 | **GLOBAL — proxy não cobre rotas de gestão YT + getSession no publisher** | — | — | — | ⚠️ `getSession` sem proxy (`publisher:1243`) | ⚠️ `refreshSession/deleteSession/listSessions/listProducts/comments/deleteCommunityPost/health` sem `proxyUrl?` (`lib/youtube.ts` tabela api F1-wide/F4) | **GAP** | **P1** | api F1-wide/F4 [1; amplo] |
| M17 | **YT SHORT — edição de título NÃO propaga** (bug-desc incompleto) | — | — | 🔴 `titleCandidate` sem `youtube_title` (`planner-runtime:673-680` vs `:471-479`) | — | — | **BUG** | **P1** | editor G1 · wizard W8 · yt-short #1 [3] |
| M18 | **YT SHORT — description sem template-resolve na propagação** | — | — | 🔴 `String(cfg…description)` cru (`:734` vs `:453-455`) | — | — | **BUG** | P1 (G3)/P2 (yt-short #11) | editor G3 · yt-short #11 [2] |
| M19 | **GLOBAL — media type não muda inputs YT** (Short↔Comunidade muda só o label) | ⚠️ select L1438-1458 + box YT fixo | — | — | — | — | **GAP** | P1 | wizard W3 · yt-community P1-3/P1-4 [2] |
| M20 | **IG — STORIES: Caption/Location órfãos** (exibidos/gravados, nunca enviados) | ⚠️ `PlannerWizard:1483-1550,1626-1640` sem condição STORIES | — | — | 🔴 `if (mediaType !== "STORIES")` (`publisher:1951-1966`) | — | **BUG** (confusão) | P2 | ig #6 [1] |
| M21 | **YT — categoria numérica cru + `YOUTUBE_CATEGORIES` morto** | ⚠️ input numérico (`PlannerWizard:1761-1771`) | ⚠️ mapa morto (`planner-config:216-234`) | 🟢 flui até createShort (`planner-runtime:538-549` → `publisher:1204-1206`) | 🟢 default 22 alinhado | 🟢 backend default 17 nunca usado | **GAP** | P2 | wizard W7 · api F3 [2] |
| M22 | **GLOBAL — produtos em CSV: vírgula no nome / `{var}` resolve vazio** | 🔴 split(",") (`PlannerWizard:1055`) | — | 🔴 `resolveYtTpl` roda em products (`planner-runtime:453`) | — | — | **GAP** | P2 | yt-short #12/#13 [1] |
| M23 | **Wizard — validação de Short ignora `youtube_title`** (bloqueio por excesso em upload direto) | 🔴 guard usa só caption/fallback/library (`PlannerWizard:804-819`) | — | 🟢 runtime usa `rawYtTitle` 1ª fonte (`:452-453,471-474`) | — | — | **BUG** | P1 | wizard W2 [1] |
| M24 | **GLOBAL — propagação não cobre fields per-item** (location/collabs/tags/audio) e heurística posicional | — | — | ⚠️ diff só `caption/caption_fallback/title_fallback` (`planner-runtime:631-648`); match posicional `i % len` (`:814-851`) | — | — | **GAP** | P2 | ig #17/#19 · editor §10 [1-2] |
| M25 | **IG — mix mídia×upload direto** (REELS com imagem → video_url=imagem → IG rejeita) | 🔴 grava media_type do select p/ uploads (`PlannerWizard:903,958-975`) | — | ⚠️ não deriva do arquivo (`planner-runtime:1009-1011`) | 🔴 manda `video_url` com imagem (`publisher:1946-1950`) | — | **BUG** | P1 | ig #8 [1] |
| M26 | **IG — user_tags só no 1º slide do carrossel** (comportamento parcial não documentado) | ⚠️ tags mostradas p/ CAROUSEL (`PlannerWizard:910`) | — | — | ⚠️ idx===0 only (`publisher:238-247`) | — | **GAP** | P2 | ig #9 [1] |
| M27 | **GLOBAL — itens menores** (pinned alias divergente G4; duplicate sem validate P-Dup; getTimeInTimeZone duplicada V5; preview sem `youtube_type` V2; made_for_kids×products W-yt0; state ressuscitado 1 tick R2; 400vs404 no PATCH P9; `parseYoutubeOptions` 0..100) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | **GAP** | P2 | editor G4/P9/V2/V5/R2 · yt-short #10 · api F3 [—] |

### OKs verificados (não são problema — preservar nas correções)
- IG REELS/IMAGE full chain (ig #1/#2), share_to_feed default `"true"` (ig #10), caption vazia IG aceita (ig #11).
- YT Short cadeia de título com fallbacks (`planner-runtime:471-480` → `publisher:1168-1174`) e validações config YT (título 1..100, descrição ≤5000, categoria 1..100, booleans) (yt-short #14).
- YT Community runtime→publisher→API **sólido** em 4 camadas de guard (wizard/POST posts/publisher/lib) (yt-community F3-F8, F10).
- Mix YT+IG bloqueado client + server (`PlannerWizard:297-307,1090-1096`; `validatePlannerChannelMix` `planner-config:314-340`; POST/PATCH/duplicate 400).
- Remover canal cancela posts (bug-remove; `planners/[id]/route.ts:137-191`) + reset_state por identidade (`PlannerWizard:1017-1043`).
- Proxy honrado no caminho do publisher (community-text/upload, short, IG) (`publisher:948-1209,1821-2547`) + auth/segredos server-side (api F5).
- Categoria flui config→`youtube_options.category_id`→publisher `?? 22` (api F3).
- Community >10 imagens trunca; adaptação de imagem best-effort; sessionId ausente→`missing_session` (yt-community F4/F5/F6).

---

## 2. Lista ORDENADA de correções (P0 primeiro)

> Ordem de dependência: **B0 (deadlock wizard)** precede tudo (desbloqueia edição p/ testar o resto); depois **B1 (products)** funda o formato; **B2 (propagação)** só faz sentido com B1 resolvido; **D (dual captions)** depende de B0+B1 (o plano exige "produtos por plataforma" e "texto da comunidade" primeiro). C6: **commit de `lib/planner-config.ts` é pré-requisito de qualquer edit nesse arquivo.**

### P0-B0 — Deadlock planner YT-only (consenso 3 tracks)
- **O que mudar:** expor campo **"Texto da Comunidade"** (textarea, box "Configurações YouTube") renderizado quando `onlyYoutubeSelected && (mediaType==="IMAGE"||isCarousel)`, gravando no MESMO `config.content[].caption` que hoje o campo Caption grava (zero mudança de schema/runtime). Para Short: adicionar `youtubeTitle` ao guard de validação (W2) e não exigir caption oculta. Rótulo do select CAROUSEL em YT → "Carrossel · Post na Comunidade" (P1-3).
- **Arquivos:** `components/PlannerWizard.tsx` (L1483-1624 render condicional, L804-847 guard, L1454-1469 label) · `lib/planner-config.ts` (validar texto community não-vazio server-side).
- **Como testar:** criar planner YT novo com canal YT + IMAGE → salvar sem erro com texto preenchido; salvar vazio → erro PT-BR claro apontando o campo **visível**; `run` → post community com message não-vazia (`publisher:906`).
- **Impacto nas features entregues:** corrige REGRESSÃO do **isolation** (b3d5d56 escondeu os campos IG mas não criou substituto YT). Não reverte o isolation: campos IG continuam ocultos; o novo campo vive dentro do box YT. Zero impacto em proxy/bug-remove.

### P0-B1 — Produtos afiliados: formato único + roteamento real de tagging (consenso 6 tracks)
- **O que mudar:** (1) criar helper único **`toYoutubeProductsJson(config)`** (no `planner-config.ts`, consumindo `normalizeYoutubeProductsList`/`serializeYoutubeProducts` que hoje são dead code) — ÚNICO normalizador usado por `buildPostData`, propagação e preview; validar `Array<{query, item?}>` com shape-check de `item`; (2) **nunca** alimentar produtos com template (`{var}`) nem split por vírgula (M22); (3) no publisher: entradas com `item` verbatim → `POST /api/shorts` (`products`); entradas `query`-only → `POST /api/shorts/auto` (`product_names` + `filters` opcional) — precisa de `createAutoShort` em `lib/youtube.ts` (com `proxyUrl?`, espelhando `createShort`); (4) wizard: picker com seleção real → monta `{query, item?}` (não JSON cru read-only).
- **Arquivos:** `lib/planner-config.ts` · `lib/planner-runtime.ts` (L456-470) · `app/api/cron/publisher/route.ts` (L1177-1209) · `lib/youtube.ts` (novo `createAutoShort`) · `components/PlannerWizard.tsx` (L1717-1758).
- **Como testar:** query-only: config `youtube_products=[{"query":"smartwatch"}]` → post short → publisher chama `/shorts/auto` → `AutoShortResponse` com `total_selected≥1` e `tagging_error=null`; verbatim: `[{"query":"x","item":{...}}]` → `/shorts` → `_parse_products` mantém dicts → tag aplicada (`studio.py:1408-1412`). Teste negativo: `[{"query":"sem item"}]` **nunca** em `/shorts` (M4: derruba upload — 502).
- **Impacto nas entregues:** **proxy**: `createAutoShort` deve passar `getChannelProxyUrl(channel)` (espelhar L1195-1209). **isolation**: manter produtos ocultos em Community (M8) — o picker só renderiza no modo Short. **bug-desc**: propagação passa a usar o mesmo helper (B2).

### P0-B2 — Propagação espelha 100% o `buildPostData` (consenso 5 tracks)
- **O que mudar:** extrair **função única `buildYoutubeOptions(...)`** usada por `buildPostData` E `propagatePlannerConfigToPendingPosts` (hoje `buildYoutubeOptionsForPropagation:654-745` re-deriva sem products, sem `youtube_title`, sem `resolveYtTpl` na description). Incluir: `titleCandidate = [youtube_title(resolvido), selected.title, title_fallback, caption, itemName]`, `products` via `toYoutubeProductsJson` (B1), `resolveYtTpl` na description, alias `youtube_pinned_comment ?? youtube_pinned_comment_text` (G4).
- **Arquivos:** `lib/planner-runtime.ts` (L451-560 buildPostData, L654-745 propagate, L765-910 propagate loop).
- **Como testar:** planner short YT com products+título+templates na descrição → PATCH editar só a caption → posts pending preservam products/título/template-resolvido; editar `youtube_title` → `youtube_options.title` muda nos pending (teste-ouro do bug-desc). Verificar community NÃO mexe (`:891`) e o guard de status no update (M14).
- **Impacto nas entregues:** **bug-desc** (7fe3347) fica COMPLETO — a feature prometia "editar descrição/título propaga"; hoje título não propaga (M17). Sem regressão: o trigger `shouldPropagateConfig` já inclui as keys; apenas o conteúdo re-gravado muda. **bug-remove**: não alterar a criação de `cancelled`; adicionar apenas guard de status no update dos posts.

### P0-B3 — videoId real na busca de produtos (consenso 4 tracks)
- **O que mudar:** no route `app/api/youtube/products/route.ts`: fallback quando `videoId` ausente → último `Post.youtube_video_id` publicado do canal (`where: {channel_id, status:"published", youtube_video_id:{not:null}}` orderBy `published_at desc`); 2º fallback `sacrifice_video_id` (session config; expor no `SessionResponse` da API externa + rota `POST /api/sessions/{id}/config` já existe `shorts.py:150-183`); se nada → 400 PT-BR claro ("publique um Short ou configure o vídeo isca"). No wizard: remover derivação de título/item-id; mensagem de erro amigável.
- **Arquivos:** `app/api/youtube/products/route.ts` (L14-22) · `lib/youtube.ts` (`listProducts` + proxy) · API externa `models/session.py` (`SessionResponse` + sacrifice_video_id) · `components/PlannerWizard.tsx` (L683-741).
- **Como testar:** canal com 1 short publicado → busca sem videoId resolve o publicado e retorna itens; canal sem short → erro PT-BR; com `sacrifice_video_id` configurado → usa ele.
- **Impacto nas entregues:** **proxy**: `listProducts` precisa de `proxyUrl?` (hoje sem — mesmo problema de M16); o route tem o canal, passar `getChannelProxyUrl`. Sem efeito em isolation/bug-remove.

### P1 — (ordem sugerida, após os 4 P0)
1. **Dual captions full wiring** (M9) — dependente de B0/B1: whitelist `caption_youtube/instagram` em `content-items/route.ts` + sanitize (limite 2200, espelhar `caption` BK-07/BK-14); resolução por plataforma num ÚNICO ponto (`resolveCaptionTemplateVars` recebe `platform` do canal: `caption_youtube ?? caption` / `caption_instagram ?? caption`); uploader lê `youtube.txt`/`instagram.txt` (hoje `UploadContext.tsx:468-548` lê só 1º `.txt`); `applyCaptionTemplate`/`buildPostData`/`propagate`/preview compartilham `resolveFinalCaption()` (C2/C5, nunca 3 cópias); wizard com 2 inputs por plataforma no modo IG e no modo YT. Teste: pasta com youtube.txt+instagram.txt → round-trip preserva ambos; short YT resolve youtube.txt; IG resolve instagram.txt.
2. **Races** (M13/M14): publisher — guards `where: {id, status: {in: processing-statuses}}` nas escritas finais + re-check `status!=="cancelled"` antes do call externo; propagate — re-check status no update (só pending/scheduled/queued).
3. **STORIES→REELS no runtime** (M11): em `resolvePlannerRuntime`, se canal YT e mediaType STORIES → converter p/ REELS (ou erro claro) — não só no save do wizard.
4. **Community vazia → cadeia de fallback** (M12): título do item → title_fallback → caption, como o short; senão falhar cedo em `runPlannerOnce` com mensagem clara em vez de falha definitiva no publisher.
5. **Carrossel 2..10** (M10): validar contagem no wizard (via `/api/content-items?parent_id=`) e no `POST /api/posts` p/ `media_type=CAROUSEL` IG.
6. **Proxy rotas de gestão** (M16): adicionar `proxyUrl?` a `refreshSession/deleteSession/listSessions/deleteCommunityPost/listProducts/listComments/createComment/commentAction/createPinnedComment` e repassar do canal nos routes (products, posts-delete, comments, refresh, link/connect); `getSession` no publisher (L1243) com proxy do canal.
7. **Wedge item deletado** (M15): em sequencial, marcar índice tentado no state (`attempted_indexes`) e pular ao próximo após `resolution_failed`, em vez de travar para sempre.
8. **Media-type gating** (M8/M19): ocultar Produtos/Título/Privacidade/Categoria/Monetizar/Pinned quando mediaType=IMAGE/CAROUSEL em YT (Comunidade SEM produtos — spec); mostrar apenas Texto da Comunidade.

### P2 (higiene, sem dependência)
- M20 STORIES captions/location órfãos · M21 dropdown `YOUTUBE_CATEGORIES` + faixa 0..100 vs 1..100 · M22 CSV/vírgula/`{var}` em products (some com B1) · M24 propagação per-item + `content_item_id` no Post · M23 guard vira fix W2 (já no B0) · M26 user_tags carrossel · M27 (pinned alias, duplicate validate, getTimeInTimeZone única, preview `youtube_type`, made_for_kids×products, P9 400vs404).

---

## 3. Especificação funcional curta (decisões tomadas — ≤1 página)

**1. Media Type dinâmico por plataforma.** O `<select>` atual é substituído por seleção contextual: planner IG → Reels/Imagem/Carrossel/Story (campos IG); planner YT → **Short** (vídeo) ou **Comunidade** (texto+imagens 1..10). A forma escolhida determina o conjunto de inputs exibidos (GUI por forma). Sem Story em YT; CAROUSEL em YT = "Carrossel · Post na Comunidade". Mix YT+IG continua bloqueado (client+server, 400 PT-BR).

**2. Campos YT por forma.** *Short*: Título (obrigatório — guard passa a incluir `youtube_title`), Descrição (com `{var}` templates e chips), Produtos Afiliados (seção curta — ver 3), Privacidade, Categoria (dropdown), Feito para crianças, Monetizar, Comentário fixado. *Comunidade*: **Texto da publicação*** (grava `config.content[].caption`, cadeia `applyCaptionTemplate`; validação 4 camadas mantida) + seleção de imagens; TODOS os campos de vídeo (Título/Produtos/Privacidade/Categoria/Monetizar/Pinned) ficam ocultos — Comunidade **sem produtos** (API `post.py` não taggeia; preservar).

**3. Produtos afiliados (busca live + auto-select).** Wizard (modo Short YT): "+ Adicionar Produto Afiliado" → busca live `GET /api/session/{id}/products?query=&video_id=<resolvido B3>` (debounce, limit 20) → usuário escolhe um item (guarda `item` verbatim) OU deixa `query` livre. Config: `youtube_products: Array<{query, item?}>` via `toYoutubeProductsJson(config)` (helper único para build, propagação e preview). Publicação: `query`-only → `POST /api/shorts/auto` (`product_names` + `filters`); `item` verbatim → `POST /api/shorts` (`products`). Nunca misturar os dois numa chamada; nunca enviar `query`-only para `/shorts` (derruba upload); legado CSV convertido para `{query}` no load.

**4. Captions duplas (youtube.txt / instagram.txt).** Ingestão: pasta importada na biblioteca → `youtube.txt` → `caption_youtube`, `instagram.txt` → `caption_instagram`, `caption` genérico mantido como fallback (migration deixa NULL em linhas pré-existentes). Resolução centralizada: `resolveFinalCaption(platform, item)` = `caption_youtube ?? caption` (YT) / `caption_instagram ?? caption` (IG), usada por `buildPostData`, `propagate` e preview (1 única régua, nunca 3 cópias). `{post_caption}` resolve a caption da plataforma do canal do post. Hierarquia: texto manual/templates do wizard > `{post_caption}` específico > caption genérica. Propagação usa a caption correta da plataforma do post (o post já conhece `youtube_type`).

**5. Categoria dropdown.** `YOUTUBE_CATEGORIES` (`planner-config.ts:216-234`, hoje morto) vira dropdown no wizard; faixa única 1..100 (alinhar `parseYoutubeOptions`); default 22 (People & Blogs) consistente com publisher e `createShort`.

**6. Chips de variáveis.** Chips `{post_title}`/`{post_caption}`/`{date}`/`{channel_name}`/`{hashtags}` disponíveis em TODOS os campos de texto que resolvem templates no runtime (Descrição/Título YT + Texto da Comunidade + campos IG) — não só no bloco IG; placeholder da Descrição YT deixa de prometer sem UI.

---

## 4. Riscos residuais e armadilhas ("evitar armadilhas")

### Riscos residuais (aceitos / a vigiar)
1. **C6 — `lib/planner-config.ts` com diff 371+/180− NÃO commitado.** Qualquer track que edite o arquivo sobrescreve o trabalho em curso. → **Ação obrigatória antes de qualquer correção: commit do estado atual `9ae5a54` + diff.**
2. **C4 — overlap em `lib/planner-runtime.ts` (1326 ln) por 4 correções** (B1 build, B2 propagate, dual caption, preview). Edições paralelas → merge conflict quase certo. → Serializar ou delegar a 1 agente; ordem T4(fundação)→build→propagate.
3. **API externa fora do nosso controle de versão** (`~/Projects/youtube-community-api`). Dependências: `SessionResponse` + `sacrifice_video_id` (B3) e contrato `/shorts/auto` precisam existir lá; se a externa mudar o contrato, a web quebra. → Congelar contrato na spec e testar com a externa real.
4. **Grandfathered mix (planners antigos YT+IG)**: run/preview continuam com warning (sem bloqueio). Correções de propagação/dual caption devem preservar esse comportamento.
5. **Dual captions × content identity**: editar só `youtube.txt` não muda `config.content[]` → `contentChanged=false` → state de publicação NÃO reseta (posts futuros usam caption nova sobre conteúdo publicado). Documentar (esperado), não "corrigir" com reset indiscriminado.
6. **`made_for_kids=true` + products** = conflito do YouTube (kids desabilita shopping). Guarda de UX pendente (P2) — não é bloqueante de entrega.
7. **M4 (query sem item em `/shorts`) é um 502 destrutivo** (vídeo já enviado + draft órfão). É o único bug P0 **latente** (só surge se alguém implementar B1 errado) — o teste negativo do B1 é obrigatório.

### NÃO FAZER ("evitar armadilhas")
- ❌ **Não** enviar `product_names`/`filters` no `POST /api/shorts` (campo inexistente; FastAPI ignora silenciosamente).
- ❌ **Não** enviar `products` com entrada `{query}` sem `item`/merchant (derruba o upload — `studio.py:477-486`).
- ❌ **Não** aplicar template `{var}` em products (produto não é caption; var desconhecida→`""`→produto some).
- ❌ **Não** implementar dual captions antes de B0/B1 (plano depende de "texto da comunidade" e "products por plataforma"); e **nunca** criar 3ª cópia da régua de caption — só `resolveFinalCaption()` central.
- ❌ **Não** adicionar `caption_*` à whitelist sem sanitize (limite 2200, espelhar `caption`) — payload gigante/BK.
- ❌ **Não** re-mostrar campos IG em planner YT (regressão do isolation) — campos novos vivem no box "Configurações YouTube".
- ❌ **Não** mostrar produtos em Comunidade (spec + API sem tagging).
- ❌ **Não** re-adicionar STORIES em planner YT.
- ❌ **Não** mexer no fluxo de cancelamento de canal (bug-remove) ao adicionar guards de race — guard é adicional, não substitutivo.
- ❌ **Não** fazer o PATCH falhar inteiro se a propagação falhar (try/catch por etapa já existe — manter).
- ❌ **Não** alternar `state` do client em PATCH (server zera; manter).
- ❌ **Não** deixar `settings` do canal vazar em selects públicos (regra F5 — proxy cru incluído).

---

## 5. Resumo para o dono (20 linhas)

1. A auditoria de Fase 1 terminou: 6/6 verificadores entregaram provas com `arquivo:linha`; veredito harsh = **PASSOU**. GAPS≠BUGS, nenhum achado sem citação (reverifiquei 5 alegações críticas no código e na API externa — todas verdadeiras).
2. A branch está em estado "promessa": dual captions e produtos `{query,item?}` existem só no schema/helpers (0 consumidores).
3. **P0 #1 (deadlock):** o isolation escondeu Caption/Templates/Fallback no planner YT mas a validação exige texto → planner de Comunidade não pode ser criado/ editado pela UI.
4. **P0 #2 (produtos):** o painel de produtos é um no-op silencioso — CSV→strings→a API externa descarta strings → 0 produtos taggeados, sem erro.
5. **P0 #3 (propagação):** editar um planner apaga products/título/template dos Shorts pendentes (`buildYoutubeOptionsForPropagation` ≠ `buildPostData`).
6. **P0 #4 (busca):** a busca de produtos fabrica um videoId falso (título do planner) — a API exige um vídeo real do canal.
7. Correção proposta: 1 helper único `toYoutubeProductsJson`; propagate e build usam a MESMA função `buildYoutubeOptions`.
8. Correção proposta: nomes → `POST /api/shorts/auto` (product_names+filters); item verbatim → `POST /api/shorts` (products). Nunca os dois juntos.
9. Correção proposta: videoId = último short publicado do canal → `sacrifice_video_id` → erro PT-BR claro.
10. P1: dual captions (whitelist content-items + resolução por plataforma num ponto único + uploader youtube.txt/instagram.txt + campos no wizard).
11. P1: 2 races reais no publisher (cancelamento sobrescrito por escrita incondicional; propagação sobre post claimado) — guards de status.
12. P1: STORIES→REELS deve ser normalizado no runtime (configs grandfathered quebram hoje).
13. P1: proxy preciso em rotas de gestão YT (refresh/session/products/comments) e no `getSession` do publisher.
14. P1: carrossel IG exige 2..10 itens (1 item hoje passa e falha na API IG, definitivo); pasta vazia deixa o planner mudo para sempre.
15. P1: wedge de item deletado em planner sequencial (índice nunca avança).
16. P2: dropdown de categoria (YOUTUBE_CATEGORIES está morto), chips de variáveis no YT, labels EN/PT.
17. Decisões de spec: Media Type por plataforma (Short vs Comunidade); Comunidade SEM produtos; texto da Comunidade grava no campo caption; 2 captions por plataforma; hierarquia manual>template>genérica.
18. Entregues preservadas: isolation YT/IG, proxy no publisher, bug-remove (cancelamento), bug-desc (ganha completude: título passa a propagar).
19. Armadilha nº1: `planner-config.ts` tem diff não commitado — commit antes de qualquer correção. Armadilha nº2: nunca mandar query-only para `/shorts` (derruba o upload com 502).
20. Próximo passo: executar B0→B1→B2→B3 em série (runtime é ponto de contenção — 1 agente por vez), depois o P1 1..8, com `npm run build` + teste E2E mínimo (short YT c/ products + comunidade).