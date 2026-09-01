# F6-P1 — Proxy nas rotas de gestão YouTube (M16)

**Branch:** `feat/yt-products-dual-captions` · **Fase:** F6 · **Fonte:** `docs/PLANNER_AUDIT_REPORT.md` (M16/L45) + `docs/audit-track-api.md` (§1 F1-wide/F4)

---

## 1. O que mudou (arquivo:linha)

### 1.1 `lib/youtube.ts` — funções de gestão agora aceitam `proxyUrl?: string | null` e repassam a `youtubeFetch(..., proxyUrl ?? null)`

| Função | Linha | Antes | Depois |
|---|---|---|---|
| `refreshSession` | 241 | sem proxy | `youtubeFetch(path, {method:POST}, 15_000, proxyUrl ?? null)` |
| `deleteSession` | 257 | sem proxy | `youtubeFetch(path, {method:DELETE}, 15_000, proxyUrl ?? null)` |
| `deleteCommunityPost` | 375 | sem proxy | 3º param `proxyUrl?` → `youtubeFetch(..., 15_000, proxyUrl ?? null)` |
| `listComments` | 551 | sem proxy | 4º param `proxyUrl?` → `youtubeFetch(..., 15_000, proxyUrl ?? null)` |
| `createComment` | 570 | sem proxy | 4º param `proxyUrl?` → repassa |
| `commentAction` | 592 | sem proxy | 5º param `proxyUrl?` → repassa |
| `createPinnedComment` | 619 | sem proxy | 5º param `proxyUrl?` → repassa |

Já cobriam (HEAD): `youtubeFetch` L56, `getHealth` L196, `listSessions` L209, `getSession` L229, `uploadCommunityPost`, `createCommunityPostText`, `createShort`, `createAutoShort`, `listProducts` L665. Nenhuma assinatura quebrada — todos os parâmetros novos são opcionais (retrocompatível).

### 1.2 Rotas de gestão repassam `getChannelProxyUrl(channel)`

| Rota | Linha | Função |
|---|---|---|
| `app/api/channels/[id]/youtube/refresh/route.ts` | 26-28 | `refreshSession(guard.sessionId, getChannelProxyUrl(guard.channel))` |
| `app/api/youtube/comments/route.ts` | 35-36 / 82-84 / 97 / 125 | `listComments(..., proxy)`, `commentAction(..., proxy)`, `createPinnedComment(..., proxy)`, `createComment(..., proxy)` |
| `app/api/youtube/posts/route.ts` | 32-35 | `deleteCommunityPost(guard.sessionId, remotePostId, getChannelProxyUrl(guard.channel))` |
| `app/api/youtube/sessions/route.ts` | 28-43 | `channelId` OPCIONAL: quando presente, `listSessions(getChannelProxyUrl(guard.channel))` (comportamento anterior sem `channelId` preservado — listagem global sem canal único) |
| `app/api/cron/publisher/route.ts` | 1366 | `getSession(sessionId, getChannelProxyUrl(post.channel))` no check de sessão expirada (antes L1359 sem proxy — contradição F1/fixada) |
| `app/api/youtube/connect/route.ts` | 84 / 188 | cleanup da sessão órfã usa `proxyUrl` do body (mesma rede do connect); sessão remota anterior via `getChannelProxyUrl(existing)` |
| `app/api/youtube/sessions/link/route.ts` | 137 | sessão remota anterior via `getChannelProxyUrl(existing)` |
| `app/api/channels/[id]/route.ts` | 285 | `deleteSession(sessionId, getChannelProxyUrl(channel))` na deleção com `?deleteRemoteSession=true` |

### 1.3 Não mencionado na spec do bloco (decisão documentada)

- `app/api/youtube/health/route.ts` **não** ganhou proxy: a health é ping global da API externa sem contexto de canal (mesma natureza da listagem global de sessões). Audit track classifica como P2 ("1º canal com proxy ou documenta direto") — mantém-se sem proxy por ora; `getHealth` já aceita `proxyUrl?` quando um caller tiver channel.
- `createSession` (lib/youtube.ts) segue sem `proxyUrl?` — fora do escopo da tarefa (lista pretendida não o inclui). Risco residual: a criação da sessão no connect não passa por proxy; documentar em fase futura se necessário.

---

## 2. Como testar

```bash
# 1. Barra de qualidade
npx tsc --noEmit            # 0 erros
npm run build               # OK
node ./node_modules/prisma/build/index.js validate   # schema válido (sem npx prisma)

# 2. Sem vazamento p/ client
grep -rn "getChannelProxyUrl" components/              # vazio
grep -rln '"use client"' components/ | xargs grep -ln "lib/proxy"   # vazio

# 3. Fluxo manual com canal YT que tem proxy (Channel.proxy_url)
#    a) Refresh de sessão passa pelo proxy do canal
curl -X POST http://localhost:3000/api/channels/<id>/youtube/refresh -H 'Cookie: ...'
#    b) Comentários (GET+POST) passam pelo proxy do canal
curl "http://localhost:3000/api/youtube/comments?channelId=<id>&videoId=<vid>" -H 'Cookie: ...'
#    c) Exclusão de post da Comunidade pelo proxy
curl -X DELETE "http://localhost:3000/api/youtube/posts?channelId=<id>&remotePostId=<rid>" -H 'Cookie: ...'
#    d) Listagem de produtos (já coberta em F3, não regressada)
curl "http://localhost:3000/api/youtube/products?channelId=<id>&query=iphone" -H 'Cookie: ...'
#    e) Listagem de sessões com channelId (proxy) e sem (direto, retro)
curl http://localhost:3000/api/youtube/sessions -H 'Cookie: ...'
curl "http://localhost:3000/api/youtube/sessions?channelId=<id>" -H 'Cookie: ...'

# 4. Publisher — sessão expirada agora confirma via proxy do canal:
#    publicar um Short de canal com proxy e verificar log (dry-run):
curl http://localhost:3000/api/cron/publisher -H 'Authorization: Bearer $CRON_SECRET'
```

**Como observar o proxy em uso:** um canal com `proxy_url` inválido/inalcançável agora falha também nas rotas de gestão (antes passava direto) — sinal de que o repasse está ativo. Para verificar sem proxy real, use `proxy_url` de um host morto e observe `YoutubeApiError` com falha de conexão nas rotas de gestão (vs. sucesso sem proxy antes).

---

## 3. Por que esta implementação é (e não é) uma regressão

- **Retrocompatibilidade:** todos os parâmetros são opcionais (`proxyUrl?: string | null`); callers que não passam → `proxyUrl ?? null` → fetch direto, exatamente o comportamento anterior.
- **Não vaza segredo ao client:** `getChannelProxyUrl`/`lib/proxy` só existem em route handlers server-side (verificado por grep em `components/`); `toSafeChannel` contínua mascarando `proxy_url` (`has_proxy`/`proxy_url_masked`).
- **Entregues preservadas:** isolation YT/IG (nada de UI tocado), proxy no publisher (só ampliado p/ `getSession`), bug-remove (guards M13 intocados), bug-desc (nada de propagação mexido).
- **`sessions/route.ts`:** resolver `requireOwnedYoutubeChannel(channelId)` ANTES do try/catch é seguro — a função devolve resposta pronta em falha (401/400/404), nunca lança.

---

## 4. Riscos residuais

1. **`createSession` sem proxy** (connect): a criação da primeira sessão via cookies não passa por proxy; canais que SÓ alcançam a API via proxy não conseguiriam criar sessão — fase futura, documentado no audit F4.
2. **Health sem proxy** (P2, decisão documentada): se a infra exigir proxy para `/api/health`, ajustar `app/api/youtube/health/route.ts` para resolver o 1º canal do usuário com proxy.
3. **Listagem global de sessões sem canal** fica sem proxy por natureza (multi-sessão, sem canal único); `channelId` opcional cobre o caso estreito.
4. **`getSession` no publisher** usa `post.channel` — canal já carregado no mesmo escopo (mesmo objeto usado em L1171/L1258), sem consulta extra.
5. **Concorrência de agentes:** os edits chegaram via trabalhos paralelos na mesma branch; commit único agrupa o bloco. Revisar `git log` antes de push (push é do dono).

---

## 5. Checklist de aceite

- [x] `lib/youtube.ts`: 7 funções de gestão com `proxyUrl?` + repasse a `youtubeFetch`
- [x] Rotas refresh/comments/posts/sessions/products repassam `getChannelProxyUrl(channel)`
- [x] Publisher `getSession` (L1366) com proxy do canal
- [x] `npx tsc --noEmit` 0 erros · `npm run build` OK · prisma `validate` OK
- [x] Nenhum proxy vaza ao client (grep server-only)
- [x] Relatório em `docs/fix-F6-P1-proxy-rotas-gestao.md`