# Fix — EditContentModal: campos de legenda por plataforma + produtos renderizados

**Branch:** `feat/yt-products-dual-captions`
**Natureza:** UI do modal de edição de metadados da library — os campos existiam no estado/save (F4/F6) mas NUNCA foram renderizados no JSX.

## Problema

O usuário não via "Legenda YouTube/Instagram" no modal de edição. Investigação revelou:

- `caption_youtube`/`caption_instagram` estavam nas whitelists (POST/PATCH) e sanitização, mas o modal só tinha "Legenda" padrão.
- **Além disso:** o campo `youtube_products` (item-products, commit `90e8af6`) tinha estado + save, mas o textarea **também não estava renderizado** — o commit adicionou só lógica, sem JSX. Foi corrigido junto.

## O que mudou (components/EditContentModal.tsx)

- `ContentItem` (interface local): `caption_youtube?: string | null`, `caption_instagram?: string | null`.
- Novo helper `sanitizeCaptionText(v)` (trim + slice CAPTION_MAX + escapeHtml) — mesma régua da caption padrão.
- Estados: `captionYoutube`, `captionInstagram` (junto de caption).
- Load: prefill individual com `item.caption_youtube/caption_instagram`; bulk/reset limpa.
- Save **individual**: campo vazio → `null` (LIMPA); preenchido → `sanitizeCaptionText`.
- Save **bulk**: só envia se digitado (vazio = manter o atual; NÃO sobrescreve) — mesmo padrão do youtube_products.
- JSX renderizado (após "Legenda", antes de Tags):
  - **Legenda YouTube** (textarea, hint "Usada no lugar da legenda padrão quando o post vai para o YouTube. Vazia = usa a legenda padrão.")
  - **Legenda Instagram** (idem)
  - **Produtos Afiliados (YouTube)** (textarea, hint "Nomes separados por vírgula") — campo que existia na lógica mas não tinha UI.

## Como testar

1. Library → item → editar → campos "Legenda YouTube" / "Legenda Instagram" / "Produtos Afiliados (YouTube)" visíveis.
2. Preencher Legenda YouTube → salvar → reabrir → valor preenchido.
3. Esvaziar Legenda YouTube → salvar → PATCH manda `caption_youtube: null` → servidor limpa.
4. Bulk (selecionar 2+): deixar vazio → não sobrescreve; preencher → aplica em todos.
5. Publicação: planner YT usa `caption_youtube ?? caption` (runtime `resolveFinalCaption` — já existente, sem mudança aqui).

## Riscos

- Sanitização por plataforma espelha a caption padrão (escape + 2200) — alinhado à whitelist do servidor.
- Bulk não limpa (vazio = manter) — comportamento intencional e documentado no hint.
