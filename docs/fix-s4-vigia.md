# fix-s4-vigia — Auditoria de consistência & segredos (S4)

Branch: `fixes-monolith` (HEAD 9242e7a) — trabalho em `s4-vigia`.
Escopo: varredura de inconsistências, vazamento de segredos, isolamento e
deadlocks introduzidos na linha `feat(tiktok)` A1→A5.

Barra: `tsc --noEmit` 0 | `npm run build` OK | `prisma validate` OK |
deploy 0001→0013 em DB limpo OK (sem drift) | nenhum segredo exposto (grep).

---

## P0 — CORRIGIDO: migration faltante para `Post.tiktok_*`

**Sintoma:** `prisma/schema.prisma` declara `tiktok_type`, `tiktok_post_id`,
`tiktok_publish_id`, `tiktok_options`, `tiktok_status` + index
`posts_tiktok_post_id_idx` no model `Post` (adicionados em 62ab85d A4), mas
**nenhuma migration cria essas colunas** — `0011_add_tiktok_channel_fields` é
no-op (`SELECT 1`) e `0012` só adiciona `content_items.caption_tiktok`.

**Impacto em produção:** `migrate deploy` (scripts/db-migrate.sh) deixa a
tabela `posts` sem as colunas. `buildPostData` (lib/planner-runtime.ts) cria
posts com `tiktok_type/tiktok_options/tiktok_post_id` **explícitos (inclusive
NULL)** → `INSERT INTO posts (…, tiktok_type, …)` → SQLite:
`table posts has no column named tiktok_type` → **TODA criação de post de
planner quebra em produção** (não só TikTok). O publisher também faz SELECT
desses campos.

**Prova:** `prisma/dev.db` local (db push pré-A4) não tem colunas tiktok;
`_prisma_migrations` parava em 0006.

**Correção:** `prisma/migrations/0013_add_tiktok_post_fields/migration.sql`
(ALTER TABLE x5 + index, estilo aditivo espelhando `0005_youtube_post_fields`).
Verificação: `migrate deploy` num DB limpo aplica 0001→0013 e `db push`
reporta **in sync** (zero drift).

## P1 — CORRIGIDO: `raw: info` (raw API passthrough) em creator-info

`app/api/tiktok/creator-info/route.ts` retornava `raw: info` — o objeto
inteiro de `fetchTiktokCreatorInfo`, que faz spread de **todo o payload
desconhecido** do TikTok (`…payload`). Nenhum segredo está no payload atual
(só creator_*, privacy_level_options, toggles, max_duration), mas a regra do
gauntlet é **jamais repassar resposta crua de API externa ao client**. O
client (PlannerWizard) só consome os campos whitelistados. Removido `raw` +
comentário da regra.

## P2 — CORRIGIDO: nome não escapado no caminho de idempotência do planner

`app/api/planners/route.ts` POST: o branch com `x-idempotency-key` (que o
wizard **sempre** envia) gravava `name` cru; o branch normal usava `safeName`
(`escapeHtml`). Inconsistência → todos os planners criados pelo wizard iam sem
escape (stored XSS latente; React escapa na renderização, mas o dado no banco
ficava sujo). Unificado para `safeName`.

## P1/P2 — DOCUMENTADOS (não alterados, pré-existentes / decisão de produto)

- `app/api/channels/[id]/token/route.ts` retorna o **token IG cru** ao client
  (UX "copiar token" em app/channels/page.tsx:208). É endpoint dedicado,
  autenticado e **pré-existente** (escopo IG; TikTok nunca passa por aqui —
  canal TikTok tem `access_token` NULL, retorna 404). P2: superfície XSS
  conhecida, fora do escopo desta linha.
- `app/api/channels/[id]/test/route.ts` ecoa `body.slice(0,500)` da resposta
  remota (admin-only, proxy sempre `maskProxyUrl`). P2.
- `app/api/planners/[id]/duplicate/route.ts` retorna 500 em erro genérico
  (POST usa 400) — menor, pré-existente, o check de mix já devolve 400.

---

## Verificação por eixo do mandato

### 1. SEGREDOS (`grep` em todos os responses)
- `tiktok/health` → `access_token_masked` (máscara 4***4), `client_key_masked`,
  nunca cru. ✓
- `tiktok/oauth/start` → só `{ url }` de autorização (state assinado). ✓
- `tiktok/oauth/callback` → persiste tokens no `Channel.settings` (JSON) e
  redireciona com `connect=success` **sem** tokens na URL. ✓
- `channels` e `channels/[id]` → `toSafeChannel` descarta `access_token`/
  `proxy_url` crus; `settings` re-serializado **sem** `tiktok_access_token`/
  `tiktok_refresh_token`; `proxy_url_masked`. ✓
- `settings` → chaves sensíveis só `{ set, masked }`. ✓
- `creator-info` → agora whitelist explícita (P1 acima). ✓
- Publisher/cron → tokens só em `Authorization`/corpo externo; erro salvo via
  `mapTiktokErrorToPortuguese` (PT-BR). Nenhum `console.*` imprime token. ✓
- **Conclusão: nenhum response expõe token cru do TikTok.**

### 2. ISOLATION (planners)
- POST (route.ts), PATCH ([id]/route.ts) e duplicate ([id]/duplicate/route.ts)
  chamam `validatePlannerChannelMix` quando >1 canal → 400 PT-BR.
- Mensagens: `PLANNER_MIX_ERROR` ("Planners não podem misturar canais de
  YouTube e Instagram…") e `PLANNER_TIKTOK_MIX_ERROR` dedicada ("Planners
  TikTok não podem misturar canais de outras plataformas.") — consistente nos
  3 caminhos. ✓
- `duplicate` de planner TikTok single-canal: `validatePlannerChannelMix`
  retorna ok (1 plataforma) → clone criado. ✓
- Wizard client-side também bloqueia mix antes do submit. ✓

### 3. DEADLOCK / PROPAGAÇÃO
`propagatePlannerConfigToPendingPosts` (lib/planner-runtime.ts):
- `CAPTION_PROPAGATION_KEYS` inclui `tiktok_caption/title/privacy_level/
  disable_duet/disable_stitch/disable_comment/video_cover_timestamp_ms/
  brand_content_toggle/brand_organic_toggle`. ✓
- `tiktok_options` re-derivado pela **mesma** `buildTiktokOptionsForPost` da
  criação; guarda M5: `rebuilt !== null` senão **preserva** o existente (nunca
  apaga dados de publicação). ✓
- M5 YouTube intacto: `youtube_options` só reescrito quando `rebuilt !== null`
  (título não resolúvel → preserva). ✓
- M14 anti-race: `updateMany` com `status IN (pending,scheduled,queued)` no
  WHERE + batch de 50 com yield (sem travamento long em SQLite). ✓
- `shouldPropagateConfig` detecta mudaças de caption/tiktok → propaga. ✓

### 4. Erros PT-BR
- `TIKTOK_ERROR_MAP` cobre token inválido/expirado, rate limit, vídeo, formato,
  privacy, título, brand, cover, domínio, upload/publish. ✓
- Publisher grava `error_message` mapeado PT-BR (ex.: "Token do TikTok inválido
  — reconecte o canal em Canais"). Logs internos não vazam (só post id). ✓
- Mensagens novas tiktok consistentes com o padrão do app (ex.: "channelId é
  obrigatório." — PT-BR; "Channel not found" segue convenção global). ✓

### 5. Missing de campos
- `Post` (schema): `tiktok_type/post_id/publish_id/options/status` ✓ (agora com
  migration 0013).
- Whitelists: `content-items` POST/PATCH incluem `caption_tiktok` sanitizada
  (`sanitizeCaption`: trim + CAPTION_MAX 2200 + escapeHtml; vazio→null;
  bulk vazio=manter). `upload-chunk/complete` sanitiza `captionTiktok`. ✓
- `posts/route.ts` POST_ALLOWED_FIELDS **não** inclui `tiktok_*` — correto:
  posts TikTok são criados exclusivamente pelo runtime do planner
  (`buildPostData`), server-side. ✓
- Propagação inclui `caption_tiktok` por post (resolveFinalCaption). ✓

### 6. Migrações / schema
`node ./node_modules/prisma/build/index.js validate` OK; `generate` OK;
`migrate deploy` 0001→0013 em DB limpo OK; `db push` → "in sync".
`channel.settings` (0002), `proxy_url/proxy_enabled` (0008),
`content_items.caption_tiktok` (0012), `posts.tiktok_*` (0013 NOVA). ✓

### 7. lens_diagnostics (modo all → arquivos da sessão)
Tool `lens_diagnostics` não está exposto neste harness; executado o equivalente
`pi-lens-analyze` (fast runners: tree-sitter/ast-grep/lint) em
`creator-info/route.ts`, `planners/route.ts`, `planners/[id]/route.ts`,
`lib/planner-runtime.ts`, `lib/planner-config.ts`, `schema.prisma`:
- **0 blockers reais.** Flagados "error-swallowing: catch{}" são guards
  best-effort **intencionais e comentados** (idempotência, safety de propagação).
- Avisos restantes: complexidade alta (validatePlannerConfig 164),
  deep-nesting, console-statements — pré-existentes, estilo do repo (logs
  deliberados), sem relação com esta linha. LATEST: tsc 0 + build OK.

### 8. Barra
`tsc --noEmit` 0 ✓ | `npm run build` ✓ (todas as rotas compilam) |
nenhum segredo exposto (greps acima) | `docs/fix-s4-vigia.md` ✓.

---

Commit: `fix(tiktok): S4 consistência & segredos`. Sem push.
Resumo: 1 P0 + 1 P1 + 1 P2 corrigidos; 2 P2 pré-existentes documentados.