# T2 — Preview de tiktok_options + indicador no card (verificação)

Branch: `trab-t2-preview` (a partir de `fixes-monolith` @ b40a00e). Sem push.

## O que foi feito

- `app/api/planners/[id]/preview/route.ts`
  - `tiktok_fields` completo e derivado do **mesmo** `buildTiktokOptionsForPost`
    usado na criação do post (`buildPostData`) e na propagação M5 — o preview
    mostra exatamente o payload que vai para `Post.tiktok_options`:
    `{ available, title, privacy_level, disable_duet, disable_stitch,
       disable_comment, video_cover_timestamp_ms, brand_content_toggle,
       brand_organic_toggle, media_type: 'video'|'photo'|'carousel',
       photo_cover_index, caption_tiktok }` (+ mirrors legados
    `tiktok_caption/tiktok_title/tiktok_privacy_level`).
  - `media_type` derivado via `mapTiktokMediaType(runtime.mediaType)`
    (REELS/VIDEO/STORIES→video, IMAGE→photo, CAROUSEL→carousel).
  - `photo_cover_index` é `null` na v1 (só vídeo; foto/carrossel bloqueados na
    criação por `validateTiktokMediaType`).
  - Planners YT/IG: `buildTiktokOptionsForPost` retorna `null` → `available=false`
    → sem throw e `youtube_fields`/`runtime`/`caption` intactos (não quebra previews existentes).
- `lib/planner-runtime.ts`
  - Novo export `mapTiktokMediaType` (fonte única do mapeamento media_type→TikTok).
- `app/planners/page.tsx` (modal de Preview)
  - Card **"TikTok · O que será enviado"** (badge TikTok = planner tem canal
    tiktok) com rótulos PT-BR: Título, Privacidade (Público/Amigos mútuos/
    Seguidores/Somente eu), Duet/Stitch/Comentários (habilitado/desabilitado),
    Capa (vídeo) (Automática ou segundos), Marca (content/orgânico) Sim/Não,
    Mídia (Vídeo/Foto/Carrossel), Capa da foto, Legenda.
  - Card espelhado **"YouTube · Campos do Short"** com `youtube_fields`
    (mesmo grid label/valor — como o TikTok é exibido, o YouTube também).
- `scripts/gauntlet/tiktok-preview-options.mts` — smoke novo (33 asserts).

## Barra

| Item | Resultado |
|---|---|
| `npx tsc --noEmit` | 0 erros |
| `npm run build` (Next 16, Turbopack) | ✓ Compiled successfully, BUILD_ID gerado |
| Smoke `scripts/gauntlet/tiktok-preview-options.mts` | 33 passed / 0 failed |
| Data-path real (routa simulada 1:1 sobre dev.db clonado, planner TikTok + IG) | 13/13 asserts verdes |
| Boot do servidor (`next start`) | rota de preview responde 401 anônimo (sem crash de inicialização) |

Runner do smoke:

```bash
npx --no-install tsx scripts/gauntlet/tiktok-preview-options.mts
```

## Verificação manual (UI)

1. `npm run dev` e login.
2. Ter um planner TikTok (canal TikTok vinculado) e abrir **Preview** no card.
3. Esperado: card "TikTok · O que será enviado" listando Título, Privacidade
   ("Público" para PUBLIC_TO_EVERYONE), Duet/Stitch/Comentários habilitado/
   desabilitado, Capa (vídeo) "Automática" (ou segundos), Marca Sim/Não,
   Mídia "Vídeo", Legenda resolvida.
4. Planner YouTube → card "YouTube · Campos do Short" com os mesmos campos de
   sempre; planner Instagram → nenhum card novo; captions/canais/gating
   continuam funcionando como antes.
5. Conferir contra o payload gravado: criar um post do planner e comparar
   `Post.tiktok_options` com `tiktok_fields` do preview (fonte única: a mesma
   função `buildTiktokOptionsForPost`).

## Arquivo:linha (referência)

- `app/api/planners/[id]/preview/route.ts`: bloco "TikTok fields" (após
  `youtubeFields`) — `buildTiktokOptionsForPost` + parse + `mapTiktokMediaType`.
- `lib/planner-runtime.ts`: `mapTiktokMediaType` (logo após
  `validateTiktokMediaType`).
- `app/planners/page.tsx`: `PlannerPreviewData.youtube_fields/tiktok_fields`,
  helpers `tiktokPreviewRows`/`youtubePreviewRows`/`PreviewFieldsCard` e o bloco
  condicional no modal de Preview (após o card Caption).