# Fix TikTok Planner v2 — T1 Foto · T2 Preview · T3 Carrossel · T5 Privacidade

Consolidado em `fixes-monolith` (integração dos 4 trab em sequência, sem squash):

```
c359359 merge(tiktok): T1 foto via content/init + cron publisher TikTok photo
d87b1b7 merge(tiktok): T2 preview tiktok_options no planner premium
94e0eec merge(tiktok): T3 carrossel de fotos (2..10) via content/init + wizard capa
<merge T5> merge(tiktok): T5 privacy labels PT-BR + tradução valores no wizard
```

Escopo: publicação de **FOTO e CARROSSEL DE FOTOS** no TikTok (além de vídeo,
que já existia). **NÃO há agendamento nativo** — o agendamento continua sendo
feito pelo cron publisher existente (`app/api/cron/publisher/route.ts`), que
processa posts `status: "pending"`; foto/carrossel são publicados imediatamente
na próxima varredura do cron.

---

## T1 — Foto única via content/init (PULL_FROM_URL)

O que mudou:
- `lib/tiktok.ts:776-806` — `TIKTOK_PHOTO_MIN_IMAGES/MAX_IMAGES` e
  `validateTiktokPhotoUrls` (exige 1..10 URLs https absolutas).
- `lib/tiktok.ts:808-870` — `buildTiktokPhotoInitPayload` monta o payload
  `POST /v2/post/publish/content/init/` com `media_type: IMAGE`,
  `source: "PULL_FROM_URL"` (foto NÃO aceita FILE_UPLOAD).
- `lib/planner-runtime.ts:840-990` — `buildTiktokOptionsForPost` ganha
  `mediaType/mediaUrl` (T1) e espelha `photo_urls`/`photo_cover_index` no
  `tiktok_options` do Post (URL final = `post.image_url` como fonte da verdade).
- `lib/planner-runtime.ts:991` — `validateTiktokMediaType` libera `IMAGE`.
- `components/PlannerWizard.tsx` — opção de mídia "Foto TikTok" (`IMAGE`),
  sem auto-fix forçando REELS.
- `app/api/cron/publisher/route.ts:663-663+` — publisher trata
  `tiktok_type === "photo"` via content/init; revalida https antes do call.

Como testar:
- `npx tsx scripts/gauntlet/tiktok-photo.mts` (40 PASS).
- Criar planner TikTok com item de mídia tipo Imagem (URL https de
  `/api/file/...` ou externa verificada) → rodar o cron
  (`GET /api/cron/publisher`) → post sai como foto no TikTok.

## T2 — Preview de tiktok_options no planner

O que mudou:
- `app/api/planners/[id]/preview/route.ts:273-323` — o preview agora
  calcula `tiktokOptions` com `buildTiktokOptionsForPost` e expõe
  `media_type` via `mapTiktokMediaType` (`"photo" | "carousel" | "video"`),
  para o card "O que será enviado".
- `lib/planner-runtime.ts:1005-1024` — `mapTiktokMediaType`.
- `app/planners/page.tsx` — UI do preview mostra a intenção TikTok
  (foto/carrossel) antes de publicar.

Como testar:
- `npx tsx scripts/gauntlet/tiktok-preview-options.mts` (189 linhas).
- Abrir planner TikTok premium → preview exibe "Foto TikTok"/"Carrossel de
  fotos TikTok" quando o conteúdo for imagem/carrossel.

## T3 — Carrossel de fotos (2..10) via content/init

O que mudou (superset de T1 — foto única continua funcionando):
- `lib/tiktok.ts:776-806` — validação `1..10` (carrossel = 2..10 no runtime,
  1..10 no publisher para foto única).
- `lib/planner-runtime.ts:840-990` — `buildTiktokOptionsForPost` aceita
  `children` (resolvidos pelo runtime), `postChildrenUrls` e
  `children_urls`; monta `photo_urls` deduplicados; valida capa
  (`tiktok_photo_cover_index`, 0-based, fora do intervalo → erro PT-BR).
- `lib/planner-runtime.ts:1115-1130` — `buildPostData`: `CAROUSEL` →
  `tiktok_type: "photo"` com `children` repassados ao options builder.
- `lib/planner-config.ts:996-1001` — validação de config
  `tiktok_photo_cover_index` (inteiro 0..9).
- `components/PlannerWizard.tsx:89` — rótulo "Carrossel de fotos TikTok";
  `:1992` opção de mídia CAROUSEL; `:2150` seletor "Foto de capa" (1ª..10ª);
  `:234` state `tiktokPhotoCoverIndex`.
- `app/api/cron/publisher/route.ts:766-795` — resolve `photoUrls` por
  `children_urls` (JSON) > `tiktok_options.photo_urls` > `image_url`;
  valida `2..10` (carrossel) / `1..10` (foto única) e https absoluto
  (`makeAbsoluteUrl`), erros PT-BR `Malformed Data` sem chamar a API.

Como testar:
- `npx tsx scripts/gauntlet/tiktok-carousel.mts` (30 PASS).
- Planner TikTok com conteúdo do tipo Carrossel (2..10 imagens) → rodar cron →
  post publicado como álbum de fotos no TikTok.
- Casos de erro: 1 imagem em modo carrossel, 11 imagens, capa fora do
  intervalo → falha com mensagem PT-BR no post.

## T5 — Privacy labels em PT-BR

O que mudou:
- `lib/planner-config.ts:440-455` — `labelTiktokPrivacy(value)` traduz
  `PUBLIC_TO_EVERYONE → "Público"`, `MUTUAL_FOLLOW_FRIENDS → "Amigos"`,
  `FOLLOWER_OF_CREATOR → "Seguidores"`, `SELF_ONLY → "Somente eu"`,
  `PRIVATE_TO_EVERYONE → "Privado"` (fallback `<raw> (personalizado)`).
- `components/PlannerWizard.tsx:2099` — dropdown de privacidade usa os
  rótulos PT-BR (o valor enviado continua sendo o código cru exigido pela API).
- `lib/planner-runtime.ts` (comentário T5) — garante que o runtime manda o
  VALUE cru, nunca o rótulo.

Como testar:
- `npx tsx scripts/gauntlet/tiktok-captions.mts` (32 PASS).
- Wizard TikTok → dropdown "Privacidade" mostra "Público"/"Somente eu", etc.;
  ao salvar, `tiktok_privacy_level` no JSON do planner continua com o código
  cru (`PUBLIC_TO_EVERYONE`...).

---

## Riscos conhecidos
- **Agendamento**: não existe agendamento nativo — foto/carrossel dependem do
  cron publisher (mesmo mecanismo do vídeo). Se o cron estiver desligado, nada
  é publicado (mesmo comportamento já existente).
- **Domínio verificado**: PULL_FROM_URL exige domínio https verificada no app
  TikTok. URLs `http://` ou domínio não verificado falham com erro PT-BR
  (`photo_domain_not_verified`/`photo_url_not_verified` mapeados em
  `lib/tiktok.ts` TIKTOK_ERROR_MAP).
- **Limite de imagens**: carrossel `2..10`; foto única `1..10`. Validação em
  runtime (buildPostData), config (wizard) e publisher (defesa final).
- **Conflitos integração**: wizard/planner-runtime/lib-tiktok/publisher eram
  compartilhados entre T1/T3 e T2/T5 — resolvidos preservando as 4 features
  (T3 é superset de T1; T5 só toca labels/ui + validação config).

## Validação executada
- `npx tsc --noEmit` ✅
- `npm run build` ✅
- `prisma validate` ✅
- Smokes não-visuais: `tiktok-photo` (40), `tiktok-carousel` (30),
  `tiktok-publishing` (70), `tiktok-isolation` (16), `tiktok-captions` (32),
  `tiktok-a2-smoke` (16), `first-comment` (22), `ai-suggest` (12),
  `products-routing` (20) — todos 0 FAIL.