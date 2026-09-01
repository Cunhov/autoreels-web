// F4 smoke test — dual captions YouTube/Instagram end-to-end (M9).
//
// Cobre os 4 cenários da spec F4-P1:
//   1. pasta com youtube.txt + instagram.txt → round-trip preserva ambos;
//   2. planner short YT resolve youtube.txt ({post_caption});
//   3. planner IG resolve instagram.txt ({post_caption});
//   4. .txt único → fallback para ambas as plataformas (caption genérica).
// Mais: sanitização das captions (trim/2200/escape) e `??` (vazio explícito
// NÃO cai na genérica).
//
// Roda com: node --import ./.ai/f4-smoke/alias-hook.mjs .ai/f4-smoke/smoke.test.mts
import assert from "node:assert";
import {
  resolveFinalCaption,
  buildPostData,
  propagatePlannerConfigToPendingPosts,
} from "../../lib/planner-runtime.ts";
import { readFolderCaptions, type FolderCaptions } from "../../lib/folder-captions.ts";
import { sanitizeCaption, CAPTION_MAX } from "../../lib/sanitize.ts";

type AnyRec = Record<string, unknown>;

// ── Prisma mock: contentItem.findFirst mapeia por id (rows com caption_*) ──
function makePrisma(opts: {
  posts: AnyRec[];
  itemRows: Record<string, AnyRec>;
  channels: AnyRec[];
}) {
  const updates: Array<{ id: string; data: AnyRec }> = [];
  const prisma: AnyRec = {
    _updates: updates,
    contentItem: {
      findFirst: async (args: AnyRec) => {
        const where = ((args as AnyRec)?.where || {}) as AnyRec;
        const id = String(where.id || "");
        return opts.itemRows[id] || null;
      },
    },
    post: {
      findMany: async () => opts.posts,
      update: async (args: AnyRec) => {
        updates.push({
          id: String((args.where as AnyRec).id),
          data: args.data as AnyRec,
        });
        return { id: (args.where as AnyRec).id };
      },
      updateMany: async (args: AnyRec) => {
        updates.push({
          id: String((args.where as AnyRec).id),
          data: args.data as AnyRec,
        });
        // M13/M14: guard de status — só atualiza post ainda em voo.
        const wanted = opts.posts.find((p) => p.id === (args.where as AnyRec).id);
        const ok =
          wanted &&
          ["pending", "scheduled", "queued"].includes(String(wanted.status));
        return { count: ok ? 1 : 0 };
      },
    },
    plannerLog: { create: async () => ({}) },
    channel: {
      findMany: async () => opts.channels,
      findUnique: async () => null,
    },
  };
  return prisma;
}

// Item de biblioteca com as 3 captions (youtube.txt + instagram.txt + genérica)
const libItemDual = {
  id: "lib1",
  name: "video.mp4",
  title: "",
  caption: "Legenda genérica (caption.txt)",
  caption_youtube: "Texto exclusivo do YouTube (youtube.txt)",
  caption_instagram: "Texto exclusivo do Instagram (instagram.txt)",
  tags: null,
};
// Item que só tem a caption genérica (.txt único → fallback pra ambas)
const libItemGeneric = {
  id: "lib2",
  name: "foto.jpg",
  title: "",
  caption: "Legenda única",
  caption_youtube: null,
  caption_instagram: null,
  tags: null,
};

const baseRuntime = (captions: string, id = "lib1"): AnyRec => ({
  ok: true,
  mediaType: "REELS",
  mediaUrl: `https://cdn/${id}.mp4`,
  children: [],
  thumbnailUrl: null,
  shareToFeed: null,
  locationId: null,
  collaborators: null,
  userTags: null,
  audioConfiguration: null,
  selectedContent: {
    id,
    media_type: "REELS",
    caption: captions, // template digitado (ou texto literal)
  },
});

const baseConfig: AnyRec = {
  frequency: { value: 60, unit: "minutes" },
  sort_order: "old_to_new",
  timezone: "America/Sao_Paulo",
  content: [],
  caption: "",
  caption_templates: [],
  caption_rotation: "off",
  youtube_title: "Titulo",
  youtube_description: "Desc",
};

const tryIt = async (label: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
  } catch (e) {
    console.error(`  ❌ ${label}`);
    console.error(e);
    process.exitCode = 1;
  }
};

// ── T1: readFolderCaptions — round-trip preserva os 3 arquivos ───────────
await tryIt("T1 round-trip: youtube.txt + instagram.txt + legend.txt → 3 captions", async () => {
  const files = [
    { name: "1.jpg", text: async () => "n/a" },
    { name: "youtube.txt", text: async () => "Texto exclusivo do YouTube (youtube.txt)" },
    { name: "INSTAGRAM.TXT", text: async () => "Texto exclusivo do Instagram (instagram.txt)" },
    { name: "legenda.txt", text: async () => "Legenda genérica (caption.txt)" },
  ];
  const got: FolderCaptions = await readFolderCaptions(files);
  assert.strictEqual(got.caption, "Legenda genérica (caption.txt)");
  assert.strictEqual(got.captionYoutube, "Texto exclusivo do YouTube (youtube.txt)");
  assert.strictEqual(got.captionInstagram, "Texto exclusivo do Instagram (instagram.txt)");
});

// ── T2: readFolderCaptions — só .txt genérico (fallback p/ ambas) ────────
await tryIt("T2 .txt único → caption genérica, captions por plataforma null", async () => {
  const files = [{ name: "foto.jpg", text: async () => "x" }, { name: "legenda única.txt", text: async () => "Legenda única" }];
  const got: FolderCaptions = await readFolderCaptions(files);
  assert.strictEqual(got.caption, "Legenda única");
  assert.strictEqual(got.captionYoutube, null);
  assert.strictEqual(got.captionInstagram, null);
});

// ── T3: planner short YT resolve youtube.txt via {post_caption} ──────────
await tryIt("T3 buildPostData YT short → {post_caption} = caption_youtube", async () => {
  const prisma = makePrisma({ posts: [], itemRows: { lib1: libItemDual }, channels: [] });
  const post = await buildPostData({
    prisma: prisma as never,
    planner: { user_id: "u1", id: "pl1" },
    channel: { id: "ch-yt", name: "Meu Canal", platform: "youtube" },
    runtime: baseRuntime("{post_caption}") as never,
    config: baseConfig as never,
    now: new Date("2026-09-01T12:00:00Z"),
    templateIndex: 0,
    postOrdinal: 0,
  });
  assert.strictEqual(post.caption, "Texto exclusivo do YouTube (youtube.txt)", "YT usa youtube.txt");
  assert.strictEqual(post.youtube_type, "short");
});

// ── T4: planner IG resolve instagram.txt via {post_caption} ──────────────
await tryIt("T4 buildPostData IG → {post_caption} = caption_instagram", async () => {
  const prisma = makePrisma({ posts: [], itemRows: { lib1: libItemDual }, channels: [] });
  const post = await buildPostData({
    prisma: prisma as never,
    planner: { user_id: "u1", id: "pl1" },
    channel: { id: "ch-ig", name: "Conta IG", platform: "instagram" },
    runtime: baseRuntime("{post_caption}") as never,
    config: baseConfig as never,
    now: new Date("2026-09-01T12:00:00Z"),
    templateIndex: 0,
    postOrdinal: 0,
  });
  assert.strictEqual(post.caption, "Texto exclusivo do Instagram (instagram.txt)", "IG usa instagram.txt");
  assert.strictEqual(post.youtube_type, null);
});

// ── T5: .txt único → fallback em ambas plataformas ───────────────────────
await tryIt("T5 fallback: .txt único resolve nas duas plataformas", async () => {
  const prisma = makePrisma({ posts: [], itemRows: { lib2: libItemGeneric }, channels: [] });
  const yt = await buildPostData({
    prisma: prisma as never,
    planner: { user_id: "u1", id: "pl1" },
    channel: { id: "ch-yt", name: "Meu Canal", platform: "youtube" },
    runtime: baseRuntime("{post_caption}", "lib2") as never,
    config: baseConfig as never,
    now: new Date("2026-09-01T12:00:00Z"),
    templateIndex: 0,
    postOrdinal: 0,
  });
  const ig = await buildPostData({
    prisma: prisma as never,
    planner: { user_id: "u1", id: "pl1" },
    channel: { id: "ch-ig", name: "Conta IG", platform: "instagram" },
    runtime: baseRuntime("{post_caption}", "lib2") as never,
    config: baseConfig as never,
    now: new Date("2026-09-01T12:00:00Z"),
    templateIndex: 0,
    postOrdinal: 0,
  });
  assert.strictEqual(yt.caption, "Legenda única");
  assert.strictEqual(ig.caption, "Legenda única");
});

// ── T6: propagação re-resolve POR CANAL (YT→youtube.txt, IG→instagram.txt) ──
await tryIt("T6 propagação: caption por canal (não do 1º canal)", async () => {
  const posts: AnyRec[] = [
    {
      id: "p-yt", channel_id: "ch-yt", planner_id: "pl1", status: "pending",
      youtube_type: "short", youtube_options: JSON.stringify({ title: "OLD" }),
      caption: "antiga-yt", video_url: "https://cdn/lib1.mp4",
      scheduled_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z",
    },
    {
      id: "p-ig", channel_id: "ch-ig", planner_id: "pl1", status: "pending",
      youtube_type: null, caption: "antiga-ig", image_url: "https://cdn/lib2.jpg",
      scheduled_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z",
    },
  ];
  const prisma = makePrisma({
    posts,
    itemRows: { lib1: libItemDual, lib2: libItemGeneric },
    channels: [
      { id: "ch-yt", name: "Meu Canal", platform: "youtube" },
      { id: "ch-ig", name: "Conta IG", platform: "instagram" },
    ],
  });
  const cfg: AnyRec = {
    ...baseConfig,
    content: [
      { id: "lib1", media_type: "REELS", caption: "{post_caption}", url: "https://cdn/lib1.mp4", caption_fallback: "", title_fallback: "" },
      { id: "lib2", media_type: "IMAGE", caption: "{post_caption}", url: "https://cdn/lib2.jpg", caption_fallback: "", title_fallback: "" },
    ],
  };
  await propagatePlannerConfigToPendingPosts(
    prisma as never,
    { id: "pl1", user_id: "u1" },
    cfg as never,
    new Date("2026-09-02T12:00:00Z"),
  );
  const updYt = prisma._updates.find((u: AnyRec) => u.id === "p-yt");
  const updIg = prisma._updates.find((u: AnyRec) => u.id === "p-ig");
  assert.ok(updYt && updIg, "ambos os posts atualizados");
  assert.strictEqual((updYt.data as AnyRec).caption, "Texto exclusivo do YouTube (youtube.txt)");
  assert.strictEqual((updIg.data as AnyRec).caption, "Legenda única", "IG (sem instagram.txt) cai na genérica");
});

// ── T7: resolveFinalCaption — `??` (vazio explícito NÃO cai na genérica) ──
await tryIt("T7 resolveFinalCaption: routing + ?? (vazio explícito)", async () => {
  const dual = { caption: "genérica", caption_youtube: "yt", caption_instagram: "ig" };
  assert.strictEqual(resolveFinalCaption("youtube", dual), "yt");
  assert.strictEqual(resolveFinalCaption("instagram", dual), "ig");
  assert.strictEqual(resolveFinalCaption("instagram", null), "");
  assert.strictEqual(resolveFinalCaption(undefined, null), "");
  assert.strictEqual(resolveFinalCaption("YOUTUBE", dual), "yt", "case-insensitive");
  // ?? — campo vazio fica vazio (não usa a genérica)
  assert.strictEqual(
    resolveFinalCaption("youtube", { caption: "genérica", caption_youtube: "", caption_instagram: "ig" }),
    "",
    "youtube.txt vazio = escolha explícita de legenda vazia",
  );
});

// ── T8: sanitizeCaption — trim + limite 2200 + escape (BK-07/BK-14) ──────
await tryIt("T8 sanitizeCaption: trim + 2200 + escape", async () => {
  assert.strictEqual(sanitizeCaption("  com espaços  "), "com espaços");
  assert.strictEqual(sanitizeCaption("<b>bold</b>"), "&lt;b&gt;bold&lt;/b&gt;");
  const long = "x".repeat(CAPTION_MAX + 100);
  assert.strictEqual(sanitizeCaption(long).length, CAPTION_MAX);
});

if (process.exitCode) {
  console.error("\n❌ F4 smoke FALHOU — veja erros acima");
} else {
  console.log("\n✅ F4 smoke: todos os 8 testes passaram (dual captions end-to-end)");
}