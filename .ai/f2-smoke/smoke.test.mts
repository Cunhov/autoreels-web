// F2-B2 smoke test — propagação espelha buildPostData via
// buildYoutubeOptionsForPost (M5/M17/M18/G4).
//
// Roda com: node --import ./.ai/f2-smoke/alias-hook.mjs .ai/f2-smoke/smoke.test.mts
import assert from "node:assert";
import {
  buildPostData,
  propagatePlannerConfigToPendingPosts,
} from "../../lib/planner-runtime.ts";

type AnyRec = Record<string, unknown>;

function makePrisma(posts: AnyRec[]) {
  const updates: Array<{ id: string; data: AnyRec }> = [];
  const prisma: AnyRec = {
    _updates: updates,
    contentItem: {
      findFirst: async () => ({ name: "meu-video-legal.mp4", title: "", caption: "" }),
    },
    post: {
      findMany: async () => posts,
      update: async (args: AnyRec) => {
        updates.push({ id: String((args.where as AnyRec).id), data: args.data as AnyRec });
        return { id: (args.where as AnyRec).id };
      },
      updateMany: async (args: AnyRec) => {
        updates.push({
          id: String((args.where as AnyRec).id),
          data: args.data as AnyRec,
        });
        // M13/M14: propagate usa updateMany com guard de status — o mock
        // conta como atualizado somente quando o status do post ainda está
        // em pending/scheduled/queued (simula o guard real).
        const wanted = posts.find((p) => p.id === (args.where as AnyRec).id);
        const ok =
          wanted &&
          ["pending", "scheduled", "queued"].includes(String(wanted.status));
        return { count: ok ? 1 : 0 };
      },
    },
    plannerLog: { create: async () => ({}) },
    channel: {
      findMany: async () => [
        { id: "ch1", name: "Canal Teste", platform: "youtube" },
        { id: "ig1", name: "Conta IG", platform: "instagram" },
      ],
      findUnique: async () => null,
    },
  };
  return prisma;
}

const baseContent = {
  id: "lib1",
  media_type: "REELS",
  caption: "Legenda base",
  caption_fallback: "",
  title_fallback: "",
};

const baseConfig: AnyRec = {
  frequency: { value: 60, unit: "minutes" },
  sort_order: "old_to_new",
  timezone: "America/Sao_Paulo",
  content: [baseContent],
  caption: "",
  caption_templates: [],
  caption_rotation: "off",
  youtube_title: "Titulo {channel_name}",
  youtube_description: "Descricao {channel_name} do dia {date}",
  youtube_privacy: "UNLISTED",
  youtube_made_for_kids: false,
  youtube_monetize_with_ads: true,
  youtube_category_id: 22,
  youtube_pinned_comment_text: "Pinned 1",
  youtube_products: [
    { query: "smartwatch", item: { id: "p1", title: "Smartwatch X", merchant: { id: "m1" } } },
    { query: "fone" },
  ],
};

const runtime = {
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
  selectedContent: { ...baseContent },
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

// ── Teste 1: buildPostData produz youtube_options completo ─────────────
await tryIt("T1 buildPostData → products/title/desc/privacy/pinned", async () => {
  const prisma = makePrisma([]);
  const post = await buildPostData({
    prisma: prisma as never,
    planner: { user_id: "u1", id: "pl1" },
    channel: { id: "ch1", name: "Canal Teste", platform: "youtube" },
    runtime: runtime as never,
    config: baseConfig as never,
    now: new Date("2026-09-01T12:00:00Z"),
    templateIndex: 0,
    postOrdinal: 0,
  });
  assert(post.youtube_type === "short");
  assert(typeof post.youtube_options === "string");
  const yt = JSON.parse(post.youtube_options) as AnyRec;
  assert.strictEqual(yt.title, "Titulo Canal Teste", "youtube_title resolvido com {channel_name}");
  assert.strictEqual(yt.description, "Descricao Canal Teste do dia 01/09/2026", "template {date} em tz");
  assert.deepStrictEqual(
    JSON.parse(yt.products as string),
    [{ item: { id: "p1", title: "Smartwatch X", merchant: { id: "m1" } } }],
  );
  assert.deepStrictEqual(JSON.parse(yt.product_names as string), ["fone"]);
  assert.strictEqual(yt.privacy, "UNLISTED");
  assert.strictEqual(yt.made_for_kids, false);
  assert.strictEqual(yt.monetize_with_ads, true);
  assert.strictEqual(yt.category_id, 22);
  assert.strictEqual(yt.pinned_comment_text, "Pinned 1");
});

// ── Teste 2: PATCH só caption → pending preserva products/título/desc ──
const pendingShort = {
  id: "p1",
  channel_id: "ch1",
  planner_id: "pl1",
  status: "pending",
  youtube_type: "short",
  youtube_options: JSON.stringify({ title: "OLD", privacy: "PUBLIC" }),
  caption: "antiga",
  video_url: "https://cdn/meu-video.mp4",
  scheduled_at: "2026-09-01T00:00:00Z",
  created_at: "2026-09-01T00:00:00Z",
};

await tryIt("T2 PATCH caption → products/título/desc preservados", async () => {
  const prisma = makePrisma([{ ...pendingShort }]);
  const cfg = {
    ...baseConfig,
    content: [{ ...baseContent, caption: "Legenda NOVA" }],
  };
  const res = await propagatePlannerConfigToPendingPosts(
    prisma as never,
    { id: "pl1", user_id: "u1" },
    cfg as never,
    new Date("2026-09-02T12:00:00Z"),
  );
  assert.strictEqual(res.updated, 1);
  const upd = prisma._updates.find((u: AnyRec) => u.id === "p1");
  assert.ok(upd, "update feito");
  assert.strictEqual((upd.data as AnyRec).caption, "Legenda NOVA");
  const yt = JSON.parse((upd.data as AnyRec).youtube_options as string) as AnyRec;
  assert.strictEqual(yt.title, "Titulo Canal Teste", "M17: título com youtube_title preservado");
  // products/product_names são gravados como JSON STRING (paridade com buildPostData)
  assert.deepStrictEqual(
    JSON.parse(yt.products as string),
    [{ item: { id: "p1", title: "Smartwatch X", merchant: { id: "m1" } } }],
    "M5: products preservados",
  );
  assert.deepStrictEqual(JSON.parse(yt.product_names as string), ["fone"]);
  assert.strictEqual(yt.description, "Descricao Canal Teste do dia 02/09/2026", "M18: template re-resolvido");
  assert.strictEqual(yt.privacy, "UNLISTED");
  assert.strictEqual(yt.pinned_comment_text, "Pinned 1", "G4: pinned preservado");
});

// ── Teste 3: PATCH youtube_title → youtube_options.title muda ──────────
await tryIt("T3 PATCH youtube_title → title muda nos pending", async () => {
  const prisma = makePrisma([{ ...pendingShort }]);
  const cfg = {
    ...baseConfig,
    youtube_title: "Novo Titulo {channel_name}",
    content: [{ ...baseContent, caption: "Legenda NOVA" }],
  };
  await propagatePlannerConfigToPendingPosts(
    prisma as never,
    { id: "pl1", user_id: "u1" },
    cfg as never,
    new Date("2026-09-02T12:00:00Z"),
  );
  const upd = prisma._updates.find((u: AnyRec) => u.id === "p1");
  const yt = JSON.parse((upd.data as AnyRec).youtube_options as string) as AnyRec;
  assert.strictEqual(yt.title, "Novo Titulo Canal Teste", "teste-ouro bug-desc: título propaga");
  assert.strictEqual(yt.category_id, 22, "herança config>item>youtube mantida");
});

// ── Teste 4: community NÃO tem youtube_options reescrito ───────────────
await tryIt("T4 community → propagação não reescreve youtube_options", async () => {
  const prisma = makePrisma([
    {
      id: "p9",
      channel_id: "ch1",
      planner_id: "pl1",
      status: "pending",
      youtube_type: "community",
      youtube_options: JSON.stringify({ title: "COM" }),
      caption: "texto antigo",
      image_url: "https://cdn/img.jpg",
      scheduled_at: "2026-09-01T00:00:00Z",
      created_at: "2026-09-01T00:00:00Z",
    },
  ]);
  const cfg = { ...baseConfig, youtube_title: "XYZ" };
  await propagatePlannerConfigToPendingPosts(
    prisma as never,
    { id: "pl1", user_id: "u1" },
    cfg as never,
    new Date("2026-09-02T12:00:00Z"),
  );
  const upd = prisma._updates.find((u: AnyRec) => u.id === "p9");
  assert.ok(upd, "update feito");
  assert.strictEqual(
    (upd.data as AnyRec).youtube_options,
    undefined,
    "community: youtube_options NÃO deve entrar no update",
  );
  assert.ok((upd.data as AnyRec).caption);
});

// ── Teste 5: post não-YT não mexe em youtube_options ───────────────────
await tryIt("T5 post IG → youtube_options intocado", async () => {
  const prisma = makePrisma([
    {
      id: "p8",
      channel_id: "ig1",
      planner_id: "pl1",
      status: "pending",
      youtube_type: null,
      youtube_options: JSON.stringify({ dirty: 1 }),
      caption: "x",
      scheduled_at: "2026-09-01T00:00:00Z",
      created_at: "2026-09-01T00:00:00Z",
    },
  ]);
  await propagatePlannerConfigToPendingPosts(
    prisma as never,
    { id: "pl1", user_id: "u1" },
    { ...baseConfig } as never,
    new Date("2026-09-02T12:00:00Z"),
  );
  const upd = prisma._updates.find((u: AnyRec) => u.id === "p8");
  assert.strictEqual(
    (upd.data as AnyRec).youtube_options,
    undefined,
    "post IG: youtube_options NÃO deve entrar no update",
  );
  // caption é re-derivada de propósito para TODOS os posts pendentes (decisão
  // de produto da propagação, documentada no JSDoc) — contrato aqui é só não
  // mexer em youtube_options de posts não-Shorts.
});

// ── Teste 6: G4 alias — só youtube_pinned_comment propaga ──────────────
await tryIt("T6 alias G4 só youtube_pinned_comment → pinned re-resolvido", async () => {
  const prisma = makePrisma([{ ...pendingShort }]);
  const cfg: AnyRec = {
    ...baseConfig,
    youtube_pinned_comment_text: undefined, // só o alias
    youtube_pinned_comment: "Pinned via alias",
  };
  await propagatePlannerConfigToPendingPosts(
    prisma as never,
    { id: "pl1", user_id: "u1" },
    cfg as never,
    new Date("2026-09-02T12:00:00Z"),
  );
  const upd = prisma._updates.find((u: AnyRec) => u.id === "p1");
  const yt = JSON.parse((upd.data as AnyRec).youtube_options as string) as AnyRec;
  assert.strictEqual(yt.pinned_comment_text, "Pinned via alias");
});

if (process.exitCode) {
  console.error("\n❌ FALHOU — veja erros acima");
} else {
  console.log("\n✅ Todos os 6 testes passaram");
}