#!/usr/bin/env npx tsx
/**
 * Smoke T3 — CARROSSEL DE FOTOS TikTok (content/init photo_images + photo_cover_index)
 * Valida:
 *  - createTiktokPhotoInit aceita 2..10 URLs https + coverIndex (payload content/init)
 *  - validateTiktokPhotoUrls: 1..10 URLs https (máx 10; http rejeitado) — PT-BR
 *  - coverIndex fora do intervalo → erro PT-BR
 *  - buildTiktokPhotoInitPayload: post_mode DIRECT_POST, media_type IMAGE,
 *    source_info { PULL_FROM_URL, photo_images, photo_cover_index }
 *  - planner-runtime: CAROUSEL liberado (validateTiktokMediaType), e
 *    buildTiktokOptionsForPost monta photo_urls (2..10) + photo_cover_index;
 *    ERR0: 1 imagem em modo carrossel → erro PT-BR "2 e 10"; cover fora do
 *    intervalo → erro PT-BR
 */
import {
  createTiktokPhotoInit,
  buildTiktokPhotoInitPayload,
  validateTiktokPhotoUrls,
  TIKTOK_PHOTO_MIN_IMAGES,
  TIKTOK_PHOTO_MAX_IMAGES,
  TiktokApiError,
} from "@/lib/tiktok";
import {
  buildTiktokOptionsForPost,
  validateTiktokMediaType,
} from "@/lib/planner-runtime";

const BASE = "https://autoreels.cunhov.site/api/file/";
const urls = (n: number) =>
  Array.from({ length: n }, (_, i) => `${BASE}admin/photo-${i + 1}.jpg`);

// ── harness (mock fetch) ────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`✅ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`❌ ${label}${detail ? " — " + detail : ""}`); }
}

let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponses: Map<string, { status: number; body: unknown }> = new Map();

const origFetch = global.fetch as unknown as typeof fetch;
function mockFetch(url: string | URL, init?: RequestInit) {
  const u = String(url);
  fetchCalls.push({ url: u, init: init as RequestInit });
  for (const [key, resp] of mockResponses.entries()) {
    if (u.includes(key)) {
      return Promise.resolve(
        new Response(JSON.stringify(resp.body), { status: resp.status }) as unknown as Response,
      );
    }
  }
  return Promise.resolve(
    new Response(JSON.stringify({ error: { code: "not_mocked", message: "no mock " + u } }), { status: 404 }) as unknown as Response,
  );
}
function setMock(key: string, status: number, body: unknown) { mockResponses.set(key, { status, body }); }
function clearMocks() { mockResponses.clear(); fetchCalls = []; }

async function run() {
  (global as unknown as { fetch: unknown }).fetch = mockFetch as unknown as typeof fetch;

  // ── 1) Limits & validação de URLs (lib) ───────────────────────────────
  check("min constants 1..10", TIKTOK_PHOTO_MIN_IMAGES === 1 && TIKTOK_PHOTO_MAX_IMAGES === 10, `${TIKTOK_PHOTO_MIN_IMAGES}..${TIKTOK_PHOTO_MAX_IMAGES}`);
  check("valida 1 url https ok", validateTiktokPhotoUrls([urls(1)[0]]) === null);
  check("valida 10 urls https ok", validateTiktokPhotoUrls(urls(10)) === null);
  check("valida 0 urls → erro PT-BR", (validateTiktokPhotoUrls([]) || "").includes("ao menos uma URL"), validateTiktokPhotoUrls([]) || "");
  const err11 = validateTiktokPhotoUrls(urls(11));
  check("valida 11 urls → max 10 (PT-BR)", !!err11 && err11.includes("10") && err11.includes("11"), err11 || "");
  const errHttp = validateTiktokPhotoUrls(["http://inseguro.com/a.jpg"]);
  check("URL http → https exigida (PT-BR)", !!errHttp && /https/i.test(errHttp), errHttp || "");
  const errEmptyUrl = validateTiktokPhotoUrls([""]);
  check("URL vazia → erro PT-BR", !!errEmptyUrl, errEmptyUrl || "");

  // ── 2) buildTiktokPhotoInitPayload (shape do content/init) ────────────
  const payload = buildTiktokPhotoInitPayload({
    options: { title: "Carrossel T3", privacy_level: "PUBLIC_TO_EVERYONE" },
    photoUrls: urls(3),
    coverIndex: 1,
  }) as Record<string, unknown>;
  check("payload post_mode DIRECT_POST", payload.post_mode === "DIRECT_POST");
  check("payload media_type IMAGE", payload.media_type === "IMAGE");
  const si = payload.source_info as Record<string, unknown>;
  check("source_info source PULL_FROM_URL", si.source === "PULL_FROM_URL");
  check("photo_images 3 urls", Array.isArray(si.photo_images) && (si.photo_images as string[]).length === 3, String((si.photo_images as string[])?.length));
  check("photo_cover_index 1", si.photo_cover_index === 1, String(si.photo_cover_index));
  const pi = payload.post_info as Record<string, unknown>;
  check("post_info.title", pi.title === "Carrossel T3", String(pi.title));
  // cover padrão = 0 quando omitido
  const payload2 = buildTiktokPhotoInitPayload({ options: { title: "x" }, photoUrls: urls(2) }) as Record<string, unknown>;
  check("photo_cover_index default 0", (payload2.source_info as Record<string, unknown>).photo_cover_index === 0);

  // ── 3) createTiktokPhotoInit E2E mock (2 e 10 URLs, coverIndex) ───────
  clearMocks();
  setMock("content/init", 200, { data: { publish_id: "photo_abc" } });
  try {
    const res = await createTiktokPhotoInit({
      accessToken: "tok",
      title: "Carrossel 10 fotos",
      photoUrls: urls(10),
      coverIndex: 9,
    });
    check("init 10 urls OK → publish_id", res.publishId === "photo_abc", res.publishId);
    const body = JSON.parse(String((fetchCalls[0]?.init?.body) || "{}")) as Record<string, unknown>;
    const sent = (body.source_info as Record<string, unknown>).photo_images as string[];
    check("envia 10 photo_images", Array.isArray(sent) && sent.length === 10, String(sent?.length));
    check("envia photo_cover_index 9", (body.source_info as Record<string, unknown>).photo_cover_index === 9);
    check("envia Authorization Bearer", /Bearer tok/.test(String((fetchCalls[0]?.init?.headers as Record<string, string>)?.Authorization || "")));
  } catch (e) {
    check("init 10 urls OK → publish_id", false, String(e));
  }

  clearMocks();
  setMock("content/init", 200, { data: { publish_id: "photo_min" } });
  try {
    const res = await createTiktokPhotoInit({
      accessToken: "tok",
      title: "Carrossel 2 fotos",
      photoUrls: urls(2),
      coverIndex: 0,
    });
    check("init 2 urls OK", res.publishId === "photo_min", res.publishId);
  } catch (e) {
    check("init 2 urls OK", false, String(e));
  }

  // coverIndex fora do intervalo → erro 400 PT-BR (TiktokApiError)
  clearMocks();
  let coverErr: string | null = null;
  try {
    await createTiktokPhotoInit({ accessToken: "tok", title: "x", photoUrls: urls(2), coverIndex: 2 });
  } catch (e) {
    coverErr = e instanceof TiktokApiError ? e.message : (e instanceof Error ? e.message : String(e));
  }
  check("coverIndex fora do intervalo → erro PT-BR", !!coverErr && /índice|capa/i.test(coverErr!), coverErr || "none");

  // 11 urls → erro PT-BR
  let manyErr: string | null = null;
  try {
    await createTiktokPhotoInit({ accessToken: "tok", title: "x", photoUrls: urls(11) });
  } catch (e) {
    manyErr = e instanceof Error ? e.message : String(e);
  }
  check("init 11 urls → erro max 10 PT-BR", !!manyErr && /10/.test(manyErr) && /Carrossel de fotos TikTok aceita entre/.test(manyErr!), manyErr || "none");

  // ── 4) planner-runtime: CAROUSEL liberado + monta photo_urls/cover ────
  check("validateTiktokMediaType CAROUSEL ok", validateTiktokMediaType("CAROUSEL").ok === true, validateTiktokMediaType("CAROUSEL").error || "");

  const carouselOptions = await buildTiktokOptionsForPost({
    prisma: {} as never,
    planner: { user_id: "u1" },
    config: { tiktok_caption: "Meu carrossel", tiktok_photo_cover_index: 1 },
    selectedContent: null,
    channelName: "chan",
    now: new Date(),
    caption: "caption",
    platform: "tiktok",
    mediaType: "CAROUSEL",
    mediaUrl: urls(1)[0],
    children: urls(3).map((url) => ({ url, type: "image" })),
  });
  const co = carouselOptions ? JSON.parse(carouselOptions) : null;
  check("carousel options gerado", co !== null, String(carouselOptions));
  check("photo_urls = 3 children", Array.isArray(co?.photo_urls) && co.photo_urls.length === 3, String(co?.photo_urls?.length));
  check("photo_cover_index do config (1)", co?.photo_cover_index === 1, String(co?.photo_cover_index));
  check("cover timestamp NÃO entra no carrossel", co?.video_cover_timestamp_ms === undefined);

  // cover do config fora do intervalo → erro PT-BR
  let coverRangeErr: string | null = null;
  try {
    await buildTiktokOptionsForPost({
      prisma: {} as never,
      planner: { user_id: "u1" },
      config: { tiktok_caption: "x", tiktok_photo_cover_index: 5 },
      selectedContent: null,
      channelName: "c",
      now: new Date(),
      caption: "c",
      platform: "tiktok",
      mediaType: "CAROUSEL",
      children: urls(2).map((url) => ({ url, type: "image" })),
    });
  } catch (e) {
    coverRangeErr = e instanceof Error ? e.message : String(e);
  }
  check("cover fora do intervalo (2 fotos, índice 5) → erro PT-BR", !!coverRangeErr && /Foto de capa do carrossel TikTok inválida/.test(coverRangeErr!), coverRangeErr || "none");

  // ERR0 OBRIGATÓRIO: 1 imagem em modo carrossel → erro PT-BR "2 e 10"
  let oneImgErr: string | null = null;
  try {
    await buildTiktokOptionsForPost({
      prisma: {} as never,
      planner: { user_id: "u1" },
      config: { tiktok_caption: "x" },
      selectedContent: null,
      channelName: "c",
      now: new Date(),
      caption: "c",
      platform: "tiktok",
      mediaType: "CAROUSEL",
      children: [ { url: urls(1)[0], type: "image" } ],
    });
  } catch (e) {
    oneImgErr = e instanceof Error ? e.message : String(e);
  }
  check("1 imagem em carrossel → erro PT-BR (2..10)", !!oneImgErr && /exige entre 2 e 10 imagens \(recebidas: 1\)/.test(oneImgErr!), oneImgErr || "none");

  // 11 children em carrossel → erro PT-BR
  let elevenErr: string | null = null;
  try {
    await buildTiktokOptionsForPost({
      prisma: {} as never,
      planner: { user_id: "u1" },
      config: { tiktok_caption: "x" },
      selectedContent: null,
      channelName: "c",
      now: new Date(),
      caption: "c",
      platform: "tiktok",
      mediaType: "CAROUSEL",
      children: urls(11).map((url) => ({ url, type: "image" })),
    });
  } catch (e) {
    elevenErr = e instanceof Error ? e.message : String(e);
  }
  check("11 imagens em carrossel → erro PT-BR", !!elevenErr && /2 e 10 imagens \(recebidas: 11\)/.test(elevenErr!), elevenErr || "none");

  // fallback: foto única IMAGE continua 1 URL (T1)
  const singleOptions = await buildTiktokOptionsForPost({
    prisma: {} as never,
    planner: { user_id: "u1" },
    config: { tiktok_caption: "x" },
    selectedContent: null,
    channelName: "c",
    now: new Date(),
    caption: "c",
    platform: "tiktok",
    mediaType: "IMAGE",
    mediaUrl: urls(1)[0],
  });
  const so = singleOptions ? JSON.parse(singleOptions) : null;
  check("foto única IMAGE → photo_urls [1] e cover 0", Array.isArray(so?.photo_urls) && so.photo_urls.length === 1 && so.photo_cover_index === 0, String(so?.photo_urls?.length));

  // restaura fetch
  (global as unknown as { fetch: unknown }).fetch = origFetch;

  console.log(`\n=== Smoke T3 CARROSSEL: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });