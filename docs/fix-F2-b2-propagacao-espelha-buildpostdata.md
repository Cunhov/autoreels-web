# fix-F2-B2 — Propagação espelha 100% o buildPostData (M5/M17/M18/G4)

> **Bloco:** F2-B2 (P0 M5/M17/M18) · **Branch:** `feat/yt-products-dual-captions`
> **Data:** após HEAD `72408b2` (pré-commit deste bloco)
> **Fonte de verdade consultada:** `docs/PLANNER_AUDIT_REPORT.md` (§1 M5/M17/M18, §2 P0-B2) · `docs/audit-track-*` (yt-short #1/#11, editor G1/G2/G3/G4, ig #18, wizard W8)
> **Natureza:** refactor com mesmo comportamento de criação + correção de 3 bugs de propagação.

## O que mudou (arquivo:linha)

### `lib/planner-runtime.ts`

| Item | Local | O quê |
|---|---|---|
| Função única extraída | `:393` (início `buildYoutubeOptionsForPost`) | Lógica do antigo bloco inline `buildPostData` (L451-560) virada função ÚNICA `buildYoutubeOptionsForPost(opts)` recebendo `{ prisma, planner, config, selectedContent, channelName, now, caption, itemName? }` |
| Cadeia de título (M17) | no corpo da função | `titleCandidate = [youtube_title RESOLVIDO, selected.title, title_fallback, caption, itemName]` — youtube_title agora é a 1ª fonte TAMBÉM na propagação |
| Products (M5/F1) | no corpo | `toYoutubeProductsJson(cfg.youtube_products)` → `products` (itens verbatim) + `product_names` (query-only) gravados como JSON string — nunca apagados ao editar planner |
| Description com template (M18) | no corpo | `rawYtDescTpl = resolveYtTpl(cfg.youtube_description)` (antes: string crua na propagação) + fallback para caption quando vazio |
| Pinned alias (G4) | no corpo | `cfg.youtube_pinned_comment ?? cfg.youtube_pinned_comment_text ?? selAny.pinned_comment_text ?? selAny.youtube_pinned_comment` (antes a propagação só lia `_text`) |
| Herança config>item>youtube_options | no corpo | privacy/made_for_kids/monetize/category mantidos idênticos ao `buildPostData` original |
| `buildPostData` consome a função | `:644` | bloco inline de ~110 linhas substituído pela chamada única (zero duplicação) |
| Propagação consome a MESMA função | `:881` | `buildYoutubeOptionsForPropagation` DELETADA; propagate chama `buildYoutubeOptionsForPost` com `channelName` e `now` do loop |
| Community não é tocada | `:892-897` | ramo `community` mantém `newYoutubeOptions = undefined` → update só leva `caption`; `youtube_options` de community NUNCA reescrito |
| `CAPTION_PROPAGATION_KEYS` | `:696-712` | adicionado `"youtube_pinned_comment"` (alias G4); já cobria `youtube_title`, `youtube_description`, `youtube_privacy`, `youtube_made_for_kids`, `youtube_monetize_with_ads`, `youtube_category_id`, `youtube_products` |

## Como testar

1. **Barra:** `npx tsc --noEmit` (0 erros) + `npm run build` (ok) + `node ./node_modules/prisma/build/index.js validate` (schema válido).
2. **Smoke automatizado (este bloco):**
   ```
   node --import ./.ai/f2-smoke/alias-hook.mjs .ai/f2-smoke/smoke.test.mts
   ```
   Cenários (mock de prisma, sem rede/banco):
   - T1 `buildPostData` → youtube_options completo (título resolvido `{channel_name}`, description `{date}` em tz, products verbatim, product_names, privacy, pinned).
   - T2 PATCH só caption → pending preserva products/título/description re-resolvida (M5/M17/M18).
   - T3 PATCH youtube_title → `youtube_options.title` muda (teste-ouro do bug-desc — M17).
   - T4 community → propagação NÃO reescreve `youtube_options`.
   - T5 post IG → `youtube_options` intocado.
   - T6 só `youtube_pinned_comment` (alias G4) → pinned re-resolvido.
3. **E2E manual (quando houver UI/cron):** planner Short YT com products+título+templates na descrição → `run` → PATCH apenas caption → conferir `youtube_options` dos pending (products/título/desc) intactos; PATCH `youtube_title` → title dos pending muda; planner de Comunidade → PATCH não altera `youtube_options`.

## Riscos / observações

- **Comportamento de criação preservado:** parity verificado contra o bloco original (mesmos passos, mesma ordem, mesmos defaults). Diff líquido ~ -5 linhas (238+/243−), é um move.
- **products gravados como JSON string** em `youtube_options.products/product_names` (paridade com `lib/youtube.ts:159` e o publisher que faz `JSON.parse`) — não é regressão.
- **`itemName` é parâmetro opcional:** nenhum caller passa (ambos usam o lookup interno única vez) — mantido na assinatura por spec da tarefa; sem N+1 extra (mesma quantidade de `findFirst` do código anterior).
- **`now` da propagação** agora alimenta `{date}` em descrição (re-resolve na data da edição) — mesmo contrato do buildPostData (que usa o now do post).
- **Fora do escopo deste bloco:** guard de status no update (M14/P1, race propagação×publisher) e guard de cancelamento (M13) — task F2-B2 cobre só M5/M17/M18/G4. Não mexi em schema/migrations.
- **Sem risco às entregues:** isolation (mix YT/IG) intocado, proxy no publisher intocado, bug-remove (cancelamento) intocado; bug-desc fica COMPLETO (título agora propaga).