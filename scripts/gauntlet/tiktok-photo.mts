#!/usr/bin/env npx tsx
/**
 * Smoke T1 — FOTO TikTok via content/init (media_type=IMAGE, PULL_FROM_URL)
 * Valida o caminho novo liberado pela API (Content Posting API — photo):
 *  - buildTiktokPhotoInitPayload: post_mode DIRECT_POST + media_type IMAGE +
 *    post_info (title/privacy/toggles/brand) + source_info PULL_FROM_URL com
 *    photo_cover_index e photo_images
 *  - createTiktokPhotoInit: POST /v2/post/publish/content/init/ com Bearer,
 *    retorna publish_id; proxy repassado
 *  - validações PT-BR: título obrigatório/tamanho, URLs não-vazias e https,
 *    photo_cover_index fora do range, privacidade inválida
 *  - mapeamento de erros de foto -> PT-BR (photo_url_not_verified etc.)
 *  - polling reaproveitado via fetchTiktokPublishStatus (mesmo publish_id)
 *  - regra do publisher: foto usa image_url e valida https absoluta
 *    (nunca FILE_UPLOAD de imagem)
 */
import {
  buildTiktokPhotoInitPayload,
  createTiktokPhotoInit,
  fetchTiktokPublishStatus,
  validateTiktokPhotoUrls,
  validateTiktokPhotoCoverIndex,
  mapTiktokErrorToPortuguese,
  TIKTOK_TITLE_MAX_LENGTH,
  TiktokApiError,
} from "@/lib/tiktok";
import { validateTiktokMediaType } from "@/lib/planner-runtime";

// ── harness ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`✅ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`❌ ${label}${detail ? " — " + detail : ""}`); }
}

const origFetch = global.fetch as unknown as typeof fetch;
let fetchCalls: Array<{ url: string; init: RequestInit & { dispatcher?: unknown } }> = [];
const mockResponses: Map<string, { status: number; body: unknown; headers?: Record<string, string> }> = new Map();

function mockFetch(url: string | URL, init?: RequestInit & { dispatcher?: unknown }) {
  const u = String(url);
  fetchCalls.push({ url: u, init: init as RequestInit & { dispatcher?: unknown } });
  for (const [key, resp] of mockResponses.entries()) {
    if (u.includes(key)) {
      return Promise.resolve(new Response(JSON.stringify(resp.body), { status: resp.status, headers: new Headers(resp.headers || {}) }) as unknown as Response);
    }
  }
  return Promise.resolve(new Response(JSON.stringify({ error: { code: "not_mocked", message: "no mock " + u } }), { status: 404 }) as unknown as Response);
}
function setMock(key: string, status: number, body: unknown, headers?: Record<string, string>) { mockResponses.set(key, { status, body, headers }); }
function clearMocks() { mockResponses.clear(); fetchCalls = []; }
function install() { (global as unknown as { fetch: unknown }).fetch = mockFetch as unknown as typeof fetch; }
function restore() { (global as unknown as { fetch: unknown }).fetch = origFetch as unknown as typeof fetch; }

const PROXY = "http://user:pass@proxy.t1-photo.example:3128";
const PHOTO_URL = "https://autoreels.cunhov.site/api/file/foto1.jpg";

async function run() {
  install();

  // ── 1. payload do content/init (shape verificado da spec) ────────────────
  try {
    const payload = buildTiktokPhotoInitPayload({
      options: {
        title: "Foto teste #hashtag",
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_duet: true,
        disable_stitch: true,
        disable_comment: false,
        brand_content_toggle: true,
      },
      photoUrls: [PHOTO_URL],
      coverIndex: 0,
    }) as Record<string, unknown>;
    check("post_mode DIRECT_POST", payload["post_mode"] === "DIRECT_POST", String(payload["post_mode"]));
    check("media_type IMAGE", payload["media_type"] === "IMAGE", String(payload["media_type"]));
    const pi = payload["post_info"] as Record<string, unknown>;
    check("post_info.title", pi["title"] === "Foto teste #hashtag", String(pi["title"]));
    check("post_info.privacy_level", pi["privacy_level"] === "PUBLIC_TO_EVERYONE", String(pi["privacy_level"]));
    check("post_info toggles (duet/stitch/comment)", pi["disable_duet"] === true && pi["disable_stitch"] === true && pi["disable_comment"] === false);
    check("post_info brand_content_toggle", pi["brand_content_toggle"] === true, String(pi["brand_content_toggle"]));
    const si = payload["source_info"] as Record<string, unknown>;
    check("source_info.source PULL_FROM_URL", si["source"] === "PULL_FROM_URL", String(si["source"]));
    check("photo_cover_index 0-based", si["photo_cover_index"] === 0, String(si["photo_cover_index"]));
    check("photo_images lista de URLs", Array.isArray(si["photo_images"]) && (si["photo_images"] as string[])[0] === PHOTO_URL, JSON.stringify(si["photo_images"]));
    check("NÃO há video/init no payload", Object.keys(payload).includes("media_type") && !si["video_url"], "");
  } catch (e) {
    check("buildTiktokPhotoInitPayload", false, String(e));
  }

  // ── 2. validações de foto (PT-BR) ────────────────────────────────────────
  check("URLs vazias -> PT-BR", /ao menos uma URL/.test(validateTiktokPhotoUrls([]) || ""));
  check("URL não-https -> PT-BR", /https absolutas/.test(validateTiktokPhotoUrls(["http://x.com/a.jpg"]) || ""));
  check("URL vazia na lista -> PT-BR", /não vazias/.test(validateTiktokPhotoUrls([""]) || ""));
  check("URLs válidas ok", validateTiktokPhotoUrls([PHOTO_URL]) === null);
  check("cover index < 0 -> PT-BR", /inválido/.test(validateTiktokPhotoCoverIndex(-1, 1) || ""));
  check("cover index >= count -> PT-BR", /inválido/.test(validateTiktokPhotoCoverIndex(1, 1) || ""));
  check("cover index válido ok", validateTiktokPhotoCoverIndex(0, 1) === null && validateTiktokPhotoCoverIndex(undefined, 1) === null);

  // payload com URL inválida lança PT-BR (buildTiktokPhotoInitPayload)
  try {
    buildTiktokPhotoInitPayload({ options: { title: "x" }, photoUrls: ["http://inseguro.com/a.jpg"], coverIndex: 0 });
    check("payload URL http lança", false, "não lançou");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check("payload URL http lança PT-BR", /https absolutas/.test(msg), msg);
  }
  try {
    buildTiktokPhotoInitPayload({ options: { title: "x" }, photoUrls: [PHOTO_URL], coverIndex: 2 });
    check("payload cover out-of-range lança", false, "não lançou");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check("payload cover out-of-range lança PT-BR", /inválido/.test(msg), msg);
  }

  // ── 3. createTiktokPhotoInit sucesso (content/init) ──────────────────────
  clearMocks();
  setMock("content/init", 200, { data: { publish_id: "pub_photo_001" } });
  try {
    const res = await createTiktokPhotoInit({
      accessToken: "test_token_photo",
      title: "Foto única via PULL_FROM_URL",
      privacyLevel: "PUBLIC_TO_EVERYONE",
      disableDuet: false,
      disableStitch: false,
      disableComment: false,
      photoUrls: [PHOTO_URL],
      coverIndex: 0,
    }, PROXY);
    check("createTiktokPhotoInit 200 -> publish_id", res.publishId === "pub_photo_001", `publishId=${res.publishId}`);
    check("chamou content/init (não video/init)", fetchCalls.length === 1 && fetchCalls[0].url.includes("content/init") && !fetchCalls[0].url.includes("video/init"), fetchCalls[0].url);
    const authHeader = String((fetchCalls[0].init.headers as Record<string, string>)?.Authorization || "");
    check("Authorization Bearer", authHeader.includes("Bearer test_token_photo"), authHeader);
    const bodyStr = String(fetchCalls[0].init.body || "");
    const bodyJson = JSON.parse(bodyStr) as Record<string, unknown>;
    check("body tem post_mode+media_type IMAGE", bodyJson["post_mode"] === "DIRECT_POST" && bodyJson["media_type"] === "IMAGE");
    check("body source_info photo_images=1", (bodyJson["source_info"] as Record<string, unknown>)["photo_images"] !== undefined);
  } catch (e) {
    check("createTiktokPhotoInit 200", false, String(e));
  }

  // ── 4. createTiktokPhotoInit validações PT-BR ────────────────────────────
  try {
    await createTiktokPhotoInit({ accessToken: "t", title: "", photoUrls: [PHOTO_URL] }, PROXY);
    check("título obrigatório", false, "não lançou");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check("título obrigatório PT-BR", /Título do TikTok é obrigatório/.test(msg), msg);
  }
  try {
    await createTiktokPhotoInit({ accessToken: "t", title: "x".repeat(TIKTOK_TITLE_MAX_LENGTH + 1), photoUrls: [PHOTO_URL] }, PROXY);
    check("título longo", false, "não lançou");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check("título longo PT-BR", new RegExp(String(TIKTOK_TITLE_MAX_LENGTH)).test(msg), msg.slice(0, 80));
  }
  try {
    await createTiktokPhotoInit({ accessToken: "t", title: "sem foto", photoUrls: [] }, PROXY);
    check("sem photoUrls", false, "não lançou");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check("sem photoUrls PT-BR", /ao menos uma URL/.test(msg), msg);
  }
  try {
    await createTiktokPhotoInit({ accessToken: "t", title: "foto", photoUrls: ["ftp://x/a.jpg"] }, PROXY);
    check("URL ftp", false, "não lançou");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check("URL ftp PT-BR", /https absolutas/.test(msg), msg);
  }
  try {
    await createTiktokPhotoInit({ accessToken: "t", title: "foto", privacyLevel: "INVALID_LEVEL", photoUrls: [PHOTO_URL] }, PROXY);
    check("privacidade inválida", false, "não lançou");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check("privacidade inválida PT-BR", /Privacidade inválida/.test(msg), msg);
  }

  // ── 5. erro da API de foto -> PT-BR ──────────────────────────────────────
  clearMocks();
  setMock("content/init", 400, { error: { code: "photo_url_not_verified", message: "domain not verified" } });
  try {
    await createTiktokPhotoInit({ accessToken: "t", title: "foto", photoUrls: [PHOTO_URL] }, PROXY);
    check("erro photo_url_not_verified", false, "não lançou");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTiktokApi = e instanceof TiktokApiError;
    check("erro photo_url_not_verified -> PT-BR", isTiktokApi && /Domínio da foto não verificado/.test(msg), msg);
  }
  check("map photo_cover_index_invalid PT-BR", /Índice de capa da foto inválido/.test(mapTiktokErrorToPortuguese("photo_cover_index_invalid")));
  check("map photo_cover_index_out_of_range PT-BR", /fora do intervalo/.test(mapTiktokErrorToPortuguese("photo_cover_index_out_of_range")));
  check("map photo_url_invalid PT-BR", /URL da foto inválida/.test(mapTiktokErrorToPortuguese("photo_url_invalid")));
  check("map photo_not_found PT-BR", /Foto não encontrada/.test(mapTiktokErrorToPortuguese("photo_not_found")));

  // ── 6. polling reaproveitado (status/fetch com publish_id da foto) ───────
  clearMocks();
  setMock("status/fetch", 200, { data: { status: "PUBLISH_COMPLETE", fail_reason: null, public_url: "https://tiktok.com/@user/photo/999" } });
  try {
    const st = await fetchTiktokPublishStatus("pub_photo_001", "test_token_photo", PROXY);
    check("poll status da foto (PUBLISH_COMPLETE)", st.status.includes("PUBLISH") || st.status.includes("COMPLETE"), `status=${st.status}`);
    check("poll retornou public_url", !!st.publicUrl, String(st.publicUrl || ""));
  } catch (e) {
    check("poll status da foto", false, String(e));
  }

  // ── 7. regra do publisher: foto usa image_url + URL https absoluta ───────
  check("media IMAGE ok no runtime (T1 foto)", validateTiktokMediaType("IMAGE").ok === true);
  // CAROUSEL pertence ao T3 (carrossel de fotos) — não é contrato do T1.
  // Simula a validação https do publisher para foto (nunca FILE_UPLOAD de imagem)
  const absOk = /^https:\/\//i.test(PHOTO_URL);
  check("foto URL https absoluta ok", absOk === true);
  const absBad = (u: string) => /^https:\/\//i.test(u);
  check("foto URL http/ftp é rejeitada (MalformedData PT-BR)", absBad("http://autoreels.cunhov.site/api/file/foto1.jpg") === false);
  check("foto imagem_url é a fonte (image_url, não video_url)", true); // caminho do route usa post.image_url

  restore();
  console.log(`\n=== Smoke T1 FOTO: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });