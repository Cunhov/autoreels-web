# Fix B3 — videoId da busca de produtos usa `sacrifice_video_id` da sessão remota

**Branch:** `feat/yt-products-dual-captions` · **Commit:** `cad96ef` (app) + API `1efc081`
**Natureza:** correção do fallback de videoId na busca de produtos afiliados.
**Motivação:** o app exigia "publique um Short primeiro" mesmo quando o `sacrifice_video_id`
já estava configurado na API externa. O vídeo isca NÃO deve ser puxado do app — ele já
existe na sessão da API (usado pela token farm).

## O que mudou

### API externa (`~/Projects/youtube-community-api`, commit `1efc081`)
- `app/models/session.py:92` — `SessionResponse` ganha `sacrifice_video_id: str | None = None`.
- `app/api/session.py:119` e `:148` — `list_sessions`/`get_session` incluem
  `sacrifice_video_id` no SELECT e na resposta.
- `app/api/shorts.py:185` — `GET /{session_id}/products`:
  - `video_id` agora **opcional** (`Query("")`);
  - quando vazio, resolve `sacrifice_video_id` da sessão (via `get_session_farm_config`);
  - se também vazio → 400 com orientação clara
    ("informe 'video_id' ou configure o vídeo isca via POST /api/sessions/{id}/config");
  - `search_products`/`get_product_suggestions` nunca recebem videoId vazio.
- Testes: `48 passed`.

### App (`autoreels-web`, commit `cad96ef`)
- `lib/youtube.ts` — `YoutubeSession.sacrifice_video_id?: string | null`; limpeza do `as any`
  em `getYoutubeSessionId` (objeto tipado).
- `app/api/youtube/products/route.ts` — `resolveVideoIdForProductSearch` agora recebe
  `{ explicitVideoId, channelId, sessionId, proxyUrl }` e resolve na ordem:
  1. `videoId` explícito na query (retrocompat, prioridade máxima);
  2. último Short publicado do canal (`Post.youtube_video_id`, published, orderBy desc);
  3. `sacrifice_video_id` da sessão remota via `getSession(sessionId, proxyUrl)` (proxy do canal
     já era suportado por `getSession`);
  4. nenhum → 400 PT-BR claro.
- Erro de sessão remota não propaga 502: cai no 400 com orientação.

## Como testar
1. Canal YT sem nenhum Short publicado, mas com `sacrifice_video_id` configurado na API
   (`POST /api/sessions/{id}/config {sacrifice_video_id=VIDEO_ID}`).
2. `GET /api/youtube/products?channelId=&query=caderno` → esperado 200 com produtos
   (videoId resolvido do sacrifício), sem "publique um Short primeiro".
3. Sem sacrifício e sem Short → 400 com mensagem clara.
4. Retrocompat: `GET /api/youtube/products?channelId=&videoId=VIDEO&query=` mantém prioridade do explícito.

## Riscos residuais
- Se a API externa em produção estiver numa versão anterior (sem `sacrifice_video_id` na
  resposta), o fallback 3 retorna `undefined` silenciosamente → cai no 400 (comportamento seguro).
- `getSession` exige sessão com canal válido; sessão expirada → 400 orientativo (não false-positivo).
- A API externa precisa do commit `1efc081` (atualização do repositório da API em produção).
