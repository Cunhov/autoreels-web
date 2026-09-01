# Verificação F0-B0 pós-B1 — Deadlock planner YT-Community + Media Type dinâmico

> **Agente:** 1 (builder+crítico, gauntlet loop) · **Fase:** F0 · **Branch:**
> `feat/yt-products-dual-captions` · **HEAD verificado:** `67dbf6a`
> (F0-B0 entregue em `d2723ba`; re-verificado APÓS os commits B1 `881d1d5`/
> `233d0e8`/`67dbf6a` para garantir que o picker de produtos não regrediu o
> deadlock-fix). Fonte de verdade: `docs/PLANNER_AUDIT_REPORT.md` P0-B0
> (M7/M19/M23/M8) + `docs/fix-F0-b0-deadlock-yt-community.md`.

## Resultado: 3/3 cenários de aceite PASS + barra do loop OK (nenhum código alterado nesta verificação)

### O que foi verificado (arquivo:linha em HEAD 67dbf6a)

| Requisito da fase | Evidência (HEAD atual) | Status |
|---|---|---|
| Campo **"Texto da Publicação \*"** (textarea, máx 5000) no box "Configurações YouTube" quando `onlyYoutubeSelected && (isCarousel \|\| IMAGE)` | `PlannerWizard.tsx:1841-1873` — grava no MESMO state `caption` → `globalSettings.caption` (`:1045`) → `config.content[].caption` (`:1091-1126`); publisher usa `post.caption` como message (zero schema/runtime) | ✅ intacto |
| Ocultar campos de vídeo quando `mediaType !== REELS` (Título, Descrição, Produtos, Privacidade, Categoria, Feito p/ crianças, Monetizar, Comentário fixado) | Box REELS inteiro sob `onlyYoutubeSelected && !isCarousel && mediaType === "REELS"` (`:1874-2080`); comunidade/Carrossel sem produtos (M8/M19) | ✅ intacto |
| Guard Short aceita `youtube_title`; não exige caption oculta com título preenchido (W2/M23) | `PlannerWizard.tsx:938-957` — `!youtubeTitle.trim() && !captionResolvida && !titleFallback` | ✅ intacto |
| Guard Comunidade aponta campo VISÍVEL no modo só-YouTube | `PlannerWizard.tsx:966-984` — mensagem PT-BR citando "Texto da Publicação"; mantém texto antigo p/ misto/IG | ✅ intacto |
| Label do select: CAROUSEL em YT → "Carrossel · Post na Comunidade"; STORIES oculto com canal YT | `PlannerWizard.tsx:1610-1615` | ✅ intacto |
| `planner-config.ts`: validação server-side não bloqueia Short YT com `youtube_title` | `validateYtCommunityText` (`:353-408`) — pula REELS e entradas sem `media_type`; `resolveCaptionTextForWizard` (`:292-326`) fonte única client/server; chamada em `validatePlannerConfig` (`:447`) | ✅ intacto |

### Testes executados nesta verificação

1. **Barra do loop**: `npx tsc --noEmit` → 0 erros · `npm run build` → ok ·
   `node ./node_modules/prisma/build/index.js validate` → schema válido (nenhum
   schema/migration tocado).
2. **Unit server-side (12 casos)** via `node --experimental-strip-types` direto
   no `validatePlannerConfig` de HEAD — **12/12 PASS**, cobrindo os 3 cenários
   de aceite:
   - YT planner + IMAGE com texto → salva (ok);
   - YT planner + IMAGE vazio → 400 PT-BR citando Comunidade/Texto da Publicação;
   - YT planner + REELS + `youtube_title` sem caption → salva (ok);
   - + coberturas: CAROUSEL vazio bloqueia (comunidade), `{post_caption}`/`{post_title}`
     resolvem, templates+rotação resolvem, `{hashtags}`/caption vazia bloqueiam,
     legado sem `media_type` nunca bloqueia, planner IG puro intocado.
3. **B1 não regrediu**: `git show 881d1d5 -- lib/planner-config.ts` → zero hits
   em `validateYtCommunityText`/`resolveCaptionTextForWizard`/`YT_CONFIG_KEYS`;
   `233d0e8` e `67dbf6a` não tocaram os guard/label/comunidade (verificado por
   leitura direta do wizard em HEAD).

### Isolamento / bug-remove / bug-desc (barra: NÃO quebrar)

- **Isolation**: campos IG continuam ocultos via `!onlyYoutubeSelected`
  (`PlannerWizard.tsx:1640,1673,1741,1783,1800,1821`); produto afiliado segue
  restrito ao box REELS — Comunidade/Carrossel YT não mostra picker.
- **bug-remove** (cancelamento) e **bug-desc** (propagação): fora do escopo dos
  irmãos desta fase e não tocados — nenhum diff de F0-B0 atinge publisher/
  planner-runtime (só `PlannerWizard.tsx` + `planner-config.ts` em `d2723ba`).

### Riscos / notas (crítico harsh)

- **Assimetria client×server em planner heterogêneo**: item[0] sem caption com
  itens seguintes com caption própria → o guard do wizard (linhas `:966-984`,
  avalia só a caption global = item[0]) bloqueia o save, enquanto o server
  (avalia entrada a entrada) aceitaria. Comportamento pré-existente do pipeline
  IG e o campo agora é VISÍVEL (basta preencher) — documentado, não bloqueia a
  fase. Caso raro: exige planner de Comunidade com múltiplos posts e item[0]
  sem texto.
- **Short com `youtube_title` só-template** que resolve vazio: passa no guard de
  save; o publisher mantém o guard definitivo
  (`app/api/cron/publisher/route.ts:1168-1174`) — falha de publicação, não de
  save. Contrato aceito no fix original.
- **Artifício fora do escopo**: worktree tem diff não commitado em
  `app/api/cron/publisher/route.ts` (fallback CSV legado — pertencente à fase de
  publisher/rotas, NÃO a esta). Não foi commitado nem alterado por este agente.

## Como re-testar (manual)

1. Criar planner com canal YouTube apenas + media type **Post na Comunidade**:
   preencher "Texto da Publicação" → salvar ok; esvaziar → erro PT-BR no banner
   apontando o campo visível.
2. Media type **Short do YouTube** + Título preenchido, sem caption → salvar ok.
3. Media type **Carrossel · Post na Comunidade** → sem produtos/campos de vídeo,
   com "Texto da Publicação".
4. `run` manual do planner de Comunidade → post com `message` não-vazia
   (`publisher:906`).