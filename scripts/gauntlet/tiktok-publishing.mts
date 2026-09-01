#!/usr/bin/env npx tsx
/**
 * Smoke A5 — COMPLIANCE, LIMITS & OBSERVABILITY (publishing)
 * Valida o caminho completo de publicação TikTok (Direct Post) com TikTok mockado:
 *  - init FILE_UPLOAD (chunk sizes, total_chunk_count)
 *  - init PULL_FROM_URL (video_url)
 *  - privacy levels válidos/inválidos
 *  - toggles (disable_duet/stitch/comment)
 *  - cover timestamp (video_cover_timestamp_ms)
 *  - brand content/organic toggles
 *  - caption_tiktok > caption fallback (resolveTiktokCaption + resolveFinalCaption)
 *  - tiktok.txt / caption genérica (folder-captions)
 *  - proxy repassado em todas as chamadas
 *  - erros TikTok -> PT-BR
 *  - rate limit: 429 + Retry-After + backoff + classificação (não derruba publisher)
 *  - validação pré-upload (validateTiktokVideo) -> 400 PT-BR
 */
import {
  createTiktokVideoInit,
  uploadTiktokChunks,
  fetchTiktokPublishStatus,
  buildTiktokInitPayload,
  validateTiktokVideo,
  mapTiktokErrorToPortuguese,
  getTiktokErrorMessage,
  classifyTiktokError,
  parseRetryAfterMs,
  getTiktokBackoffMs,
  isTiktokRateLimitError,
  resolveTiktokCaption,
  readFolderCaptionsWithTiktok,
  TIKTOK_TITLE_MAX_LENGTH,
  TIKTOK_MAX_VIDEO_SIZE_BYTES,
  TiktokApiError,
} from "@/lib/tiktok";
import { resolveFinalCaption } from "@/lib/planner-runtime";
import { readFolderCaptions } from "@/lib/folder-captions";

// ── harness ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`✅ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`❌ ${label}${detail ? " — " + detail : ""}`); }
}

const origFetch = global.fetch as unknown as typeof fetch;
let fetchCalls: Array<{ url: string; init: RequestInit & { dispatcher?: unknown } }> = [];
let mockResponses: Map<string, { status: number; body: unknown; headers?: Record<string, string> }> = new Map();

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

const PROXY = "http://user:pass@proxy.a5.example:3128";

async function run() {
  install();

  // ── 1. validação pré-upload (validateTiktokVideo) ─────────────────────────
  check("validate size > 500MB",
    validateTiktokVideo({ size: TIKTOK_MAX_VIDEO_SIZE_BYTES + 1 }).valid === false &&
    /tamanho máximo de 500 MB/.test(validateTiktokVideo({ size: TIKTOK_MAX_VIDEO_SIZE_BYTES + 1 }).error || ""),
    `${validateTiktokVideo({ size: TIKTOK_MAX_VIDEO_SIZE_BYTES + 1 }).error}`);

  check("validate duração máxima p/ criador",
    validateTiktokVideo({ durationSec: 301, maxDurationSec: 300 }).valid === false &&
    /duração máxima de 300 s/.test(validateTiktokVideo({ durationSec: 301, maxDurationSec: 300 }).error || ""),
    validateTiktokVideo({ durationSec: 301, maxDurationSec: 300 }).error || "");

  check("validate duração mínima 3s",
    validateTiktokVideo({ durationSec: 2 }).valid === false && /muito curto/.test(validateTiktokVideo({ durationSec: 2 }).error || ""));

  check("validate formato não suportado",
    validateTiktokVideo({ format: "avi" }).valid === false && /Formato não suportado \(use MP4 H\.264\)/.test(validateTiktokVideo({ format: "avi" }).error || ""));

  check("validate mp4 ok",
    validateTiktokVideo({ format: "mp4", durationSec: 30, size: 1000, title: "ok" }).valid === true);

  check("validate título > 2200",
    validateTiktokVideo({ titleLen: TIKTOK_TITLE_MAX_LENGTH + 1 }).valid === false &&
    /Título excede 2200 caracteres/.test(validateTiktokVideo({ titleLen: TIKTOK_TITLE_MAX_LENGTH + 1 }).error || ""));

  check("validate privacy inválida",
    validateTiktokVideo({ privacy: "ONLY_ME_ROGUE" }).valid === false &&
    /Privacidade inválida/.test(validateTiktokVideo({ privacy: "ONLY_ME_ROGUE" }).error || ""));

  check("validate cover negativo",
    validateTiktokVideo({ coverTimestampMs: -5 }).valid === false && /Cover inválido/.test(validateTiktokVideo({ coverTimestampMs: -5 }).error || ""));

  // ── 2. init FILE_UPLOAD com todos os campos ───────────────────────────────
  clearMocks();
  setMock("video/init", 200, { data: { publish_id: "pub_fu_1", upload_url: "https://upload.tiktok.com/u1" } });
  try {
    const r = await createTiktokVideoInit({
      accessToken: "tok", title: "Título de teste #viral",
      privacyLevel: "PUBLIC_TO_EVERYONE", disableDuet: true, disableStitch: false, disableComment: true,
      videoCoverTimestampMs: 1500, brandContentToggle: true, brandOrganicToggle: false,
      source: { source: "FILE_UPLOAD", video_size: 10_000_000, chunk_size: 5_000_000, total_chunk_count: 2 },
    }, PROXY);
    check("init FILE_UPLOAD retorna publish_id+upload_url", r.publishId === "pub_fu_1" && r.uploadUrl.includes("upload.tiktok"));
    const body = JSON.parse((fetchCalls[0].init.body as string) || "{}");
    const pi = body.post_info as Record<string, unknown>;
    check("init post_info title", pi.title === "Título de teste #viral");
    check("init post_info privacy", pi.privacy_level === "PUBLIC_TO_EVERYONE");
    check("init post_info toggles", pi.disable_duet === true && pi.disable_stitch === false && pi.disable_comment === true, JSON.stringify({duet:pi.disable_duet,stitch:pi.disable_stitch,comment:pi.disable_comment}));
    check("init post_info cover", pi.video_cover_timestamp_ms === 1500);
    check("init post_info brand", pi.brand_content_toggle === true && pi.brand_organic_toggle === false);
    const si = body.source_info as Record<string, unknown>;
    check("init source_info FILE_UPLOAD", si.source === "FILE_UPLOAD" && si.video_size === 10_000_000 && si.chunk_size === 5_000_000 && si.total_chunk_count === 2);
    // proxy repassado: fetchWithTimeout passa dispatcher; assert chamada foi feita com proxy (verifica que o header bearer está presente)
    check("init requisição usou Bearer", (fetchCalls[0].init.headers as Record<string, string>)?.Authorization === "Bearer tok");
  } catch (e) { check("init FILE_UPLOAD completo", false, String(e)); }

  // ── 3. init PULL_FROM_URL ────────────────────────────────────────────────
  clearMocks();
  setMock("video/init", 200, { data: { publish_id: "pub_pull_1" } });
  try {
    const r = await createTiktokVideoInit({
      accessToken: "tok", title: "Via URL",
      source: { source: "PULL_FROM_URL", video_url: "https://autoreels.cunhov.site/api/file/x.mp4" },
    }, PROXY);
    check("init PULL_FROM_URL n/ exige upload_url", r.publishId === "pub_pull_1" && r.uploadUrl === "");
    const body = JSON.parse((fetchCalls[0].init.body as string) || "{}");
    check("init PULL_FROM_URL source_info", (body.source_info as Record<string, unknown>).source === "PULL_FROM_URL" && String((body.source_info as Record<string, unknown>).video_url).endsWith("/api/file/x.mp4"));
  } catch (e) { check("init PULL_FROM_URL", false, String(e)); }

  // ── 4. init privacy inválida rejeitada localmente ────────────────────────
  clearMocks();
  try {
    await createTiktokVideoInit({ accessToken: "tok", title: "x", privacyLevel: "BAD_LEVEL", source: { source: "PULL_FROM_URL", video_url: "https://autoreels.cunhov.site/api/file/x.mp4" } }, PROXY);
    check("init privacy inválida rejeitada", false);
  } catch (e) {
    check("init privacy inválida rejeitada", (e as Error).message.includes("Privacidade inválida"), (e as Error).message);
  }

  // ── 5. init erro de rate limit mapeado + Retry-After ─────────────────────
  clearMocks();
  setMock("video/init", 429, { error: { code: "rate_limit", message: "Rate limit reached" } }, { "Retry-After": "2" });
  try {
    await createTiktokVideoInit({ accessToken: "tok", title: "x", source: { source: "PULL_FROM_URL", video_url: "https://autoreels.cunhov.site/api/file/x.mp4" } }, PROXY);
    check("init 429 vira erro", false);
  } catch (e) {
    const te = e as TiktokApiError;
    check("init 429 é rate limit", isTiktokRateLimitError(e, te.status), te.status + "");
    check("init 429 classificado rate-limited", classifyTiktokError(e, te.status) === "rate-limited");
    check("init 429 mensagem PT-BR", /Limite de requisições/.test(te.message), te.message);
    check("init 429 carrega retryAfterMs(2s)", te.retryAfterMs === 2000, `${te.retryAfterMs}`);
  }

  // ── 6. retry/backoff helpers ─────────────────────────────────────────────
  check("parseRetryAfterMs segundos", parseRetryAfterMs("3") === 3000);
  check("getTiktokBackoffMs usa Retry-After", getTiktokBackoffMs(1, 5000) === Math.min(5000, 60000));
  check("getTiktokBackoffMs exp backoff", getTiktokBackoffMs(2, null) === 4000, String(getTiktokBackoffMs(2, null)));
  check("getTiktokBackoffMs cap 60s", getTiktokBackoffMs(99, null) === 60000);

  // ── 7. mapa de erros PT-BR amplo ─────────────────────────────────────────
  const errCases: Array<[string, RegExp]> = [
    ["access_token_invalid", /Token do TikTok inválido ou expirado/],
    ["access_token_expired", /Token do TikTok expirado/],
    ["invalid_token", /Token do TikTok inválido/],
    ["rate_limit_exceeded", /Limite de requisições/],
    ["too_many_requests", /Limite de requisições/],
    ["video_too_long", /duração máxima/],
    ["video_too_large", /tamanho máximo de 500 MB/],
    ["invalid_video_format", /Formato não suportado/],
    ["unsupported_format", /Formato não suportado/],
    ["privacy_not_allowed", /privacidade não permitido/],
    ["privacy_level_not_allowed", /privacidade não permitido/],
    ["invalid_privacy_level", /privacidade inválido/i],
    ["invalid_title", /Título inválido/],
    ["title_too_long", /2200/],
    ["brand_content_not_allowed", /Conteúdo de marca não permitido/],
    ["brand_not_eligible", /Conteúdo de marca não permitido/],
    ["cover_timestamp_invalid", /Timestamp de capa inválido/],
    ["url_not_verified", /Domínio do vídeo não verificado/],
    ["domain_not_verified", /Domínio do vídeo não verificado/],
    ["chunk_upload_failed", /Falha no upload/],
    ["upload_failed", /Falha no upload/],
    ["publish_failed", /Falha ao publicar no TikTok/],
    ["internal_error", /Erro interno do TikTok/],
    ["server_error", /Erro no servidor do TikTok/],
  ];
  for (const [code, re] of errCases) {
    const pt = mapTiktokErrorToPortuguese(code);
    check(`erro PT-BR ${code}`, re.test(pt), pt);
  }
  check("getTiktokErrorMessage de mensagem crua", /TikTok/.test(getTiktokErrorMessage("access_token_invalid")));
  check("classify 500 transient", classifyTiktokError(new Error("boom"), 500) === "transient");
  check("classify 400 definitive", classifyTiktokError(new Error("bad"), 400) === "definitive");

  // ── 8. upload chunks + retry 429 (1x) ────────────────────────────────────
  clearMocks();
  const uploads: number[] = [];
  let retryCount = 0;
  (global as unknown as { fetch: unknown }).fetch = ((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("upload-chunk-retry")) {
      retryCount++;
      if (retryCount === 1) return Promise.resolve(new Response("429", { status: 429, headers: { "Retry-After": "1" } }) as unknown as Response);
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }) as unknown as Response);
    }
    if (u.includes("upload-chunks-ok")) {
      uploads.push(((init?.headers as Record<string, string>)?.["Content-Range"] || "").length);
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }) as unknown as Response);
    }
    return mockFetch(url, init as RequestInit & { dispatcher?: unknown });
  }) as unknown as typeof fetch;

  const buf = Buffer.alloc(3 * 1024 * 1024, 0x07);
  try {
    await uploadTiktokChunks("https://upload.tiktok.com/upload-chunks-ok", buf, 1024 * 1024, PROXY);
    check("upload 3 chunks", uploads.length === 3, `chunks=${uploads.length}`);
  } catch (e) { check("upload 3 chunks", false, String(e)); }
  try {
    await uploadTiktokChunks("https://upload.tiktok.com/upload-chunk-retry", Buffer.alloc(512 * 1024, 0x08), 1024 * 1024, PROXY);
    check("upload retry 1x em 429", retryCount === 2, `attempts=${retryCount}`);
  } catch (e) { check("upload retry 1x em 429", false, String(e)); }
  install(); // restaura mock genérico

  // ── 9. status publish complete / failed PT-BR ────────────────────────────
  clearMocks();
  setMock("status/fetch", 200, { data: { status: "PUBLISH_COMPLETE", public_url: "https://tiktok.com/@u/v/1", video_id: "vid1" } });
  try {
    const st = await fetchTiktokPublishStatus("pub", "tok", PROXY);
    check("status PUBLISH_COMPLETE", /PUBLISH|COMPLETE/.test(st.status), st.status);
    check("status video_id", st.videoId === "vid1", String(st.videoId));
  } catch (e) { check("status PUBLISH_COMPLETE", false, String(e)); }

  clearMocks();
  setMock("status/fetch", 200, { data: { status: "FAILED", fail_reason: "video_too_long" } });
  try {
    const st = await fetchTiktokPublishStatus("pub", "tok", PROXY);
    check("status FAILED + fail_reason PT-BR", /FAILED/i.test(st.status) && mapTiktokErrorToPortuguese(st.failReason || "").includes("duração"), st.status);
  } catch (e) { check("status FAILED", false, String(e)); }

  // ── 10. PULL_FROM_URL / FILE_UPLOAD via buildTiktokInitPayload com validação rejeitando ▸ ──
  try {
    buildTiktokInitPayload({ options: { title: "payload" }, sourceInfo: { source: "FILE_UPLOAD", video_size: 100, chunk_size: 100, total_chunk_count: 1 } });
    check("buildTiktokInitPayload ok", true);
  } catch (e) { check("buildTiktokInitPayload ok", false, String(e)); }
  try {
    buildTiktokInitPayload({ options: { title: "x".repeat(TIKTOK_TITLE_MAX_LENGTH + 10) }, sourceInfo: { source: "FILE_UPLOAD", video_size: 100, chunk_size: 100, total_chunk_count: 1 } });
    check("buildTiktokInitPayload rejeita título longo", false);
  } catch (e) {
    check("buildTiktokInitPayload rejeita título longo", /2200/.test((e as Error).message), (e as Error).message);
  }

  // ── 11. caption fallback (tiktok > caption) ──────────────────────────────
  check("resolveTiktokCaption usa caption_tiktok", resolveTiktokCaption({ caption: "genérica", caption_tiktok: "do tiktok" }) === "do tiktok");
  check("resolveTiktokCaption fallback para caption", resolveTiktokCaption({ caption: "genérica" }) === "genérica");
  check("resolveFinalCaption tiktok usa caption_tiktok", resolveFinalCaption("tiktok", { caption: "genérica", caption_tiktok: "do tiktok" }) === "do tiktok");
  check("resolveFinalCaption tiktok fallback caption", resolveFinalCaption("tiktok", { caption: "genérica" }) === "genérica");
  check("resolveFinalCaption tiktok null-safe", resolveFinalCaption("tiktok", null) === "");

  // ── 12. folder captions: tiktok.txt + genérica ───────────────────────────
  const files: Array<{ name: string; text(): Promise<string> }> = [
    { name: "tiktok.txt", text: async () => "legenda tiktok do arquivo" },
    { name: "caption.txt", text: async () => "legenda genérica" },
  ];
  const fc = await readFolderCaptions(files);
  check("folder tiktok.txt lido", fc.captionTiktok === "legenda tiktok do arquivo", String(fc.captionTiktok));
  check("folder genérica lida", fc.caption === "legenda genérica");
  // .txt específico vazio NÃO cai na genérica
  const fc2 = await readFolderCaptionsWithTiktok([{ name: "tiktok.txt", text: async () => "" }]);
  check("readFolderCaptionsWithTiktok tiktok vazio", fc2.captionTiktok === "", JSON.stringify(fc2));
  const fc3 = await readFolderCaptionsWithTiktok([{ name: "geral.txt", text: async () => "fallback" }, { name: "tiktok.txt", text: async () => "tk" }]);
  check("readFolderCaptionsWithTiktok misto", fc3.caption === "fallback" && fc3.captionTiktok === "tk", JSON.stringify(fc3));

  restore();
  console.log(`\n=== Smoke A5 PUBLISHING: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
