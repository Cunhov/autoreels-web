# Module 03 — Planners: the bar (scenarios PL1–PL8)

Reference: `lib/planner-runtime.ts` (713 ln — runPlannerOnce, resolvePlannerRuntime, buildPostData, template/state machinery), `lib/planner-config.ts` (240 ln — parse/validate), `components/PlannerWizard.tsx` (1,134 ln), `app/api/planners/*`, `app/api/admin/fix-planners/route.ts`, and the Phase-0 invocation in `app/api/cron/publisher/route.ts`.

Harness: reuse `scripts/gauntlet/` boot (server + temp DB + session JWT). Two drive modes: (a) integration — seed planners, trigger `POST /api/cron/publisher` ticks (Phase 0 runs all active planners); (b) direct — import `runPlannerOnce` in a node script for concurrency tests that need in-process timing.

## PL1 — atomic claim: concurrent runs never double-create

Seed an ACTIVE planner due now with 2 publishable channels. Fire two `runPlannerOnce` calls concurrently (direct mode, Promise.all).
Pass: exactly one returns ok/created>0; the other returns `skipped:'already_running'`; exactly N posts created for N channels (no duplicates); `last_run` advanced once.

## PL2 — temporal gates (due / start_time / sleep)

(a) due: planner with last_run = now → NOT due (skipped `not_due`), no posts; last_run 10 min ago with interval 5 min → due (within the 15s slack).
(b) start_time: future start_time → skipped `start_time`, no posts; past → runs.
(c) sleep schedule: config with an active sleep window (read planner-config for the sleep_schedule shape) → skipped `sleep`; outside window → runs.
Pass: each gate returns the exact skip code; zero posts created when skipped; `last_run` NOT advanced by a skip (tick not consumed).

## PL3 — config edge cases fail cleanly

PL3-hashtags (user-reported bug fixed 2026-08-16): `{hashtags}` resolves to
`#tag1 #tag2` from the selected content's tags (ContentItem.tags JSON array) —
was hardcoded empty; rotation `off` + templates still uses the base caption;
wizard auto-switches rotation to `sequential` when the user types a template
(was silently ignored with rotation off).

Seed planners with: invalid frequency value (0/negative/garbage), missing channels, invalid JSON config, unknown template placeholders.
Pass: each returns skipped with a specific code (`invalid_config` / `no_channels` / `resolution_failed`); no exception escapes (no 500 in the cron run); zero posts; `last_run` untouched.

## PL4 — template exhaustion and rotation

Planner with 3 templates, template_index persisted at 3 (exhausted) and at 2.
Pass: at index 2 → creates post with template 3 (index 2) and advances to 3; at index 3 (exhausted) → defined behavior (wrap to 0 OR skip with a warning — assert whichever the code does, documented); no crash, no post with an undefined template. Also: template_index increments by the number of POSTS created (multi-channel planners advance once per post, not once per run) — assert the persisted state matches created posts exactly.

## PL5 — channel health filtering

Planner with 3 channels: 1 inactive (status != active), 1 with garbage/expired token (health false), 1 healthy.
Pass: exactly ONE post created (healthy channel only); the skip is explicit (`no_publishable_channels` when ALL are blocked); blocked channels never receive posts; run still advances template index by 1.

## PL6 — post-claim failure reverts the claim (tick not consumed)

Direct mode: force a failure AFTER the claim and BEFORE posts are created (e.g. mock prisma create to throw once, or seed a state that makes buildPostData throw — read the revert logic around line 694).
Pass: `last_run` is rolled back (or the claim path returns a failure that lets the NEXT run fire); the next run succeeds and creates the posts; no post is created twice; no stuck 'already_running' planner.

## PL7 — fix-planners admin route (regression guard)

Seed a planner in a broken state (e.g. last_run in the future, or state/config mismatch that the fixer targets — read app/api/admin/fix-planners/route.ts first to learn what it fixes).
Pass: the fixer reports the planner, fixes it, and the planner then runs normally (one cron tick creates posts).

## PL8 — wizard (visual + functional, Playwright)

`/planners` page: (a) renders the list with statuses; (b) new-planner flow: fill a minimal config, save → planner appears with the right summary; (c) edit flow: change frequency, save, persists; (d) validation: empty/invalid config shows an inline error and does NOT submit; (e) mobile 390×844: no horizontal scroll, no clipped controls.
Pass: console errors == 0 in all flows; screenshots at 1440×900 + 390×844; pixel-diff vs pre-gauntlet baseline captures shows no layout regression; the critic judges flows blind if visuals changed.

## Gates (every round)

`npx tsc --noEmit` 0 · touched-file eslint 0 · `npm run build` exit 0 · scenarios PL1–PL8 green. Baseline on current code recorded first (round-00) — failing scenarios are the value.

## Out of scope

Planner → post publishing lifecycle (module 01), calendar UI (not in this module), insights (module 04).
