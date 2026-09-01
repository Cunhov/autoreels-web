# fix-F4-P1 — Captions duplas YouTube/Instagram end-to-end (M9)

> **Fase:** F4-P1 (M9 — dual captions schema-only → end-to-end) · **Branch:** `feat/yt-products-dual-captions`
> **Fonte de verdade consultada:** `docs/PLANNER_AUDIT_REPORT.md` (§1 M9, §2 P1-1) · `docs/audit-track-api.md` (F6) · `docs/audit-track-editor.md` (§6) · `docs/audit-integration-plan.md` (T3/T4)
> **Natureza:** wiring completo das colunas `caption_youtube`/`caption_instagram` (migration 0009) — API de content-items, upload de pasta (`youtube.txt`/`instagram.txt`), resolução por plataforma num ÚNICO ponto (`resolveFinalCaption`) em runtime/propagação/preview. Additive — nenhum contrato quebrado.

---

## Problema (antes)

Migration 0009 + schema (`prisma/schema.prisma:150-151`) criaram as colunas **sem nenhum consumidor** (grep no trabalho = 0 fora de prisma):
- `app/api/content-items/route.ts:13-19` — whitelist sem `caption_*` → API nem grava nem devolve as captions por plataforma.
- Upload de pasta (`contexts/UploadContext.tsx`) lia **só o 1º `.txt`** como caption genérica — `youtube.txt`/`instagram.txt` virariam captions erradas.
- Runtime (`lib/planner-runtime.ts:278-312`) resolvia `{post_caption}` **só de `caption`** — sem awareness de plataforma; `buildPostData`/propagação/preview idem.
- Sem sanitização das novas colunas no POST/PATCH (BK-07/BK-14 exigem limite 2200 + escape para QUALQUER caption).

## O que mudou (arquivo:linha)

### 1. `lib/sanitize.ts` — `sanitizeCaption` (único ponto de sanitização de caption)
- `:131-144` — nova `sanitizeCaption(input)`: trim + slice(`CAPTION_MAX`=2200) + escape `<`/`>` — **única** usada por content-items POST/PATCH e upload-chunk/complete (BK-07/BK-14 estendido às captions por plataforma).

### 2. `app/api/content-items/route.ts` (POST) + `app/api/content-items/[id]/route.ts` (PATCH)
- POST `:13-19` / PATCH `:13-18` — `caption_youtube` e `caption_instagram` entram nas whitelists (`POST_ALLOWED_FIELDS`/`PATCH_ALLOWED_FIELDS`).
- POST `:199-212` / PATCH `:140-153` — sanitização espelhada à do `caption` via `sanitizeCaption` — **nunca grava sem sanitize**.

### 3. `lib/folder-captions.ts` — helper puro de leitura das captions da pasta (NOVO)
- `readFolderCaptions(files)` — módulo sem React/DOM (testável): nome EXATO `youtube.txt`→`captionYoutube`, `instagram.txt`→`captionInstagram` (case-insensitive via `toLowerCase`), QUALQUER outro `.txt`→`caption` genérica (1º encontrado, mesmo comportamento pré-dual-captions); falha de leitura→`null`.

### 4. `contexts/UploadContext.tsx` — parse da pasta + carry-through
- `:482-484` — folder parse usa `readFolderCaptions` (substitui o `txtFile` genérico).
- `:13` — import do helper.
- `:34-37` / `:58-62` — `UploadTask` e `UploadOpts` ganham `captionYoutube`/`captionInstagram`.
- `:377-378` — `buildTask` repassa para a task.
- `:490-501` — item ÚNICO da pasta: `pushMediaTask` recebe `captionYoutube`/`captionInstagram` (vão ao formData do complete).
- `:537-549` — `carousel_folder`: POST `/api/content-items` inclui `caption_youtube`/`caption_instagram` no body (whitelist nova aceita).
- `:539-546` — fallback de falha de criação do carrossel também repassa as 3 captions.
- `:842-846` — formData do complete: `append("captionYoutube", …)` / `append("captionInstagram", …)`.

### 5. `app/api/upload-chunk/complete/route.ts` — aceita e salva
- `:69-71` — `formData.get("captionYoutube")` / `formData.get("captionInstagram")`.
- `:358-366` — persistidos em `caption_youtube`/`caption_instagram`, sanitizados com `sanitizeCaption` (mesma régua do content-items).

### 6. `lib/planner-runtime.ts` — `resolveFinalCaption` (RÉGUA ÚNICA) + plataforma
- `:241-270` — **novo `resolveFinalCaption(platform, item)`**: `youtube → caption_youtube ?? caption`; `instagram → caption_instagram ?? caption`; senão `caption`. `??` (nullish): caption por plataforma **vazia = escolha explícita** de não usar a genérica (spec F4). Tipo `FinalCaptionSource` publicado.
- `:278,296-299` — `resolveCaptionTemplateVars` recebe `platform?` (6º arg, opcional — retrocompatível) e resolve `{post_caption}` via `resolveFinalCaption(platform, libItem)`; select do ContentItem agora inclui `caption_youtube`/`caption_instagram` (`:288`).
- `:371,393` — `applyCaptionTemplate` aceita `platform?` e repassa.
- `:438,454` — `buildYoutubeOptionsForPost` aceita `platform?` e repassa (templates de título/descrição também veem a plataforma).
- **Consumidores wired (NUNCA 3 cópias — todos passam por `resolveFinalCaption`):**
  - `buildPostData` `:665,693` — `platform: opts.channel.platform` (pelo canal do post).
  - propagação `:911,932` — `platform: channelPlatform` (por canal DE CADA post — correto até em planner misto legado).
  - preview/runtime `:1122` — `firstChannel.platform` (mix bloqueado; 1º canal = plataforma do planner).

### 7. `app/api/planners/[id]/preview/route.ts`
- `:138-140` — `resolveCaptionTemplateVars` recebe `(planner.channels || [])[0]?.platform` (mesma regra do runtime).

## Como testar

1. **Barra:** `npx tsc --noEmit` (0 erros) · `npm run build` (ok) · `node ./node_modules/prisma/build/index.js validate` (schema válido) · smoke F4 `node --import ./.ai/f4-smoke/alias-hook.mjs .ai/f4-smoke/smoke.test.mts` (8/8) · smoke F2 (regressão) `node --import ./.ai/f2-smoke/alias-hook.mjs .ai/f2-smoke/smoke.test.mts` (6/6).
2. **Smoke F4 cobre os 4 cenários da spec:** round-trip pasta youtube.txt+instagram.txt preserva ambos (T1); .txt único → caption genérica (T2); short YT resolve youtube.txt via `{post_caption}` (T3); IG resolve instagram.txt (T4); fallback único nas duas plataformas (T5); propagação re-resolve por canal, não pelo 1º canal (T6); `??` vazio explícito (T7); sanitize trim/2200/escape (T8).
3. **E2E manual (upload→planner→publicação):**
   - Pasta com `video.mp4` + `youtube.txt` + `instagram.txt` + `caption.txt` → upload → item na biblioteca com as 3 captions (GET `/api/content-items` devolve `caption_youtube`/`caption_instagram`);
   - Carrossel (`2+ imagens` + os `.txt`) → a pasta carrossel guarda as 3 captions;
   - Planner **canal YouTube** com item e caption `{post_caption}` → run/preview → legenda = conteúdo de `youtube.txt`;
   - Planner **canal Instagram** idem → legenda = `instagram.txt`;
   - Só `legenda.txt` → ambas as plataformas usam a genérica;
   - Editar o planner (PATCH) → posts pendentes re-resolvem a caption pela plataforma de cada canal.
4. **Sanitização:** POST/PATCH `/api/content-items` com `caption_youtube` > 2200 chars ou com `<script>` → truncado/escapado; idem via upload (formData).

## Riscos / observações

- **Wizard ainda SEM inputs por plataforma (F4-P2, fora do escopo):** o wizard não expõe campo próprio para `caption_youtube`/`caption_instagram`; o uso se dá via `{post_caption}` no template/caption (item vindo da biblioteca). Validação do wizard (`resolveCaptionTextForWizard`) continua estimando `{post_caption}` dos fallbacks — um item que só tenha `youtube.txt` (sem caption genérica) pode ser bloqueado no save do wizard mesmo resolvendo bem no runtime (falta o input dedicado; F4-P2).
- **`??` vs `||`:** caption por plataforma vazia (arquivo vazio/whitespace) resolve vazio — NÃO cai na genérica (escolha explícita). Se o arquivo `youtube.txt` existir vazio, o `{post_caption}` do YT sai vazio.
- **Primeiro `.txt` genérico:** pasta com vários `.txt` não-plataforma mantém o comportamento legado (1º encontrado).
- **Preview em planner misto (grandfathered):** preview usa o 1º canal; por post cada um usa o seu — mix é bloqueado client+server (validação intacta), diferença só teórica.
- **Sem risco às entregues:** isolation YT/IG (mix bloqueado) intocado · proxy no publisher intocado · bug-remove (cancelamento) intocado · bug-desc (propagação `buildYoutubeOptionsForPost`) intocado · roteamento F1-B1 (`resolveShortProductsRouting`) intocado · wizard: nenhuma edição (F4-P2 cobre os inputs).
- **Docs legados:** nenhum alterado — relatório novo em `docs/fix-F4-P1-...`.