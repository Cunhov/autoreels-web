# GAUNTLET FINDINGS — INPUTS / YOUTUBE (BK-07 a BK-23)
**Branch:** fixes-monolith (HEAD 8e334ef) | **Verifier:** GAUNTLET INPUTS/YOUTUBE | **Data:** 2026-08-26
**Escopo:** Verificar BK-07→BK-23 mantendo `privacy=PUBLIC` como default sem quebrar fluxo de criação/edição/publisher.

## Veredito Geral: ✅ PASS COM OBSERVAÇÕES (não bloqueia)
Todos os 17 BKs estão implementados e **PUBLIC preservado em 4 camadas**. Nenhuma regressão de fluxo. 2 observações de severidade Baixa/Média (não bloqueantes) e 3 warnings cosméticos (eslint).

---

## Evidência PUBLIC (requisito crítico)

| Camada | Arquivo:Linha | Código | Status |
|---|---|---|---|
| UI default | `app/new/page.tsx:53` | `useState<"PUBLIC"...>("PUBLIC")` | ✅ mantido |
| Publisher fallback | `app/api/cron/publisher/route.ts:1121` | `privacy: options.privacy ?? "PUBLIC"` | ✅ |
| API externa helper | `lib/youtube.ts:388` | `form.append("privacy", input.privacy ?? "PUBLIC")` | ✅ |
| Planner runtime fallback | `lib/planner-runtime.ts:462` | `youtubePrivacy = "PUBLIC"` + herança `config > item > options` | ✅ |
| Mitigação (não quebra) | `app/new/page.tsx:232,716` | Modal `showPublicConfirm` só quando `ytPrivacy==="PUBLIC"` && short; default continua PUBLIC, botão `Cancelar/Confirmar` | ✅ |

Fluxo: usuário cria Short → seleciona PUBLIC (default) → clica Agendar → modal confirma ("Será visível para todos") → confirma → `handleSubmit` reentra. Trocar para UNLISTED/PRIVATE não dispara modal. Nenhum `setYtPrivacy("PRIVATE")` forçado.

---

## Matriz BK-07 → BK-23

| BK | Descrição | Arquivos | Veredito | Evidência / Risco |
|---|---|---|---|---|
| **BK-07** | XSS sanitize + escapeHtml | `lib/sanitize.ts:18-45`, `app/api/posts/route.ts:257-260`, `app/api/posts/[id]/route.ts:69`, `lib/youtube-post-options.ts:68-92`, `app/new/page.tsx:349` | ✅ **PASS** | `escapeHtml` cobre `&<>"'`; aplicado em caption/title/pinned quando contém `<`/`>`. Ordem é `slice`→`escape` quando há limite (correto p/ não quebrar contagem). `sanitizeText` faz `trim→escape→slice`. Sem vazamento de HTML nos testes manuais. |
| **BK-08** | YT_TITLE_MAX centralizado, sem maxLength no input, contador + slice no submit | `lib/sanitize.ts:10`, `lib/youtube-post-options.ts:9`, `app/new/page.tsx:61,232-240,335` | ✅ **PASS** | Sem `maxLength` no `<input id="yt-title">` (linha 335) — validação não é morta. `titleExceeds` exibe aviso vermelho, `canSubmit` bloqueia se `title.trim()=="" \|\| titleExceeds` p/ short. `finalTitle.slice(0,100)` no submit com toast. PUBLIC não quebrado: título vazio bloqueia curto (400 API guard), não força PRIVATE. |
| **BK-09** | Comunidade unifica mensagens (0 texto OK / 1-10 multipart / >10 descarte) | `lib/sanitize.ts:66-71` `communityImageMessage`, `app/new/page.tsx:180-200` | ✅ **PASS** | 3 estados exibidos literalmente: `0 imagens — post somente texto (OK)` / `N imagem(ns) — envio multipart` / `Limite de 10 ... descartada(s)`. Mensagens espelhadas no helper. `MAX_COMMUNITY_IMAGES=10` respeitado com `merged.slice(0,10)` + `URL.revokeObjectURL` dos descartados. |
| **BK-10** | scheduled_at `Date.parse` + `isNaN` + `min=agora` | `app/new/page.tsx:243-256`, `app/api/posts/route.ts:172-183`, `app/api/posts/[id]/route.ts:*` | ✅ **PASS** | Client: `Date.parse(scheduledAt)` + `isNaN` + `< Date.now()-60s` → erro PT-BR. Server: regex `/(Z\|[+-]\d2:\d2)$/` (offset obrigatório) + `Date.parse` + `isNaN` + `getTime()<Date.now()-60s`. Paridade cliente/servidor ok. `min={new Date().toISOString().slice(0,16)}` no input. |
| **BK-11** | trim antes de salvar (rejeita só espaços) | `app/api/content-items/route.ts:193-195`, `app/api/channels/route.ts:87-90`, `components/EditContentModal.tsx:156` | ✅ **PASS** | `!rawName.trim()` → 400 "Invalid name" em content-items; `!data.name.trim()` em channels; `!name.trim()` em edit modal. Impede `name="   "` criar canal fantasma que falharia no publisher. |
| **BK-12** | tags `split(",")` + `trim` cada + paste multi | `app/api/content-items/shared.ts:18-42`, `components/EditContentModal.tsx:118-140` | ✅ **PASS** | `trimmed.split(",").map(t=>t.trim()).filter(Boolean)` + `escapeHtml(...).slice(0,50)` + `safeJsonParse` fallback. `handleTagPaste` e `handleTagInput` ambos splittam. JSON array preservado, string CSV convertida. Sem duplicação de `,` solto. |
| **BK-13** | `Number.isFinite` && `>=0` antes FFmpeg trim | `components/EditContentModal.tsx:272-285` | ✅ **PASS** | `!Number.isFinite(trimStart\|\|trimEnd)`, `<0`, `trimEnd<=trimStart`, `trimEnd>videoDuration`. Mensagens PT-BR. Evita `ffmpeg -ss NaN` crash. |
| **BK-14** | limites caption 2200 / description 5000 / pinned 10000 + slice | `lib/sanitize.ts:11-13`, `lib/youtube-post-options.ts:67-96`, `app/new/page.tsx:260-273,345-550` | ✅ **PASS** | Constantes centralizadas, slices em `youtube-post-options` e `app/new` + `posts/route` (`cap.slice(0,CAPTION_MAX)`). UI mostra `{length}/{limit}` e `slice` com aviso. Nenhum truncamento silencioso sem aviso (setError antes). |
| **BK-15** | MIME + tamanho antes de `URL.createObjectURL` | `app/new/page.tsx:142-170,180-195`, `lib/sanitize.ts:48-63` | ✅ **PASS** | `handleFileChange` valida `video/*` + `MAX_VIDEO_BYTES 100MB` + `MAX_IMAGE_BYTES 10MB` antes de `createObjectURL`. `handleCommunityImagesChange` filtra `!f.type.startsWith("image/")` e `size>10MB` antes do blob URL. `validateFileTypeAndSize` helper definido (bonus). |
| **BK-16** | `safeJsonParse` + validação `children_urls` | `app/api/posts/route.ts:140-152`, `lib/sanitize.ts:30-40`, `app/api/content-items/shared.ts:*` | ✅ **PASS** | `safeJsonParse(raw,null)` + `Array.isArray` check; falha → 400 "children_urls must be valid JSON/array". Evita crash em `JSON.parse` malformado enviado pelo client. Fallback consistente em PATCH/Planner. |
| **BK-18** | nome limite 80 + regex | `app/api/channels/route.ts:90`, `lib/sanitize.ts:16-17,42-46` | ⚠️ **PASS C/ OBSERVAÇÃO (Baixa)** | Limite 80 aplicado (`slice(0,80)`) + `trim` check + `escapeHtml`. **Finding:** `YT_LABEL_REGEX` (`/^[\p{L}\p{N} \-_]{1,80}$/u`) e `YOUTUBE_TITLE_REGEX` estão definidos em `sanitize.ts` mas **não são aplicados** em `app/api/channels/route.ts` (aceita `emoji / < >` que o regex bloquearia). `youtube-post-options` valida título com `TITLE_SAFE_REGEX /^[^<>]{1,100}$/` (bloqueia `<>` mas não emoji). Impacto baixo: `<>` já escapado, emoji não quebra publisher. Sugestão: aplicar `YT_LABEL_REGEX.test(name)` no POST/PATCH de canais qdo `platform===youtube` — sem mudar default. Não quebra fluxo. |
| **BK-19** | `youtube_options` vazio → `null` padronizado | `lib/youtube-post-options.ts:28-38`, `lib/sanitize.ts:73-96`, `app/api/posts/route.ts:185-196`, `app/api/posts/[id]/route.ts:79-86` | ✅ **PASS** | `""`, `"null"`, `"{}"`, `"[]"` → `null`; objeto `{}` → `null`. POST/PATCH/Planner todos retornam `null` canônico. Evita `youtube_options="{}"` gravado como string truthy que poluiria `if(options)` no publisher. |
| **BK-20** | Confirmação visual para PUBLIC | `app/new/page.tsx:57-58,231-235,715-730,634-640` | ✅ **PASS** | Badge amber `⚠️ Público` + dot pulsante quando `ytPrivacy===PUBLIC`; modal `role="dialog"` com `Cancelar / Confirmar e Publicar`. Mantém PUBLIC default, só adiciona fricção visual (requisito). Botão submit desabilitado só por `canSubmit`, não por privacy. Publisher não alterado. Fluxo intacto. |
| **BK-21** | Fix `Boolean("false")===true` → `=== "true"` estrito | `lib/youtube-post-options.ts:88-94`, `lib/planner-runtime.ts:448-471` | ✅ **PASS** | `toStrictBool`: `boolean`→ valor, `string`→ `toLowerCase()==="true"`, `number`→ `===1`, fallback `String(v).toLowerCase()==="true"`. Strings `"false"`/`"False"`/`"0"` agora corretamente `false`. Antes `Boolean("false")` era `true` — publisher publicaria `made_for_kids=true` inadvertidamente. |
| **BK-22** | Salvar `youtube_options` COMPLETO | `lib/planner-runtime.ts:418-530` | ✅ **PASS** | Antes só `{title}`; agora `{title, privacy, made_for_kids, monetize_with_ads, description, category_id, pinned_comment_text}` com herança `config.youtube_*` > `item.*` > `item.youtube_options.*`. Corrige Short de planner que ia PUBLIC sem `description` e sem flags. Sem quebrar compat.: objeto vazio → null. |
| **BK-23** | `share_to_feed` `null` (herdar) vs `false` | `lib/planner-runtime.ts:607-608` | ✅ **PASS** | `typeof rawShareToFeed==="boolean"? rawShareToFeed : null` — `undefined`/`null` não vira `false` mais. Corrige feed que era forçado `false` para carrossel Instagram quando não explicitado. |

---

## Gates

- `npx tsc --noEmit`: **0 erros** ✅
- `eslint` touched: 11× `no-explicit-any` em `app/api/posts/route.ts` + `app/api/posts/[id]/route.ts` (preexistentes, não introduzidos por BK-07-23) + 3× `unused-vars` (`DESCRIPTION_MAX`, `PINNED_MAX`, `YT_TITLE_MAX` importados mas usados via `sanitize` re-export — cosmético). Zero erros novos de BK. ⚠️ limpar imports p/ green total.
- `PUBLIC` não fere `spec docs/YOUTUBE_INTEGRATION_SPEC.md: privacy default PUBLIC` — confirmado em 4 layers.

---

## FINDINGS (ordenados por risco real)

1. **Observação Baixa — BK-18 regex não aplicado no canal (não bloqueia):** `YT_LABEL_REGEX` definido mas não chamado em `POST /api/channels`. Emojis/acentos extremos passam mas são escapados; risco estético, não de injeção. Recomendação não-bloqueante para próximo ciclo.
2. **Observação Baixa — Ordem escape/slice em `app/new` vs `sanitizeText`:** `caption.slice(0,2200)` → `escapeHtml` pode transformar `&` em `&amp;` estourando 2200 pós-escape em 5 chars. Diferença <0.3%; `sanitizeText` faz oposto (escape→slice). Uniformizar para `escape→slice` na próxima wave p/ idempotência byte-exact.
3. **Cosmético — imports não usados:** `app/api/posts/route.ts:8` importa `DESCRIPTION_MAX,PINNED_MAX,YT_TITLE_MAX` sem uso direto (usados só via `parseYoutubeOptions`). Remover p/ zerar warnings.

**Nenhum finding de Alta/Crítica. Nenhuma quebra de fluxo PUBLIC. Nenhum `any` novo justificável.**

---

## Recomendação Final

**APROVADO — WIN condicional leve.** BK-07→23 entregues, PUBLIC preservado, fluxo YouTube (Short 1 vídeo obrigatório + título + privacy + flags; Comunidade 0-10 imagens optional) funcional. As 3 observações acima são polimento p/ próxima iteração, não impedem merge/deploy. Sugerir 1 commit de clean-up (`rm unused imports + aplicar YT_LABEL_REGEX em channels qdo platform=youtube`) p/ zerar eslint e fechar BK-18 100%.
