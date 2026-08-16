# Module 02 — Content Library: the bar (scenarios L1–L8)

Reference: `components/ContentLibrary.tsx` (2,615 ln), `app/api/content-items/{route,[id],bulk,tags}/route.ts`, `lib/deleteFiles.ts`, `app/api/storage/route.ts`, `app/api/file/[...path]/route.ts`.

The harness drives the REAL standalone server (shared `scripts/gauntlet/` framework) with a session JWT, a temp DB and uploads dir, and seeds ContentItems + real files on disk. Evidence layers: **invariant harness (L1–L6, API-level over real HTTP)** + **visual (L7, Playwright screenshots desktop 1440×900 + mobile 390×844)** + **performance (L8, seeded 1,200 items)**.

## L1 — delete is atomic DB+disk, and failure leaves no ghost

Seed a ContentItem with a real file on disk. DELETE /api/content-items/[id].
Pass: record AND file both gone; no orphan file left in uploads dir; no DB row without a file (drift scan over the whole user tree == 0 orphans after the operation). Also: DELETE with a missing file (disk already cleaned) must still succeed (row removed, no crash, no 500).

## L2 — rename keeps the URL consistent or updates it consistently

PATCH name on an item.
Pass: name updated; the item's `url`/`path` still resolve (GET /api/file/...) — either the file was renamed or the url was regenerated — but NEVER a 404 after rename; no second ContentItem created; carousel children (parent_id) unaffected.

## L3 — folder operations: no cycles, no orphans, no wrong-parent

Seed a folder tree (A → B → C) with items inside. Move item / move folder (PATCH parent_id).
Pass: parent_id assignments are consistent (target folder exists and belongs to the same user); moving a folder into its own descendant is REJECTED (cycle guard) — assert the API returns 4xx and the tree is unchanged; deleting a parent folder leaves children either deleted (documented cascade) or re-parented — assert the chosen contract and that no child points to a missing parent afterwards (integrity scan: every parent_id resolves; every item reachable from root).

## L4 — bulk operations are atomic per request

Seed 50 items. POST /api/content-items/bulk with tags assignment for 50 ids; and a bulk delete of 20.
Pass: either ALL 50 items get the tags or NONE (no partial write on failure — inject a failure by including a non-existent id in the same batch and assert the API rejects the whole batch, not a subset); bulk delete removes exactly the 20 records AND their disk files; counts match before/after.

## L5 — duplicate-name semantics (REAL contract, calibrated after round-01 baseline)

The dedupe-by-name contract (second upload updates the first item) lives in
`/api/upload-chunk/complete` (upload-finalize), NOT in the raw
`content-items` POST. The POST layer is a raw create and may produce two rows;
that is by design (the library UI reaches it only through finalize, which
dedupes). Two sub-scenarios prove the real contract:

- L5a (raw create): two POSTs to `content-items` with the same name+parent →
  both 2xx, exactly 2 rows, both files intact on disk (no corruption). This is
the documented deviation from the original bar letter.
- L5b (dedupe proof): two `/api/upload-chunk/complete` calls for the same
  name+parent → same item id returned twice, exactly 1 row, final file on disk
  matches the declared size (second updates first, no corruption).

## L6 — concurrent mutations converge (no lost update / no 500)

Two concurrent PATCHes to the same item (different fields), and a concurrent DELETE + PATCH on the same id, and two concurrent moves of the same item to different parents.
Pass: no 500; the final row is one of the two valid outcomes (no torn state); the file on disk is never corrupted; after DELETE+PATCH race the row either exists (with one of the patch results) or is gone — but the API never returns success for an operation on a deleted id with a 200.

## L7 — visual (Playwright, screenshots)

The library page renders: (a) empty state; (b) grid with folders + video/image badges + carousel grouping; (c) bulk-select toolbar; (d) mobile 390×844 — no horizontal scroll, no clipped cards, tap targets visible.
Pass: screenshots captured at the two viewports; a fresh-context critic compares candidate vs a recorded pre-gauntlet baseline screenshot blind (labels stripped, sides randomized, forced pick) OR, if the visuals are unchanged-by-design, the gate is: no layout regression detected by pixel-diff (diff below noise threshold) + no console errors in the browser log during the flows.

## L8 — performance (1,200 seeded items)

Seed 1,200 ContentItems (+files optional — seed with tiny files). Measure in the browser (Playwright + performance.timing / custom rAF probe):

- Initial render of the library grid ≤ a named budget (baseline measured BEFORE the gauntlet on the same machine; the round wins if the candidate does NOT regress it by more than 10%).
- Scroll: no dropped-frame bursts > 200 ms during a scripted scroll pass (rAF-based probe).
Pass: candidate within budget vs the recorded baseline; budget numbers recorded in the module's gates/.

## Out of scope

Upload/finalize (won in the upload gauntlet), planner/publisher interplay (module 01/03), UI restyling (visual bar is regression-only unless the critic forces a pick).
