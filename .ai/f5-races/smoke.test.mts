// F5-P1 smoke test — races e robustez (M13/M14/M11/M10/M15).
//
// Cobertura:
//   T1  M13 — finalizePostWrite: post cancelado NÃO é sobrescrito (published/failed)
//   T2  M13 — isPostStillInFlight: cancelled=false, in-flight=true, terminal=false
//   T3  M14 — propagação com race: post cancelado no meio do lote é PULADO
//             (where inclui status; o estado terminal é preservado)
//   T4  M14 — propagação normal atualiza pending/scheduled/queued (sem race)
//   T5  M11 — resolvePlannerRuntime: canal YT + STORIES → REELS (vídeo vira short)
//   T6  M15 — runPlannerOnce: item deletado no meio → run AVANÇA e publica o próximo
//   T7  M15 — runPlannerOnce: todos os itens deletados → falha limpa, sem loop
//   T8  M10 — POST /api/posts: CAROUSEL com 1 item → 400 PT-BR (2..10 obrigatório)
//   T9  M10 — POST /api/posts: CAROUSEL com 11 itens → 400 PT-BR
//   T10 M10 — POST /api/posts: CAROUSEL com 2..10 itens → 200; REELS não afetado
//
// Roda com: node --import ./.ai/f5-races/alias-hook.mjs \
//           --experimental-strip-types .ai/f5-races/smoke.test.mts
import assert from "node:assert";

import {
  resolvePlannerRuntime,
  runPlannerOnce,
  propagatePlannerConfigToPendingPosts,
} from "../../lib/planner-runtime.ts";
import {
  finalizePostWrite,
  isPostStillInFlight,
} from "../../lib/publisher-race-guard.ts";
import { POST as postsPOST } from "../../app/api/posts/route.ts";

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

// ─── In-memory Prisma store (dirigido por globalThis.__PRISMA__) ─────────────
function makeStore(seed: {
  items?: Map<string, AnyRec>; // id -> ContentItem (library)
  folders?: Map<string, AnyRec[]>; // parent_id -> filhos (pastas de carrossel)
  posts?: Map<string, AnyRec>;
  planners?: Map<string, AnyRec>;
  channels?: Map<string, AnyRec>;
}) {
  const state: {
    items: Map<string, AnyRec>;
    folders: Map<string, AnyRec[]>;
    posts: Map<string, AnyRec>;
    planners: Map<string, AnyRec>;
    channels: Map<string, AnyRec>;
    logs: AnyRec[];
    createdPosts: AnyRec[];
    stateWrites: AnyRec[];
    /** Hook de race: roda no início do updateMany de POST quando o id bate. */
    beforePostUpdateMany?: (postId: string) => void;
  } = {
    items: seed.items || new Map(),
    folders: seed.folders || new Map(),
    posts: seed.posts || new Map(),
    planners: seed.planners || new Map(),
    channels: seed.channels || new Map(),
    logs: [],
    createdPosts: [],
    stateWrites: [],
  };

  globalThis.__PRISMA__ = {
    contentItem: {
      findFirst: async ({ where }: AnyRec) => {
        if (!where?.id) return null;
        return state.items.get(String(where.id)) || null;
      },
      findMany: async ({ where }: AnyRec) => {
        if (where?.parent_id)
          return [...(state.folders.get(String(where.parent_id)) || [])];
        return [...state.items.values()];
      },
      count: async () => state.items.size,
    },
    post: {
      findMany: async ({ where }: AnyRec) => {
        const w = (where || {}) as AnyRec;
        const statuses = new Set<string>(Array.isArray(w.status?.in) ? w.status.in : []);
        return [...state.posts.values()].filter((p) => {
          if (w.planner_id && p.planner_id !== w.planner_id) return false;
          if (statuses.size > 0 && !statuses.has(String(p.status))) return false;
          if (w.id?.in && !w.id.in.includes(p.id)) return false;
          return true;
        });
      },
      findUnique: async ({ where }: AnyRec) =>
        state.posts.get(String(where?.id)) || null,
      findFirst: async ({ where }: AnyRec) =>
        state.posts.get(String(where?.id)) || null,
      updateMany: async ({ where, data }: AnyRec) => {
        if (state.beforePostUpdateMany)
          state.beforePostUpdateMany(String(where?.id));
        const target = state.posts.get(String(where?.id));
        if (!target) return { count: 0 };
        const allowed = new Set<string>(Array.isArray(where?.status?.in) ? where.status.in : []);
        if (allowed.size > 0 && !allowed.has(String(target.status))) return { count: 0 };
        for (const [k, v] of Object.entries(data || {})) target[k] = v;
        return { count: 1 };
      },
      update: async ({ where, data }: AnyRec) => {
        const t = state.posts.get(String(where?.id));
        if (!t) throw new Error("post not found");
        Object.assign(t, data || {});
        return t;
      },
      create: async ({ data }: AnyRec) => {
        const row: AnyRec = { id: `post-${state.posts.size + 1}`, created_at: new Date(), ...(data as AnyRec) };
        state.posts.set(String(row.id), row);
        state.createdPosts.push(row);
        return row;
      },
      count: async ({ where }: AnyRec) => {
        return [...state.posts.values()].filter(
          (p) => !where?.planner_id || p.planner_id === where.planner_id,
        ).length;
      },
    },
    planner: {
      updateMany: async ({ where, data }: AnyRec) => {
        const p = state.planners.get(String(where?.id));
        if (!p) return { count: 0 };
        if (where?.last_run !== undefined && p.last_run !== where.last_run)
          return { count: 0 };
        if (data?.last_run !== undefined) p.last_run = data.last_run;
        if (data?.state !== undefined) {
          p.state = data.state;
          state.stateWrites.push(data.state);
        }
        return { count: 1 };
      },
      update: async ({ where, data }: AnyRec) => {
        const t = state.planners.get(String(where?.id));
        if (t) Object.assign(t, data || {});
        return t;
      },
    },
    channel: {
      findMany: async ({ where }: AnyRec) => {
        const w = (where || {}) as AnyRec;
        return [...state.channels.values()].filter(
          (c) => !w.id?.in || w.id.in.includes(c.id),
        );
      },
      findUnique: async ({ where }: AnyRec) =>
        state.channels.get(String(where?.id)) || null,
    },
    plannerLog: {
      create: async (args: AnyRec) => {
        state.logs.push(args.data);
        return args.data;
      },
    },
    $transaction: async (ops: AnyRec[]) => {
      for (const op of ops) await op;
      return [];
    },
  };
  return state;
}

const safeState = (raw: string | null | undefined): AnyRec => {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as AnyRec) : {};
  } catch {
    return {};
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── T1/T2: M13 — guard de escrita final no publisher ─────────────────────────
await tryIt("T1 M13 finalizePostWrite: cancelado NÃO é sobrescrito p/ published", async () => {
  const posts = new Map<string, AnyRec>([
    ["p-cancelled", { id: "p-cancelled", status: "cancelled" }],
    ["p-processing", { id: "p-processing", status: "processing" }],
    ["p-failed", { id: "p-failed", status: "failed" }],
    ["p-ready", { id: "p-ready", status: "ready_to_publish" }],
  ]);
  makeStore({ posts });
  // Cancelled: escrita bloqueada → false, status permanece cancelled.
  const blocked = await finalizePostWrite("p-cancelled", "pl1", "YouTube", {
    status: "published",
    published_at: new Date(),
    youtube_video_id: "vid",
  });
  assert.strictEqual(blocked, false, "escrita sobre cancelado deve ser bloqueada");
  assert.strictEqual(posts.get("p-cancelled")?.status, "cancelled");
  // Failed também é terminal → bloqueado.
  const blockedFail = await finalizePostWrite("p-failed", "pl1", "YouTube", {
    status: "published",
    published_at: new Date(),
  });
  assert.strictEqual(blockedFail, false, "escrita sobre failed deve ser bloqueada");
  assert.strictEqual(posts.get("p-failed")?.status, "failed");
  // In-flight: escrita normal → true e status landed.
  const ok = await finalizePostWrite("p-processing", "pl1", "YouTube", {
    status: "published",
    published_at: new Date(),
    youtube_video_id: "vid",
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(posts.get("p-processing")?.status, "published");
  // ready_to_publish (fase 3 IG) também é escrevível.
  const okReady = await finalizePostWrite("p-ready", "pl1", "IG", {
    status: "published",
    published_at: new Date(),
    instagram_media_id: "ig1",
  });
  assert.strictEqual(okReady, true);
  assert.strictEqual(posts.get("p-ready")?.status, "published");
});

await tryIt("T2 M13 isPostStillInFlight: cancelled=false; fila=true; terminal=false", async () => {
  const posts = new Map<string, AnyRec>([
    ["a", { id: "a", status: "cancelled" }],
    ["b", { id: "b", status: "processing" }],
    ["c", { id: "c", status: "ready_to_publish" }],
    ["d", { id: "d", status: "published" }],
    ["e", { id: "e", status: "pending" }],
  ]);
  makeStore({ posts });
  assert.strictEqual(await isPostStillInFlight("a"), false);
  assert.strictEqual(await isPostStillInFlight("b"), true);
  assert.strictEqual(await isPostStillInFlight("c"), true);
  assert.strictEqual(await isPostStillInFlight("d"), false);
  assert.strictEqual(await isPostStillInFlight("e"), true);
});

// ── T3/T4: M14 — propagação com guard de status ──────────────────────────────
await tryIt("T3 M14 propagação race: post cancelado no meio do lote é PULADO", async () => {
  const posts = new Map<string, AnyRec>([
    ["p1", { id: "p1", planner_id: "plA", channel_id: "ch1", status: "pending", caption: "Antiga 1", video_url: "https://x/1.mp4" }],
    ["p2", { id: "p2", planner_id: "plA", channel_id: "ch1", status: "pending", caption: "Antiga 2", video_url: "https://x/2.mp4" }],
  ]);
  const store = makeStore({ posts });
  // Race: durante o updateMany do PRIMEIRO post, o segundo é cancelado
  // (simula bug-remove/publisher chegando no mesmo instante).
  store.beforePostUpdateMany = (id) => {
    if (id === "p1") {
      const p2 = posts.get("p2");
      if (p2) p2.status = "cancelled";
    }
  };
  const config = {
    frequency: { value: 5, unit: "minutes" },
    sort_order: "old_to_new",
    caption: "",
    content: [
      { type: "config", url: "https://x/1.mp4", media_type: "REELS", caption: "Nova 1" },
      { type: "config", url: "https://x/2.mp4", media_type: "REELS", caption: "Nova 2" },
    ],
  };
  const { updated, total } = await propagatePlannerConfigToPendingPosts(
    globalThis.__PRISMA__ as never,
    { id: "plA", user_id: "u1" },
    config as never,
    new Date(),
  );
  assert.strictEqual(total, 2);
  assert.strictEqual(updated, 1, "apenas o post ainda em voo deve ser atualizado");
  assert.strictEqual(posts.get("p1")?.caption, "Nova 1", "p1 pendente recebe a nova caption");
  assert.strictEqual(posts.get("p2")?.status, "cancelled", "p2 cancelado PRESERVADO");
  assert.strictEqual(posts.get("p2")?.caption, "Antiga 2", "caption do cancelado não é reescrita");
});

await tryIt("T4 M14 propagação normal: pending/scheduled/queued atualizados", async () => {
  const posts = new Map<string, AnyRec>([
    ["a", { id: "a", planner_id: "plB", channel_id: "ch1", status: "pending", caption: "old" }],
    ["b", { id: "b", planner_id: "plB", channel_id: "ch1", status: "scheduled", caption: "old" }],
    ["c", { id: "c", planner_id: "plB", channel_id: "ch1", status: "queued", caption: "old" }],
    ["d", { id: "d", planner_id: "plB", channel_id: "ch1", status: "cancelled", caption: "old" }],
    ["e", { id: "e", planner_id: "plB", channel_id: "ch1", status: "published", caption: "old" }],
  ]);
  makeStore({ posts });
  const config = {
    frequency: { value: 5, unit: "minutes" },
    sort_order: "old_to_new",
    caption: "Nova global",
    content: [
      { type: "config", media_type: "REELS", caption: "Nova global" },
    ],
  };
  const { updated, total } = await propagatePlannerConfigToPendingPosts(
    globalThis.__PRISMA__ as never,
    { id: "plB", user_id: "u1" },
    config as never,
    new Date(),
  );
  assert.strictEqual(total, 3, "findMany filtra só pending/scheduled/queued");
  assert.strictEqual(updated, 3);
  assert.strictEqual(posts.get("d")?.status, "cancelled");
  assert.strictEqual(posts.get("e")?.status, "published");
  assert.strictEqual(posts.get("d")?.caption, "old");
  assert.strictEqual(posts.get("e")?.caption, "old");
});

// ── T5: M11 — STORIES→REELS no runtime (canal YT) ────────────────────────────
await tryIt("T5 M11 runtime: canal YT + STORIES → REELS (com warning)", async () => {
  makeStore({});
  const planner = {
    id: "pl-yt",
    user_id: "u1",
    name: "YT",
    config: JSON.stringify({
      frequency: { value: 5, unit: "minutes" },
      sort_order: "old_to_new",
      content: [
        { type: "config", url: "https://x/story.mp4", media_type: "STORIES", caption: "cap" },
      ],
    }),
    state: null,
    status: "active",
    last_run: null,
    channels: [
      { id: "ch-yt", platform: "youtube", status: "active", settings: JSON.stringify({ sessionId: "s1" }) },
    ],
  };
  const runtime = await resolvePlannerRuntime(globalThis.__PRISMA__ as never, planner as never, new Date());
  assert.strictEqual(runtime.ok, true);
  assert.strictEqual(runtime.mediaType, "REELS", "STORIES do canal YT vira REELS no runtime");
  assert.strictEqual(runtime.mediaUrl, "https://x/story.mp4");
  assert.ok(
    (runtime.warnings || []).some((w: string) => /STORIES convertido para REELS/i.test(String(w))),
    "warning da conversão presente",
  );
});

await tryIt("T5b M11: canal IG mantém STORIES (sem conversão)", async () => {
  makeStore({});
  const planner = {
    id: "pl-ig",
    user_id: "u1",
    name: "IG",
    config: JSON.stringify({
      frequency: { value: 5, unit: "minutes" },
      sort_order: "old_to_new",
      content: [
        { type: "config", url: "https://x/story.mp4", media_type: "STORIES", caption: "cap" },
      ],
    }),
    state: null,
    status: "active",
    last_run: null,
    channels: [{ id: "ch-ig", platform: "instagram", status: "active" }],
  };
  const runtime = await resolvePlannerRuntime(globalThis.__PRISMA__ as never, planner as never, new Date());
  assert.strictEqual(runtime.ok, true);
  assert.strictEqual(runtime.mediaType, "STORIES", "IG mantém STORIES");
});

// ── T6/T7: M15 — wedge de item deletado em planner sequencial ────────────────
const seedM15 = (
  withMiddleDeleted: boolean,
  ItemC = { id: "c", url: "https://x/c.png", type: "image", name: "C" },
) => {
  const items = new Map<string, AnyRec>([
    ["a", { id: "a", url: "https://x/a.mp4", type: "video", name: "A" }],
    ["b", { id: "b", url: "https://x/b.mp4", type: "video", name: "B" }],
    ["c", ItemC],
  ]);
  if (withMiddleDeleted) items.delete("a"); // índice 0 deletado (no meio do fluxo)
  const planners = new Map<string, AnyRec>([
    ["pl-m15", {
      id: "pl-m15",
      user_id: "u1",
      name: "M15",
      config: JSON.stringify({
        frequency: { value: 5, unit: "minutes" },
        sort_order: "old_to_new",
        content: [
          { type: "library_item", id: "a", media_type: "REELS", caption: "Item A" },
          { type: "library_item", id: "b", media_type: "REELS", caption: "Item B" },
          { type: "library_item", id: "c", media_type: "IMAGE", caption: "Item C" },
        ],
      }),
      state: null,
      status: "active",
      last_run: null,
    }],
  ]);
  const channels = new Map<string, AnyRec>([
    ["ch-ig", {
      id: "ch-ig",
      user_id: "u1",
      platform: "instagram",
      status: "active",
      access_token: "tok",
      token_source: "manual",
      token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000),
      account_id: "acct1",
    }],
  ]);
  const store = makeStore({ items, planners, channels });
  const plannerRow = planners.get("pl-m15")!;
  return { store, plannerRow };
};

await tryIt("T6 M15 item deletado no meio → run AVANÇA e publica o próximo", async () => {
  const { store, plannerRow } = seedM15(true);
  const plannerForRun = {
    ...plannerRow,
    channels: [{ id: "ch-ig", platform: "instagram", status: "active", access_token: "tok", token_source: "manual", token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000) }],
  };
  const now = new Date();
  const out = await runPlannerOnce(globalThis.__PRISMA__ as never, plannerForRun as never, now, { force: true });
  assert.strictEqual(out.ok, true, `run deve avançar statt travar: ${JSON.stringify(out)}`);
  assert.strictEqual(out.created, 1);
  // O post criado deve usar o item VÁLIDO B (idx 1), não o deletado A (idx 0).
  const created = store.createdPosts[0] as AnyRec;
  assert.strictEqual(created.video_url, "https://x/b.mp4", "post usa o próximo item válido");
  // O estado persistido avançou o índice até o item B (last_index=1).
  const lastState = safeState(String(store.stateWrites[store.stateWrites.length - 1]));
  assert.strictEqual(lastState.last_index, 1, "last_index avança além do item deletado");
  // Warning informativo sobre o item deletado.
  assert.ok(
    (out.warnings || []).some((w: string) => /Library item not found/i.test(String(w))),
    "warning do item deletado presente",
  );

  // Run 2: avança para o item C (imagem). Re-lê a ROW do store (como o cron
  // re-lê do banco a cada tick) — o planner.row foi mutado pela claim/state
  // do run 1 (last_run + state.last_index).
  await sleep(1); // garante last_run/now distintos
  const rowAfter1 = store.planners.get("pl-m15")!;
  const now2 = new Date();
  const out2 = await runPlannerOnce(
    globalThis.__PRISMA__ as never,
    {
      ...rowAfter1,
      channels: [
        {
          id: "ch-ig",
          platform: "instagram",
          status: "active",
          access_token: "tok",
          token_source: "manual",
          token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000),
        },
      ],
    } as never,
    now2,
    { force: true },
  );
  assert.strictEqual(out2.ok, true, JSON.stringify(out2));
  const created2 = store.createdPosts[1] as AnyRec;
  assert.strictEqual(created2.image_url, "https://x/c.png", "run 2 publica o item C");
  const state2 = safeState(String(store.stateWrites[store.stateWrites.length - 1]));
  assert.strictEqual(state2.last_index, 2, "last_index avança para o item C");
});

await tryIt("T7 M15 todos os itens deletados → falha limpa (sem loop infinito)", async () => {
  const { store, plannerRow } = seedM15(true);
  // Remove TAMBÉM b/c: todo o conteúdo aponta para itens inexistentes.
  store.items.delete("b");
  store.items.delete("c");
  const plannerForRun = {
    ...plannerRow,
    channels: [{ id: "ch-ig", platform: "instagram", status: "active", access_token: "tok", token_source: "manual", token_expires_at: new Date(Date.now() + 30 * 24 * 3600_000) }],
  };
  const out = await runPlannerOnce(globalThis.__PRISMA__ as never, plannerForRun as never, new Date(), { force: true });
  assert.strictEqual(out.ok, false, "sem itens válidos, run falha limpo");
  assert.strictEqual(out.skipped, "resolution_failed");
  assert.strictEqual(store.createdPosts.length, 0, "nenhum post criado");
  assert.ok(
    String((out as AnyRec).error || "").includes("Media URL missing"),
    "erro claro de mídia ausente",
  );
});

// ── T8/T9/T10: M10 — carrossel 2..10 server-side (POST /api/posts) ───────────
const postCarousel = async (childrenCount: number) => {
  const children = Array.from({ length: childrenCount }, (_, i) => ({
    url: `https://x/slide-${i}.png`,
    type: "image",
  }));
  const res = await postsPOST(
    new Request("http://localhost/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "CAROUSEL",
        children_urls: JSON.stringify(children),
      }),
    }),
  );
  return res;
};

await tryIt("T8 M10 POST /api/posts: CAROUSEL com 1 item → 400 PT-BR", async () => {
  makeStore({});
  const res = await postCarousel(1);
  const body = await res.json();
  assert.strictEqual(res.status, 400);
  assert.ok(
    /entre 2 e 10 mídias/i.test(String(body.error || "")),
    `erro PT-BR claro: ${body.error}`,
  );
});

await tryIt("T9 M10 POST /api/posts: CAROUSEL com 11 itens → 400 PT-BR", async () => {
  makeStore({});
  const res = await postCarousel(11);
  const body = await res.json();
  assert.strictEqual(res.status, 400);
  assert.ok(/entre 2 e 10 mídias/i.test(String(body.error || "")));
});

await tryIt("T10 M10 POST /api/posts: CAROUSEL 2..10 ok; REELS com 1 child não afetado", async () => {
  const store = makeStore({});
  const res = await postCarousel(5);
  assert.strictEqual(res.status, 200);
  const created = await res.json();
  assert.strictEqual(created.media_type, "CAROUSEL");
  assert.strictEqual(store.createdPosts.length, 1);

  // REELS com children (não-carrossel) NÃO sofre a validação 2..10.
  const resReels = await postsPOST(
    new Request("http://localhost/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "REELS",
        video_url: "https://x/v.mp4",
        children_urls: JSON.stringify([{ url: "https://x/v.mp4", type: "video" }]),
      }),
    }),
  );
  assert.strictEqual(resReels.status, 200);
});

// ── T11: meta-check M13 — nenhuma escrita terminal incondicional resta no publisher ──
await tryIt("T11 M13 nenhuma escrita publish/fail/revert por id sem guard no publisher", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const src = readFileSync(
    resolve(process.cwd(), "app/api/cron/publisher/route.ts"),
    "utf8",
  );
  // Escrevas terminais (published/failed/revert) devem passar por
  // finalizePostWrite — nunca prisma.post.update({ where: { id } }) com status.
  const unguarded = /prisma\.post\.update\(\{[\s\S]{0,220}?data: \{[\s\S]{0,120}?status: ("published"|"failed"|"pending")/.exec(
    src,
  );
  assert.strictEqual(
    unguarded,
    null,
    `escrita terminal sem guard encontrada: ${unguarded?.[0]?.slice(0, 180)}`,
  );
  // Os guards estão realmente ligados à rota.
  assert.ok(src.includes("finalizePostWrite("), "finalizePostWrite em uso");
  assert.ok(src.includes("isPostStillInFlight("), "isPostStillInFlight em uso");
  assert.ok(
    src.includes("@/lib/publisher-race-guard"),
    "guard importado do lib (não definido na route — export de route quebraria o build)",
  );
});

// ── Resumo ───────────────────────────────────────────────────────────────────
if (process.exitCode) {
  console.error("\nF5-RACES: cenários com falha — ver ❌ acima.");
} else {
  console.log("\nF5-RACES: todos os cenários PASSARAM.");
}