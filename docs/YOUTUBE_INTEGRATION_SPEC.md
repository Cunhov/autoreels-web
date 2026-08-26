# SPEC — Integração YouTube (youtube-community-api) no autoreels-web

> **Fonte única de verdade para todos os agentes.** Leia este arquivo inteiro antes de tocar em qualquer código.
> API externa: FastAPI em `/Users/bestoptionnotebook/Projects/youtube-community-api` (guia completo: `API_GUIDE.md` e `README.md` naquele repo).

---

## 1. Decisões já tomadas pelo dono do app (NÃO redecidir)

1. **Comunicação**: HTTP direto do Next (server-side) → API FastAPI, via env vars.
2. **Conexão de canais**: AMBOS — formulário de cookies NO app (chama `POST /api/session`) E importação de sessões existentes (`GET /api/session`).
3. **Agendamento**: YouTube é plataforma de primeira classe — entra nos planners, calendário, cron/publisher, retries e logs exatamente como o Instagram.
4. **Recursos v1**: TUDO que a API permite — Shorts completo, Post na Comunidade (texto + até 10 imagens), gestão de comentários (listar/criar/curtir/coração/fixar), exclusão de conteúdo.
5. **Upload de vídeo do Short**: multipart upload direto do arquivo armazenado no app (`video` field). NÃO usar video_url.
6. **Produção**: API num domínio público próprio HTTPS → tudo configurável por `.env`.
7. UI em **português (PT-BR)**, seguindo o padrão visual iOS-like existente (componentes `IOSButton`, `IOSComponents`, etc).

## 2. Configuração (.env)

```
YOUTUBE_API_BASE_URL=https://yt-api.seudominio.com   # default: http://localhost:8000
YOUTUBE_API_KEY=<master key>
```

- Criar `lib/youtube.ts` centralizando TODO acesso à API:
  - `getYoutubeConfig()` → lê env, lança erro descritivo se ausente.
  - `youtubeFetch(path, init)` → adiciona header `Authorization: <YOUTUBE_API_KEY>` (a API aceita a chave crua no Authorization ou `X-API-Key`), timeout com o mesmo padrão de `fetchWithTimeout` de `lib/instagram.ts`, e trata erros HTTP lançando `Error` com a mensagem de `detail` do corpo JSON da API.
  - Funções tipadas por domínio (sessions, posts, shorts, comments, products).
- NUNCA chamar a API externa do cliente diretamente — sempre via route handlers server-side.

## 3. Superfície da API externa (endpoints que vamos usar)

Auth: header `Authorization: <api_key>` ou `X-API-Key: <api_key>`. Health não exige auth.

### Sessões/canais

| Método | Rota | Notas |
| --- | --- | --- |
| GET | `/api/health` | `{ok, sessions_active, db_connected, version}` |
| GET | `/api/session` | `{sessions:[{id,label,channel_id,channel_name,status,created_at,last_rotate_at}]}` |
| POST | `/api/session` | body JSON `{cookies:{LOGIN_INFO,__Secure-3PAPISID,__Secure-3PSID,__Secure-3PSIDTS}, label?}` → 201 `SessionResponse` |
| POST | `/api/session/{id}/refresh` | força refresh de tokens/cookies |
| DELETE | `/api/session/{id}` | remove sessão + api keys |

### Comunidade

| Método | Rota | Notas |
| --- | --- | --- |
| POST | `/api/post/upload` | **multipart**: `session_id`, `message`, `images[]` (arquivos JPEG/PNG/GIF/WebP, máx 10) → publica imediatamente |
| POST | `/api/post` | JSON `{session_id, message, image_urls?}` (alternativa com URLs) |
| DELETE | `/api/post` | query `session_id` + `remote_post_id` |

### Shorts

`POST /api/shorts` (**multipart**, exatamente um de `video`(file) ou `video_url`):

- `session_id` (obrigatório), `title` (obrigatório), `description` ("")
- `privacy`: PRIVATE (default) \| PUBLIC \| UNLISTED
- `made_for_kids` bool, `category_id` int (17 default), `monetize_with_ads` bool
- `products` string JSON `'[]'`
- `pinned_comment_text` string opcional (comentário fixado automático)
→ 201 `ShortResponse`: `{id, session_id, channel_id, video_id, title, privacy, status, error_message, watch_url, created_at, updated_at}`

Outros:

| Método | Rota | Notas |
| --- | --- | --- |
| GET | `/api/shorts?session_id=` | lista tentativas |
| GET | `/api/shorts/{id}` | status de uma tentativa |
| GET | `/api/videos/{video_id}/comments?session_id=&limit=20` | lista comentários |
| POST | `/api/videos/{video_id}/comments` | form `session_id`,`text` |
| POST | `/api/videos/{video_id}/comments/action`* | form `session_id`,`comment_id`,`action`=like\|heart\|pin |
| POST | comentário fixado | form `session_id`,`text`,`like` bool,`heart` bool (rota sob `/api/videos`) — conferir path exato em `app/api/shorts.py` |
| GET | `/api/sessions/{session_id}/products...` | catálogo de produtos afiliados (conferir path exato; params: `query`,`video_id`,`suggestions`,`title`,`description`,`vendors`,`min_commission_pct`,`sort`,`limit`) |

> ⚠️ Antes de implementar rotas de comentários/produtos, conferir os paths EXATOS em `/Users/bestoptionnotebook/Projects/youtube-community-api/app/api/shorts.py` (routers `video_router` prefix `/api/videos`, `session_router` prefix `/api/sessions`).

## 4. Modelo de dados (Prisma)

- `Channel` com `platform = "youtube"`:
  - `account_id` = channel_id do YouTube (`UC...`)
  - `username` = channel_name, `profile_picture_url` se disponível
  - `settings` (JSON) = `{ "sessionId": "<id da sessão na YT API>" }` — SEMPRE ler/escrever sessionId por aqui. Não guardar cookies no banco do app.
- `Post` — adicionar campos (migration):
  - `youtube_type String?` → `"short"` | `"community"`
  - `youtube_video_id String?`
  - `youtube_post_id String?` (remote post id da comunidade, p/ exclusão)
  - Opções de publicação do Short (título/descrição/privacy/made_for_kids/monetize/pinned_comment) → campo JSON novo `youtube_options String?` (ou reaproveitar campo JSON existente se houver) — decidir lendo o schema atual.
- `ContentItem`: reaproveitar mídia existente (vídeos p/ Short; imagens p/ Comunidade). Não mudar o modelo sem necessidade.
- Rodar `npx prisma migrate dev` (ou o fluxo de migration do repo) e manter `prisma/schema.prisma` consistente.

## 5. Publisher (app/api/cron/publisher/route.ts)

Branch nova quando `channel.platform === "youtube"`:

1. Ler `settings` do canal → `sessionId`.
2. `youtube_type === "short"`: abrir o arquivo de vídeo do storage local (mesmo mecanismo que `app/api/file/[...path]/route.ts` usa), montar `FormData` nativo (Node 20+: `new FormData()` + `new Blob([buffer])` / `fileFromSync` equivalente) e `POST /api/shorts`. Sucesso ⇒ salvar `youtube_video_id` (= `video_id`) e marcar post publicado. Falha ⇒ mesmos retry/log patterns do Instagram (usar classificação permanente/transiente análoga a `classifyTokenRefreshError`).
3. `youtube_type === "community"`: baixar imagens do content item (máx 10) e `POST /api/post/upload` multipart. Salvar id retornado em `youtube_post_id`.
4. Sessão expirada (`status: expired` na API): marcar canal com erro amigável "Sessão do YouTube expirada — reconecte em Canais" e pausar retries (padrão permanent).
5. Logs do planner: mensagens PT-BR claras.

**Importante**: respeitar a arquitetura atual do publisher (funções existentes, tratamento MalformedDataError, serialize helpers). Não reescrever o arquivo — adicionar o caminho do YouTube com o mínimo de invasão.

## 6. Rotas de API novas (server-side, todas autenticadas pelo NextAuth existente)

- `GET  /api/youtube/sessions` → proxy de `GET /api/session` (p/ importação)
- `POST /api/youtube/connect` → recebe cookies + label, chama `POST /api/session`, cria Channel platform=youtube vinculado ao user logado
- `POST /api/channels/[id]/youtube/refresh` → chama refresh da sessão remota
- `DELETE` canal youtube → também pode chamar `DELETE /api/session/{id}` (perguntar via checkbox "excluir também a sessão na API externa", default false)
- `GET/POST /api/youtube/comments` → listar/comentar/agir (like/heart/pin) — valida que o canal pertence ao user
- `GET /api/youtube/products?channelId=&query=` → busca produtos (opcional v1)
- `GET /api/youtube/health` → status da integração p/ Settings

## 7. UI

### Canais (`components/ChannelModal.tsx`, `app/channels/page.tsx`)

- Plataforma "YouTube" disponível na criação de canal. Modal com 2 abas:
  - **Colar cookies**: campos LOGIN_INFO, __Secure-3PAPISID,__Secure-3PSID, __Secure-3PSIDTS + label. Validação client-side (não vazios) + loading + erro da API.
  - **Importar sessão**: lista `GET /api/youtube/sessions` com nome/status/última rotação; botão "Vincular" cria o Channel local.
- Card do canal YouTube mostra: nome, status, badge da sessão (ativa/expirada), botões Atualizar sessão / Desconectar.

### Novo conteúdo / Editar (`app/new/page.tsx`, `components/EditContentModal.tsx`)

Quando o canal alvo é YouTube, mostrar escolha de tipo:

- **Short**: título (obrigatório, ≤100 chars, contador), descrição, privacidade (Público/Não listado/Privado), made_for_kids, monetizar, comentário fixado opcional. Vídeo obrigatório (validar existe).
- **Comunidade**: texto (obrigatório) + até 10 imagens (reusar MediaUploader).
Campos salvos em `youtube_options`/metadados do post.

### Planners & Calendário

- Garantir que canais youtube aparecem nos selects dos planners, wizard, preview e calendário (provavelmente genérico — TESTAR, não assumir).
- Preview do planner deve saber dizer "Short do YouTube" vs "Post na Comunidade".

### Comentários

- Nova página `app/youtube/comments` (ou modal a partir do card do post/canal): seleciona canal → lista vídeos/posts publicados → ver comentários → ações curtir/coração/fixar + criar comentário fixado. PT-BR.

### Analytics

- A API externa NÃO fornece métricas. Onde hoje há métricas IG, exibir estado vazio honesto p/ YouTube ("Métricas do YouTube ainda não disponíveis") sem quebrar.

### Settings (`app/settings/page.tsx`)

- Seção "Integração YouTube": mostra se `YOUTUBE_API_BASE_URL/YOUTUBE_API_KEY` estão configuradas (via `/api/youtube/health`), status da API externa, versão.

## 8. Qualidade / Definition of Done

1. `npm run build` passa sem erros.
2. `npm run lint` sem novos erros.
3. TypeScript estrito: nenhum `any` novo injustificado.
4. Nenhum segredo no client bundle; chamadas externas só server-side.
5. Estados de loading/erro/vazio em TODA tela nova (padrão visual existente).
6. Nada do fluxo Instagram pode regredir.
