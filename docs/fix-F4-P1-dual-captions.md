# fix-F4-P1-dual-captions.md — Verificação E2E + cobertura de rota (M9)

> **Agente:** 5 — BUILDER+CRÍTICO (gauntlet loop) · **Fase:** F4-P1 (M9 — dual captions)
> **Branch:** `feat/yt-products-dual-captions` · **HEAD no início:** `7be89ef`
> **Barra no HEAD final:** `npx tsc --noEmit` 0 erros ✅ · `npm run build` ok ✅ · `node ./node_modules/prisma/build/index.js validate` ok ✅ · smoke F4 (commitado) 8/8 ✅ · smoke F2-B2 6/6 ✅ · **smoke E2E de rota (novo, este agente) 12/12 ✅**

## Contexto (importante)

Ao iniciar este track, um **agente paralelo já havia implementado e commitado a F4-P1 na mesma branch**:
- `5d56d8a` — whitelist + sanitize `caption_youtube`/`caption_instagram` em content-items (POST/PATCH) e upload-chunk/complete;
- `5e70c61` — uploader detecta `youtube.txt`/`instagram.txt` (nome exato, case-insensitive) via `lib/folder-captions.ts`; tasks/buildTask/formData/carousel repassam as captions por plataforma;
- `06564ff` — `resolveFinalCaption` (régua única) + `platform` pelo canal do post em `resolveCaptionTemplateVars`/`applyCaptionTemplate`/`buildYoutubeOptionsForPost`/`buildPostData`/`propagate`/`resolvePlannerRuntime`/preview;
- `a6cda86` — smoke `.ai/f4-smoke/` (8 cenários a nível de função pura);
- `a333c76` — relatório `docs/fix-F4-P1-captions-duais.md`.

**Papel deste agente:** verificação harsh do HEAD commitado (barra completa re-rodada) + **camada de teste E2E que faltava** — os cenários da spec executados no **limite HTTP real** (rotas `app/api/content-items` e `app/api/upload-chunk/complete` dão round-trip de verdade das captions), que o smoke commitado (nível função) não cobre. Nenhum código da implementação foi duplicado: o `lib/planner-runtime.ts` ficou **byte-idêntico ao HEAD** (revertido um reordenamento cosmético de JSDoc), e as rotas não foram re-editadas.

## O que este agente adicionou (arquivo:linha)

- `.ai/f4-dual-captions/smoke.test.mts` — **12 testes**, rodando as rotas reais via `node --import`:
  - **T1-T2** `readFolderCaptions`: pasta com youtube.txt+instagram.txt+.txt genérico → 3 captions (case-insensitive); só youtube.txt → captionYoutube e genérica null.
  - **T3-T4** `POST /api/content-items` (handler real, com shims de next-auth/next-server/prisma): round-trip preserva as 3 captions; sanitize `sanitizeCaption` com trim + escape `<b>`→`&lt;b&gt;` + truncamento 2200; campo desconhecido descartado pela whitelist.
  - **T5** `POST /api/upload-chunk/complete` (handler real com staging `.part.0` em dir temporário): `formData captionYoutube/captionInstagram` → ContentItem com `caption_youtube`/`caption_instagram` sanitizados (o cenário "item único de pasta" da spec, ponta-a-ponta).
  - **T6** `resolveFinalCaption` — régua única (youtube/instagram/sem plataforma/mixed; `??` vazio explícito não cai na genérica).
  - **T7-T9** `buildPostData`: short YT resolve youtube.txt; IG resolve instagram.txt **sem vazamento cruzado** (`youtube_options` null no IG); `.txt` único → fallback nas duas plataformas.
  - **T10-T11** `propagatePlannerConfigToPendingPosts`: captions por plataforma **do canal de cada post** (YT e IG lado a lado).
  - **T12** `resolvePlannerRuntime` (preview parity): planner com canal YT resolve youtube.txt — cobre o ponto `firstChannel.platform` (`planner-runtime.ts:1122`).
- `.ai/f4-dual-captions/alias-hook.mjs` + `shim-*.mjs` — resolução `@/` com shims dirigidos (`next/server`, `next-auth`, `@/lib/prisma`, `@/lib/auth`, `@/app/api/upload-chunk/route`, `@/lib/ffmpeg`) para rodar as rotas fora do Next; `@/lib/prisma` fake dirigido por `globalThis.__PRISMA__`.
- `docs/fix-F4-P1-dual-captions.md` (este) — verificação + instruções.

## Como testar (barra completa, HEAD `a333c76` + este bloco)

```bash
npx tsc --noEmit                                  # 0 erros
npm run build                                     # ok
node ./node_modules/prisma/build/index.js validate # schema válido
node --import ./.ai/f4-smoke/alias-hook.mjs .ai/f4-smoke/smoke.test.mts            # 8/8 (commitado)
node --import ./.ai/f4-dual-captions/alias-hook.mjs .ai/f4-dual-captions/smoke.test.mts  # 12/12 (novo)
node --import ./.ai/f2-smoke/alias-hook.mjs .ai/f2-smoke/smoke.test.mts             # 6/6 (regressão)
```

## Riscos / observações (crítico harsh)

1. **Regenerar o Prisma Client** — `node_modules/.prisma/client` estava defasado em relação à migration 0009 (nenhum consumidor dos campos existia antes). Rodar `node ./node_modules/prisma/build/index.js generate` em qualquer checkout que vá consumir `caption_youtube`/`caption_instagram` (tsc falhava com `'caption_youtube' does not exist in type 'ContentItemSelect'` antes da regeneração).
2. **Semântica `??`**: caption por plataforma presente porém `""` (arquivo vazio/edição) NÃO cai na genérica — escolha explícita da spec; `sanitizeCaption` trima, então `"  "` vira omit no uploader → NULL → fallback genérico nesse caso.
3. **Content identity × reset_state**: editar só `youtube.txt` não muda `config.content[]` → `contentChanged=false` → estado de publicação NÃO reseta (esperado e documentado — não corrigir com reset indiscriminado).
4. **Wizard sem inputs por plataforma**: `PlannerWizard` (grep 0) ainda não expõe os 2 campos por plataforma e `resolveCaptionTextForWizard` (L87) não conhece captions específicas (pode subestimar validação) — track de UI da F4.
5. **Mix bloqueado preservado**: teste T8 prova que canal IG não recebe caption do YT nem `youtube_options`; smoke F2-B2 6/6 confirma que B2 (propagação espelha buildPostData) segue intacto; proxy/isolation/bug-remove não foram tocados.
6. **Arquivos de outros tracks permanecem intocados**: `app/api/youtube/products/route.ts` e `lib/youtube.ts` (B3 refinements, commit `aa626e0`) não fazem parte deste bloco; `.ai/watcher-audit-baseline.md` e `docs/diagnose-upload-vps.md` (untracked de outros agentes) NÃO foram commitados por este agente.

## Commit
Bloco incremental único deste agente: `.ai/f4-dual-captions/*` + `docs/fix-F4-P1-dual-captions.md` — na branch `feat/yt-products-dual-captions` (NUNCA push).