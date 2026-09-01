# fix-s3-regressoes — Auditoria de regressões do merge feat/tiktok-posting

**Branch:** trab-s3-regressoes (base: fixes-monolith @ 9242e7a)
**Escopo:** 5 commits `feat/tiktok-posting` (A1 auth → A5 smokes) × YT/IG/publisher/library.
**Barra:** `tsc` 0 · `npm run build` OK · todos os smokes `.mts` verdes (pré + novos).
**Resultado:** **1 bug real encontrado e corrigido** (drift de schema Post.tiktok_*), demais itens intactos.

---

## 1. Achado crítico — migration 0013 ausente (colunas TikTok no Post)

`schema.prisma` (A2/A4) declarou no model `Post`:
`tiktok_type`, `tiktok_post_id`, `tiktok_publish_id`, `tiktok_options`, `tiktok_status` + `@@index([tiktok_post_id])`
— mas as migrations do merge só cobriram `content_items.caption_tiktok` (0012) e um no-op (0011).

**Prova empírica (ANTES):** DB fresco criado por `prisma migrate deploy` (0001→0012):

```
posts tem tiktok_type: false | tiktok_options: false
content_items tem caption_tiktok: true   ← só isso existia
```

**Impacto:**
- DB **fresco**: `migrate deploy` cria `posts` sem as colunas → o Prisma Client (gerado do schema)
  emite `INSERT/SELECT ... tiktok_type` → `SQLiteError: no such column: posts.tiktok_type`
  no planner (criação de post) e no publisher (cron).
- DB **gerenciado** (produção): 0011/0012 aplicam sem criar colunas de `posts` → mesmo drift.
- DB **legacy** (pré-migrations): `db push` alinha aditivamente → esse caminho escapava.

**Fix aplicado:** `prisma/migrations/0013_add_tiktok_post_fields/migration.sql`
(5× `ALTER TABLE "posts" ADD COLUMN ...` + `CREATE INDEX posts_tiktok_post_id_idx`,
mesmo padrão aditivo de 0005 `youtube_post_fields`; idempotente via journal do `migrate deploy`).

**Prova empírica (DEPOIS):** migrate deploy 0001→0013 em DB novo:
`posts tiktok_type: true, tiktok_options: true, tiktok_status: true` + índice
`posts_tiktok_post_id_idx` presente; índices YT (`posts_youtube_video_id_idx`) preservados.

---

## 2. Auditoria item a item

### 1. lib/planner-runtime.ts — PEQUENAS FUNÇÕES PURAS PRESERVADAS ✓
- `resolveFinalCaption(platform, item)`: régua única F4 intacta — `caption_youtube ?? caption`
  (youtube), `caption_instagram ?? caption` (instagram), `caption_tiktok ?? caption` (tiktok),
  genérica senão. Semântica `??` (vazio por plataforma = escolha explícita). Novo ramo tiktok
  é isolado — `resolveFinalCaption("youtube", {caption_tiktok})` continua retornando a genérica
  (assert no smoke tiktok-captions).
- `buildYoutubeOptionsForPost` (F2/M5/M17/M18): continua ÚNICA função — usada em `buildPostData`
  E `propagatePlannerConfigToPendingPosts`; cadeia de título/products/description/herança intacta.
  `buildTiktokOptionsForPost` é ramo separado, retorna `null` para plataforma ≠ tiktok.
- `selectedContent` select: `caption_tiktok` ADICIONADO junto, `caption_youtube`/`caption_instagram`
  mantidos (nenhum campo removido).
- `buildPostData`: YT (youtube_type short/community) e IG (caption/media_type) com a MESMA lógica;
  TikTok é `if` adicional — media IMAGE/CAROUSEL bloqueado só quando canal tiktok.
- Propagação: re-deriva youtube_options só para `ytType === "short"`; tiktok_options só para
  `tkType === "video"`; regra M5/B2 (não apagar options existentes quando rebuild retorna null) respeitada nos dois.

### 2. lib/planner-config.ts — normalize/validate INTACTOS ✓
- `parsePlannerConfig`/`validatePlannerConfig`: youtube_products (Array<{query,item?}> | strings |
  CSV) e captions/templates validados como antes; bloco TikTok adicionado DEPOIS e permissivo
  (campo presente → valida; vazio/null ≡ ausente). Nenhum early-return novo antes do bloco YT.
- `privacy_level` alias genérico só valida quando há contexto tiktok (`tiktok_privacy_level`/
  `tiktok_caption` presentes) — não interfere em configs YT/IG.
- Exclusividade `youtube_type` × `tiktok_type` adicionada ao final: só impede tipo conflitante,
  não bloqueia config mista (isolation de canais faz o 400).

### 3. app/api/cron/publisher/route.ts — PUBLISHER INTACTO ✓
- `publishTiktokPost` (linha 631) inserido ANTES de `publishYoutubePost` (1253) — corpo de YT não
  tocado pelo merge (diff: 3 hunks — imports, bloco novo, dispatcher).
- Dispatcher: branch TikTok → branch YT → IG (fallthrough original). `continue` após tiktok/YT
  impede fallthrough; posts IG não têm `tiktok_type`/`youtube_type` então chegam ao lane IG.
  Marcadores `tiktok_type`/`youtube_type` cobrem canal deletado (platform null), como o YT já fazia.
- `MalformedDataError`/`classifyError` inalterados — tiktok reutiliza (fail "Malformed Data" para
  init inválido, "Publishing Failed" para upstream; "Missing Credentials" para token ausente).

### 4. app/api/planners/** — 400 de mix preservado com 3 pernas ✓
- `planners/route.ts`, `[id]/route.ts`, `[id]/duplicate/route.ts`: `validatePlannerChannelMix`
  (lib/planner-config) → YT+IG retorna `PLANNER_MIX_ERROR` (400) EXATAMENTE como antes; mix com
  TikTok retorna `PLANNER_TIKTOK_MIX_ERROR` (dedicado). Um canal só (qualquer plataforma) passa.
- `create`/`update`/`duplicate` chamam o mix check ANTES do insert de canais — validação baseada
  em plataformas reais do banco, não em campos de config (não quebra por causa de tiktok_options).

### 5. components/PlannerWizard.tsx — SEÇÕES CONDICIONAIS OK ✓
- `onlyYoutubeSelected` / `onlyInstagramSelected` inalterados; `onlyInstagramSelected` exige
  `!tiktokSelected` (memo novo) — selection IG não arrasta tiktok.
- Media selector: só-tiktok → opção única "Vídeo TikTok"; senão os 4 tipos com labels YT
  (Short do YouTube / Post na Comunidade / Carrossel·Comunidade) e IG (Reels/Story), `STORIES`
  oculto quando youtubeSelected||tiktokSelected (auto-fix para REELS, pré-existente).
- Campos IG (Share to Feed, Location, Collabs, Audio, User Tags) ocultos com
  `!onlyYoutubeSelected && !onlyTiktokSelected` — sem duplicar seções; "Configurações TikTok" é
  bloco separado `onlyTiktokSelected`.
- Submit: guards YT (título do Short, texto da Comunidade) intactos; guard TikTok adicionado depois.

### 6. app/api/content-items/* — WHITELISTS OK ✓
- `POST_ALLOWED_FIELDS`/`PATCH_ALLOWED_FIELDS` adicionaram só `caption_tiktok` (e `upload-chunk`
  leu `captionTiktok` do formData); `caption_youtube`/`caption_instagram`/`youtube_products`/`tags`/
  `url` etc. permanecem. Sem mass assignment: `caption_tiktok` passa pela MESMA `sanitizeCaption`
  (trim + 2200 + escape `<`/`>`) das demais.

### 7. lib/folder-captions.ts — TRIPLE CAPTIONS ✓
- `readFolderCaptions`: `tiktok.txt` → `captionTiktok` com a MESMA regra de `youtube.txt`/
  `instagram.txt` (case-insensitive); genérico = qualquer `.txt` que NÃO seja os 3 reservados.
- Vazio preserva `""` (smoke: `tiktok.txt` vazio não cai na genérica — spec F4).
- Observação (comportamento pré-existente, NÃO regressão): no `upload-chunk/complete`, caption
  vazia/tikTok cai em spread `?:` → coluna null no DB → runtime faz fallback à genérica; o mesmo
  vale para youtube/instagram (F4 original). A camada folder-captions (`""`) e a camada DB (null)
  divergem — idêntico para as 3 plataformas; documentado, não corrigido aqui para manter simetria.

### 8. Migrations — CONFLITO ENCONTRADO E CORRIGIDO (ver §1)
- 0011: no-op intencional (settings JSON no Channel) — ok.
- 0012: `ALTER TABLE content_items ADD COLUMN caption_tiktok TEXT` — SQLite válido, padrão 0009/0010.
- Gap: colunas de `posts` sem migration → **0013 adicionada** (fix §1).
- Nenhum conflito com 0008/0009/0010 (colunas distintas, aditivo).

### 9. Canais (extra do merge, conferido)
- `app/api/channels/route.ts` + `[id]/route.ts`: `toSafeChannel` preserva shape pré-existente
  (access_token removido, has_token/token_source/proxy_id fields), adiciona `has_tiktok_token`/
  `tiktok_open_id_masked` e nunca expõe `tiktok_access_token`/`refresh_token` cru.
- `contexts/UploadContext.tsx`: campo `captionTiktok` aditivo no UploadTask/UploadOpts; fluxo de
  pasta usa `readFolderCaptions` (triple).

---

## 3. Verificação (barra)

| Checagem | Resultado |
|---|---|
| `npx tsc --noEmit` | **0 erros** |
| `npm run build` (after rm -rf .next) | **OK** (routas completas, exit 0) |
| `prisma migrate deploy` 0001→0013 (DB novo) | **OK**, colunas tiktok presentes |
| `prisma db push` (DB teste) | **OK**, colunas presentes |

### Smokes `.mts` (todos verdes)

| Smoke | Resultado |
|---|---|
| `products-routing.mts` (pré-existente) | 20 PASS, 0 FAIL |
| `planner-direct.mts --db` (pré-existente, PL1–PL6) | PASS (PL1..PL6) |
| `planner-edit-direct.mts --db` (pré-existente) | PASS (S3direct, S4direct) |
| `tiktok-a2-smoke.mts` | 16 PASS, 0 FAIL |
| `tiktok-captions.mts` | 24 PASS, 0 FAIL |
| `tiktok-isolation.mts` | 16 PASS, 0 FAIL |
| `tiktok-publishing.mts` | 70 PASS, 0 FAIL |
| `tiktok-watcher.mts` | 17 PASS, 0 FAIL |

Obs.: `planner-direct/planner-edit-direct` precisam de DB preparado (driver do planner-run.sh usa
`prisma db push`); rodados contra `/tmp/s3-test.db` com schema atual (inclusive colunas tiktok).

---

## 4. Observações (não-bloqueantes)

1. **Import morto** `TIKTOK_PRIVACY_FALLBACK` em `app/api/planners/[id]/preview/route.ts` (A4):
   importado, não usado. `tsc` não acusa (`noUnusedLocals` off); deixo para o lint baseline.
2. Build com `next dev` ativo disputa `.next` (ENOENT transitório em `pages-manifest.json`/
   `validator.ts`/`_buildManifest.js.tmp`): rodar build sem dev server concorrente (ou limpar `.next`).
3. Durante a auditoria havia uma sessão concorrente rodando `next build`  — a falha inicial do
   build foi essa corrida, não o código.

## 5. Risco residual

- Publicação TikTok real (iniciar upload via API) não foi exercitada neste ambiente; smokes usam
  mock/fetch-mock. A coluna `tiktok_status`/fluxo de polling depende do contrato real da API TikTok
  (validado em A2/A5 smokes com contract mock, fora do escopo de regressão YT/IG).