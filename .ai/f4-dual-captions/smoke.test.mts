// F4-P1 smoke test — dual captions YouTube/Instagram end-to-end (M9).
//
// Cobertura:
//   T1-T2  readFolderCaptions (parse da pasta: youtube.txt/instagram.txt/
//          .txt genérico, case-insensitive)
//   T3-T4  content-items POST round-trip (whitelist + sanitizeCaption:
//          trim/escape/2200; campo desconhecido descartado)
//   T5     upload-chunk/complete round-trip (formData captionYoutube/
//          captionInstagram → ContentItem captions por plataforma, sanitizadas)
//   T6     resolveFinalCaption — régua única (youtube/instagram/fallback)
//   T7-T8  buildPostData — short YT resolve youtube.txt; IG resolve
//          instagram.txt
//   T9     .txt único (caption genérica) → fallback em AMBAS plataformas
//   T10-T11 propagate — caption por plataforma do canal do POST
//   T12    preview parity — resolvePlannerRuntime com canal YT resolve
//          youtube.txt
//
// Roda com: node --import ./.ai/f4-dual-captions/alias-hook.mjs \
//           .ai/f4-dual-captions/smoke.test.mts
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readFolderCaptions } from "../../lib/folder-captions.ts";
import {
  resolveFinalCaption,
  buildPostData,
  propagatePlannerConfigToPendingPosts,
  resolvePlannerRuntime,
} from "../../lib/planner-runtime.ts";
import { POST as contentItemsPOST } from "../../app/api/content-items/route.ts";
import { POST as completePOST } from "../../app/api/upload-chunk/complete/route.ts";

type AnyRec = Record<string, unknown>;

const tryIt = async (label: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
  } catch (e) {
    console.error(`  ❌ ${label}`);
    console.error(e);
    process.exitCode = 1;
  }
};

const capFile = (name: string, content: string) => ({
  name,
  text: async () => content,
});

// ── T1: pasta com youtube.txt + instagram.txt + .txt genérico ──────────
await tryIt("T1 readFolderCaptions → 3 captions (case-insensitive)", async () => {
  const captions = await readFolderCaptions([
    capFile("youtube.txt", "Legenda YouTube"),
    capFile("INSTAGRAM.TXT", "Legenda Instagram"),
    capFile("meu-caption.txt", "Legenda genérica"),
    capFile("video1.mp4", ""), // mídia ignorada (não .txt)
  ]);
  assert.strictEqual(captions.captionYoutube, "Legenda YouTube");
  assert.strictEqual(captions.captionInstagram, "Legenda Instagram");
  assert.strictEqual(captions.caption, "Legenda genérica");
});

// ── T2: só youtube.txt → caption genérica fica null (fallback acontece no runtime) ──
await tryIt("T2 só youtube.txt (maiúsculo) → só captionYoutube", async () => {
  const captions = await readFolderCaptions([
    capFile("YouTube.TXT", "YT only"),
    capFile("foto.jpg", ""),
  ]);
  assert.strictEqual(captions.captionYoutube, "YT only");
  assert.strictEqual(captions.captionInstagram, null);
  assert.strictEqual(captions.caption, null);
});

// ── T3: content-items POST round-trip + sanitize + whitelist ────────────
await tryIt("T3 content-items POST → round-trip preserva 3 captions sanitizadas", async () => {
  const createdPayloads: AnyRec[] = [];
  globalThis.__PRISMA__ = {
    contentItem: {
      findFirst: async () => null,
      create: async (args: AnyRec) => {
        createdPayloads.push(args.data as AnyRec);
        return args.data as AnyRec;
      },
    },
  };
  const res = await contentItemsPOST(
    new Request("http://localhost/api/content-items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "pasta-F4",
        type: "folder",
        caption: "  cap genérica  ",
        caption_youtube: " yt <b>  ",
        caption_instagram: "  ig ",
        evil_mass_assignment: "dropped",
      }),
    }),
  );
  assert.strictEqual(res.status, 200);
  const saved = createdPayloads[0] as AnyRec;
  assert.strictEqual(saved.caption, "cap genérica", "trim aplicado em caption");
  assert.strictEqual(saved.caption_youtube, "yt &lt;b&gt;", "trim + escape em caption_youtube");
  assert.strictEqual(saved.caption_instagram, "ig", "trim em caption_instagram");
  assert.strictEqual(saved.user_id, "u1");
  assert.strictEqual(saved.evil_mass_assignment, undefined, "whitelist rejeita campo desconhecido");
});

// ── T4: limite 2200 (CAPTION_MAX) nas captions por plataforma ──────────
await tryIt("T4 content-items POST → caption_youtube truncada em 2200", async () => {
  const createdPayloads: AnyRec[] = [];
  globalThis.__PRISMA__ = {
    contentItem: {
      findFirst: async () => null,
      create: async (args: AnyRec) => {
        createdPayloads.push(args.data as AnyRec);
        return args.data as AnyRec;
      },
    },
  };
  const long = "a".repeat(3000);
  const res = await contentItemsPOST(
    new Request("http://localhost/api/content-items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "longcap",
        type: "folder",
        caption_youtube: long,
        caption_instagram: "b".repeat(200),
      }),
    }),
  );
  assert.strictEqual(res.status, 200);
  assert.strictEqual((createdPayloads[0] as AnyRec).caption_youtube, "a".repeat(2200));
  assert.strictEqual((createdPayloads[0] as AnyRec).caption_instagram, "b".repeat(200));
});

// ── T5: upload-chunk/complete round-trip (itens únicos via formData) ────
await tryIt("T5 upload-chunk/complete → captionYoutube/captionInstagram salvos", async () => {
  const uploadsDir = await mkdtemp(path.join(tmpdir(), "f4-uploads-"));
  try {
    globalThis.__UPLOADS_DIR__ = uploadsDir;
    const partData = Buffer.from("F4DUALCAPTIONPARTDATA");
    const targetPath = "e2e/video.mp4.f4t1";
    await mkdir(path.join(uploadsDir, "u1", "e2e"), { recursive: true });
    await writeFile(
      path.join(uploadsDir, "u1", "e2e", "video.mp4.f4t1.part.0"),
      partData,
    );

    const createdPayloads: AnyRec[] = [];
    globalThis.__PRISMA__ = {
      contentItem: {
        findFirst: async () => null, // parent + existingItem: ausentes
        aggregate: async () => ({ _sum: { size: 0 } }),
        create: async (args: AnyRec) => {
          createdPayloads.push(args.data as AnyRec);
          return args.data as AnyRec;
        },
      },
    };

    const fd = new FormData();
    fd.append("filename", "video.mp4");
    fd.append("size", String(partData.length));
    fd.append("path", targetPath);
    fd.append("folderPath", "admin");
    fd.append("totalChunks", "1");
    fd.append("type", "video");
    fd.append("caption", " Cap genérica ");
    fd.append("captionYoutube", "  YT <em>  ");
    fd.append("captionInstagram", " IG ");

    const res = await completePOST(
      new Request("http://localhost/api/upload-chunk/complete", {
        method: "POST",
        body: fd,
      }),
    );
    const body = (await res.json()) as AnyRec;
    assert.strictEqual(res.status, 200, String(body.error || res.status));
    const item = body.item as AnyRec;
    assert.strictEqual(item.caption, "Cap genérica", "caption genérica sanitizada");
    assert.strictEqual(item.caption_youtube, "YT &lt;em&gt;", "captionYoutube sanitizada e salva");
    assert.strictEqual(item.caption_instagram, "IG", "captionInstagram sanitizada e salva");
  } finally {
    await rm(uploadsDir, { recursive: true, force: true });
  }
});

// ── T6: resolveFinalCaption — régua única por plataforma ────────────────
await tryIt("T6 resolveFinalCaption = régua única (yt/ig/fallback)", () => {
  const item = {
    caption: "genérica",
    caption_youtube: "YT cap",
    caption_instagram: "IG cap",
  };
  assert.strictEqual(resolveFinalCaption("youtube", item), "YT cap");
  assert.strictEqual(resolveFinalCaption("YouTube", item), "YT cap", "case-insensitive");
  assert.strictEqual(resolveFinalCaption("instagram", item), "IG cap");
  assert.strictEqual(resolveFinalCaption("instagram", { caption: "genérica" }), "genérica", "fallback IG");
  assert.strictEqual(resolveFinalCaption("youtube", { caption: "genérica" }), "genérica", "fallback YT");
  assert.strictEqual(resolveFinalCaption(null, item), "genérica", "sem plataforma → genérica");
  assert.strictEqual(resolveFinalCaption("mixed", item), "genérica", "mixed (grandfathered) → genérica");
  assert.strictEqual(resolveFinalCaption("youtube", null), "");
});

// Values distintos por plataforma — detecta vazamento cruzado (mix bloqueado)
const DUAL_LIB_ITEM: AnyRec = {
  id: "lib1",
  url: "https://cdn/meu-video.mp4",
  type: "video",
  name: "meu-video.mp4",
  title: "",
  tags: "[]",
  caption: "Legenda genérica (fallback)",
  caption_youtube: "Legenda YouTube (youtube.txt)",
  caption_instagram: "Legenda Instagram (instagram.txt)",
};

function makePlannerPrisma(libItem: AnyRec, posts: AnyRec[] = [], channels: AnyRec[] = []) {
  const updates: Array<{ id: string; data: AnyRec }> = [];
  const prisma: AnyRec = {
    _updates: updates,
    contentItem: {
      findFirst: async () => libItem,
      findMany: async () => [],
    },
    post: {
      findMany: async () => posts,
      update: async (args: AnyRec) => {
        updates.push({
          id: String((args.where as AnyRec).id),
          data: args.data as AnyRec,
        });
        return { id: (args.where as AnyRec).id };
      },
    },
    plannerLog: { create: async () => ({}) },
    channel: {
      findMany: async () => channels,
      findUnique: async () => null,
    },
    planner: { updateMany: async () => ({ count: 1 }) },
  };
  return prisma;
}

const runtimeFor = (entryCaption: string) =>
  ({
    ok: true,
    mediaType: "REELS",
    mediaUrl: "https://cdn/meu-video.mp4",
    children: [],
    thumbnailUrl: null,
    shareToFeed: null,
    locationId: null,
    collaborators: null,
    userTags: null,
    audioConfiguration: null,
    selectedContent: {
      id: "lib1",
      media_type: "REELS",
      caption: entryCaption,
      caption_fallback: "",
      title_fallback: "",
    },
  }) as never;

const baseConfig: AnyRec = {
  frequency: { value: 60, unit: "minutes" },
  sort_order: "old_to_new",
  timezone: "America/Sao_Paulo",
  content: [{ id: "lib1", media_type: "REELS", caption: "{post_caption}" }],
  caption: "",
  caption_templates: [],
  caption_rotation: "off",
};

// ── T7: short YT resolve youtube.txt (buildPostData) ────────────────────
await tryIt("T7 buildPostData YT short → caption = youtube.txt", async () => {
  const prisma = makePlannerPrisma(DUAL_LIB_ITEM);
  const post = await buildPostData({
    prisma: prisma as never,
    planner: { user_id: "u1", id: "pl1" },
    channel: { id: "ch1", name: "Canal YT", platform: "youtube" },
    runtime: runtimeFor("{post_caption}"),
    config: baseConfig as never,
    now: new Date("2026-09-01T12:00:00Z"),
    templateIndex: 0,
    postOrdinal: 0,
  });
  const p = post as AnyRec;
  assert.strictEqual(p.caption, "Legenda YouTube (youtube.txt)", "{post_caption} resolve a caption YT");
  assert.strictEqual(p.youtube_type, "short");
  const yt = JSON.parse(p.youtube_options as string) as AnyRec;
  assert.strictEqual(yt.description, "Legenda YouTube (youtube.txt)", "description espelha a caption da plataforma");
  assert.ok(String(yt.title).startsWith("Legenda YouTube"), "cadeia de título usa a caption YT");
});

// ── T8: canal IG resolve instagram.txt ──────────────────────────────────
await tryIt("T8 buildPostData IG → caption = instagram.txt (e NÃO youtube.txt)", async () => {
  const prisma = makePlannerPrisma(DUAL_LIB_ITEM);
  const post = await buildPostData({
    prisma: prisma as never,
    planner: { user_id: "u1", id: "pl1" },
    channel: { id: "ig1", name: "Conta IG", platform: "instagram" },
    runtime: runtimeFor("{post_caption}"),
    config: baseConfig as never,
    now: new Date("2026-09-01T12:00:00Z"),
    templateIndex: 0,
    postOrdinal: 0,
  });
  const p = post as AnyRec;
  assert.strictEqual(p.caption, "Legenda Instagram (instagram.txt)", "{post_caption} resolve a caption IG");
  assert.strictEqual(p.youtube_type, null, "IG não é youtube_type");
  assert.strictEqual(p.youtube_options, null, "cruzamento com playlists YT bloqueado");
});

// ── T9: .txt único → fallback em AMBAS plataformas ──────────────────────
await tryIt("T9 item só com caption genérica → fallback YT e IG", async () => {
  const genericOnly: AnyRec = {
    id: "lib1",
    url: "https://cdn/meu-video.mp4",
    type: "video",
    name: "meu-video.mp4",
    title: "",
    tags: "[]",
    caption: "Legenda única (caption.txt)",
    caption_youtube: null,
    caption_instagram: null,
  };
  for (const platform of ["youtube", "instagram"]) {
    const prisma = makePlannerPrisma(genericOnly);
    const post = await buildPostData({
      prisma: prisma as never,
      planner: { user_id: "u1", id: "pl1" },
      channel: { id: "ch1", name: "Canal", platform },
      runtime: runtimeFor("{post_caption}"),
      config: baseConfig as never,
      now: new Date("2026-09-01T12:00:00Z"),
      templateIndex: 0,
      postOrdinal: 0,
    });
    assert.strictEqual(
      (post as AnyRec).caption,
      "Legenda única (caption.txt)",
      `fallback p/ ${platform}`,
    );
  }
});

// ── T10: propagação — post YT pending recebe caption_youtube ────────────
await tryIt("T10 propagate YT short → caption = youtube.txt (platform do POST)", async () => {
  const pending = [
    {
      id: "p1",
      channel_id: "ch1",
      planner_id: "pl1",
      status: "pending",
      youtube_type: "short",
      youtube_options: null,
      caption: "antiga",
      video_url: "https://cdn/meu-video.mp4",
      scheduled_at: "2026-09-01T00:00:00Z",
      created_at: "2026-09-01T00:00:00Z",
    },
  ];
  const prisma = makePlannerPrisma(DUAL_LIB_ITEM, pending, [
    { id: "ch1", name: "Canal YT", platform: "youtube" },
  ]);
  const res = await propagatePlannerConfigToPendingPosts(
    prisma as never,
    { id: "pl1", user_id: "u1" },
    { ...baseConfig, content: [{ id: "lib1", caption: "{post_caption}" }] } as never,
    new Date("2026-09-02T12:00:00Z"),
  );
  assert.strictEqual(res.updated, 1);
  const upd = prisma._updates.find((u: AnyRec) => u.id === "p1");
  assert.ok(upd, "update feito");
  assert.strictEqual(
    (upd.data as AnyRec).caption,
    "Legenda YouTube (youtube.txt)",
    "propagação usa a caption da plataforma do canal do post",
  );
});

// ── T11: propagação — post IG pending recebe caption_instagram ──────────
await tryIt("T11 propagate IG pending → caption = instagram.txt", async () => {
  const pending = [
    {
      id: "p8",
      channel_id: "ig1",
      planner_id: "pl1",
      status: "pending",
      youtube_type: null,
      youtube_options: null,
      caption: "antiga",
      image_url: "https://cdn/img.jpg",
      scheduled_at: "2026-09-01T00:00:00Z",
      created_at: "2026-09-01T00:00:00Z",
    },
  ];
  const prisma = makePlannerPrisma(DUAL_LIB_ITEM, pending, [
    { id: "ig1", name: "Conta IG", platform: "instagram" },
  ]);
  const res = await propagatePlannerConfigToPendingPosts(
    prisma as never,
    { id: "pl1", user_id: "u1" },
    { ...baseConfig, content: [{ id: "lib1", caption: "{post_caption}" }] } as never,
    new Date("2026-09-02T12:00:00Z"),
  );
  assert.strictEqual(res.updated, 1);
  const upd = prisma._updates.find((u: AnyRec) => u.id === "p8");
  assert.ok(upd, "update feito");
  assert.strictEqual(
    (upd.data as AnyRec).caption,
    "Legenda Instagram (instagram.txt)",
    "propagação IG usa instagram.txt",
  );
  assert.strictEqual((upd.data as AnyRec).youtube_options, undefined, "IG não mexe em youtube_options");
});

// ── T12: preview parity — resolvePlannerRuntime com canal YT ────────────
await tryIt("T12 resolvePlannerRuntime (preview) canal YT → caption = youtube.txt", async () => {
  const prisma = makePlannerPrisma(DUAL_LIB_ITEM, [], [
    { id: "ch1", name: "Canal YT", platform: "youtube" },
  ]);
  const planner = {
    id: "pl1",
    user_id: "u1",
    name: "Planner YT",
    status: "active",
    last_run: null,
    config: JSON.stringify({
      frequency: { value: 60, unit: "minutes" },
      sort_order: "old_to_new",
      timezone: "America/Sao_Paulo",
      content: [{ id: "lib1", media_type: "REELS", caption: "{post_caption}" }],
      caption: "",
      caption_templates: [],
      caption_rotation: "off",
    }),
    state: null,
    channels: [{ id: "ch1", name: "Canal YT", platform: "youtube" }],
  } as never;
  const runtime = await resolvePlannerRuntime(prisma as never, planner, new Date("2026-09-01T12:00:00Z"));
  assert.strictEqual(
    (runtime as AnyRec).caption,
    "Legenda YouTube (youtube.txt)",
    "preview/runtime resolve a caption da plataforma do canal",
  );
});

if (process.exitCode) {
  console.error("\n❌ FALHOU — veja erros acima");
} else {
  console.log("\n✅ Todos os 12 testes de dual captions passaram");
}