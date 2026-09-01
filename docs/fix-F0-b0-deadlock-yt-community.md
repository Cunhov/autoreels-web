# Fix F0-B0 — Deadlock planner YT-Community + Media Type dinâmico + guard Short

> Branch: `feat/yt-products-dual-captions` · Base: `85855ad` (HEAD 85855ad) ·
> Fase F0 (agente builder+crítico, gauntlet loop) · Fonte de verdade:
> `docs/PLANNER_AUDIT_REPORT.md` P0-B0 (M7/M19/M23/M8) + `docs/audit-track-wizard.md`
> (W1/W2/W3) + `docs/audit-track-yt-community.md` (P0-1/F1/F2).

## O que mudou (arquivo:linha)

### `components/PlannerWizard.tsx`
| Local | Mudança |
|---|---|
| `:17` | Importa `resolveCaptionTextForWizard` de `@/lib/planner-config` (fonte única — removeu a cópia local `:84-131` do diff) |
| `:755-783` (guard Short, M23/W2) | Nova condição `!youtubeTitle.trim()`: com **Título do Short** preenchido (campo VISÍVEL do box YT), o guard **não exige mais caption oculta** — corrige bloqueio de upload direto. Mensagem PT-BR atualizada: *"Shorts do YouTube exigem um título — preencha o campo "Título" em Configurações YouTube, ou informe uma legenda com texto literal."* |
| `:785-812` (guard Comunidade, M7/P0-B0) | Em planner só-YouTube (`onlyYoutubeSelected`) a mensagem aponta para o campo **visível**: *"…preencha o campo "Texto da Publicação" em Configurações YouTube."* (mantém mensagem antiga para planner misto/IG, onde Caption é visível) |
| `:1417-1426` (label media type) | Option `CAROUSEL` em YT → **"Carrossel · Post na Comunidade"**; `STORIES` continua oculto com canal YT (`!youtubeSelected`) |
| `:1649-1686` (box YT — Comunidade) | `onlyYoutubeSelected && (isCarousel || mediaType === "IMAGE")` renderiza **"Texto da Publicação \*"** (textarea, máx 5000) gravando no **MESMO** `caption` state → `globalSettings.caption` → `config.content[].caption` (publisher usa `post.caption` como message — **zero mudança de schema/runtime**). Helper text esclarece: Comunidade não recebe produtos |
| `:1687-1790` (box YT — Short) | Todos os campos de vídeo (**Título, Descrição, Produtos, Privacidade, Categoria, Feito para crianças, Monetizar, Comentário fixado**) agora renderizam **só** quando `mediaType === "REELS"` (M8/M19) — Comunidade/Carrossel YT não mostra produtos nem campos de vídeo |

### `lib/planner-config.ts`
| Local | Mudança |
|---|---|
| `:249-285` | **`resolveCaptionTextForWizard` exportado** (mesma lógica que era local do wizard): middleware compartilhado cliente↔servidor p/ validar com o mesmo critério |
| `:287-297` | `YT_CONFIG_KEYS` — presença de campo `youtube_*` = planner com canal YouTube |
| `:310-395` | **`validateYtCommunityText`** — validação server-side do P0-B0: config de planner YouTube com entradas **Comunidade** (`media_type` IMAGE/CAROUSEL) exige texto resolvido não-vazio (caption literal, fallbacks `{post_caption}`/`{post_title}`, ou `caption_templates`+rotação). **Short NUNCA bloqueia**: entradas `media_type` REELS ou sem `media_type` (legado preservado) são puladas — `youtube_title` no config dispensa caption |
| `:404` | Chamada da regra dentro de `validatePlannerConfig` (após a validação de `content`) |

## Como testar

1. **Barra do loop** ✓ rodado:
   - `npx tsc --noEmit` → 0 erros
   - `npm run build` → ok (rota table completa, sem erros)
   - `node ./node_modules/prisma/build/index.js validate` → schema válido (nada de schema/migration mudou)

2. **Planner YT novo + IMAGE (Post na Comunidade), com texto** → salva sem erro; config gravado com `content[].caption` = texto (publisher envia como `message` do post).

3. **Planner YT novo + IMAGE, texto vazio** → erro PT-BR no banner global (visível em todos os steps): *"Posts na Comunidade do YouTube exigem texto — preencha o campo "Texto da Publicação" em Configurações YouTube."* (wizard) + mesmo guard server-side (`400` com detalhes) via API.

4. **Planner YT + REELS + Título preenchido, sem caption** → salva sem erro (W2/M23 corrigido — antes bloqueava "Short exige título" mesmo com título no box YT).

5. **API (unit)**: `validatePlannerConfig` testado com 12 casos via `node --experimental-strip-types` — 12/12 PASS (IG não exige; YT community vazio bloqueia; YT short REELS+`youtube_title` libera; templates/fallbacks resolvem; legado sem `media_type` nunca bloqueia).

## Riscos / notas

- **Falso positivo do guard server-side**: configs legacy com `youtube_*` + entradas IMAGE/CAROUSEL sem texto passam a ser rejeitados no save — é o comportamento desejado (deadlock M7); a correção dá campo visível para preencher. Planners IG puros não têm `youtube_*` → intocados.
- **Templates stale**: no modo só-YouTube os campos IG (Templates/Rotação/Fallback) ficam ocultos; se um config legado tiver `caption_templates` + rotação ativa, a validação (client e server) avalia o texto **resolvido** (templates), não só a caption digitada — comportamento pré-existente do pipeline, raro e documentado (client e server usam o mesmo `resolveCaptionTextForWizard`, então nunca divergem).
- **Short com `youtube_title` só-template** (ex.: `{post_title}` que resolve vazio): o guard deixa passar (título raw presente); o publisher mantém o guard definitivo *"Short do YouTube exige título"* (`app/api/cron/publisher/route.ts:1168-1174`) — falha de publicação, não de save. Contrato mantido.
- **Ordem de erro em payload misto**: config pirata YT+IG com comunidade vazia pode receber o erro de texto antes do `PLANNER_MIX_ERROR` (guard de texto roda no `validateConfigPayload`, antes do mix check) — ambos são 400 e o mix continua bloqueado; mensagem difere apenas.
- **Intocados a pedido da barra**: isolation (campos IG continuam ocultos via `!onlyYoutubeSelected`), proxy no publisher, bug-remove (cancelamento), bug-desc (propagação), docs legados. Nenhum schema/migration alterado.