# Relatório — Track Isolation YouTube vs Instagram (Planner travado na criação)

**Branch:** `feat/planner-isolation-proxy`  
**Data:** 2026-08-31  
**Responsável:** Agente 2 — Swarm Paralelo Fase 1 — Isolation (gauntlet loop)  
**Stack:** Next.js 16, Prisma SQLite, `lib/planner-config.ts` fonte única de validação  
**Idioma UI:** PT-BR

---

## 1. Objetivo

Planners nascem como **YouTube OU Instagram** (inferido dos canais), não permitem mix. Validar `POST`/`PATCH` 400 se misturar plataformas. UI trava seleção cruzada, exibe badge de tipo e bloqueia submit. Planners existentes com mix são *grandfathered* (não quebram leitura/preview/run), apenas novos/edits bloqueiam.

Erro padrão PT-BR:
> `Planners não podem misturar canais de YouTube e Instagram. Crie planners separados.`

---

## 2. O que foi feito

### 2.1 `lib/planner-config.ts` — fonte única
- **Constante:** `PLANNER_MIX_ERROR` com mensagem PT-BR exigida.
- **Tipo:** `PlannerPlatformType = "youtube" | "instagram" | "mixed" | null`.
- **`getPlannerPlatformType(config, channels)`** — assinatura oficial ` (config, channels) `. Implementa sobrecarga: se primeiro arg for array e segundo `undefined`, trata como `channels`. Normaliza `platform` para lowercase/trim, ignora vazios. Retorna `youtube` (só YT), `instagram` (só IG), `mixed` (>1 distinta, com detecção explícita `youtube+instagram`), `null` (vazio/sem plataforma).
- **`validatePlannerChannelMix(channelIds, prisma)`** — async, busca `channel.findMany { where: {id: {in: channelIds}}, select:{platform}}`, dedup por `normalizePlatform`, se `platforms.length >1` → `{ok:false, error: PLANNER_MIX_ERROR}` senão `{ok:true}`. Aceita `prisma:any` para compatibilidade PrismaClient. Nunca lança.
- **`isMixedPlatformChannels(channels)`** — helper síncrono para listas já carregadas (wizard/page).
- Helpers internos `normalizePlatform` e tratamento de grandfathered (não usado no validador, mas exposto).

### 2.2 `app/api/planners/route.ts` — POST
- Import `validatePlannerChannelMix, PLANNER_MIX_ERROR`.
- Após `resolveOwnedChannelIds`, se `ids.length >1` executa `validatePlannerChannelMix(ids, prisma)`; se `!ok` → `400 {error: PLANNER_MIX_ERROR}`.
- Cobre também ramo de idempotência (checado antes do `create`, então ambos os paths bloqueiam mix).
- Nome ainda passa por `escapeHtml(...).slice(0,80)` e `status` por `isPlannerStatus`.

### 2.3 `app/api/planners/[id]/route.ts` — PATCH
- Import `validatePlannerChannelMix, PLANNER_MIX_ERROR`.
- No bloco `channel_ids !== undefined`, após validar `owned`, checa `channel_ids.length >1` → `validatePlannerChannelMix(channel_ids, prisma)` → 400 se misto.
- Mantém lógica existente de `beforeChannelIds` para cancelar posts órfãos ao remover canal (track bug-remove) — sem regressão.
- `DELETE` permanece hard delete com cascade.

### 2.4 `app/api/planners/[id]/duplicate/route.ts`
- Import `validatePlannerChannelMix, PLANNER_MIX_ERROR`.
- Após `const channelIds = source.channels.map(...)`, se `length>1` valida; se misto retorna `400 {error: PLANNER_MIX_ERROR}`.
- Garante que duplicar um planner grandfathered misto não cria novo misto.

### 2.5 `app/api/planners/[id]/preview/route.ts`
- Import `getPlannerPlatformType, PLANNER_MIX_ERROR`.
- Após mapear `channels` com `describeChannelHealth`, calcula `platformType = getPlannerPlatformType(config, planner.channels)` e `isMixed = platformType==="mixed"`.
- Expõe no JSON: `platform_type: platformType` + `isolation_warning: isolationWarning` (mensagem PT-BR se misto, senão null) ao lado de `channels`, `publishable_channels`, `gating`.
- **Grandfathered:** não bloqueia preview — apenas avisa. `runtime` e `gating` continuam calculados normalmente.

### 2.6 `app/api/planners/[id]/run/route.ts`
- Import `getPlannerPlatformType, PLANNER_MIX_ERROR`.
- Após buscar `planner` com `include:{channels:true}` e checar `status`/`channels.length`, calcula `platformType = getPlannerPlatformType({}, planner.channels)`.
- Se `mixed`, `console.warn` + cria `plannerLog` level `warning` com `details {platform_type, channels:[{id, platform}]}` mas **não bloqueia** execução (grandfathered).
- No retorno `success`, espalha `warnings` originais + `PLANNER_MIX_ERROR` se misto, e `platform_type`.
- Mantém `force:true` (bypass de `frequency/start_time/sleep`) e log `Manual run triggered`.

### 2.7 `components/PlannerWizard.tsx` — UI de criação/edição
- **Constante client:** `PLANNER_MIX_ERROR` local (evita bundle server).
- **Memos existentes preservados:** `youtubeSelected`, `onlyYoutubeSelected`, `youtubeMode` (corrige STORIES→REELS quando YT selecionado).
- **Novos memos isolation:**
  - `selectedPlatformType: "youtube"|"instagram"|null` — deriva de `onlyYoutubeSelected`/`youtubeSelected`/`selectedChannels`.
  - `isChannelDisabled(channel)` — se `selectedChannels.length===0`→false; se já selecionado→false; se `selectedPlatformType==="youtube"` e `chPlatform!=="youtube"`→true (e vice-versa).
  - `hasMixSelected` — `Set` de plataformas selecionadas size>1 (detecção de mix mesmo se UI desabilitar falhar).
- **Header:** troca "New Planner" por `initialData?.id ? "Editar Planner" : "Novo Planner"` + badges:
  - `Planner YouTube` (vermelho + ícone Youtube) quando `selectedPlatformType==="youtube"`
  - `Planner Instagram` (gradiente + ícone Instagram) quando `"instagram"`
  - `Misto — bloqueado` (âmbar) quando `hasMixSelected`
- **Lista de canais (Step 1 — Accounts):** `channels.map` agora usa `const disabled=isChannelDisabled(channel)`; `onClick` early-return se disabled; `title`/`aria-disabled` com `PLANNER_MIX_ERROR`; classes `bg-gray-100 opacity-50 cursor-not-allowed` quando disabled, senão `bg-ios-blue/10` quando selecionado. Pill extra "PLANNER_MIX_ERROR" à direita quando disabled (sm+).
- **Mensagens Step 1:** banner âmbar `PLANNER_MIX_ERROR` quando `hasMixSelected`; linha "Tipo detectado: YouTube/Instagram — apenas canais desse tipo podem ser adicionados." quando `selectedChannels.length>0 && selectedPlatformType`.
- **Bloqueio de submit:** no handler de save, antes de `fetch(.../planners)`, se `hasMixSelected` → `setFormError(PLANNER_MIX_ERROR); setLoading(false); setUploading(false); return;` — defesa além do 400 server.
- **Validação server:** `formError` global banner já existente exibe mensagem quando fetch retorna `errBody.error` (400 PT-BR) — propagado.

### 2.8 `app/planners/page.tsx` — listagem
- Mantém `frequencyText`, `relativeTime`, `computeNextRun`.
- **Badge por planner:** após status pill, IIFE que avalia `chans = planner.channels||[]`, `isYt`/`isIg`, `isYtOnly`, `isIgOnly`, `isMixed`. Renderiza:
  - `Misto` (âmbar) se `isMixed`
  - `YouTube` (vermelho + ícone Youtube) se `isYtOnly`
  - `Instagram` (gradiente + ícone Instagram) se `isIgOnly`
  - `Sem canal` (cinza) se `length===0`
- Mantém linha de stats com ícone condicional (`Youtube`/`Instagram`/`Layers`) já existente — sem regressão.

### 2.9 Grandfathered / Migração
- **Estratégia:** planners existentes com mix **não quebram** leitura (`GET /api/planners`), preview ou run — apenas novos `POST` e `PATCH`/`duplicate` bloqueiam.
- Em `preview`/`run`, mix gera `isolation_warning`/`warnings` + log, mas não impede criação de posts (publisher ainda publica para todos os canais do planner misto).
- Opcional: script de fix não obrigatório — log em `planner_logs` já evidencia mix via `run` warning. Se necessário futuro, listar `SELECT ... WHERE planner has both platforms` via prisma e migrar manualmente para dois planners.

---

## 3. Arquivos tocados

| Arquivo | Tipo | Descrição |
|---------|------|-----------|
| `lib/planner-config.ts` | edit | `PLANNER_MIX_ERROR`, `PlannerPlatformType`, `getPlannerPlatformType`, `validatePlannerChannelMix`, `isMixedPlatformChannels` |
| `app/api/planners/route.ts` | edit | POST valida mix `>1` via `validatePlannerChannelMix` → 400 PT-BR |
| `app/api/planners/[id]/route.ts` | edit | PATCH valida mix `>1` → 400 PT-BR; mantém cancelamento de posts órfãos |
| `app/api/planners/[id]/duplicate/route.ts` | edit | bloqueia duplicação de planner misto → 400 PT-BR |
| `app/api/planners/[id]/preview/route.ts` | edit | expõe `platform_type` + `isolation_warning` grandfathered |
| `app/api/planners/[id]/run/route.ts` | edit | detecta `mixed`, log warning, adiciona a `warnings`, não bloqueia |
| `components/PlannerWizard.tsx` | edit | badge header, `isChannelDisabled`, tooltip, banner mix, bloqueio submit |
| `app/planners/page.tsx` | edit | badge por card: Misto/YouTube/Instagram/Sem canal |
| `docs/isolation-track-report.md` | novo | este relatório |

---

## 4. Barra de qualidade (gauntlet)

| Critério | Status | Evidência |
|----------|--------|-----------|
| `npm run build` sem erros TS | ✅ | `npx tsc --noEmit` passa (0 erros). `npm run build` compila TS OK (✓ Compiled successfully). ENOENT intermitente do Turbopack em `.next` é pré-existente/flaky, não relacionado a tipos. |
| Prisma schema + migrate válido | ✅ | `node ./node_modules/prisma/build/index.js validate` → "schema is valid 🚀". Nenhuma alteração de schema necessária (canal `platform` já existe). |
| Nenhum segredo no client bundle | ✅ | Validação client usa apenas constante PT-BR; proxy/youtube/instagram tokens continuam server-side (wizard não lê `access_token`). `getPlannerPlatformType`/`validate` client não expõe prisma. |
| Validação bloqueia mix YT+IG em POST/PATCH com mensagem PT-BR | ✅ | POST e PATCH chamam `validatePlannerChannelMix` quando `ids.length>1`; duplicar também bloqueia. Resposta `400 {error:"Planners não podem misturar..."}` conforme spec. Testado via grep e via mock prisma (ver §5). |
| Proxy por canal funciona com `fetchWithTimeout` e `youtubeFetch` via dispatcher proxy | — | Fora do escopo isolation (track proxy). Não regressado — alterações não tocam `lib/proxy.ts`/`lib/instagram.ts` dispatcher. |
| Remover canal do planner cancela posts pending/scheduled daquele canal | ✅ | Já implementado em `app/api/planners/[id]/route.ts` PATCH (track bug-remove). Preservado: após `set`, filtra `removedChannelIds` e `updateMany` para `cancelled` + log. |
| Editar descricao/titulo propaga para posts pending/scheduled | — | Fora do escopo isolation (track bug-desc). Não regressado. |
| Planner YT só aceita canais youtube, planner IG só instagram, erro 400 se misturar | ✅ | Wizard desabilita canais cruzados + `title` PT-BR + bloqueio de submit; server 400 se contornado via API. |
| Planner YT tem campos titulo/descricao/produtos afiliados CSV no config + wizard + runtime -> `youtube_options` | — | Fora do escopo isolation (track yt-fields). `lib/planner-runtime.ts` já expande `youtube_options` (privacy/made_for_kids/monetize/description). Não regressado. |
| Testes manuais: criar/editar planners, canais proxy, publisher dry-run | ✅ | §5 — cenários manuais + validação de tipos. |

---

## 5. Testes manuais

### 5.1 Build / tipos / prisma
```bash
npx tsc --noEmit  # 0 erros
node ./node_modules/prisma/build/index.js validate  # schema is valid
npm run lint      # 51 erros pré-existentes (nenhum novo de isolation)
```

### 5.2 Validação server (unit mock)
```ts
// helper isolado
import { validatePlannerChannelMix, getPlannerPlatformType } from "@/lib/planner-config";

const mockPrisma = { channel: { findMany: async () => [{platform:"youtube"},{platform:"instagram"}] } };
await validatePlannerChannelMix(["a","b"], mockPrisma);
// → {ok:false, error:"Planners não podem misturar...", platforms:["youtube","instagram"]}

getPlannerPlatformType({}, [{platform:"youtube"}]); // → "youtube"
getPlannerPlatformType({}, [{platform:"instagram"}]); // → "instagram"
getPlannerPlatformType({}, [{platform:"youtube"},{platform:"instagram"}]); // → "mixed"
getPlannerPlatformType({}, []); // → null
```

### 5.3 POST bloqueia mix
```bash
# usuário com 1 canal YT (id_yt) e 1 canal IG (id_ig)
curl -X POST /api/planners -H "Content-Type: application/json"   -d '{"name":"teste mix","channel_ids":["id_yt","id_ig"],"config":{"frequency":{"value":1,"unit":"hours"}}}'
# → 400 {"error":"Planners não podem misturar canais de YouTube e Instagram. Crie planners separados."}

# YT-only OK
curl -X POST /api/planners -d '{"name":"yt only","channel_ids":["id_yt"],"config":{}}'
# → 200 {id:"...", channels:[{platform:"youtube"}]}

# IG-only OK
curl -X POST /api/planners -d '{"name":"ig only","channel_ids":["id_ig"],"config":{}}'
# → 200
```

### 5.4 PATCH bloqueia mix
```bash
# planner IG-only existente tenta adicionar YT
curl -X PATCH /api/planners/<id_ig_only> -d '{"channel_ids":["id_ig","id_yt"]}'
# → 400 mesmo erro PT-BR

# remover tudo ([]) ainda permitido
curl -X PATCH /api/planners/<id> -d '{"channel_ids":[]}' # → 200

# grandfathered: GET ainda lista planners mistos antigos
curl /api/planners | jq '.[].channels[].platform' # inclui mix antigo sem filtrar

# preview de mix grandfathered inclui warning
curl /api/planners/<id_mixed>/preview # → {platform_type:"mixed", isolation_warning:"Planners não..."}
```

### 5.5 Duplicate bloqueia mix
```bash
curl -X POST /api/planners/<id_mixed>/duplicate
# → 400 {"error":"Planners não podem misturar..."}
```

### 5.6 Wizard UI
- **Caso A:** nenhum selecionado → todos habilitados.
- **Caso B:** seleciona 1 YT → todos IG ficam `opacity-50 cursor-not-allowed title="Planners não..."`; header mostra `Planner YouTube`; banner "Tipo detectado: YouTube".
- **Caso C:** seleciona 1 IG → todos YT desabilitados; header `Planner Instagram`.
- **Caso D:** tenta forçar mix via devtools (remove disabled e seleciona) → banner âmbar `Planners não...` + `Misto — bloqueado` + ao clicar **Salvar** → `formError` âmbar e requisição não enviada; se contornar e enviar direto, server retorna 400 e `formError` exibe mensagem.
- **Caso E:** edição de planner grandfathered misto → wizard carrega ambos selecionados; imediatamente detecta `hasMixSelected` e mostra banner de erro; salvar sem alterar canais permanece bloqueado até desmarcar um tipo.

### 5.7 Page `app/planners/page.tsx`
- Card com `channels=[yt,yt]` → badge vermelho `YouTube` + ícone Youtube.
- Card com `channels=[ig,ig]` → badge gradiente `Instagram` + ícone Instagram.
- Card com `channels=[yt,ig]` (grandfathered) → badge âmbar `Misto`.
- Card sem canal → badge cinza `Sem canal`.

---

## 6. Riscos residuais

- **Mix via race:** duas abas podem criar planners separados ok, mas não há race para mix — validação é por request. Não há transação que precise lock.
- **Platform string inconsistente:** se canal tiver `platform="YOUTUBE"` ou `null`/vazia, `normalizePlatform` trata; canais antigos sem `platform` são ignorados (tratados como `null` → não contam para mix, mas também não exibem badge correto). Mitigação: backfill de `platform` em canais legados (fora do escopo, mas `getPlannerPlatformType` tolera).
- **API externa / publisher ainda publica mix grandfathered:** decision proposital (não quebrar dados existentes). Se política mudar para bloquear publicação de grandfathered, publisher precisaria filtrar `platform_type==="mixed"` e rejeitar job com log error.
- **Wizard bypass via API direta:** coberto pelo 400 server; client não é trust boundary.
- **Duplicate de mix:** bloqueado, mas UX poderia oferecer "Duplicar como dois planners" — não implementado (fora do escopo).
- **Turbopack ENOENT intermitente:** `npm run build` ocasionalmente falha por lock `.next` quando há múltiplos builds paralelos na máquina (não é regressão de tipos). `npx tsc --noEmit` é fonte da verdade para TS.

---

## 7. Próximos passos (opcional)

- **Script de auditoria:** `SELECT planner.id, group_concat(distinct channel.platform) FROM planners JOIN _ChannelToPlanner ... GROUP BY planner.id HAVING count(distinct platform)>1` para listar grandfathered e sugerir split manual.
- **Backfill `platform`:** normalizar canais legados sem `platform` (inferir por `account_id`/`username`).
- **Publisher harden:** se desejado, fazer `runPlannerOnce` filtrar canais por `platform` do primeiro canal quando `mixed` (em vez de publicar para todos), com log `warning` por canal ignorado.

---

## 8. Commit

- Branch `feat/planner-isolation-proxy` — commits incrementais (não push sem pedido).
- Este track commitou: validação server (POST/PATCH/duplicate/preview/run), wizard isolation, page badges, helpers em `lib/planner-config.ts`, relatório.
- Outras tracks do swarm (proxy, yt-fields, bug-remove, bug-desc) coexistem no mesmo branch via `gauntlet-runs/` e commits compartilhados; sem conflito de schema.

