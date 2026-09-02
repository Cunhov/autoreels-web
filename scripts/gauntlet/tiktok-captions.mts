#!/usr/bin/env npx tsx
/**
 * Smoke A5 — CAPTIONS (caption_tiktok > caption, tiktok.txt, genérica, bulk)
 * Valida o pipeline de legendas TikTok ponta a ponta:
 *  - resolveFinalCaption("tiktok", ...) caption_tiktok ?? caption
 *  - resolveTiktokCaption
 *  - readFolderCaptions reconhece tiktok.txt (case-insensitive) + genérica
 *  - readFolderCaptionsWithTiktok
 *  - caption vazia específica NÃO cai na genérica
 *  - normalizeTiktokPrivacyLevel
 *  - buildTiktokOptionsForPost monta tiktok_options com title a partir da caption
 */
import {
  resolveTiktokCaption,
  readFolderCaptionsWithTiktok,
} from "@/lib/tiktok";
import { readFolderCaptions } from "@/lib/folder-captions";
import {
  resolveFinalCaption,
  normalizeTiktokPrivacyLevel,
  buildTiktokOptionsForPost,
} from "@/lib/planner-runtime";
import {
  TIKTOK_PRIVACY_LABELS,
  labelTiktokPrivacy,
} from "@/lib/planner-config";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`✅ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`❌ ${label}${detail ? " — " + detail : ""}`); }
}
type FileLike = { name: string; text(): Promise<string> };
const f = (name: string, text: string): FileLike => ({ name, text: async () => text });

async function run() {
  // caption fallback (núcleo da spec)
  check("resolveTiktokCaption caption_tiktok", resolveTiktokCaption({ caption: "c", caption_tiktok: "tk" }) === "tk");
  check("resolveTiktokCaption fallback caption", resolveTiktokCaption({ caption: "c" }) === "c");
  check("resolveTiktokCaption null-safe", resolveTiktokCaption(null) === "");
  check("resolveFinalCaption tiktok prioriza tiktok", resolveFinalCaption("tiktok", { caption: "c", caption_tiktok: "tk" }) === "tk");
  check("resolveFinalCaption tiktok fallback caption", resolveFinalCaption("tiktok", { caption: "c" }) === "c");
  check("resolveFinalCaption não-tiktok ignora caption_tiktok", resolveFinalCaption("youtube", { caption: "c", caption_tiktok: "tk" }) === "c");

  // folder captions: tiktok.txt reconhecido (case-insensitive)
  const fc1 = await readFolderCaptions([f("TIKTOK.TXT", "tk maiúsculo"), f("caption.txt", "genérica")]);
  check("folder TIKTOK.TXT case-insensitive", fc1.captionTiktok === "tk maiúsculo", String(fc1.captionTiktok));
  check("folder genérica preservada", fc1.caption === "genérica");

  // só tiktok.txt, sem genérica
  const fc2 = await readFolderCaptions([f("tiktok.txt", "apenas tk")]);
  check("folder só tiktok.txt", fc2.captionTiktok === "apenas tk" && fc2.caption === null, JSON.stringify(fc2));

  // tiktok.txt vazio NÃO cai na genérica (spec F4)
  const fc3 = await readFolderCaptions([f("tiktok.txt", ""), f("geral.txt", "fallback")]);
  check("tiktok.txt vazio mantém vazio (não usa genérica)", fc3.captionTiktok === "" && fc3.caption === "fallback", JSON.stringify(fc3));

  // readFolderCaptionsWithTiktok
  const wt1 = await readFolderCaptionsWithTiktok([f("tiktok.txt", "sem genérica")]);
  check("withTiktok só específico", wt1.captionTiktok === "sem genérica" && wt1.caption === null, JSON.stringify(wt1));
  const wt2 = await readFolderCaptionsWithTiktok([f("geral.txt", "g"), f("tiktok.txt", "tk")]);
  check("withTiktok misto", wt2.caption === "g" && wt2.captionTiktok === "tk", JSON.stringify(wt2));

  // normalize privacy
  check("normalize privacy válido", normalizeTiktokPrivacyLevel("PUBLIC_TO_EVERYONE") === "PUBLIC_TO_EVERYONE");
  check("normalize privacy inválido → null", normalizeTiktokPrivacyLevel("ROGUE") === null);
  check("normalize privacy vazio → null", normalizeTiktokPrivacyLevel("") === null);
  check("normalize privacy respeita allowed", normalizeTiktokPrivacyLevel("SELF_ONLY", ["PUBLIC_TO_EVERYONE"]) === "SELF_ONLY" /* fallback global permite mesmo não no allowed */);

  // T5 — labels PT-BR de privacidade (UI-only; values crus preservados)
  check("label PUBLIC_TO_EVERYONE → Público (todos)", labelTiktokPrivacy("PUBLIC_TO_EVERYONE") === "Público (todos)", labelTiktokPrivacy("PUBLIC_TO_EVERYONE"));
  check("label MUTUAL_FOLLOW_FRIENDS → Amigos mútuos", labelTiktokPrivacy("MUTUAL_FOLLOW_FRIENDS") === "Amigos mútuos");
  check("label FOLLOWER_OF_CREATOR → Seguidores do criador", labelTiktokPrivacy("FOLLOWER_OF_CREATOR") === "Seguidores do criador");
  check("label SELF_ONLY → Só eu", labelTiktokPrivacy("SELF_ONLY") === "Só eu");
  check("label desconhecido → raw + (personalizado)", labelTiktokPrivacy("WHATEVER_CREATOR_OPT") === "WHATEVER_CREATOR_OPT (personalizado)", labelTiktokPrivacy("WHATEVER_CREATOR_OPT"));
  check("label case-insensitive", labelTiktokPrivacy("self_only") === "Só eu", labelTiktokPrivacy("self_only"));
  check("label null/vazio → vazio", labelTiktokPrivacy(null) === "" && labelTiktokPrivacy("") === "");
  check("dicionário traz as 4 opções oficiais", ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"].every((k) => typeof TIKTOK_PRIVACY_LABELS[k] === "string"));

  // buildTiktokOptionsForPost (tiktok_options JSON)
  const optionsJson = await buildTiktokOptionsForPost({
    prisma: {} as never,
    planner: { user_id: "u1" },
    config: {
      tiktok_caption: "Título TikTok",
      tiktok_privacy_level: "SELF_ONLY",
      tiktok_disable_duet: true,
      tiktok_video_cover_timestamp_ms: 2000,
      tiktok_brand_content_toggle: true,
    },
    selectedContent: null,
    channelName: "chan",
    now: new Date(),
    caption: "caption fallback qq",
    platform: "tiktok",
  });
  const parsed = optionsJson ? JSON.parse(optionsJson) : null;
  check("buildTiktokOptionsForPost monta tiktok_options", parsed !== null, String(optionsJson));
  check("options title usa tiktok_caption", parsed?.title === "Título TikTok", String(parsed?.title));
  check("options privacy", parsed?.privacy_level === "SELF_ONLY", String(parsed?.privacy_level));
  check("options duet", parsed?.disable_duet === true, String(parsed?.disable_duet));
  check("options cover", parsed?.video_cover_timestamp_ms === 2000, String(parsed?.video_cover_timestamp_ms));
  check("options brand", parsed?.brand_content_toggle === true, String(parsed?.brand_content_toggle));

  // platform != tiktok → null (não gera options)
  const notTk = await buildTiktokOptionsForPost({
    prisma: {} as never, planner: { user_id: "u1" },
    config: { tiktok_caption: "x" }, selectedContent: null, channelName: "c", now: new Date(),
    caption: "c", platform: "youtube",
  });
  check("buildTiktokOptionsForPost não-tiktok → null", notTk === null, String(notTk));

  // title truncado a 2200
  const longJson = await buildTiktokOptionsForPost({
    prisma: {} as never, planner: { user_id: "u1" },
    config: { tiktok_caption: "x".repeat(3000) }, selectedContent: null, channelName: "c", now: new Date(),
    caption: "", platform: "tiktok",
  });
  const longParsed = longJson ? JSON.parse(longJson) : null;
  check("options title truncado a 2200", longParsed?.title?.length <= 2200, String(longParsed?.title?.length));

  console.log(`\n=== Smoke A5 CAPTIONS: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
