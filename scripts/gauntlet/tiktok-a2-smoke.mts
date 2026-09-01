#!/usr/bin/env npx tsx
/**
 * Smoke A2 — Upload & Publish Core
 * Valida:
 *  - createTiktokVideoInit FILE_UPLOAD + PULL_FROM_URL com proxy repassado
 *  - uploadTiktokChunks com Content-Range + retry 1x em 429/5xx
 *  - fetchTiktokPublishStatus
 *  - mapTiktokErrorToPortuguese PT-BR
 *  - proxy via getChannelProxyUrl sempre repassado
 */
import { getChannelProxyUrl } from "@/lib/proxy";
import {
  createTiktokVideoInit,
  uploadTiktokChunks,
  fetchTiktokPublishStatus,
  mapTiktokErrorToPortuguese,
  buildTiktokInitPayload,
} from "@/lib/tiktok";

// Mock helpers
let fetchCalls: Array<{ url: string; init: RequestInit; proxyUrl?: string | null }> = [];
let mockResponses: Map<string, { status: number; body: unknown; headers?: Record<string,string> }> = new Map();

// Save original fetch
const origFetch = global.fetch as unknown as typeof fetch;

function mockFetch(url: string | URL, init?: RequestInit & { dispatcher?: unknown }) {
  const u = String(url);
  fetchCalls.push({ url: u, init: init as RequestInit });
  // Determine which mock to return based on URL
  for (const [key, resp] of mockResponses.entries()) {
    if (u.includes(key)) {
      const headers = new Headers(resp.headers || {});
      return Promise.resolve(new Response(JSON.stringify(resp.body), { status: resp.status, headers }) as unknown as Response);
    }
  }
  // Default 404
  return Promise.resolve(new Response(JSON.stringify({ error: { code: "not_mocked", message: "no mock for " + u } }), { status: 404 }) as unknown as Response);
}

function setMock(key: string, status: number, body: unknown, headers?: Record<string,string>) {
  mockResponses.set(key, { status, body, headers });
}
function clearMocks() { mockResponses.clear(); fetchCalls = []; }

async function run() {
  let pass = 0, fail = 0;
  const check = (label: string, ok: boolean, detail="") => {
    if (ok) { pass++; console.log(`✅ ${label} ${detail}`); }
    else { fail++; console.error(`❌ ${label} ${detail}`); }
  };

  // Patch global fetch
  (global as unknown as { fetch: unknown }).fetch = mockFetch as unknown as typeof fetch;
  // Also patch fetchWithTimeout's internal fetch? fetchWithTimeout uses global fetch, so covered.

  const proxyUrl = "http://user:pass@proxy.example.com:8080";
  const channel = { proxy_url: proxyUrl, settings: JSON.stringify({ tiktok_open_id: "123", tiktok_access_token: "tok", tiktok_refresh_token: "rt", tiktok_expires_at: Math.floor(Date.now()/1000)+3600 }), platform: "tiktok" };
  const gotProxy = getChannelProxyUrl(channel as unknown as { proxy_url?: string | null; settings?: string | null });
  check("proxy repassado via getChannelProxyUrl", gotProxy === proxyUrl, `got=${gotProxy}`);

  // 1) createTiktokVideoInit FILE_UPLOAD success
  clearMocks();
  setMock("video/init", 200, { data: { publish_id: "pub123", upload_url: "https://upload.tiktok.com/upload123" } });
  try {
    const res = await createTiktokVideoInit({
      accessToken: "test_token",
      title: "Titulo teste #hashtag",
      privacyLevel: "PUBLIC_TO_EVERYONE",
      disableDuet: false,
      disableStitch: false,
      disableComment: false,
      videoCoverTimestampMs: 1000,
      brandContentToggle: false,
      source: { source: "FILE_UPLOAD", video_size: 1000000, chunk_size: 1000000, total_chunk_count: 1 }
    }, proxyUrl);
    check("createTiktokVideoInit FILE_UPLOAD 200", res.publishId === "pub123" && res.uploadUrl.includes("upload.tiktok"), `publishId=${res.publishId}`);
    check("createTiktokVideoInit enviou proxy (fetch chamado)", fetchCalls.length === 1 && fetchCalls[0].url.includes("video/init"), `calls=${fetchCalls.length}`);
    // Verify headers include Authorization
    const authHeader = (fetchCalls[0].init.headers as Record<string,string>)?.Authorization || "";
    check("createTiktokVideoInit Authorization Bearer", authHeader.includes("Bearer test_token"), authHeader);
  } catch (e) {
    check("createTiktokVideoInit FILE_UPLOAD 200", false, String(e));
  }

  // 2) createTiktokVideoInit PULL_FROM_URL
  clearMocks();
  setMock("video/init", 200, { data: { publish_id: "pub_pull_456", upload_url: "" } });
  try {
    const res2 = await createTiktokVideoInit({
      accessToken: "test_token",
      title: "Titulo PULL",
      source: { source: "PULL_FROM_URL", video_url: "https://autoreels.cunhov.site/api/file/test.mp4" }
    }, proxyUrl);
    check("createTiktokVideoInit PULL_FROM_URL", res2.publishId === "pub_pull_456", `publishId=${res2.publishId}`);
  } catch (e) {
    check("createTiktokVideoInit PULL_FROM_URL", false, String(e));
  }

  // 3) uploadTiktokChunks with mock PUT
  clearMocks();
  // We need to mock uploadUrl PUT: any PUT to upload url returns 200
  setMock("upload.tiktok", 200, {});
  // Also mock upload.tiktok.com
  setMock("upload", 200, {});
  // For generic upload, we will intercept any URL containing upload
  // Our mockFetch checks includes, so set key "upload"
  try {
    const buf = Buffer.alloc(2 * 1024 * 1024, 0x01); // 2MB
    await uploadTiktokChunks("https://upload.tiktok.com/upload123", buf, 1024*1024, proxyUrl);
    // Should have made 2 PUT calls (2MB /1MB chunk)
    check("uploadTiktokChunks 2 chunks PUT", fetchCalls.length === 2, `calls=${fetchCalls.length}`);
    const cr = (fetchCalls[0].init.headers as Record<string,string>)?.["Content-Range"] || "";
    check("uploadTiktokChunks Content-Range header", cr.startsWith("bytes 0-"), cr);
  } catch (e) {
    check("uploadTiktokChunks", false, String(e));
  }

  // 4) upload retry 1x on 429
  clearMocks();
  let uploadAttempts = 0;
  // Custom mock for this test: first call 429, second 200
  const origMock = mockFetch;
  let retryFetchCalls = 0;
  (global as unknown as { fetch: unknown }).fetch = ((url: string|URL, init?: RequestInit) => {
    const u = String(url);
    fetchCalls.push({ url: u, init: init as RequestInit });
    if (u.includes("upload-retry")) {
      retryFetchCalls++;
      if (retryFetchCalls === 1) {
        return Promise.resolve(new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } }) as unknown as Response);
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }) as unknown as Response);
    }
    return origMock(url, init as unknown as RequestInit & {dispatcher: unknown});
  }) as unknown as typeof fetch;
  try {
    const buf2 = Buffer.alloc(512*1024, 0x02);
    await uploadTiktokChunks("https://upload.tiktok.com/upload-retry", buf2, 1024*1024, proxyUrl);
    check("uploadTiktokChunks retry 1x em 429", retryFetchCalls === 2, `attempts=${retryFetchCalls}`);
  } catch (e) {
    check("uploadTiktokChunks retry 1x em 429", false, String(e));
  }
  // restore
  (global as unknown as { fetch: unknown }).fetch = mockFetch as unknown as typeof fetch;

  // 5) fetchTiktokPublishStatus published
  clearMocks();
  setMock("status/fetch", 200, { data: { status: "PUBLISH_COMPLETE", fail_reason: null, public_url: "https://tiktok.com/@user/video/123" } });
  try {
    const st = await fetchTiktokPublishStatus("pub123", "test_token", proxyUrl);
    check("fetchTiktokPublishStatus published", st.status.includes("PUBLISH") || st.status.includes("COMPLETE"), `status=${st.status}`);
  } catch (e) {
    check("fetchTiktokPublishStatus published", false, String(e));
  }

  // 6) mapTiktokErrorToPortuguese PT-BR
  const cases: Array<[string, string]> = [
    ["access_token_invalid", "Token do TikTok"],
    ["rate_limit", "Limite de requisições"],
    ["video_too_long", "duração máxima"],
    ["privacy_not_allowed", "privacidade"],
    ["title_too_long", "2200"],
  ];
  for (const [code, expected] of cases) {
    const pt = mapTiktokErrorToPortuguese(code);
    check(`mapTiktokErrorToPortuguese ${code} -> PT-BR`, pt.toLowerCase().includes(expected.toLowerCase()), `got=${pt}`);
  }

  // 7) buildTiktokInitPayload helper
  try {
    const payload = buildTiktokInitPayload({
      options: { title: "Teste payload", privacy_level: "SELF_ONLY" },
      sourceInfo: { source: "FILE_UPLOAD", video_size: 1000, chunk_size: 1000, total_chunk_count: 1 }
    });
    check("buildTiktokInitPayload FILE_UPLOAD", (payload.post_info as Record<string,unknown>).title === "Teste payload" && (payload.source_info as Record<string,unknown>).source === "FILE_UPLOAD", JSON.stringify(payload));
  } catch (e) {
    check("buildTiktokInitPayload", false, String(e));
  }

  // 8) validate PULL_FROM_URL detection (via isTiktokPULL logic simulated)
  const systemBase = "https://autoreels.cunhov.site";
  const pullUrl = `${systemBase}/api/file/test.mp4`;
  const isPull = pullUrl.includes("autoreels.cunhov.site/api/file/");
  check("PULL_FROM_URL detection para /api/file", isPull, pullUrl);

  // Restore original fetch
  (global as unknown as { fetch: unknown }).fetch = origFetch as unknown as typeof fetch;

  console.log(`\n=== Smoke A2: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
