# fix-s2-analytics — "Analytics pararam de funcionar" (P0)

**Branch:** `s2-analytics` (a partir de `fixes-monolith` @ `9242e7a`)

**Sintoma reportado:** a página `/analytics` não carrega mais. A aba "Todos"
(LocalDashboard) era o primeiro impacto; selecionar qualquer canal também
falhava.

**Commit:** `fix(analytics): S2 restaura insights` (atômico, sem push).

---

## 1. Causa raiz (schema drift após merges TikTok 0011/0012)

O `schema.prisma` ganhou campos TikTok (`Post.tiktok_type | tiktok_options |
tiktok_post_id | tiktok_publish_id | tiktok_status`) nos merges
`85c8cfb` (A1) e `62ab85d` (A4) **sem migration correspondente**:
`0011_add_tiktok_channel_fields` é um no-op (`SELECT 1`) e
`0012_add_tiktok_captions` só altera `content_items`.

Resultado: o Prisma Client gerado passa a fazer `SELECT` das colunas
`tiktok_*` em qualquer query de `Post` **sem `select` explícito**, e um banco
que não recebeu as colunas (dev local, legado, ou deploy sem `migrate
deploy`) explode com:

```
The column `main.posts.tiktok_type` does not exist in the current database.
PrismaClientKnownRequestError, code: P2022
```

`GET /api/posts` (rota que alimenta o LocalDashboard do Analytics) faz
exatamente isso — `prisma.post.findMany` sem `select` — e **não tem
try/catch**: o 500 cru com stack vazava e o dashboard ficava em branco.

O repasse 0013 (`prisma/migrations/0013_add_tiktok_post_fields`, que adiciona
as 5 colunas em `posts`) **existia no disco mas nunca foi commitado** — era um
untracked file que o texto do próprio migration já descrevia como correção
para "EVERY planner post create fails ... table posts has no column named
tiktok_type". Ele fecha a lacuna para bancos gerenciados/fresh (`migrate
deploy`), mas o Analytics ainda dependia de (a) o banco local ser alinhado e
(b) a rota não derrubar o painel inteiro com 500 cru.

### Evidência ANTES (reproduzido localmente)

```
GET /api/posts?limit=5            → HTTP 500
  The column `main.posts.tiktok_type` does not exist in the current database.
GET /api/channels/{tiktok}/insights?days=30 → HTTP 400
  {"error":"Channel has no access token","detail":"Re-connect the channel in /channels."}
```

Arquivos auditados (fluxo completo):
- `app/analytics/page.tsx` — o que a página chama (GET /api/posts, /api/planners, /api/channels, /api/channels/[id]/insights);
- `app/api/posts/route.ts` — **L96** `prisma.post.findMany` sem select (break);
- `app/api/channels/[id]/insights/route.ts` — L28 select do canal **sem `platform`**;
- `app/api/ig-insights.ts` — token resolvido por `resolveAccessToken(channel.access_token)` (só Instagram);
- `app/api/cron/metrics/route.ts` — L38 iterava **todos** os canais ativos (inclusive TikTok/YouTube) para sincronizar métricas IG;
- `lib/instagram.ts` — `fetchWithTimeout`/`getGraphBaseUrl`: check (d) do roteiro — o fluxo de insights não passa proxy, mas **não foi o break** (comportamento igual ao pré-0008; não-blocking, anotado em 4).

Resultado do check (a)–(e): **(c) schema query inválida após migrations =
causa raiz.** (a) `platform` não estava no select (corrigido — ver 2); (b)
métricas são Prisma (`post_metrics`), não fs — não aplica; (d) proxy não é
usado nas insights (não é o break); (e) rotas app-router corretas.

## 2. Correções

**Ambiente (restaura o fluxo):** alinhar o banco local via caminho "legacy"
do `db-migrate.sh` (db push aditivo + baseline das migrations):

```
npx prisma db push                       # adiciona tiktok_* em posts +
                                         # caption_*/youtube_products em content_items
npx prisma migrate resolve --applied 0007_cron_locks ... 0013_add_tiktok_post_fields
npx prisma migrate status                # "Database schema is up to date!"
```

Em produção, `docker-entrypoint.sh` → `scripts/db-migrate.sh` já executa esse
caminho (db push + resolve + migrate deploy) — com o 0013 commitado, `migrate
deploy` também resolve bancos gerenciados/fresh.

**Código (commit atômico `fix(analytics): S2 restaura insights`):**

| Arquivo | Linha(s) | Mudança |
|---|---|---|
| `prisma/migrations/0013_add_tiktok_post_fields/migration.sql` | todo | **Commit do migration 0013** (estava untracked): adiciona `posts.tiktok_type/tiktok_post_id/tiktok_publish_id/tiktok_options/tiktok_status` + índice — fecha a lacuna de schema dos merges A1/A4 |
| `app/api/posts/route.ts` | L95-111 | `GET` com try/catch → 500 JSON via `getErrorMessage` (sem vazar stack). Painel não fica mais em branco com 500 cru; volta a funcionar sozinho quando o DB é alinhado |
| `app/api/channels/[id]/insights/route.ts` | L28, L39-50 | `platform` no select do canal + guard non-Instagram → 400 PT-BR ("Métricas do Instagram não se aplicam a um canal tiktok.") em vez de "Channel has no access token" enganoso |
| `app/analytics/page.tsx` | ~L1241-1251, L1110-1130, L1244-1254 | Canal TikTok/YouTube passam a renderizar `PlatformMetricsEmpty` (PT-BR, "Métricas do TikTok ainda não disponíveis...") sem chamar a rota de insights IG; `PlatformMetricsEmpty` genérico substitui `YoutubeMetricsEmpty` (texto do YouTube preservado) |
| `app/api/cron/metrics/route.ts` | L38-46 | `findMany` filtrado por `platform: "instagram"` — o job de métricas é IG-only; não itera mais canais TikTok/YouTube (token em settings, sem access_token IG) nem queima quota da Graph API |

Nenhum caminho de publish (TikTok/YouTube/IG) foi tocado.

## 3. Evidência DEPOIS

```
GET /api/posts?limit=5                 → HTTP 200 (5 posts; antes 500)
GET /api/channels/{ig}/insights?days=30 → HTTP 200
  channel: Teste IG | source: ig | totals.posts_analyzed: 0
GET /api/channels/{tiktok}/insights?days=30 → HTTP 400 (PT-BR)
  {"error":"Métricas do Instagram não se aplicam a um canal tiktok.",
   "detail":"As métricas de audiência para esta plataforma ainda não são suportadas pelo painel."}
prisma migrate status                  → 13 migrations, Database schema is up to date!
tsc --noEmit                           → 0 erros
next build                             → exit 0 (compiled successfully)
```

## 4. Notas / riscos

- **Proxy (check d):** `fetchMediaInsights` não encaminha o proxy do canal
  (o merge 0008 adicionou `proxy_url`/dispatcher ao `lib/instagram.ts` apenas
  para refresh/profile). Não é o break desta P0 — a chamada IG é idêntica ao
  pré-0008 — mas canais configurados com proxy ainda buscam insights sem
  proxy. Fora do escopo desta correção (exige token real para testar).
- **Coexistência de agentes paralelos:** o workspace é compartilhado com
  outras tarefas (S1/S3) que alternam branches/resets — este trabalho foi
  commitado na branch própria `s2-analytics` para não se perder.
- **Regressão:** tsc 0, build OK, rota /api/posts 200, insights IG 200,
  TikTok 400 PT-BR. Fluxo de publish intocado.