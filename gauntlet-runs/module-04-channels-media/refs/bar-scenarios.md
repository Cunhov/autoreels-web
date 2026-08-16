# Module 04 — Channels + Media + Backup: the bar (scenarios M1–M7)

Reference: `app/api/channels/{route,[id],[id]/refresh,[id]/test,[id]/insights}`, `app/api/channels/oauth/{start,callback}`, `lib/instagram.ts` (exchange/refresh/profile), `lib/backup.ts` (VACUUM INTO, prune-7, restore w/ integrity + pre-restore copy), `app/api/video/{trim,thumbnail}`, `lib/ffmpeg.ts`, `lib/video-thumbnail.ts`, `components/ImageEditorModal.tsx`.

Harness: shared `scripts/gauntlet/` boot + fetch-mock. NOTE: the OAuth exchange calls `api.instagram.com` (NOT graph.instagram.com) — the fetch-mock must cover BOTH hosts (extend the mock's host matcher; passthrough for everything else). Token refresh calls graph.instagram.com (already mocked).

## M1 — OAuth lifecycle (connect)

Drive the real flow over HTTP with the mock: `start` (state issued) → `callback` with the mock returning a short-lived token → exchange → long-lived token → channel created `status:active` with the token.
Pass: channel row exists with the exchanged token; mock call sequence matches (short exchange, long exchange, profile `/me`); callback with a TAMPERED state → 4xx, no channel created; callback with an EXPIRED state → 4xx; callback with an INVALID code (mock 400) → clean 4xx, no partial channel row.

## M2 — token refresh lifecycle

Manual refresh (`/api/channels/[id]/refresh`) with a healthy mock: token updated, token_expires_at/refreshed_at set. Revoked token (mock 400 'Session has expired') → clean error surfaced, channel NOT left half-updated.
Pass: happy path fields consistent; revoked path returns an actionable error; TWO concurrent refreshes → the channel's token is one of the two valid responses (no torn/interleaved token), no crash.

## M3 — insights (pagination + errors)

Seed a channel; mock `/insights` (and the media/children sub-calls if the route makes them — read the route first) with: (a) a paginated response (2 pages) → totals accumulate correctly; (b) empty data → zeros, no crash; (c) 400 error → clean error surfaced; (d) malformed JSON body → no crash (classified, not 500).
Pass: response shape consistent (totals = sum of pages); no 500 on any input; error path maps to a 4xx with a message.

## M4 — backup & restore integrity

(a) Create: backup API → file exists under data/backups, name pattern backup-YYYYMMDD.db; running twice same day is idempotent (skipped); >7 backups → pruned to 7.
(b) Restore: restore the just-created backup → 200; the live DB still opens and `PRAGMA integrity_check` == ok (the restored DB is a valid sqlite file); a `prod.db.pre-restore` emergency copy exists.
(c) Abuse: restore with `../` traversal name or nonexistent name → 4xx, live DB untouched (hash of prod.db unchanged).
Pass: all of the above with file-level evidence (sizes, hashes, integrity check output recorded).

## M5 — trim correctness

Tiny real video (generate a 3s test clip with ffmpeg at harness setup — if ffmpeg is unavailable in the test env, record it and SKIP with a documented note instead of faking): trim with start=0.5s end=2.5s → output exists, duration within tolerance of 2s (±0.3s); trim start>=end → 400; trim beyond duration → 400; nonexistent source path → 4xx, no crash; corrupt file (garbage bytes) → clean error, no hang (bounded time).
Pass: outputs verified with ffprobe (or duration probe via the app's own helper).

## M6 — thumbnail generation

Video thumbnail (small clip): output is a valid image file (magic bytes + dimensions via the app's reader). Image thumbnail: same. Corrupt input → clean error, no crash, no partial file left.
Pass: files exist, valid image magic, no orphan partial files in uploads.

## M7 — ImageEditorModal (visual, Playwright)

Open the editor from the content library on an image item; perform a crop + save → saved item updated; modal open/close; console errors == 0; mobile 390×844 no h-scroll.
Pass: console/page errors 0; screenshots at both viewports; save produces a changed file (or API update).

## Gates (every round)

`npx tsc --noEmit` 0 · touched-file eslint 0 · `npm run build` 0 · M1–M7 green. Baseline on current code recorded first (round-00) — failing scenarios are the value. Documented skips (e.g. ffmpeg absent) must be explicit, not silent.

## Out of scope

Planner/publisher logic (modules 01/03), content CRUD (module 02), upload (won earlier).
