# fix-F6-P1 — Proxy nas rotas de gestão YouTube (M16)

> **Agente:** 7 — BUILDER+CRÍTICO (gauntlet loop) · **Fase:** F6-P1 (M16 do PLANNER_AUDIT_REPORT)
> **Branch:** `feat/yt-products-dual-captions` · **Base:** `36d1ad9` (F5-P1 races)
> **Problema fechado:** proxy por canal (`Channel.proxy_url`, entrega proxy-track) era honrado **apenas no publisher**. Todas as rotas de gestão YT (refresh/delete/list de sessão, posts-delete, comments, products, health) e a confirmação de sessão expirada no próprio publisher ignoravam o proxy — canal atrás de proxy por bloqueio geográfico/BotGuard publica mas não consegue renovar cookies, listar comentários, buscar produtos ou apagar posts.

---

## 1. O que mudou (arquivo:linha)

### 1.1 `lib/youtube.ts` — `proxyUrl?` nas 7 funções que não tinham

Todas passam `proxyUrl ?? null` ao `youtubeFetch` (timeout padrão 15s explícito, comportamento idêntico ao anterior quando sem proxy).

| Função | Linha da assinatura | Passagem do proxy |
|---|---|---|
| `refreshSession` | `lib/youtube.ts:241-251` | `:248-249` |
| `deleteSession` | `lib/youtube.ts:257-263` | `:262` |
| `deleteCommunityPost` | `lib/youtube.ts:375-381` | `:380` |
| `listComments` | `lib/youtube.ts:551-564` | `:561-562` |
| `createComment` | `lib/youtube.ts:570-589` | `:586-587` |
| `commentAction` | `lib/youtube.ts:592-616` | `:613-614` |
| `createPinnedComment` | `lib/youtube.ts:619-647` | `:644-645` |

Já tinham (verificado, **sem edit**): `getHealth` (`:196`), `listSessions` (`:209`), `getSession` (`:229`), `listProducts` (`:664`), `uploadCommunityPost` (`:314`), `createCommunityPostText` (`:354`), `createShort` (`:394`), `createAutoShort` (`:475`). `createSession` **não** recebe proxy (fora do contrato da tarefa: a sessão ainda não tem canal; documentado em §3-R2).

### 1.2 Rotas de gestão — repasse `getChannelProxyUrl(channel)`

| Rota | Função | Chamada | Linha do repasse |
|---|---|---|---|
| `app/api/channels/[id]/youtube/refresh/route.ts` | `refreshSession` | `:26-29` | `:28` |
| `app/api/youtube/comments/route.ts` GET | `listComments` | `:36` | `:35` (proxy resolvido no try) |
| `app/api/youtube/comments/route.ts` POST | `commentAction`/`createComment`/`createPinnedComment` | `:97`, `:122-125`, `:129` | `:84` (proxy no POST) |
| `app/api/youtube/posts/route.ts` DELETE | `deleteCommunityPost` | `:31-36` | `:35` |
| `app/api/youtube/sessions/route.ts` GET | `listSessions` | `:43` | `:32` — **novo param `channelId?`** (ver §1.3) |
| `app/api/youtube/sessions/link/route.ts` POST | `deleteSession` (sessão antiga da revinculação) | `:137` | `:137` (`getChannelProxyUrl(existing)`) |
| `app/api/youtube/connect/route.ts` POST | `deleteSession` (limpeza de órfã) | `:84` | `:84` (`proxyUrl` do body) |
| `app/api/youtube/connect/route.ts` POST | `deleteSession` (sessão antiga da reconexão) | `:188` | `:188` (`getChannelProxyUrl(existing)`) |
| `app/api/channels/[id]/route.ts` DELETE | `deleteSession` (`?deleteRemoteSession=true`) | `:285` | `:285` (`getChannelProxyUrl(channel)`) |
| `app/api/cron/publisher/route.ts` | `getSession` (confirmação de sessão expirada) | `:1366` | `:1366` (`getChannelProxyUrl(post.channel)`) |

### 1.3 `/api/youtube/sessions` ganhou `channelId?` opcional (M16)

A listagem cobra **todas** as sessões da API (aba "Importar sessão" do modal de canais) — não tem canal único. Para honrar o proxy sem perder retrocompat: `channelId` na query resolve o canal (via `requireOwnedYoutubeChannel`) e repassa o proxy; sem o param, comportamento anterior (chamada direta). `app/api/youtube/sessions/route.ts:21-32,43`.

### 1.4 Tipo do canal no publisher (higiene, evita `as any` novo)

`YoutubePublishPost.channel` declarado em `app/api/cron/publisher/route.ts:599-606` agora inclui `proxy_url?: string | null` — o `include: {channel:true}` já traz a coluna; o `getSession` novo usa `getChannelProxyUrl(post.channel)` **sem cast** (os 17 `as any` restantes são pré-existentes e intactos).

---

## 2. Como testar

> Pré-requisito: API externa real (`~/Projects/youtube-community-api`) + canal YouTube atrás de proxy válido (`POST /api/youtube/connect` com `proxy_url` ou `PATCH /api/channels/:id {proxy_url}`, botão "Testar Proxy" da UI).

1. **Refresh de sessão:** Canais → YouTube → "Atualizar/Refresh" → `POST /api/channels/{id}/youtube/refresh` deve renovar cookies **pelo proxy** (confirme no log da API externa que o request entrou pela network do proxy; sem proxy + rede bloqueada → 502).
2. **Exclusão:** `DELETE /api/youtube/posts?channelId=&remotePostId=` e `DELETE /api/channels/{id}?deleteRemoteSession=true` — ambos via proxy do canal.
3. **Comentários:** `app/youtube/comments` — listar (`GET /api/youtube/comments?channelId&videoId`), criar (`POST` com `text`), fixar (`pinned:true`) — todos via proxy.
4. **Sessões (novo param):** `GET /api/youtube/sessions?channelId=<id>` — usa proxy do canal; `GET /api/youtube/sessions` (sem param) — direto (retrocompat).
5. **Publisher — check de expiração:** canal com proxy + sessão expirada → o bloco `YT_SESSION_EXPIRED_RE` (`publisher:1366`) consulta `GET /api/session/{id}` **pelo proxy** antes de marcar `failed`; sem o fix, o check caía sem proxy (contradição documentada no audit-track-api F1/F4) e sessões expiradas podiam ser classificadas como transiente.
6. **Nada vaza ao client:** `grep -rn "proxy_url" components/ app/youtube/ app/channels/page.tsx` (client) — só `proxy_url_masked`/`has_proxy` (valores mascarados); todas as mudanças deste fix ficam em route handlers/lib (server-only).

### Barra executada
- `npx tsc --noEmit` → **0 erros**
- `npm run build` → **✓ Compiled successfully**
- `node ./node_modules/prisma/build/index.js validate` → **schema válido**
- `eslint` nos 9 arquivos tocados → **18 erros, mesma contagem exata da baseline HEAD** (`git stash` comparado) — nenhum novo; o `as any` adicionado na 1ª iteração foi removido via tipo (§1.4).

---

## 3. Riscos e decisões

- **R1 — Retrocompat:** todas as assinaturas adicionam o parâmetro **no fim**, opcional. Nenhum caller existente (verificado por grep em `app/`,`components/`,`scripts/`,`lib/`) muda de comportamento sem proxy: `proxyUrl ?? null` → `fetchWithTimeout` sem dispatcher (caminho antigo).
- **R2 — `createSession` sem proxy (fora do contrato):** `POST /api/youtube/connect` cria a sessão pela chamada direta (a sessão ainda não tem canal/proxy persistido). Se a criação falhar, a limpeza da sessão órfã usa o `proxy_url` **do body** (`connect/route.ts:84`). Deixar `createSession` com proxy é P2 futuro — documentar, não implementar (a tarefa F6 lista 10 funções; `createSession` não está entre elas e não há canal para derivar).
- **R3 — Health continua direto (decisão):** `GET /api/youtube/health` é um check global de infra na Settings, sem canal. `getHealth` já aceita `proxyUrl?` (desde o proxy-track), mas a rota não tem como escolher um canal — manter direto (alinhado ao audit-track-api F4: "health P2 — passa proxy do 1º canal com proxy **ou documenta direto**"; documentado).
- **R4 — `listSessions` no link (`link/route.ts:65`) direto:** é a descoberta da sessão a vincular (nada de canal ainda); o proxy só entra na exclusão da sessão antiga (`:137`), onde o canal `existing` existe.
- **R5 — Sem toque nas entregues anteriores:** isolation YT/IG, proxy do publisher (createShort/createAutoShort/community/IG — intactos), bug-remove (cancelamento), bug-desc (propagação) — nenhum desses arquivos de lógica foi alterado; o único edit no publisher é o `getSession` do check de expiração + tipo do canal.
- **R6 — Type do canal com `proxy_url?`:** o `include: {channel:true}` do Prisma sempre trouxe a coluna; declarar no tipo é correção de tipo, zero mudança de runtime.
- **R7 — `channelId` no `/api/youtube/sessions`:** hoje nenhum client usa o param; é cobertura M16 para callers futuros (ex.: importar sessão dentro do modal de um canal atrás de proxy). Sem param → comportamento idêntico ao HEAD.

---

## 4. Estado final

| Cobertura M16 | Antes | Depois |
|---|---|---|
| `refreshSession` (lib + rota) | sem proxyUrl | ✅ proxy do canal |
| `deleteSession` (connect/link/channels DELETE) | sem proxyUrl | ✅ proxy do canal / do body |
| `deleteCommunityPost` (posts DELETE) | sem proxyUrl | ✅ proxy do canal |
| `listComments/createComment/commentAction/createPinnedComment` | sem proxyUrl | ✅ proxy do canal |
| `listSessions` (sessions GET) | com proxyUrl mas rota sem repasse | ✅ `channelId?` → proxy |
| `listProducts` (products GET) | já repassava | ✅ (inalterado) |
| `getHealth` | com proxyUrl, rota direta | ✅ (inalterado; decisão §R3) |
| `getSession` no publisher (check expirada) | sem proxy (**contradição F1/F4**) | ✅ proxy do canal |