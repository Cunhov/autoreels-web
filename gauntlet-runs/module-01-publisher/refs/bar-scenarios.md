# Module 01 — Publisher pipeline: the bar (scenarios P1–P11)

Reference: `app/api/cron/publisher/route.ts` (handler, 913 ln), `lib/instagram.ts`, `app/api/cron/publisher/route.ts` phases:
-1 cleanup no-media pending → 0 planners (out of scope: module 03) → 1 claim+container (single+carousel) → 2 poll + 2.5 stuck reclaim → 3 ready→publish (+throttle, retries via `handleRetryableFailure`, notifications via `notifyPostFailed`).

The executable harness drives the REAL standalone server (next build + next start) with a **preload fetch-mock** intercepting `https://graph.instagram.com` / `https://graph.facebook.com` (and the notification webhook URL) — scripted per scenario, counting every call. No product code is modified for testability.

Every scenario asserts on: post status transitions in the test DB, mock call counts, server log, and (where relevant) notification webhook hits.

## P1 — stuck posts always converge (reclaim works)

Seed: (a) a post stuck `processing` with NO container id, created 20 min ago; (b) a post stuck `processing_upload` 3 h ago (last_attempt_at 3 h ago) WITH container; (c) a post `processing_children` 3 h ago. Mock: container status polls return FINISHED.
Pass: after ONE tick — (a) back to `pending`; (b) and (c) `failed` with `failed_reason='Processing Timeout'`. No post remains in a non-terminal status with no path forward. No ENOENT/no crash.

## P2 — exactly-once publish semantics

(a) Happy path: ready post, mock media_publish returns `{id}` → status `published`, `instagram_media_id` set, EXACTLY ONE media_publish call.
(b) Double-publish convergence: ready post whose container the mock answers with the documented "already published" error → post `published` WITHOUT a second publish attempt loop (assert: exactly one media_publish call this tick, status published, no error).
(c) Process-death simulation: seed `ready_to_publish` + mock in "publish already happened" mode → next tick → published, exactly once.
Pass: `results.published` increments consistently; no post ever goes published→something-else; DB count of published posts for the seed set == 1 each.

## P3 — carousel partial failure, no duplicate children

Seed a carousel post (children_urls = 3) with the mock failing child #2 (500) on container init.
Pass: post → `processing_children` with the 2 good children recorded (instagram_child_ids), failure recorded; EXACTLY 2 container-create calls (no re-creation of good children on the retry tick); next tick with mock healthy creates ONLY the missing child (total container-create calls == 3); post eventually `published` exactly once.

## P4 — rate-limit (429) stops the batch, nothing lost

Two ready posts, same tick; mock returns 429 on the first media_publish.
Pass: first post keeps a retryable status (not failed, not published, attempts bumped); SECOND post is NOT touched in the same tick (batch stop); next tick with healthy mock publishes BOTH exactly once; total publish calls == 2 (not 3+).

## P5 — definitive failure → failed + notified

Ready post; mock returns 400 `{"error":{"message":"OAuth invalid"}}`.
Pass: post `failed` with `failed_reason` set; webhook notification recorded once; NOT retried on following ticks (publish calls == 1 total).

## P6 — transient budget is finite

Ready post; mock returns 500 every tick, 6 ticks.
Pass: attempts increments 1..5; on the 6th (or by MAX_TRANSIENT_ATTEMPTS) post → `failed`; total media_publish calls bounded (<= 6); no infinite retry; `last_attempt_at` monotonic.

## P7 — global + per-channel throttle

Channel settings `max_posts_per_hour=1`; two ready posts to it, same tick.
Pass: exactly one published this tick; the other stays `ready_to_publish` (throttled), never lost; published next tick once the interval window is satisfied. Global interval path exercised by a second scenario with `AppConfig` global interval > 0 (only one post publishes across two ticks).

## P8 — invalid token mid-batch fails cleanly

Ready post on a channel whose access_token is garbage; mock 400.
Pass: post `failed` (definitive) + notified; server does NOT crash; `[ChannelRefresh]` spam absent (<=1 line total — the round-3 fix must not regress); next refresh passes are not re-attempted (token_expires_at null).

## P9 — execution budget respected, no runaway

Seed 10 ready posts; mock median latency ~300 ms/call.
Pass: the tick returns within a bounded wall time (assert < 60 s and `results.timeout === true`), processes posts in created_at order (no starvation: oldest first), never processes the same post twice in one tick, and no post is left in a limbo state after subsequent ticks finish the queue.

## P10 — duplicate tick rejected

Fire TWO concurrent POST /api/cron/publisher with the same valid x-cron-auth.
Pass: exactly one returns `skipped: true` (in-process lock), the other runs; no post double-claimed or double-published; results counters from the winner only.

## P11 — no-media posts are cleaned (phase -1 preserved)

Seed a `pending` post with no video_url/image_url/children_urls.
Pass: after the tick → `failed` (reason 'Missing Media') + notification; not retried.

## Gates (every round)

`npx tsc --noEmit` (0), touched-file eslint (0), `npm run build` (exit 0), scenarios P1–P11 green via the module harness. Record failing baseline on current code in `gates/round-00-…` BEFORE any fix (P-scenarios must FAIL today — that is the proof of value).

## Out of scope (later modules)

- Planner creation logic (module 03), IG insights (module 04), thumbnail/trim (module 04), refreshDueChannelTokens internals beyond "must not regress" (already fixed in the upload gauntlet).
