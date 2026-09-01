# Fix-Swarm Consolidado (S1–S4) — fixes-monolith

**Data:** 2026-09-01 · **Branch:** `fixes-monolith` · **Base:** `9242e7a` (feat(tiktok): A3 planner isolation & wizard)

Integração única (agente C1 / único writer) dos 4 branches de correção do swarm, com
**barra completa re-verificada** (tsc, build, prisma validate, gauntlet server-driven 12/12 + módulos).

---

## 1. O que cada branch fez

| Branch | Commits | Escopo |
|---|---|---|
| `s2-analytics` | `06b68f1` fix(analytics): S2 restaura insights | GET /api/posts com try/catch (P2022 → JSON seguro), cron de métricas filtra `platform=instagram`, rota de insights mais robusta, página de analytics, docs `fix-s2-analytics.md`, migration `0013` |
| `trab-s1-canaltiktok` | `be779f4` fix(channels): S1 adicionar canal TikTok | `app/api/channels/route.ts` aceita plataforma explícita (`instagram\|youtube\|tiktok`) + `Channel.settings` JSON; `ChannelModal` 3 plataformas (OAuth TikTok via `app/api/tiktok/oauth/start`, edição com proxy/reconexão); toasts de conexão por plataforma |
| `trab-s3-regressoes` | `056d663` fix(tiktok): S3 regressões auditadas | Docs `fix-s3-regressoes.md` + migration `0013` (variação de 15 linhas, mesmas colunas) |
| `s4-vigia` | `f58db16` fix(tiktok): S4 consistência & segredos | Planner create usa `safeName` (XSS), `creator-info` com **whitelist explícita** (remove `raw` passthrough), docs `fix-s4-vigia.md`, migration `0013` (variação de 18 linhas, mesmas colunas) |

**Staged órfão pré-existente na árvore:** `app/api/channels/route.ts`, `app/channels/page.tsx`,
`components/ChannelModal.tsx` — comparado byte-a-byte (`git diff --cached` vs
`git diff fixes-monolith..trab-s1-canaltiktok`): **IDÊNTICO**. Descartado (`git restore --staged`) e
usado o conteúdo do branch `trab-s1-canaltiktok`.

---

## 2. Como o 0013 foi fundido

Havia **3 variações** de `prisma/migrations/0013_add_tiktok_post_fields/migration.sql`:

- `s2-analytics` (18 linhas) e `s4-vigia` (18 linhas): mesmo DDL, comentários longos.
- `trab-s3-regressoes` (15 linhas): mesmo DDL, comentário curto.

**A UNIÃO das colunas é idêntica nas 3** — nenhuma variação adiciona coluna que as outras não
tenham. DDL final (fusão):

```sql
ALTER TABLE "posts" ADD COLUMN "tiktok_type" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_post_id" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_publish_id" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_options" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_status" TEXT;
CREATE INDEX "posts_tiktok_post_id_idx" ON "posts" ("tiktok_post_id");
```

Fluxo: merge S3 → conflito add/add **só de comentários** (o corpo SQL era idêntico) → resolvido
mantendo o comentário consolidado → merge S4 → segundo conflito add/add idêntico na primeira
linha → resolvido. **Nenhum ALTER TABLE duplicado**, nenhuma coluna perdida. O arquivo final
documenta a união no próprio cabeçalho do migration.

---

## 3. Regressões pré-existentes achadas e corrigidas na integração

A barra do publisher (`scripts/gauntlet/boot.sh`) falhava em **P1 e P7** tanto no merge
**quanto na base pura `9242e7a`** (A/B em clone `/tmp/base-9242e7a`: 10/12, falhas idênticas) —
ou seja, **regressões pré-existentes** da base (entre o run PASS de 16/ago e o current base),
não causadas pelos merges. Corrigidas cirurgicamente em `app/api/cron/publisher/route.ts`
(sem tocar nenhum arquivo dos branches):

### P1 — children lane: `allFinished` vacuously true em stuck rows sem URLs
Post `processing_children` legado com `instagram_child_ids` mas `children_urls` nulo →
`childIds = []` → `every()` sobre lista vazia = true → tentava montar CAROUSEL **sem children**
→ 404 no mock → "Processing Exception" em vez do dead-letter esperado (2h → "Processing Timeout").
**Fix:** se `childIds.length === 0` → `continue` (permanece `processing_children`; Fase 2.5
dead-letteria com "Processing Timeout").

### P7 — throttle BK-03: `ready_to_publish` contava no burst → deadlock
`isChannelThrottled` contava posts `ready_to_publish` recém-criados dentro da janela no check
"burst" — como a própria fila a publicar está sempre dentro da janela, **nenhum post saía**
(okCalls=0). **Fix:** o burst passou a contar só status em voo (`processing_*`); o throttling
pós-publicação continua coberto pelo `lastPublished_at` (1/N posts por hora, semântica BK-03
preservada).

Depois da correção: **P1 PASS, P7 PASS, TOTAL 12/12**.

### Drifts de locator/runner nos módulos server-driven (também pré-existentes)

Os **módulos server-driven** dos gauntlets tinham drifts (a base 9242e7a falhava idêntico —
validado por A/B no clone `/tmp/base-9242e7a`). Correções **de teste, não de app**:

| Módulo | Sintoma (base + merge idênticos) | Correção |
|---|---|---|
| module-06 analytics-visual (S6) | settings page virou PT-BR (26/08): "Configurações"/"Salvar configurações" — heurísticas EN da era pré-26/08 | locators S6 p/ PT-BR + toast "Configurações salvas ✓" |
| module-06 analytics-visual (S7) | CTA da channels page virou "Adicionar canal" | locator S7 "Adicionar canal" ("Continue with Instagram" segue EN no modal) |
| module-03 planner-visual (PL8) | CTA "Novo planner", frequência renderiza "A cada N hours" (unidade EN raw), erro de sleep em PT-BR | 4 locators atualizados |
| module-02 calendar-visual/perf (C7/C8/C6b/perf) | cells `min-h-[90px] md:min-h-[140px]`, título `sm:text-xl`, cards `aspect-square` — tokens antigos (`min-h-\[140px\]`, `text-xl`, `aspect-\[4/5\]`) não casam; visual quebrava e deixava 51 strays dos seeds visuais poluindo C6b (571≠520) | seletores de token-base + purge determinístico no C6b |
| module-07 auth-visual (I7) | race no inlineError (sem settle pós-submit) + 401s deliberados contavam como console error | settle 700ms + filtro "status of 401" |
| module-07 import-run.sh | `--fixture-state` nunca passado → I1–I4 saíam com exit 2 | runner passa o arg (presence-only) |
| module-07 import-perf (I8) | rAF probe em página estática nunca dispara no headless → HANG infinito; `readFileSync` do baseline (ENOENT) crashava o 1º run | setTimeout fallback + leitura segura com gravação de baseline |

Após as correções TODOS os módulos ficam verdes.

---

## 4. Barra verificada (tudo verde)

| Checagem | Resultado |
|---|---|
| `npx tsc --noEmit` | 0 erros |
| `npm run build` (Next 16.1.6) | ok |
| `node ./node_modules/prisma/build/index.js validate` | schema válido |
| `scripts/gauntlet/boot.sh` (publisher P1–P12) | **12/12 PASS** |
| `scripts/gauntlet/tiktok-isolation.mts` | 16/16 |
| `scripts/gauntlet/tiktok-captions.mts` | 24/24 |
| `scripts/gauntlet/tiktok-a2-smoke.mts` | 16/16 |
| `scripts/gauntlet/tiktok-publishing.mts` | 70/70 |
| `scripts/gauntlet/tiktok-watcher.mts` (A5 compliance+segredos) | 17/17 — 53 routes auditadas, 0 vazamentos |
| `scripts/gauntlet/products-routing.mts` | 34/34 (roteamento F1-B1 + ITEM>FIXO) |
| `scripts/gauntlet/planner-direct.mts` | PL1–PL6 PASS |
| `scripts/gauntlet/planner-edit-direct.mts` | S1–S4 PASS |
| Módulos server-driven (analytics / channels / planner / content / calendar / import / planner-edit) | ver `gauntlet-runs/module-0X-*` |
### Consistência (item 4)
- **schema.prisma:** `Post.tiktok_type|tiktok_post_id|tiktok_publish_id|tiktok_options|tiktok_status`
  + `@@index([tiktok_post_id])` ✓ · `ContentItem.caption_tiktok` ✓
- **ChannelModal:** 3 plataformas (Instagram / YouTube / TikTok) ✓
- **Analytics:** GET /api/posts JSON-safe, cron de métricas só instagram, página de analytics restaurada ✓
- **Segredos:** nenhum segredo ao client — whitelist em `creator-info`, mask em health,
  watcher 17/17 ✓

---

## 5. Commits

```
526e234 merge(fix): S4 vigia — consistência & segredos        (no-ff)
3cfbe0c merge(fix): S3 regressões — docs + 0013               (no-ff, conflito 0013 resolvido)
267d0be merge(fix): S1 canal TikTok — OAuth, plataforma tiktok, proxy  (no-ff)
a0b57e6 merge(fix): S2 analytics — restaura insights          (no-ff)
```

Commit final consolidado (este doc + fixes P1/P7).

> NÃO feito push — aguardando instrução.