# Plano de Integração — Fase 1 Swarm Paralelo (5 tracks → `feat/planner-isolation-proxy`)

> **Watcher:** agent 6 (observador)  
> **Branch base:** `feat/planner-isolation-proxy` (HEAD `848a59d`, sync com `origin/fixes-monolith`)  
> **Data:** 2026-09-01 09:06 UTC  
> **Objetivo:** mapear conflitos entre os 5 tracks paralelos, definir ordem de merge e guiar a resolução sem quebrar `PlannerWizard`, `planner-config` ou `channels/planners` routes.

---

## 1. Mapa de Propriedade por Track

| Track | Escopo declarado | Arquivos que **deve** tocar | Arquivos que **pode** tocar (efeito colateral) |
|---|---|---|---|
| **proxy** | Isolar chamadas externas (IG/YouTube) atrás de proxy interno, evitar SSRF, centralizar `fetch` com `HTTP_PROXY`/`HTTPS_PROXY` | `lib/proxy.ts` (novo), `middleware.ts` ou `lib/ssrf-guard.ts`, `lib/instagram.ts`, `lib/youtube.ts`, `next.config.ts` (opcional), `app/api/channels/[id]/refresh/route.ts`, `app/api/import-url/route.ts` | `app/api/channels/route.ts` (se criar canal via proxy), `.env.example` |
| **isolation** | Isolar planners por canal/usuário — planner só vê conteúdo e canais que lhe pertencem; impedir vazamento cross-channel | `lib/planner-config.ts` (validação `channel_ids`), `lib/planner-runtime.ts` (filtragem `resolvePlannerContent` + `publisher` claim), `app/api/planners/route.ts`, `app/api/planners/[id]/route.ts`, `components/PlannerWizard.tsx` (step Accounts), `prisma/schema.prisma` (se adicionar constraint), `app/planners/page.tsx` | `app/api/content-items/route.ts` (filtragem por planner), `components/ContentLibrary.tsx` (filtro por canal) |
| **yt-fields** | Adicionar/estabilizar campos específicos de YouTube no planner (`youtube_options`: `privacy`, `made_for_kids`, `monetize`, `description`, `category`, etc.) | `lib/youtube-post-options.ts` (validação/normalização), `lib/youtube.ts` (serialização), `lib/youtube-channel.ts`, `components/PlannerWizard.tsx` (form YT), `app/api/planners/**` (persistência `youtube_options`), `app/youtube/**` | `lib/planner-config.ts` (novo campo no config), `lib/planner-runtime.ts` (branch `isYoutube`), `app/api/posts/route.ts` (render YT) |
| **bug-remove** | Corrigir remoção/exclusão (bulk delete, cascade, drift de arquivos no disco, `deleteFiles`) | `app/api/content-items/bulk/route.ts`, `app/api/content-items/[id]/route.ts`, `lib/deleteFiles.ts`, `components/ContentLibrary.tsx` (`handleBulkDelete`), `components/MoveContentModal.tsx`, `app/api/upload-chunk/*` (limpeza órfãos) | `lib/planner-runtime.ts` (se planner referencia conteúdo deletado), `prisma/schema.prisma` (cascade) |
| **bug-desc** | Corrigir descrição/caption (template vars `{post_caption}/{date}/{hashtags}`, `caption_templates`, `caption_rotation`, `description` vs `caption`) | `components/PlannerWizard.tsx` (step Caption/Description), `lib/planner-config.ts` (`validatePlannerConfig`, `substituteCaptionTemplate`), `lib/planner-runtime.ts` (`applyCaptionTemplate`), `app/planners/page.tsx`, `app/api/planners/[id]/preview/route.ts` | `lib/sanitize.ts` (escape de caption), `components/EditContentModal.tsx` |

**Observação do watcher:** a tabela acima é inferida do nome da branch + histórico de `planner`/`youtube`/`content-items` no repo. Confirmar com cada track owner antes do merge final; ajustar se algum track tocar fora do previsto.

---

## 2. Matriz de Conflitos

### 2.1 Visão compacta (track × track)

|  | proxy | isolation | yt-fields | bug-remove | bug-desc |
|---|---|---|---|---|---|
| **proxy** | — | 🟡 `channels` routes, `instagram.ts`/`youtube.ts` | 🟡 `youtube.ts`, `youtube-channel.ts` | 🟢 baixo | 🟢 baixo |
| **isolation** | 🟡 | — | 🔴 `planner-config.ts`, `planner-runtime.ts`, `PlannerWizard.tsx` (Accounts) | 🟡 `ContentLibrary`, `planner-runtime` (conteúdo deletado) | 🔴 `planner-config.ts`, `PlannerWizard.tsx` (Caption), `planner-runtime.ts` |
| **yt-fields** | 🟡 | 🔴 | — | 🟢 baixo | 🔴 `planner-config.ts`, `PlannerWizard.tsx`, `planner-runtime.ts` (branch `isYoutube`) |
| **bug-remove** | 🟢 | 🟡 | 🟢 | — | 🟡 `ContentLibrary.tsx`, `planner-config` (se bug-desc tocar `content`) |
| **bug-desc** | 🟢 | 🔴 | 🔴 | 🟡 | — |

**Legenda:** 🔴 alto (mesma linha/função), 🟡 médio (mesmo arquivo, funções distintas), 🟢 baixo (arquivos disjuntos).

### 2.2 Matriz arquivo × tracks (onde dói de verdade)

| Arquivo | proxy | isolation | yt-fields | bug-remove | bug-desc | Conflito esperado |
|---|---|---|---|---|---|---|
| `components/PlannerWizard.tsx` (1790 linhas) | — | ✅ step Accounts (`channel_ids` filter) | ✅ form YT (`youtube_options`) | — | ✅ step Caption (`caption_templates`, `description`) | **🔴 CRÍTICO — 3 tracks no mesmo arquivo**, alta chance de conflito de merge em `STEPS`, `useEffect` de load, `handleSubmit`, `initialData` |
| `lib/planner-config.ts` (359 linhas) | — | ✅ `channel_ids` + `validatePlannerConfig` + `parsePlannerConfig` | ✅ `youtube_options` schema | — | ✅ `caption_templates` / `caption_rotation` + `substituteCaptionTemplate` | **🔴 CRÍTICO — 3 tracks validam o mesmo `PlannerJson`**; ordem de validação importa |
| `lib/planner-runtime.ts` (957 linhas) | — | ✅ `resolvePlannerContent`, `getPlannerIntervalMs`, `isSleepingNow`, publisher claim | ✅ branch `isYoutube` + `youtubeOptions` serialização | ⚠️ se conteúdo deletado | ✅ `applyCaptionTemplate` / `substituteCaptionTemplate` | **🔴 ALTO — isolation e yt-fields mexem no mesmo `selectNextContent` e `createPost`** |
| `app/api/planners/route.ts` (POST/GET) | — | ✅ `resolveOwnedChannelIds` + `validateConfigPayload` | ✅ `youtube_options` persistência | — | ✅ `caption`/`description` sanitização | **🟡 MÉDIO — todos validam `config` antes do `prisma.planner.create`** |
| `app/api/planners/[id]/route.ts` | — | ✅ ownership guard por canal | ✅ `youtube_options` patch | — | ✅ `caption` patch | **🟡 MÉDIO** |
| `app/api/channels/route.ts` + `[id]/route.ts` | ✅ proxy no `fetchInstagramProfile`/`refreshInstagramToken` | ✅ filtro `where: { user_id, ... }` | ✅ `platform: youtube` branch | — | — | **🟡 MÉDIO — proxy vs isolation tocam o mesmo `select`/`where`** |
| `lib/youtube.ts` / `lib/youtube-channel.ts` | ✅ `youtubeFetch` via proxy | — | ✅ `youtubePostOptions` + `youtubeFetch` | — | — | **🟡 MÉDIO — mesma função `youtubeFetch`** |
| `components/ContentLibrary.tsx` | — | ⚠️ filtro por planner | — | ✅ `handleBulkDelete` + `count_descendants` | — | **🟡 MÉDIO** |
| `app/api/content-items/bulk/route.ts` | — | — | — | ✅ `collectWithDescendants` + `countNestedDescendants` | — | **🟢 BAIXO (isolado)** |
| `lib/sanitize.ts` / `lib/instagram.ts` | ✅ `escapeHtml` via proxy | — | — | — | ✅ `escapeHtml` de caption | **🟢 BAIXO** |

---

## 3. Conflitos Detalhados & Como Resolver

### 3.1 `components/PlannerWizard.tsx` — o gargalo central

**Por que conflita:** 1790 linhas, 5 steps (`basics`→`accounts`→`content`→`schedule`→`sorting`), com `useEffect` de load (open-key idempotency guard adicionado em `8f70f46`), `useState` por step, e `handleSubmit` que serializa `config` inteiro.

- **isolation** deve adicionar no step `accounts`: filtro `channels.filter(c => c.user_id === session.user.id)` + UI de `channel_ids` multi-select, e guardar `channel_ids` no `config`/`relation`.
- **yt-fields** deve adicionar no wizard: seção condicional `if (youtubeMode !== 'none')` com campos `privacy`, `madeForKids`, `monetize`, `youtubeDescription`, persistindo em `config.youtube_options`.
- **bug-desc** deve mexer no step `basics`/`caption`: `caption_templates` textarea + `caption_rotation` select + `description` field, com `substituteCaptionTemplate` preview.

**Estratégia de resolução:**
1. **Mergear `bug-desc` primeiro** (menor diff, já tem helper `substituteCaptionTemplate` em `lib/planner-runtime.ts` que é ponto de integração — não mover esse helper).
2. Depois **isolation** (adiciona `channel_ids` no topo do `config` — não reordena steps).
3. Depois **yt-fields** (adiciona bloco YT após `isolation`'s `channel_ids` — manter `plannerMediaLabel` existente, estender com `youtubeMode`).
4. Em caso de conflito de `handleSubmit`, **preservar as 3 validações** (channel ownership + youtube_options + caption) na ordem: `validatePlannerConfig` → `resolveOwnedChannelIds` → `parseYoutubePostOptions`.

**Guard contra regressão:** manter o guard `open-key idempotency` (`8f70f46`) e `keepSelection` logic (`ContentLibrary`) — qualquer rebase deve preservar essas 2 linhas.

### 3.2 `lib/planner-config.ts` — validações concorrentes

**Conflito:** 3 tracks adicionam regras em `validatePlannerConfig`:

```ts
// isolation: channel_ids must be array + ownership (ou validação leve)
// yt-fields: youtube_options must be object + campos YT válidos
// bug-desc: caption_templates must be string[] + caption_rotation enum
```

**Resolução:**
- Manter **uma única função** `validatePlannerConfig` (não splitar em 3 arquivos).
- Ordem de checks: `frequency` → `sort_order` → `content` → **`channel_ids` (isolation)** → **`youtube_options` (yt-fields, delega para `parseYoutubePostOptions` sem duplicar regex)** → **`caption_templates`/`caption_rotation` (bug-desc)** → `sleep_schedule` → `start_time`.
- **Não duplicar** `FREQUENCY_UNITS`/`SORT_ORDERS` — yt-fields e bug-desc devem reutilizar constantes existentes.

### 3.3 `lib/planner-runtime.ts` — runtime vs preview

**Conflito:** `isolation` filtra `resolvePlannerContent` por `channel_ids`; `yt-fields` adiciona branch `if (isYoutube) { youtubeOptions = ... }` dentro de `selectNextContent`/`createPost`; `bug-desc` já mexeu em `substituteCaptionTemplate` vs `applyCaptionTemplate`.

**Resolução:**
- `substituteCaptionTemplate` é o **único** ponto de substituição (introduzido em `a9090a7`) — `bug-desc` não deve recriar regex; `yt-fields` deve chamar `substituteCaptionTemplate` para `youtube_options.description` também se precisar.
- `isolation` deve filtrar **antes** de `yt-fields` decidir `isYoutube` — evita criar `youtube_options` para conteúdo filtrado fora.

### 3.4 `app/api/channels/*` — proxy vs isolation

**Conflito:** `proxy` quer envolver `fetchInstagramProfile`/`refreshInstagramToken` com `proxyFetch`; `isolation` quer adicionar `where: { user_id }` guards.

**Resolução:** são ortogonais — `proxy` mexe no **como** fazer fetch, `isolation` no **quem** pode ver. Mergear `proxy` primeiro (infra), depois `isolation` (authz) por cima sem tocar no `fetch` wrapper.

---

## 4. Ordem de Merge Recomendada

### Opção A — Recomendada (menor risco de rebase)

```
1. bug-desc      (menor superfície, já tem helpers mergeados — estabelece caption contract)
2. bug-remove    (isolado em content-items — não toca wizard)
3. proxy         (infra — toca apenas fetch wrappers, sem wizard)
4. yt-fields     (feature — adiciona campos YT no wizard/config já estabilizado por bug-desc)
5. isolation     (core — por último, pois toca wizard + runtime + todos os guards; rebase sobre todos)
   ↓
6. Commit de integração: resolver PlannerWizard + planner-config + planner-runtime
7. Rodar: npx tsc --noEmit + npx eslint + gauntlet smoke (planner-scenarios P1-P8)
```

**Justificativa:** `isolation` é o mais invasivo (filtragem em 4 camadas); deixá-lo por último evita rebasear 4 vezes. `bug-remove` isolado pode ir cedo sem conflitar.

### Opção B — Alternativa (feature-first)

```
1. proxy → 2. isolation → 3. yt-fields → 4. bug-remove → 5. bug-desc
```
*Útil se `proxy` for pré-requisito de `isolation` (ex.: isolation precisa testar via proxy). Mais rebases no wizard.*

### Opção C — Paralelo com merge queue

- Cada track abre PR contra `feat/planner-isolation-proxy` com **CI de `tsc` + `eslint` por arquivo tocado**.
- Watcher mantém este `integration-plan.md` atualizado com `git diff --name-only` por PR.
- Merge sequencial via `git merge --no-ff` + `git rerere` habilitado para memorizar resoluções de `PlannerWizard`.

---

## 5. Checklist de Integração (pós-merge de cada track)

- [ ] `git diff --name-only origin/main..HEAD` — conferir que só os arquivos do mapa apareceram (nenhum `package.json`/`eslint` tocado).
- [ ] `npx tsc --noEmit` — 0 erros (cada track já deve ter passado no seu worktree).
- [ ] `npx eslint <arquivos tocados>` — 0 novos erros (warnings pré-existentes ok).
- [ ] `grep -n "substituteCaptionTemplate" lib/planner-runtime.ts app/api/planners/[id]/preview/route.ts` — garantir helper único (não duplicado por bug-desc/yt-fields).
- [ ] `grep -n "resolveOwnedChannelIds\|channel_ids" app/api/planners/route.ts lib/planner-config.ts` — garantir validação única de isolation.
- [ ] `grep -n "youtube_options\|parseYoutubePostOptions" lib/planner-config.ts lib/youtube-post-options.ts` — garantir delegação (não dupla validação).
- [ ] `wc -l components/PlannerWizard.tsx` — se > 1950 linhas, auditar se há duplicação de steps.
- [ ] Smoke do wizard: `npm run dev` → criar planner com: 1 canal IG + 1 YT, `caption_templates` com `{hashtags}`, `youtube_options` com `privacy=public`, verificar `POST /api/planners` 200 e `preview` sem `{` literal.
- [ ] Gauntlet: `scripts/gauntlet/planner-scenarios.mjs` (PL1-PL8) deve continuar green; se quebrar, culpar último merge.

---

## 6. Riscos Residuais & Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Merge de `PlannerWizard` gera `<<<<<<<` silencioso commitado | Média | Alto (quebra wizard) | Habilitar `git rerere`, exigir `npx tsc` no CI de cada PR, watcher verifica `grep -r "<<<<<<<"` pós-merge |
| `validatePlannerConfig` duplicado (cada track copiou validação) | Alta | Médio (erros 400 inconsistentes) | Code review focado em `planner-config.ts` — exigir delegação para `youtube-post-options.ts` |
| `isolation` filtra conteúdo que `yt-fields` ainda referencia (post órfão YT) | Média | Alto (planner nunca publica) | Teste de integração: planner com `channel_ids=[yt-channel]` + `content=[ig-only item]` → deve retornar 0 itens filtrados, não crash |
| `proxy` quebra `refreshInstagramToken` (timeout/proxy auth) | Baixa | Alto (canais ficam `inactive`) | `proxy` deve ter fallback: se `HTTP_PROXY` não setado, `fetch` direto (não quebrar sem proxy) |
| `bug-remove` cascade deleta `youtube_options` de planner que referencia folder deletado | Baixa | Médio (planner com `content` dangling) | `planner-runtime` já deve filtrar `content` inexistente — verificar `resolvePlannerContent` ignora ids deletados |

---

## 7. Próximos Passos para o Watcher

1. Assim que qualquer track fizer push, rodar `git diff --name-only HEAD~1..HEAD` e atualizar a matriz §2.
2. A cada 2–3 min, checar `.ai/guardian.*.heartbeat` + `git log --since="3 minutes ago"` — se algum track ficou >8 min sem heartbeat, atualizar `watcher-report.md` §2 com `lastSeen`.
3. Quando 3+ tracks tiverem PRs abertos, criar branch temporária `feat/planner-isolation-proxy-integration` e fazer **dry-run merge** na ordem §4 para revelar conflitos reais antes do merge final.

---

*Gerado pelo watcher (agent 6) sem edição de código de produto. Para dúvidas, abrir issue em `.ai/inbox/watcher.md` ou pingar o watcher na sessão `01a05a49`.*


---

## 8. ADDENDUM — Conflitos Reais Observados (09:08 UTC)

> **Watcher update:** o `git diff --stat HEAD` às 09:08 revelou **958 inserções** em 16 arquivos — todos os 5 tracks estão editando **a mesma working tree** (`feat/planner-isolation-proxy`) sem worktree isolation. A matriz abaixo é **confirmada por diff**, não mais inferida.

### 8.1 Diffs confirmados por arquivo (09:08)

| Arquivo | Linhas | Tracks confirmados (por diff) | Conflito real? |
|---|---|---|---|
| `lib/proxy.ts` (NOVO, 4.7 KB) | +~140 | **proxy** (único dono) | 🟢 Isolado — sem conflito |
| `prisma/schema.prisma` | +2 | **proxy** (`proxy_url`/`proxy_enabled`) | 🟡 Se isolation também migrar `Channel` (ex.: índice), haverá conflito de schema — **fazer `prisma db push` só no commit de integração** |
| `package.json` / `package-lock.json` | +16 | **proxy** (`undici`) | 🟢 Isolado |
| `lib/planner-config.ts` | +198 | **isolation** (`PLANNER_MIX_ERROR`, `getPlannerPlatformType`, `validatePlannerChannelMix`) **+ yt-fields** (`youtube_title`, `youtube_description`, `youtube_products`, `youtube_privacy`, etc.) **no mesmo arquivo** | 🔴 **CONFLITO REAL CONFIRMADO** — 2 tracks no mesmo arquivo, funções intercaladas (isolation no fim do arquivo, yt-fields no meio de `validatePlannerConfig`). Merge manual já feito na working tree atual — **preservar ambas as seções** |
| `lib/planner-runtime.ts` | +381 | **yt-fields** (`youtube_title`/`products` em `buildPostData`) **+ bug-desc** (`shouldPropagateConfig`, `propagatePlannerConfigToPendingPosts`, `buildYoutubeOptionsForPropagation`) | 🔴 **CONFLITO REAL CONFIRMADO** — yt-fields no topo de `buildPostData`, bug-desc no fim do arquivo (300 linhas novas). Estão ortogonais (topo vs fim) — **sem sobreposição de linhas**, mas compartilham `normalizeYoutubeProductsCsv` import |
| `lib/instagram.ts` | +14 | **proxy** (dispatcher) | 🟢 Isolado |
| `lib/youtube.ts` | +24 | **proxy + yt-fields** (dispatcher + YT fields) | 🟡 Mesmo arquivo, mas proxy no `youtubeFetch` wrapper, yt-fields em `youtube-post-options` — **sem sobreposição** |
| `app/api/channels/route.ts` | +24 | **proxy** | 🟢 Isolado |
| `app/api/channels/[id]/route.ts` | +64 | **proxy** | 🟢 Isolado (só proxy) |
| `app/api/planners/route.ts` | +10 | **isolation** (`validatePlannerChannelMix` no POST) | 🟢 Isolado |
| `app/api/planners/[id]/route.ts` | +88 | **isolation** | 🟢 Isolado |
| `app/api/planners/[id]/duplicate/route.ts` | +9 | **isolation** | 🟢 Isolado |
| `app/api/planners/[id]/run/route.ts` | +22 | **isolation + yt-fields** | 🟡 Mesmo arquivo — isolation no guard, yt-fields na propagação |
| `app/api/planners/[id]/preview/route.ts` | +8 | **bug-desc / yt-fields** | 🟢 Isolado |
| `components/PlannerWizard.tsx` | +107 | **isolation** (`selectedPlatformType`, `isChannelDisabled`, `hasMixSelected`, badges, bloqueio submit) | 🟡 Por enquanto só isolation visível; **yt-fields e bug-desc ainda não tocaram o Wizard** nesta working tree — quando tocarem, haverá conflito 🔴 |
| `app/api/upload-chunk/complete/route.ts` | +59 | **bug-remove** (lock/proxy) | 🟢 Isolado |

### 8.2 Matriz atualizada (confirmada)

|  | proxy | isolation | yt-fields | bug-remove | bug-desc |
|---|---|---|---|---|---|
| **proxy** | — | 🟢 (isolado até agora) | 🟡 `youtube.ts` (confirmado sem conflito) | 🟢 | 🟢 |
| **isolation** | 🟢 | — | 🔴 **`planner-config.ts` (CONFIRMADO)** | 🟢 | 🟡 `planner-runtime.ts` (compartilham import, mas sem sobreposição) |
| **yt-fields** | 🟡 | 🔴 | — | 🟢 | 🟡 `planner-runtime.ts` (topo vs fim) |
| **bug-remove** | 🟢 | 🟢 | 🟢 | — | 🟢 |
| **bug-desc** | 🟢 | 🟡 | 🟡 | 🟢 | — |

**Conclusão:** o pior conflito previsto (§2: `PlannerWizard.tsx` com 3 tracks) **ainda não se materializou** — apenas `isolation` tocou o Wizard até agora. O conflito real é **`planner-config.ts` (isolation + yt-fields)** — já resolvido na working tree atual, mas **frágil**: qualquer re-edição concorrente pode sobrescrever a outra seção.

### 8.3 Recomendação revisada (09:08)

1. **Parar edição direta concorrente imediatamente.** O `git status` com 16 arquivos unstaged + 4 untracked (`lib/proxy.ts`, `docs/*.md`, `docs/diagnose-upload-vps.md`) vai falhar em qualquer `git worktree add` futuro (erro `clean working tree required`). **Commitar o estado atual como checkpoint de integração:**
   ```bash
   git add lib/proxy.ts prisma/schema.prisma package.json package-lock.json \
           lib/planner-config.ts lib/planner-runtime.ts lib/instagram.ts lib/youtube.ts \
           app/api/channels/route.ts app/api/channels/[id]/route.ts \
           app/api/planners/route.ts "app/api/planners/[id]/route.ts" \
           "app/api/planners/[id]/duplicate/route.ts" "app/api/planners/[id]/run/route.ts" \
           "app/api/planners/[id]/preview/route.ts" components/PlannerWizard.tsx \
           app/api/upload-chunk/complete/route.ts
   git commit -m "feat(planner-isolation-proxy): checkpoint Fase 1 — proxy+isolation+yt-fields+bug-desc parciais (watcher 09:08)"
   npx prisma generate  # se schema mudou
   npx tsc --noEmit
   ```
2. **Depois do checkpoint, voltar a worktrees:** cada track restante (`bug-remove` fully, `yt-fields` Wizard, `bug-desc` Wizard) deve abrir worktree a partir do checkpoint.
3. **Ordem de merge revisada (pós-checkpoint):**
   ```
   checkpoint (atual, 09:08) → bug-remove (content-items/bulk) → yt-fields Wizard → bug-desc Wizard → integração final
   ```
4. **Watchers:** a partir de agora, checar `git diff --stat` em vez de só heartbeats — heartbeats continuam 0, mas `git diff` prova atividade.

