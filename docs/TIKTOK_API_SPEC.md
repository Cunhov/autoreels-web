# SPEC — Integração TikTok (Content Posting API / Direct Post) no autoreels-web

> **Fonte única de verdade para os agentes A1–A5.** Relacionado: `docs/TIKTOK_GAUNTLET_PLAN.md` (plano), `docs/TIKTOK_OPERATOR_GUIDE.md` (operar). Stack: Next.js 16 + Prisma (SQLite) + `lib/tiktok.ts`.

---

## 1. Escopo v1 (fechado)

| Suportado | Não suportado (fase 2) |
| --- | --- |
| OAuth Login Kit (code → access_token) | Upload de foto / carrossel (`/v2/post/publish/content/init/`) |
| Refresh token automático | TikTok Shop tagging |
| Query Creator Info (privacy/duração/toggles) | Stories |
| **Direct Post — vídeo** `FILE_UPLOAD` (chunked) | `IMAGE` / `CAROUSEL` → bloqueado com erro PT-BR |
| **Direct Post — vídeo** `PULL_FROM_URL` (domínio verificado) | |
| Publisher resiliente via cron | |

---

## 2. Chaves de API / Endpoints externos

Todos os endpoints abaixo são chamados **somente server-side** via `lib/tiktok.ts`, com `fetchWithTimeout` e **proxy do canal repassado** (`getChannelProxyUrl`).

| Função | Método | Endpoint | Notas |
| --- | --- | --- | --- |
| `exchangeCodeForToken` | `POST` | `https://open.tiktokapis.com/v2/oauth/token/` | `grant_type=authorization_code` |
| `refreshTiktokToken` | `POST` | `https://open.tiktokapis.com/v2/oauth/token/` | `grant_type=refresh_token` |
| `fetchTiktokCreatorInfo` | `POST` | `https://open.tiktokapis.com/v2/post/publish/creator_info/query/` | body `{}`, retorna privacy/duração/toggles |
| `createTiktokVideoInit` | `POST` | `https://open.tiktokapis.com/v2/post/publish/video/init/` | `post_info` + `source_info` |
| `uploadTiktokChunks` | `PUT` | `{upload_url}` (do init) | `Content-Range: bytes X-Y/Z` |
| `fetchTiktokPublishStatus` | `POST` | `https://open.tiktokapis.com/v2/post/publish/status/fetch/` | body `{ publish_id }` |

Auth em todas: header `Authorization: Bearer {access_token}`.

---

## 3. Env & VPS

```
# OBRIGATÓRIO
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_REDIRECT_URI=https://autoreels.cunhov.site/api/tiktok/oauth/callback

# OPCIONAL — só se usar PULL_FROM_URL
TIKTOK_VERIFIED_DOMAIN=autoreels.cunhov.site
```

- **Whitelist no TikTok Developer Console**: `https://autoreels.cunhov.site/api/tiktok/oauth/callback` e, para PULL_FROM_URL, `https://autoreels.cunhov.site/api/file/*`.
- **Domínio verificado** no app TikTok é **obrigatório** para `PULL_FROM_URL`. Como `autoreels.cunhov.site` é o domínio de produção, priorizamos `FILE_UPLOAD` (chunked) como default para evitar atrito.
- **Sandbox vs Production**: durante desenvolvimento usar **Sandbox** (creator de teste). A submissão para **Production** (que libera Direct Post de verdade) passa por **revisão do TikTok Developer** — não bloqueia o desenvolvimento (docs: `docs/TIKTOK_OPERATOR_GUIDE.md` §5).

---

## 4. Limites oficiais (Media Transfer Guide) — validados em `lib/tiktok.ts`

Constantes em `lib/tiktok.ts` (fonte única do publisher; `planner-config` para o wizard):

| Parâmetro | Valor | Validação PT-BR |
| --- | --- | --- |
| Tamanho máximo | **500 MB** | `Vídeo excede tamanho máximo de 500 MB (X.X MB)` |
| Duração mínima | **3 s** | `Vídeo muito curto (mínimo 3 s)` |
| Duração máxima | `max_video_post_duration_sec` do creator (default 600 s) | `Vídeo excede duração máxima de X s para este criador` |
| Formatos | MP4 / MOV / WebM, H.264 + AAC | `Formato não suportado (use MP4 H.264)` |
| Título | **1–2200 chars**, hashtags permitidas | `Título excede 2200 caracteres (N)` |
| Ratio | 9:16 / 1:1 / 16:9; 540p–4K | (não validado localmente) |
| Chunk upload | 5–10 MB por chunk | `Content-Range: bytes X-Y/Z` |

`validateTiktokVideo({size, durationSec, format, titleLen, title, privacy, maxDurationSec, coverTimestampMs})` → `{valid, error?}` com mensagens PT-BR. É chamado **antes de qualquer chamada externa** no `buildTiktokInitPayload` e no `createTiktokVideoInit`.

---

## 5. Privacy levels & toggles

- `privacy_level`: `PUBLIC_TO_EVERYONE` | `MUTUAL_FOLLOW_FRIENDS` | `FOLLOWER_OF_CREATOR` | `SELF_ONLY` (opções vindas do `creator_info/query`; fallback = as 4 acima).
- Toggles no `post_info`: `disable_duet`, `disable_stitch`, `disable_comment` (default = estado do creator quando a plataforma os desabilita).
- Cover: `video_cover_timestamp_ms` (ms, 0 = auto, hint "1000 = 1s").
- Brand: `brand_content_toggle`, `brand_organic_toggle` (só se creator elegível; senão erro PT-BR `Conteúdo de marca não permitido para este criador`).

---

## 6. Campos persistidos

- `Channel.settings` (JSON): `tiktok_open_id`, `tiktok_access_token`, `tiktok_refresh_token`, `tiktok_expires_at` (epoch s), `tiktok_refresh_expires_at`, `tiktok_scopes`, `tiktok_token_type`. **Merge JSON** — não sobrescreve `proxy_url`/`proxy_enabled`.
- `ContentItem.caption_tiktok` (TEXT): legenda específica do TikTok; `?? caption` como fallback.
- `Post`: `tiktok_type` (`video` v1), `tiktok_options` (JSON: `{title, privacy_level, disable_duet, disable_stitch, disable_comment, video_cover_timestamp_ms, brand_content_toggle, brand_organic_toggle}`), `tiktok_post_id`, `tiktok_publish_id`, `tiktok_status`, `tiktok_failed_reason`.

---

## 7. Erros TikTok → PT-BR

`mapTiktokErrorToPortuguese(code|message)` e `getTiktokErrorMessage(err)` cobrem (não-exaustivo):

`access_token_invalid`, `access_token_expired`, `invalid_token`, `rate_limit`, `rate_limit_exceeded`, `too_many_requests`, `video_too_long`, `video_too_large`, `video_too_short`, `invalid_video_format`, `unsupported_format`, `privacy_not_allowed`, `privacy_level_not_allowed`, `invalid_privacy_level`, `invalid_title`, `title_too_long`, `brand_content_not_allowed`, `brand_not_eligible`, `cover_timestamp_invalid`, `url_not_verified`, `domain_not_verified`, `chunk_upload_failed`, `upload_failed`, `publish_failed`, `internal_error`, `server_error`.

### Rate limit / retry (não derruba o publisher)

- `429` + header `Retry-After`: `parseRetryAfterMs` (segundos ou data) → `getTiktokBackoffMs` (usa `Retry-After`, senão exp `2000 * 2^(attempt-1)`, cap 60 s).
- `classifyTiktokError(err, status)` → `"definitive" | "transient" | "rate-limited"`.
- Upload de chunk tem **retry 1x** em 429/5xx por chunk.
- Publisher marca o post `failed` com `failed_reason` PT-BR; erro `rate-limited`/transitório permite **requeue** (próximo tick).

---

## 8. API interna (app/api/tiktok/*)

| Rota | Método | Descrição |
| --- | --- | --- |
| `/api/tiktok/connect` | GET | Gera link de OAuth (client_key + redirect + scopes) |
| `/api/tiktok/oauth/start` | GET | Inicia fluxo; gera state/CSRF |
| `/api/tiktok/oauth/callback` | GET | Troca code → token; salva `tiktok_*` em `Channel.settings` |
| `/api/tiktok/creator-info` | GET/POST | `?channelId=` → retorna privacy/duração/toggles do creator |
| `/api/tiktok/health` | GET | `?channelId=` → saúde do canal; **nunca** expõe token cru (mascara) |

Regra de segurança: **`proxy_url` e `access_token` jamais são serializados** em resposta de API. `health` expõe apenas `access_token_masked` e `open_id_masked`. (Checado pelo `tiktok-watcher.mts`.)

---

## 9. Isolation

- `lib/tiktok.ts::isTiktokMixBlocked(channels)` e `lib/planner-config.ts::PLANNER_TIKTOK_MIX_ERROR`/`PLANNER_MIX_ERROR`.
- Mensagem: `Planners TikTok não podem misturar canais de outras plataformas.` (400).
- `lib/tiktok.ts::detectChannelPlatform` infere plataforma por `platform` ou settings (`tiktok_open_id`/`sessionId`).
- `validateTiktokMediaType` bloqueia IMAGE/CAROUSEL/STORIES em v1: `TikTok v1: apenas vídeo é suportado...`.

---

## 10. Smokes (A5)

```bash
npx tsx scripts/gauntlet/tiktok-a2-smoke.mts        # 16 casos (upload/publish core)
npx tsx scripts/gauntlet/tiktok-publishing.mts      # 70 casos (compliance/publishing)
npx tsx scripts/gauntlet/tiktok-isolation.mts       # 16 casos (isolation)
npx tsx scripts/gauntlet/tiktok-captions.mts        # 24 casos (captions/tiktok.txt)
npx tsx scripts/gauntlet/tiktok-watcher.mts         # watcher (tsc/prisma/proxy/segredo/isolation)
```

Todos rodam **100% offline** (TikTok mockado in-process) e só saem com exit 0 se 0 falhas.
