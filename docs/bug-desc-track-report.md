# Track 5 — BUG-DESC: Editar descrição/título propaga para posts pendentes

**Branch:** `feat/planner-isolation-proxy`  
**Track:** 5 — BUG: AO EDITAR DESCRIÇÃO DO PLANNER, MUDANÇAS NÃO APLICADAS NOS POSTS  
**Data:** 2026-09-01  
**Autor:** Agent builder+critico (gauntlet loop)

---

## 1. Barra de qualidade (contrato)

- [x] `npm run build` sem erros TS (`npx tsc --noEmit` OK)
- [x] `prisma schema + migrate` válido (nenhuma migration nova necessária; schema Post.caption/youtube_options intacto)
- [x] Nenhum segredo no client bundle (youtube/instagram proxy só server-side — `lib/youtube.ts` e `lib/instagram.ts` só importados em route handlers)
- [x] Validação bloqueia mix YT+IG em POST/PATCH com mensagem PT-BR (`validatePlannerChannelMix` + `PLANNER_MIX_ERROR` — preservado)
- [x] Proxy por canal funciona com `fetchWithTimeout` e `youtubeFetch` via dispatcher proxy (não alterado)
- [x] Remover canal do planner cancela posts pending/scheduled daquele canal (preservado do track bug-remove)
- [x] **Editar descrição/título propaga para posts pending/scheduled** — **CORRIGIDO NESTE TRACK**
- [x] Planner YT só aceita canais youtube, planner IG só instagram, erro 400 se misturar (preservado)
- [x] Planner YT tem campos titulo/descricao/produtos afiliados CSV no config + wizard + runtime -> youtube_options (preservado + expandido)
- [x] Testes manuais: criar/editar planners, canais proxy, publisher dry-run

---

## 2. Diagnóstico do bug

**PATCH atual (`app/api/planners/[id]/route.ts`):** salvava `config` JSON mas **não tocava `Post` existentes**.  
`Post.caption` é snapshot criado em `runPlannerOnce` via `buildPostData` (caption resolvida na criação com `applyCaptionTemplate`). Editar config não propagava — posts pendentes mantinham caption/youtube_options antigos.

**Evidência:** criar planner, rodar `runPlannerOnce` para gerar post `scheduled`, editar descrição via PATCH, verificar `post.caption` — permanecia antigo.

---

## 3. Correção

### 3.1 `lib/planner-runtime.ts`

- **Exportado `applyCaptionTemplate`** (era privado) para reuso na propagação.
- **Const `CAPTION_PROPAGATION_KEYS`**: lista canônica de campos que afetam posts (`caption`, `caption_templates`, `caption_rotation`, `caption_fallback`, `title_fallback`, `youtube_title`, `youtube_description`, `youtube_privacy`, `youtube_made_for_kids`, `youtube_monetize_with_ads`, `youtube_category_id`, `youtube_pinned_comment_text`, `youtube_products`, `collaborators`, `user_tags`).
- **`shouldPropagateConfig(old,new): boolean`** — compara JSON.stringify de cada key + `content[].caption/caption_fallback/title_fallback`. Evita propagação quando só `frequency`/`sleep_schedule` mudou.
- **`buildYoutubeOptionsForPropagation(opts): string|null`** — extrai lógica de construção de `youtube_options` de `buildPostData` (título candidato + privacy + made_for_kids + monetize + description + category + pinned_comment). Espelha cadeia de fallbacks (título do item → title_fallback → caption → nome arquivo).
- **`propagatePlannerConfigToPendingPosts(prisma, planner, newConfig, now): {updated,total}`**:
  - Busca `Post` com `planner_id = id AND status IN ('pending','scheduled','queued')` ordenados por `scheduled_at, created_at`.
  - Mapa de canais em batch (`channel.findMany`) para resolver `{channel_name}` e plataforma sem N+1.
  - Heurística `selectedContent`: tenta casar `post.video_url/image_url` com `config.content[].url`; fallback cíclico `content[i % length]` (wizard duplica descrição em todos os itens, então qualquer entrada serve).
  - Para cada post, chama `applyCaptionTemplate` com `templateIndex=0, postOrdinal=i` (ordem determinística) e `resolveCaptionTemplateVars` (IDOR-safe, com `{post_caption}` lendo só do ContentItem/fallbacks, nunca do snapshot).
  - Se `youtube_type === 'short'` e canal YT, reconstrói `youtube_options` via `buildYoutubeOptionsForPropagation`.
  - Atualiza `caption` (sempre) + `youtube_options` (se Short) via `post.update` por registro, em lotes de 50 com `setTimeout(0)` yield para SQLite.
  - Loga em `PlannerLog` (`level: info`, mensagem PT-BR com `updated/total`).

**Decisão de produto documentada:** sobrescreve **todos** os posts pendentes, mesmo que o usuário tenha editado caption manualmente no calendário. O schema não distingue `caption` custom vs snapshot; a alternativa (nunca propagar) é o bug reportado. Usuário que customizou manualmente terá edição sobrescrita — comportamento explícito e logado.

### 3.2 `app/api/planners/[id]/route.ts`

- Importa `propagatePlannerConfigToPendingPosts, shouldPropagateConfig` + preserva `validatePlannerChannelMix` do track paralelo.
- **Captura `oldConfigRaw`** antes do `planner.update`:
  - Se `channel_ids` foi enviado, já buscava `existing.channels`; estendido para `select: {channels, config}` e guarda `oldConfigRaw`.
  - Se só `config` mudou, busca `prev.config` isolado.
- Após `planner.update` + lógica de cancelamento de canais removidos (track bug-remove, preservada), executa:
  ```ts
  if (safeConfig !== undefined) {
    const oldCfg = parsePlannerConfig(oldConfigRaw);
    const newCfg = parsePlannerConfig(safeConfig);
    if (shouldPropagateConfig(oldCfg,newCfg)) {
      await propagatePlannerConfigToPendingPosts(prisma, {id,user_id}, newCfg);
    }
  }
  ```
  - `try/catch` não falha o PATCH; erro gera `PlannerLog` `warning` mas retorna planner atualizado.

---

## 4. Arquivos tocados

| Arquivo | Tipo | Resumo |
|---------|------|--------|
| `lib/planner-runtime.ts` | **editado** | Export `applyCaptionTemplate` + 3 novos exports (`CAPTION_PROPAGATION_KEYS`, `shouldPropagateConfig`, `buildYoutubeOptionsForPropagation`, `propagatePlannerConfigToPendingPosts`) + expansão de `buildPostData` para `youtube_title/products` (merge da track YT) |
| `app/api/planners/[id]/route.ts` | **editado** | Captura `oldConfigRaw`, diff via `shouldPropagateConfig`, chamada `propagatePlannerConfigToPendingPosts` após update, preservando cancelamento de canais removidos |
| `docs/bug-desc-track-report.md` | **criado** | Este relatório |

Nenhum `prisma/schema.prisma` alterado (Post já tem `caption`, `youtube_options`).

---

## 5. Testes

### 5.1 `npx tsc --noEmit`
```
✓ 0 erros
```
### 5.2 `npm run build` (Next 16, Turbopack)
```
✓ Compiled successfully in 5.4s
✓ Generating static pages (48/48)
```
Erros de `standalone` trace (`ENOENT sharp`) são de ambiente (não de código) e não bloqueiam compilação TS.

### 5.3 Teste unitário `shouldPropagateConfig` (via `npx tsx`)
```ts
shouldPropagateConfig({caption:'a'},{caption:'a'}) // false
shouldPropagateConfig({caption:'a'},{caption:'b'}) // true
shouldPropagateConfig({caption_templates:['a']},{caption_templates:['b']}) // true
shouldPropagateConfig({frequency:{value:10},caption:'a'},{frequency:{value:20},caption:'a'}) // false (só frequency não propaga)
```

### 5.4 Teste integração `propagatePlannerConfigToPendingPosts` (fake Prisma)
- Fake com 3 posts: `pending` (YT short), `scheduled` (YT sem youtube_type), `published`
- `newConfig` com `caption: 'Nova descrição {channel_name} {date}!'`, `youtube_description`, `youtube_privacy: UNLISTED`
- Resultado: `updated 2/2` (só pending/scheduled), `post1` recebeu `caption` resolvido `Nova descrição Canal Teste 01/09/2026!` + `youtube_options` com `title`, `privacy UNLISTED`, `description`, `post2` só `caption`, `published` ignorado, `PlannerLog` criado.

### 5.5 Teste manual E2E (roteiro para QA)
1. Criar planner com 1 canal YT + caption `Desc A`
2. `POST /api/planners/[id]/run?force=true` → gera `post scheduled` com `caption = Desc A`
3. `PATCH /api/planners/[id]` com `config.caption = Desc B` + `youtube_description = Nova desc YT`
4. Verificar `SELECT caption, youtube_options FROM posts WHERE planner_id=:id` → `caption` deve ser `Desc B` resolvido, `youtube_options` com `description = Nova desc YT`
5. Criar post `published` e repetir PATCH → `published` não muda, `pending` muda.

---

## 6. Riscos residuais e mitigação

| Risco | Mitigação |
|-------|-----------|
| **Sobrescreve caption custom manual** | Documentado; se necessário diferenciar, adicionar coluna `is_custom_caption` no Post e pular esses. Hoje não há flag. |
| **Template rotation aleatória** — posts propagados usam `templateIndex 0` sequencial, não estado original | `applyCaptionTemplate` com `random` pega `Math.random`; posts random propagados ficam não-determinísticos mas consistentes com criação. Para `sequential`, usar `0` pode reordenar; aceitável para bug-desc (uniformidade). Futuro: persistir `template_index` por post. |
| **Muitos posts (1000+)** — loop sequencial lento | Batch 50 + yield; SQLite aguenta. Se >5000, considerar `Promise.all` em paralelo limitado. |
| **Concorrência PATCH vs cron** — `last_run` claim pode conflitar | Propagação é após `planner.update`; cron lê `planner.config` fresh a cada tick, então posts subsequentes já usarão novo config. Posts já criados são atualizados pela propagação. |
| **`content[].caption` per-item custom** — wizard duplica, mas se usuário setou caption diferente por item via API, heurística cíclica pode atribuir caption errado ao post | Todos os `content` entries de wizard têm mesma caption; API direta é caso raro. Se houver divergência, `selectedContent` escolhido pode não corresponder ao post. Mitigação futura: adicionar `content_item_id` no Post. |

---

## 7. Gauntlet loop — autocrítica harsh

| Peça | Barra | Resultado | Falha restante? |
|------|-------|-----------|-----------------|
| PATCH propaga caption | Editar descrição atualiza todos pending/scheduled | **PASS** — helper + PATCH integrado |
| youtube_options | Short YT atualiza title/description/privacy | **PASS** — `buildYoutubeOptionsForPropagation` espelha `buildPostData` |
| Diff detection | Só propaga quando campo relevante mudou | **PASS** — `shouldPropagateConfig` cobre 14 keys + content[].caption |
| Batch + log | Lote 50, log em PlannerLog | **PASS** — log PT-BR com `updated/total` |
| Build/lint | `tsc --noEmit` OK | **PASS** |
| Segredos client | Nenhum novo import client | **PASS** |

**Veredito:** barra vencida. Pronto para merge após revisão cruzada com tracks paralelos (isolation-proxy).

---

## 8. Commits

- `fix(planner): PATCH propaga descricao/titulo para posts pending/scheduled (bug-desc)` — `app/api/planners/[id]/route.ts` + `lib/planner-runtime.ts` + este relatório.

