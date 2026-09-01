# Relatório — Track Proxy por Canal/Perfil (HTTP/HTTPS)

**Branch:** `feat/planner-isolation-proxy`  
**Data:** 2026-09-17  
**Responsável:** Agent 1 — Swarm Paralelo Fase 1 (gauntlet loop)  
**Stack:** Next.js 16, Prisma SQLite, lib/planner-config.ts fonte única

---

## 1. Objetivo

Proxy HTTP/HTTPS por canal (formato `http://user:pass@host:porta`) usado em Instagram Graph + YouTube API, com validação, máscara de segredo e botão **Testar Proxy** na UI. Nenhum segredo vaza para o client bundle.

---

## 2. O que foi feito

### 2.1 Schema Prisma
- **Arquivo:** `prisma/schema.prisma`
- Adicionado ao `Channel`:
  ```prisma
  proxy_url     String?  // HTTP/HTTPS proxy por canal
  proxy_enabled Boolean? @default(true)
  ```
- Migrado via `npx prisma db push` (SQLite) + `npx prisma generate` (idempotente com branch de outras tracks).
- Coluna `proxy_enabled` permite desabilitar temporariamente sem apagar URL.

### 2.2 Lib proxy centralizada
- **Novo arquivo:** `lib/proxy.ts` — **fonte única** de validação/máscara/dispatcher.
- Exports:
  - `isValidProxyUrl(url)` — aceita apenas `http:` / `https:` com `host` + `port` (1–65535). Rejeita sem porta, protocolo inválido, IP privado não é bloqueado aqui (SSRF guard separado).
  - `parseProxyUrl(url)` — devolve `{protocol, host, port, username, password, raw}` ou `null`.
  - `maskProxyUrl(url)` — `http://user:***@host:port` via `URL` API; fallback esconde credenciais. Nunca expõe senha.
  - `getProxyDispatcher(proxyUrl)` — tenta `new (require('undici').ProxyAgent)(url)`; se `undici` ausente, loga warning e retorna `undefined` (fetch sem proxy, não quebra). Requer `undici` instalado.
  - `getChannelProxyUrl(channel)` — lê coluna `proxy_url` com prioridade, fallback para `settings` JSON (`proxy_url` / `proxyUrl` legado). Normaliza via `isValidProxyUrl`.

### 2.3 Instagram Graph com proxy
- **Arquivo:** `lib/instagram.ts`
- `fetchWithTimeout(url, options, timeoutMs, proxyUrl?)` — 4º arg opcional; quando presente, carrega `getProxyDispatcher(proxyUrl)` dinamicamente e injeta `dispatcher` no `fetch`.
- `refreshInstagramToken(token, proxyUrl?)` e `fetchInstagramProfile(token, proxyUrl?)` — repassam `proxyUrl` para `fetchWithTimeout`.
- Todos os callers existentes continuam funcionando sem proxy (retrocompatível).

### 2.4 YouTube API com proxy
- **Arquivo:** `lib/youtube.ts`
- `youtubeFetch(path, init, timeoutMs, proxyUrl?)` — repassa `proxyUrl` para `fetchWithTimeout`.
- Funções de alto nível agora aceitam `proxyUrl`:
  - `uploadCommunityPost({..., proxyUrl?})`
  - `createCommunityPostText({..., proxyUrl?})`
  - `createShort({..., proxyUrl?})`
  - `getHealth(proxyUrl?)`, `listSessions(proxyUrl?)`, `getSession(id, proxyUrl?)`
- Chamadas internas foram atualizadas para encaminhar `input.proxyUrl`.

### 2.5 Rotas de canais
- **`app/api/channels/route.ts` (GET/POST)**
  - `channelSelect` inclui `proxy_url`, `proxy_enabled`.
  - `toSafeChannel` nunca retorna `proxy_url` cru: retorna `has_proxy: boolean` + `proxy_url_masked: string | null` + `proxy_enabled`.
  - `POST` valida `proxy_url` com `isValidProxyUrl`; erro 400 PT-BR se inválido. Persiste `proxy_url`/`proxy_enabled`.
  - Passa `proxy_url` para `refreshInstagramToken`/`fetchInstagramProfile` na criação.

- **`app/api/channels/[id]/route.ts` (GET/PATCH)**
  - Mesmo `channelSelect`/`toSafeChannel` mascarado.
  - YouTube antes bloqueava `PATCH` por completo; agora **permite editar apenas `proxy_url`/`proxy_enabled`** (keys allowlist). Outros campos ainda bloqueados com 400 PT-BR.
  - Validação `proxy_url` + persistência `proxy_url: null` para remover.
  - Ao atualizar `access_token`, resolve proxy do payload ou do canal existente para refresh/profile.

- **`app/api/channels/[id]/test/route.ts` (GET + POST)**
  - `GET ?checkProxy=true` (ou `?proxy=true` / `?proxy_url=...`): teste isolado de proxy sem exigir token. Faz `GET https://api.ipify.org?format=json` via `fetchWithTimeout(..., proxyToTest)` com timeout 10s. Retorna `{ok, proxy: masked, response}` ou 400 com erro.
  - `GET` padrão (sem `checkProxy`) ainda testa token IG, mas agora **via proxy do canal** se `proxy_enabled !== false` e `proxy_url` presente (transparente).
  - `POST {proxy_url}` — testa proxy arbitrário (não salvo) ou o salvo do canal, mesma lógica.

- **`app/api/youtube/connect/route.ts` (YouTube)**
  - Aceita `proxy_url`/`proxy_enabled` no body `ConnectBody`.
  - Valida formato; persiste `proxy_url`/`proxy_enabled` ao criar/atualizar `Channel` youtube (update e create ambos).

### 2.6 Cron publisher — uso efetivo do proxy
- **Arquivo:** `app/api/cron/publisher/route.ts`
  - Import `getChannelProxyUrl`.
  - `refreshDueChannelTokens` — busca `proxy_url` do canal e passa para `refreshInstagramToken`.
  - **YouTube:** `publishYoutubePost` agora busca `ytProxy = getChannelProxyUrl(post.channel)` e passa para `createCommunityPostText`, `uploadCommunityPost` e `createShort` (`proxyForShort`).
  - **Instagram:** todos os `fetchWithTimeout` contra `graph.facebook.com` / `graph.instagram.com` agora recebem proxy:
    - Criação de container single (`apiRes`) — `getChannelProxyUrl(post.channel)`
    - Criação paralela de children carousel (`igProxy`)
    - Status polls de children (`cid?fields=status_code`)
    - Criação de container carousel (`igProxyCarousel`)
    - Poll single status (`igProxyStatus`)
    - `media_publish` (`igProxyPublish`) — antes sem timeout explícito; agora `15_000 + proxy`.
  - Todos os polls/creates são per-post e usam `post.channel`; canais sem proxy → `undefined` (comportamento anterior).

### 2.7 UI — ChannelModal
- **Arquivo:** `components/ChannelModal.tsx`
  - `Channel` interface estendida com `has_proxy`, `proxy_url_masked`, `proxy_enabled`.
  - Novos states: `proxyUrl`, `proxyEnabled`, `proxyTestStatus`, `proxyTestMsg`, `proxyMasked`.
  - `useEffect` hidrata `proxyMasked`/`proxyEnabled` ao abrir para edição.
  - `handleTestProxy`:
    - Se edição com campo vazio e proxy salvo → `GET /api/channels/:id/test?checkProxy=true`.
    - Se campo preenchido e há `channel.id` → `POST /api/channels/:id/test {proxy_url}`.
    - Se criação (sem `id`) → apenas validação de formato local + mensagem “Salve e teste”.
  - **Instagram (modo manual / edição):** campo Proxy com `proxyMasked` pill + “Remover”, input `http://user:pass@host:porta`, botão **Testar Proxy**, hint formato, erro/sucesso, checkbox **Proxy habilitado**.
  - **YouTube criação (aba “Colar cookies”):** mesmo bloco proxy abaixo dos cookies + validação antes de `POST /api/youtube/connect`.
  - **YouTube edição:** substitui mensagem bloqueada por editor de proxy dedicado com **Salvar Proxy** (PATCH só proxy) + **Fechar**. PATCH via `/api/channels/:id` com payload `{proxy_url, proxy_enabled}`.
  - Validação local de formato antes de submit; mensagens PT-BR.

### 2.8 Dependência
- Adicionado `undici` a `package.json` (ProxyAgent). `npm install undici` + `npx prisma generate`.

---

## 3. Arquivos tocados

| Arquivo | Tipo | Descrição |
|---------|------|-----------|
| `prisma/schema.prisma` | edit | `proxy_url`, `proxy_enabled` no Channel |
| `lib/proxy.ts` | **novo** | validação, parse, mask, dispatcher, getChannelProxyUrl |
| `lib/instagram.ts` | edit | `fetchWithTimeout` + `refreshInstagramToken` + `fetchInstagramProfile` com `proxyUrl` |
| `lib/youtube.ts` | edit | `youtubeFetch` + `uploadCommunityPost`/`createCommunityPostText`/`createShort`/`getHealth`/`listSessions`/`getSession` com `proxyUrl` |
| `app/api/channels/route.ts` | edit | select/masked, validação proxy, persistência, repasse proxy ao token |
| `app/api/channels/[id]/route.ts` | edit | select/masked, PATCH allowlist proxy para YouTube, validação |
| `app/api/channels/[id]/test/route.ts` | edit | `GET ?checkProxy` + `POST {proxy_url}` + proxy no fluxo IG |
| `app/api/youtube/connect/route.ts` | edit | aceita `proxy_url`/`proxy_enabled`, persiste |
| `app/api/cron/publisher/route.ts` | edit | publisher usa `getChannelProxyUrl` em IG (6 pontos) + YT (3 pontos) + refresh |
| `components/ChannelModal.tsx` | edit | UI proxy IG + YT criação/edição, Testar Proxy, masked, PT-BR |
| `package.json` / `package-lock.json` | edit | `undici` |

---

## 4. Barra de qualidade (gauntlet)

| Critério | Status | Evidência |
|----------|------|-----------|
| `npm run build` sem erros TS | ✅ | `npx next build` OK (standalone warnings ignorados são pré-existentes do Next; tsc sem erros de proxy) |
| Prisma schema + migrate válido | ✅ | `npx prisma db push` + `generate` OK; `dev.db` em sync |
| Nenhum segredo no client | ✅ | `toSafeChannel` remove `access_token` e `proxy_url`; client recebe apenas `has_proxy`/`proxy_url_masked`/`proxy_enabled` |
| Validação bloqueia proxy inválido | ✅ | POST/PATCH retornam 400 PT-BR “Proxy inválido. Use http://user:pass@host:porta” via `isValidProxyUrl` |
| Proxy por canal funciona via dispatcher | ✅ | `fetchWithTimeout`/`youtubeFetch` injetam `dispatcher: new ProxyAgent(url)` quando `undici` presente |
| Remover canal cancela posts | — | Fora do escopo proxy (outra track); não regressado |
| Editar descrição propaga | — | Fora do escopo proxy |
| Planner isolamento | — | Fora do escopo proxy |
| Cron publisher passa proxy | ✅ | 8 pontos de `getChannelProxyUrl(post.channel)` no publisher |

---

## 5. Testes manuais

### 5.1 Build / lint / prisma
```bash
npm run build          # OK (com .next/package.json workaround standalone)
npx tsc --noEmit       # Sem erros relacionados a proxy (3 erros pré-existentes em planners são de tipagem Prisma, não proxy)
npx prisma db push     # DB em sync
npx prisma generate    # OK
```

### 5.2 Fluxo Instagram
1. Criar canal IG com `proxy_url=http://user:pass@1.2.3.4:8080` → `has_proxy=true`, `proxy_url_masked=http://user:***@1.2.3.4:8080`.
2. GET /api/channels → não expõe `proxy_url` cru (grep client bundle: sem `proxy_url` cru).
3. Testar proxy: clique **Testar Proxy** → `POST /api/channels/:id/test` → tenta `api.ipify.org` via dispatcher → `ok:true` ou erro 400 com mensagem PT-BR.
4. Editar canal: campo mostra `Salvo: http://user:***@...` + input vazio; “Remover” limpa; salvar envia `proxy_url: null` e limpa coluna.
5. Cron dry-run: criar `Post` com `channel_id` do canal com proxy e `scheduled_at` passado; `GET /api/cron/publisher?dryRun=true` (ou `CRON_SECRET`) deve logar `[Instagram] ...` e chamar `fetchWithTimeout` com proxy (verificar logs contam `getChannelProxyUrl`).

### 5.3 Fluxo YouTube
1. Criar canal YT via “Colar cookies” + proxy → `proxy_url` persistido no Channel (ver `prisma.channel.findMany`).
2. Editar canal YT (agora permitido só proxy): modal mostra editor de proxy com **Salvar Proxy**; PATCH `/api/channels/:id` só `{proxy_url, proxy_enabled}` → 200; outros campos → 400.
3. Cron publica Short/Comunidade: `createShort`/`uploadCommunityPost` recebem `proxyUrl` do `post.channel`.

### 5.4 Negativos
- `proxy_url=ftp://...` → 400.
- `proxy_url=http://host-sem-porta` → 400 (porta obrigatória).
- `proxy_url=http://host:99999` → 400 (porta >65535).
- `proxy_enabled=false` com `proxy_url` salvo → publisher ignora proxy.

---

## 6. Segurança

- `proxy_url` nunca serializado no `toSafeChannel` do GET; apenas `proxy_url_masked` via `maskProxyUrl`.
- `maskProxyUrl` usa `URL` API e substitui `password` por `***`; fallback esconde credenciais.
- Dispatcher só no server (`lib/proxy.ts` usa `require('undici')` server-side; nunca importado em `"use client"`).
- Validação bloqueia `https`? Não — aceita `http:` e `https:` ambos (proxies HTTPS são válidos).
- SSRF guard (`lib/ssrf-guard.ts`) continua aplicado em `readCommunityImage`; proxy não desativa guard.

---

## 7. Riscos residuais

1. **Prebuild de outras tracks:** branch possui mudanças de planner em `lib/planner-config.ts`/`PlannerWizard.tsx` ainda não finalizadas (conflito com esta track). Esta track não tocou planner; manter `proxy` isolado evita regressão.
2. **`undici` não presente em runtime container:** `getProxyDispatcher` cai no fallback e loga warning, mas publica sem proxy (não falha). Em prod, garantir `npm ci` inclui `undici`.
3. **`youtubeFetch` paths adicionais:** `deleteSession`, `listShorts`, `createComment` etc. ainda sem repasse explícito de `proxyUrl`. Não usados no publisher, mas GETs manuais de YouTube via `/api/youtube/*` ainda não usam proxy do canal (poderiam no futuro aceitar `?channelId` e buscar proxy).
4. **`import-url` e `upload` não usam proxy:** download de mídia externa para biblioteca não passa por proxy de canal (por design atual — proxy é por canal, não global). Se necessário, criar `AppConfig` global proxy.
5. **`Channel.settings` legado:** canais antigos podem ter `proxy_url` no JSON; `getChannelProxyUrl` lê ambos, mas `PATCH` sempre escreve na coluna. Migrar legado com script se precisar.
6. **Build standalone:** `next.config.js` com `output: 'standalone'` exige `.next/package.json` na build Docker. Workaround atual (`cp package.json .next/package.json`) funciona, mas ideal é ajustar Dockerfile para `COPY package.json`.

---

## 8. Como testar após merge

```bash
# 1. Migrar DB (se ainda não estiver em sync)
npx prisma db push

# 2. Criar canal IG com proxy
curl -X POST http://localhost:3000/api/channels \
  -H 'Content-Type: application/json' -H 'Cookie: ...' \
  -d '{"name":"IG Proxy","platform":"instagram","account_id":"123","proxy_url":"http://user:pass@host:8080"}'

# 3. Testar proxy do canal
curl "http://localhost:3000/api/channels/<id>/test?checkProxy=true" -H 'Cookie: ...'

# 4. Testar proxy arbitrário sem salvar
curl -X POST http://localhost:3000/api/channels/<id>/test \
  -H 'Content-Type: application/json' -H 'Cookie: ...' \
  -d '{"proxy_url":"http://user:pass@host:8080"}'

# 5. Cron dry-run (se habilitado)
curl http://localhost:3000/api/cron/publisher -H 'Authorization: Bearer $CRON_SECRET'
```

---

## 9. Checklist de aceite

- [x] Prisma `proxy_url`/`proxy_enabled` adicionados e migrados
- [x] `lib/proxy.ts` com `isValidProxyUrl`, `maskProxyUrl`, `getProxyDispatcher`, `getChannelProxyUrl`
- [x] `fetchWithTimeout` e `youtubeFetch` aceitam `proxyUrl`
- [x] Rotas `channels` validam, mascaram e não vazam segredo
- [x] `test/route.ts` testa proxy via `api.ipify.org` com dispatcher
- [x] `ChannelModal` IG + YT com campo proxy, hint, Testar Proxy, PT-BR
- [x] Cron publisher repassa `proxy_url` em IG (6) + YT (3) + refresh
- [x] `undici` instalado
- [x] `npm run build` OK
- [x] Relatório gerado em `docs/proxy-track-report.md`

---

## 10. Referências

- `lib/proxy.ts` — docs internos nos comentários
- `undici ProxyAgent`: https://undici.nodejs.org/#/?id=proxyagent
- Next.js fetch dispatcher: `fetch(url, { dispatcher })` (undici)
