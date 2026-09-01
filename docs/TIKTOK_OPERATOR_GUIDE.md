# Guia do Operador — TikTok no autoreels-web

> Passo a passo para conectar um canal TikTok, testar e publicar via Content Posting API (Direct Post). Relacionado: `docs/TIKTOK_API_SPEC.md` (spec técnica).

---

## 1. Pré-requisitos

1. Conta no **[TikTok for Developers](https://developers.tiktok.com)** e um **app** criado.
2. **Domínio verificado** no app (obrigatório para `PULL_FROM_URL`; recomendado mesmo para `FILE_UPLOAD` para evitar atrito em review).
3. App com as permissões: `user.info.basic` + `video.publish` (+ `video.upload` se exigido no app).
4. **Direct Post** habilitado (passa por **revisão do TikTok** — em Sandbox funciona com creator de teste; Production precisa de aprovação).

---

## 2. Configurar o ambiente (env)

No arquivo `.env` / `.env.vps.txt`:

```
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_REDIRECT_URI=https://autoreels.cunhov.site/api/tiktok/oauth/callback
# opcional (PULL_FROM_URL):
TIKTOK_VERIFIED_DOMAIN=autoreels.cunhov.site
```

Depois:
```bash
npx prisma generate
npx prisma validate
```

---

## 3. Whitelist (TikTok Developer Console)

No app, em "Redirect URIs" e (se usar URL) em "URLs permitidas", adicionar:

- `https://autoreels.cunhov.site/api/tiktok/oauth/callback`
- `https://autoreels.cunhov.site/api/file/*` (para PULL_FROM_URL)

Confira se o domínio `autoreels.cunhov.site` está **verificado** no console.

---

## 4. Conectar um canal (flow completo)

1. Suba o app (dev ou VPS).
2. No UI "Canais", acione **Conectar TikTok** → abre o fluxo OAuth: `GET /api/tiktok/connect` → `api/tiktok/oauth/start` → autorização na TikTok → `api/tiktok/oauth/callback` → token salvo em `Channel.settings`.
3. Verifique a conexão:
   - `GET /api/tiktok/health?channelId=<id>` → deve retornar `ok: true`, `access_token_masked`, `expires_in_sec`.
4. Consulte o perfil do criador:
   - `GET /api/tiktok/creator-info?channelId=<id>` → retorna `privacy_level_options`, `max_video_post_duration_sec`, `comment_disabled`, `duet_disabled`, `stitch_disabled`.

> Se o token expira, o `getValidTiktokAccessToken` faz **refresh automático** (usa `refresh_token`). Se o refresh falhar, reconecte o canal.

---

## 5. Sandbox vs Production — checklist

**Sandbox (durante dev):**
- [ ] App em modo Sandbox no console TikTok
- [ ] Creator de teste adicionado como usuário do app
- [ ] Token OAuth funciona com o creator de teste
- [ ] Direct Post (init → upload → status) responde em Sandbox

**Produção (antes de ir live):**
- [ ] Submeter o app para **revisão** do TikTok (Direct Post)
- [ ] Aprovar/obter "Live" no console
- [ ] Confirmar domínio verificado (`autoreels.cunhov.site`)
- [ ] Confirmar todas as scopes aprovadas em produção
- [ ] Rodar `scripts/gauntlet/tiktok-*.mts` (offline) como smoke de sanidade
- [ ] Testar 1 publicação real com `SELF_ONLY` antes de público

---

## 6. Testar publicação

Smokes offline (nenhuma chamada real sai da máquina):

```bash
npx tsx scripts/gauntlet/tiktok-a2-smoke.mts        # upload/publish core
npx tsx scripts/gauntlet/tiktok-publishing.mts      # compliance + publishing completo
npx tsx scripts/gauntlet/tiktok-isolation.mts       # isolation (mix bloqueado)
npx tsx scripts/gauntlet/tiktok-captions.mts        # captions (tiktok.txt / caption_tiktok)
npx tsx scripts/gauntlet/tiktok-watcher.mts         # watcher (segredos/proxy/tsc/prisma)
```

Todos só têm exit 0 se **0 falhas**.

### Testar com canal real (opcional, após aprovação)

1. Crie/edite um item na library com **Legenda TikTok** (ou coloque `tiktok.txt` na pasta do conteúdo).
2. Crie um planner **só com canal TikTok** e agende.
3. Acompanhe `Post.tiktok_status`/`tiktok_post_id` e, se falhar, `tiktok_failed_reason` (PT-BR).

---

## 7. Publicar (publisher via cron)

O `POST /api/cron/publisher` gerencia `publishTiktokPost(post, channel, now)`:

- Guard `tiktok_type` (só `video`; `photo` → erro).
- Resolve token válido (`getValidTiktokAccessToken`), caption (`caption_tiktok ?? caption`), `tiktok_options`.
- Toda chamada externa usa o **proxy do canal** (`getChannelProxyUrl`).
- `FILE_UPLOAD` (default): init → `uploadTiktokChunks` → poll status.
- Erros: PT-BR em `failed_reason`; 429/erros transitórios permitem requeue; `MalformedDataError` para config inválida.
- Respeita `minIntervalMs` global, heartbeat e race-guard.

---

## 8. Problemas comuns

| Sintoma | Causa provável | Ação |
| --- | --- | --- |
| `Token do TikTok inválido ou expirado` | token expirado / sem refresh | Reconectar o canal em Canais |
| `Domínio do vídeo não verificado` | PULL_FROM_URL sem domínio verificado | Usar FILE_UPLOAD ou verificar domínio |
| `Conteúdo de marca não permitido` | creator não elegível p/ brand toggle | Desligar toggles de marca |
| `Limite de requisições atingido` | rate limit (429) | Aguardar; retry automático no publisher |
| `Vídeo excede duração máxima` | vídeo > limite do creator | Reduzir duração ou aumentar limite do creator |

---

## 9. Segurança

- `lib/tiktok.ts` **nunca** devolve token cru em resposta de API (`maskTiktokToken`, `maskTiktokOpenId`).
- `proxy_url`/`access_token` não aparecem nos JSONs das rotas (auditado pelo `tiktok-watcher.mts`).
- Proxy do canal é repassado em **todas** as chamadas externas TikTok.
