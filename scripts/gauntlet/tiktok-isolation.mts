#!/usr/bin/env npx tsx
/**
 * Smoke A5 — ISOLATION (planner TikTok vs YT/IG)
 * Valida que não há mistura de canais de plataformas no planner TikTok:
 *  - mix TikTok+YT bloqueado
 *  - mix TikTok+IG bloqueado
 *  - triple bloqueado
 *  - canal únicpo TikTok liberado
 *  - canal único YT / IG liberado
 *  - detectChannelPlatform por settings (tiktok_open_id / sessionId) e platform
 *  - mensagem de erro PT-BR
 *  - validateTiktokMediaType (T1 foto: IMAGE liberado; carousel/stories bloqueado)
 */
import {
  isTiktokMixBlocked,
  getTiktokMixErrorMessage,
  detectChannelPlatform,
} from "@/lib/tiktok";
import { validateTiktokMediaType } from "@/lib/planner-runtime";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`✅ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`❌ ${label}${detail ? " — " + detail : ""}`); }
}

const tk = (settings?: string) => ({ platform: "tiktok", settings: settings ?? JSON.stringify({ tiktok_open_id: "oid123", tiktok_access_token: "tok" }) });
const yt = () => ({ platform: "youtube", settings: JSON.stringify({ sessionId: "s1" }) });
const ig = () => ({ platform: "instagram", settings: JSON.stringify({ instagram_user_id: "ig1" }) });

async function run() {
  // detectChannelPlatform por settings
  check("detect platform por settings (tiktok)", detectChannelPlatform({ platform: null, settings: JSON.stringify({ tiktok_open_id: "x" }) }) === "tiktok");
  check("detect platform por settings (youtube sessionId)", detectChannelPlatform({ platform: null, settings: JSON.stringify({ sessionId: "x" }) }) === "youtube");
  check("detect platform por campo platform", detectChannelPlatform({ platform: "tiktok", settings: null }) === "tiktok");

  // canal único → liberado
  check("canal único tiktok OK", isTiktokMixBlocked([tk()]) === false);

  // mix bloqueado
  check("mix TikTok+YT bloqueado", isTiktokMixBlocked([tk(), yt()]) === true);
  check("mix TikTok+IG bloqueado", isTiktokMixBlocked([tk(), ig()]) === true);
  check("mix triple bloqueado", isTiktokMixBlocked([tk(), yt(), ig()]) === true);
  check("mix YT+IG (sem tiktok) bloqueado", isTiktokMixBlocked([yt(), ig()]) === true);
  check("lista vazia/única OK", isTiktokMixBlocked([]) === false && isTiktokMixBlocked([yt()]) === false && isTiktokMixBlocked([ig()]) === false);

  // mensagem PT-BR
  const msg = getTiktokMixErrorMessage();
  check("mensagem mix PT-BR", /Planners TikTok não podem misturar canais de outras plataformas/.test(msg), msg);

  // detect por settings com cripto de false positive (ambos presentes → tiktok ganha)
  const both = detectChannelPlatform({ platform: null, settings: JSON.stringify({ tiktok_open_id: "a", sessionId: "b" }) });
  check("detect com ambos prioriza tiktok", both === "tiktok", String(both));

  // validateTiktokMediaType (T1 foto: IMAGE liberado via content/init; carousel/stories bloqueado)
  check("media REELS ok", validateTiktokMediaType("REELS").ok === true);
  check("media VIDEO ok", validateTiktokMediaType("VIDEO").ok === true);
  check("media IMAGE ok (T1 foto)", validateTiktokMediaType("IMAGE").ok === true, validateTiktokMediaType("IMAGE").error || "");
  check("media CAROUSEL bloqueado (T3)", validateTiktokMediaType("CAROUSEL").ok === false && /carrossel/.test(validateTiktokMediaType("CAROUSEL").error || ""), validateTiktokMediaType("CAROUSEL").error || "");
  check("media STORIES bloqueado", validateTiktokMediaType("STORIES").ok === false && /Stories/.test(validateTiktokMediaType("STORIES").error || ""));

  console.log(`\n=== Smoke A5 ISOLATION: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
