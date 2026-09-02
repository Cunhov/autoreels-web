#!/usr/bin/env npx tsx
/**
 * Smoke T2 — Preview de tiktok_options (card "TikTok · O que será enviado").
 *
 * Valida o contrato que GET /api/planners/[id]/preview expõe em
 * `tiktok_fields` (mesmas linhas que o card em app/planners/page.tsx renderiza):
 *   - buildTiktokOptionsForPost monta o MESMO payload que o publisher grava em
 *     Post.tiktok_options: title, privacy_level, disable_duet/stitch/comment,
 *     video_cover_timestamp_ms, brand_content_toggle, brand_organic_toggle;
 *   - planner não-TikTok → buildTiktokOptionsForPost retorna null → o preview
 *     marca available=false e o card não aparece (canal não é TikTok);
 *   - mapTiktokMediaType mapeia REELS/VIDEO→video, IMAGE→photo,
 *     CAROUSEL→carousel (espelha Post.media_type no preview);
 *   - montagem do shape final de tiktok_fields: 11 campos do contrato T2
 *     (title, privacy_level, 3 toggles, cover, 2 brand, media_type,
 *     photo_cover_index, caption_tiktok).
 *
 * Runner: npx --no-install tsx scripts/gauntlet/tiktok-preview-options.mts
 * Exit code 0 only if every scenario passes.
 */
import { buildTiktokOptionsForPost, mapTiktokMediaType } from "../../lib/planner-runtime";

let failures = 0;
let passed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.error(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`);
  }
}

/** Emulação EXATA do bloco da rota de preview que monta tiktok_fields. */
async function previewTiktokFields(cfg: Record<string, unknown>, platform: string, caption: string) {
  const raw = await buildTiktokOptionsForPost({
    prisma: {} as never,
    planner: { user_id: "smoke" },
    config: cfg as never,
    selectedContent: null as never,
    channelName: "Canal Smoke",
    now: new Date("2026-09-01T12:00:00Z"),
    caption,
    platform,
  });
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { /* SAFETY */ }
  }
  return {
    available: raw !== null,
    title: typeof parsed.title === "string" ? parsed.title : null,
    privacy_level: typeof parsed.privacy_level === "string" ? parsed.privacy_level : null,
    disable_duet: parsed.disable_duet === true,
    disable_stitch: parsed.disable_stitch === true,
    disable_comment: parsed.disable_comment === true,
    video_cover_timestamp_ms: typeof parsed.video_cover_timestamp_ms === "number" ? parsed.video_cover_timestamp_ms : null,
    brand_content_toggle: parsed.brand_content_toggle === true,
    brand_organic_toggle: parsed.brand_organic_toggle === true,
    media_type: mapTiktokMediaType("REELS"),
    photo_cover_index: null,
    caption_tiktok: caption,
  };
}

async function run() {
  // ── 1. TikTok completo: título, privacy, toggles, cover, brand ─────────────
  {
    const f = await previewTiktokFields(
      {
        tiktok_caption: "Meu vídeo TikTok",
        tiktok_privacy_level: "PUBLIC_TO_EVERYONE",
        tiktok_disable_duet: true,
        tiktok_disable_stitch: false,
        tiktok_disable_comment: true,
        tiktok_video_cover_timestamp_ms: 1500,
        tiktok_brand_content_toggle: true,
        tiktok_brand_organic_toggle: false,
      },
      "tiktok",
      "caption de fallback",
    );
    check("tiktok planner → available=true", f.available === true, JSON.stringify(f));
    check("title vem de tiktok_caption", f.title === "Meu vídeo TikTok", `title=${f.title}`);
    check("privacy_level cru preservado", f.privacy_level === "PUBLIC_TO_EVERYONE", `privacy=${f.privacy_level}`);
    check("disable_duet=true", f.disable_duet === true);
    check("disable_stitch=false (habilitado)", f.disable_stitch === false);
    check("disable_comment=true", f.disable_comment === true);
    check("video_cover_timestamp_ms=1500", f.video_cover_timestamp_ms === 1500, `cover=${f.video_cover_timestamp_ms}`);
    check("brand_content_toggle=true", f.brand_content_toggle === true);
    check("brand_organic_toggle=false", f.brand_organic_toggle === false);
    check("media_type=video (REELS)", f.media_type === "video", `media=${f.media_type}`);
  }

  // ── 2. Fallbacks: tiktok_title, generic privacy/toggles keys, caption ──────
  {
    const f = await previewTiktokFields(
      {
        tiktok_title: "Título alternativo",
        privacy_level: "SELF_ONLY",
        tiktok_disable_duet: "true", // string "true" em chave tiktok_* conta
        disable_stitch: true,          // chave genérica só aceita boolean
        video_cover_timestamp_ms: "2000", // string numérica aceita
        brand_organic_toggle: true,
      },
      "tiktok",
      "caption",
    );
    check("title fallback tiktok_title", f.title === "Título alternativo", `title=${f.title}`);
    check("privacy_level alias privacy_level", f.privacy_level === "SELF_ONLY", `privacy=${f.privacy_level}`);
    check("disable_duet string 'true' (chave tiktok_*)", f.disable_duet === true);
    check("disable_stitch boolean true (chave genérica)", f.disable_stitch === true);
    check("cover string '2000'→2000", f.video_cover_timestamp_ms === 2000, `cover=${f.video_cover_timestamp_ms}`);
    check("brand_organic_toggle=true", f.brand_organic_toggle === true);
  }

  // ── 2b. Chave genérica com string "true" NÃO é parseada (contrato do A3:
  //        chaves legadas sem prefixo só aceitam boolean) — preview espelha cron
  //        porque usa a MESMA função da criação.
  {
    const f = await previewTiktokFields(
      { disable_duet: "true", disable_stitch: "true" },
      "tiktok",
      "caption",
    );
    check("generic disable_duet string 'true' → false (contrato)", f.disable_duet === false);
    check("generic disable_stitch string 'true' → false (contrato)", f.disable_stitch === false);
  }

  // ── 3. Defaults quando nada configurado ─────────────────────────────────────
  {
    const f = await previewTiktokFields({}, "tiktok", "fallback caption");
    check("privacy cai em SELF_ONLY", f.privacy_level === "SELF_ONLY", `privacy=${f.privacy_level}`);
    check("toggles default false", !f.disable_duet && !f.disable_stitch && !f.disable_comment);
    check("cover null (automática)", f.video_cover_timestamp_ms === null);
    check("title usa caption resolvida", f.title === "fallback caption", `title=${f.title}`);
    check("caption_tiktok = caption final", f.caption_tiktok === "fallback caption");
  }

  // ── 4. Planner NÃO TikTok → available=false (card não aparece) ─────────────
  {
    const f = await previewTiktokFields(
      { tiktok_caption: "não deve ser usado" },
      "youtube",
      "caption yt",
    );
    check("youtube planner → available=false", f.available === false);
    check("sem title derivado", f.title === null);
    check("sem privacy derivado", f.privacy_level === null);
  }

  // ── 5. mapTiktokMediaType (espelha Post.media_type no preview) ─────────────
  {
    check("REELS → video", mapTiktokMediaType("REELS") === "video");
    check("VIDEO → video", mapTiktokMediaType("VIDEO") === "video");
    check("STORIES → video", mapTiktokMediaType("STORIES") === "video");
    check("IMAGE → photo", mapTiktokMediaType("IMAGE") === "photo");
    check("CAROUSEL → carousel", mapTiktokMediaType("CAROUSEL") === "carousel");
    check("null → video", mapTiktokMediaType(null) === "video");
  }

  // ── 6. Contrato T2: 11 campos no shape final ───────────────────────────────
  {
    const f = await previewTiktokFields(
      { tiktok_caption: "T2", tiktok_privacy_level: "PUBLIC_TO_EVERYONE" },
      "tiktok",
      "T2",
    );
    const keys = Object.keys(f).sort();
    check(
      "tiktok_fields tem os 11 campos do contrato",
      ["available", "brand_content_toggle", "brand_organic_toggle", "caption_tiktok",
        "disable_comment", "disable_duet", "disable_stitch", "media_type",
        "photo_cover_index", "privacy_level", "title", "video_cover_timestamp_ms"]
        .sort().join(",") === keys.join(","),
      `keys=${keys.join(",")}`,
    );
  }

  console.log(`\nT2 preview tiktok_options: ${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});