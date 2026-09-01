# fix-F3-B3 — videoId real na busca de produtos (M6)

> **Fase:** F3-B3 (P0 M6) · **Branch:** `feat/yt-products-dual-captions`
> **Fonte de verdade consultada:** `docs/PLANNER_AUDIT_REPORT.md` (§1 M6, §2 P0-B3) · `docs/audit-track-api.md` (F1) · `docs/audit-track-wizard.md` (W5, §3 "Products sem videoId") · `docs/fix-F1-b1-produtos-afiliados.md` (estado do wizard pós-B1)
> **Natureza:** resolução real do `videoId` no route + proxy no `listProducts` + mensagens amigáveis. Extensão (additive) — nenhum contrato quebrado.

---

## Problema (antes)

A busca de produtos fabricava um `videoId` falso — o wizard derivava de `youtubeTitle.slice(0,50)` ou do id de item de biblioteca (nenhum dos dois é um vídeo real do canal; id de vídeo do YouTube tem 11 chars). A API externa exige `video_id` real (`shorts.py:185-234`, `client.search_products(query, video_id=...)`) → 400/502 ou resultados vazios. Além disso `listProducts` não aceitava proxy (audit-track-api F4-Wide: canais atrás de proxy não conseguiam buscar).

## O que mudou (arquivo:linha)

### 1. `app/api/youtube/products/route.ts` — videoId OPCIONAL + fallback real
- `:22-41` — `videoIdParam` (query) passa a ser **opcional**; `resolveVideoIdForProductSearch(videoIdParam, guard.channel.id)` resolve o vídeo alvo:
  1. **videoId explícito** (`?videoId=`) → mantido (retrocompat: `channelId+videoId+query` continua aceito e tem prioridade);
  2. **ausente** → último `Post` publicado do canal: `where { channel_id, status:"published", youtube_video_id:{not:null} }`, `orderBy published_at desc` (`:113-133`); guard adicional `NOT: [{ youtube_video_id: { equals: "" } }]` exclui strings vazias legadas (publisher grava `short.video_id || null`, mas ids vazios antigos = fake, fora do espirito do B3);
  3. **nenhum** → `null` → **400 PT-BR** `"Nenhum vídeo publicado para buscar produtos — publique um Short primeiro."` (`:26-41`) — fluxo de vídeo isca (`sacrifice_video_id` / `POST /api/sessions/{id}/config`) fica **documentado, NÃO implementado** (fase futura, PLANNER_AUDIT_REPORT §2 P0-B3).
- `:75-95` — `listProducts` recebe `resolvedVideoId` e **`getChannelProxyUrl(guard.channel)`** (import `:7`; mesma cobertura de proxy do publisher — F4-Wide ampliará p/ rotas de gestão).
- `:93` — resposta ganha `video_id: resolvedVideoId` (additive, para depuração/UI).

### 2. `lib/youtube.ts` — `listProducts` com `proxyUrl?`
- `:633-657` — novo 4º parâmetro opcional `proxyUrl?: string | null`; repassado ao `youtubeFetch` (`{}, 15_000, proxyUrl ?? null`) — mesmo padrão de `getSession`/`listSessions`/`uploadCommunityPost`. Único caller (route acima) atualizado; ninguém mais chama.

### 3. `components/PlannerWizard.tsx` — sem derivação + mensagem amigável
- Derivação de videoId de título/item **já não existe** (removida no B1 — verificado: zero `videoId` no `URLSearchParams` da busca L710-717; sem `youtubeTitle.slice`/item-id no fluxo).
- `:687-689` — comentário da busca atualizado (rota resolve o último Short publicado).
- `:738-761` — path de **400** com mensagem amigável atualizada: `"Nenhum vídeo publicado ainda — publique um Short primeiro para buscar o catálogo. Você ainda pode deixar só o nome: a publicação auto-seleciona o melhor produto."` + **guard anti-race** adicionado (mesma convenção do path de sucesso L771-777: `d.key === key && d.query.trim() === query`) — uma resposta 400 atrasada de um query antigo não apaga resultados de um query mais novo.

## Como testar

1. **Barra:** `npx tsc --noEmit` (0 erros) · `npm run build` (ok) · `node ./node_modules/prisma/build/index.js validate` (schema válido) · teste roteamento `npx --no-install tsx scripts/gauntlet/products-routing.mts` (14/14) · smoke F2 `node --import ./.ai/f2-smoke/alias-hook.mjs .ai/f2-smoke/smoke.test.mts` (6/6).
2. **Canal COM Short publicado** (Post `status=published`, `youtube_video_id` preenchido): chamar `GET /api/youtube/products?channelId=&query=smartwatch` **sem videoId** → route resolve o último publicado → API externa responde itens → 200 com `video_id` do Short real.
3. **Canal SEM short publicado**: mesma chamada → **400** `"Nenhum vídeo publicado para buscar produtos — publique um Short primeiro."` → wizard mostra a mensagem amarela e a entrada continua como **nome** (auto-select `/api/shorts/auto` na publicação).
4. **Retrocompat:** `GET /api/youtube/products?channelId=&videoId=<real>&query=` continua funcionando (videoId explícito tem prioridade).
5. **Proxy:** canal com `proxy_url` → o route passa `getChannelProxyUrl(channel)` ao `listProducts` (o fetch à API externa vai pelo ProxyAgent — mesmo do publisher).
6. **Wizard E2E:** campo "+ Adicionar Produto Afiliado" → digitar nome → resultados com título/vendor/preço aparecem (canal com Short publicado); sem Short publicado → mensagem amigável; clicar num resultado fixa o item verbatim.

## Riscos / observações

- **`published_at` nulo em published?** O publisher grava `published_at: now` junto com `youtube_video_id` (`app/api/cron/publisher/route.ts:1276-1277`) — um published com null teria `youtube_video_id` mas é still um vídeo real do canal (where clause exige status published + video id). Ordenação com NULLs-first no Postgres não é bug de correção: qualquer resultado é um Short válido publicado.
- **Comunidade nunca entra:** `youtube_video_id` só é gravado no ramo Short (publisher L1277); posts de Comunidade usam `youtube_post_id` (L1133). O fallback jamais seleciona post de Comunidade.
- **`video_id` na resposta é additive** — consumidores atuais (wizard lê `data.products`) não são afetados.
- **Ordem dos 400:** sem `videoId` E sem `query`+`suggestions`, a resposta agora é "Nenhum vídeo publicado…" em vez de "Informe 'query'…". O wizard sempre manda `query` + `suggestions=false`, então o fluxo real não é afetado; a mensagem é mais útil para o caso real.
- **Fora do escopo (documentado):** `sacrifice_video_id` (vídeo isca) via `POST /api/sessions/{id}/config` da API externa — NÃO implementado nesta fase (task F3-B3 define apenas fallback 1 + 400); proxy nas demais rotas de gestão (comments/refresh/delete) e `getSession` do publisher seguem sendo fase P1 futura (audit-track-api F4-Wide).
- **Sem risco às entregues:** isolation YT/IG (mix bloqueado) intocado · proxy no publisher intocado · bug-remove (cancelamento) intocado · bug-desc (propagação `buildYoutubeOptionsForPost`) intocado · roteamento F1-B1 (`resolveShortProductsRouting`) intocado.