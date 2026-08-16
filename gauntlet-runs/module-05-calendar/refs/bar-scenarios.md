# Module 05 — Calendar & Scheduling: the bar (scenarios C1–C9)

Reference: `app/api/calendar/route.ts` (116 ln), `components/Calendar/{MonthView,WeekView,DayDetailsModal,CalendarHeader,PostStatusModals,LocalPreviewModal}.tsx` (~1,200 ln), `app/calendar/page.tsx`, `app/api/posts/route.ts` + `app/api/posts/[id]/route.ts` (post CRUD the calendar uses).

Harness: shared `scripts/gauntlet/` boot (server + temp DB + session JWT + Playwright). Evidence layers: invariant harness (C1–C6 over real HTTP) + visual/perf (C7–C9).

## C1 — calendar window query correctness

Seed posts across: inside the month window, before it, after it, `scheduled_at: null`, `status: published`.
Pass: GET /api/calendar?start=&end= returns exactly the in-window posts (null-scheduled and out-of-window excluded — read the route to confirm the documented contract), ordered by scheduled_at asc, with the fields the UI needs (status, media, planner, channel, thumbnail). No crash on: start>end (documented behavior — likely empty), missing params (4xx), non-ISO dates (4xx or empty — assert whatever the code does, no 500).

## C2 — move/reschedule invariants

PATCH a post's scheduled_at via the posts API (or the calendar route if it supports moves).
Pass: after the move the post is in the new window and NOT in the old one; a move to the past (already past) is rejected or handled cleanly (assert the contract: no post silently published in the past); concurrent moves of the same post converge (final = one of the two, no 500); moving to a slot that would violate the global publish interval is allowed at the scheduling layer (posts are queued; the publisher throttles) — document the contract.

## C3 — delete from calendar

DELETE a post from the calendar view.
Pass: row gone, no orphan references (channel/planner untouched), calendar window no longer shows it; deleting a published post is rejected or documented (assert contract).

## C4 — status transitions visible in the UI data

Seed posts in every status the UI colors (pending, processing, processing_upload, ready_to_publish, published, failed, throttled?).
Pass: GET /api/calendar returns them all with status; the UI maps every status to a color/badge without crashing (Playwright: month view renders a day containing all statuses — no console errors, every badge class resolves).

## C5 — planner-scheduled posts appear correctly

Seed a post created by a planner (planner_id set, scheduled_at from the planner's runtime).
Pass: appears in the window at the right day/time; DayDetailsModal shows the planner name; the "reschedule from calendar" flow (if the UI has one — check DayDetailsModal) persists without losing the planner link.

## C6 — large-window / pagination robustness

Seed 300 posts across 3 months + one day with 40 posts.
Pass: the calendar API returns all (no artificial cap or a documented one); month view with 40 posts in one day renders (no crash, no console error); week view renders; performance budget (C9) holds.

## C7 — visual (Playwright, desktop 1440×900 + mobile 390×844)

Flows: month view renders with posts + statuses; day modal opens with post details; week view renders; month navigation (prev/next) works and updates the window; mobile: no horizontal scroll, no clipped day cells.
Pass: console errors == 0 across all flows; screenshots saved to out/; pixel-diff vs pre-gauntlet baseline shows no layout regression; the critic judges blind if the visuals changed.

## C8 — timezone consistency

The route returns ISO timestamps; the UI renders them in the user's local timezone (read how MonthView formats — pt-BR locale?).
Pass: a post at 23:30 UTC renders on the CORRECT day in a non-UTC timezone (e.g. America/Sao_Paulo, UTC-3) — the harness sets TZ env on the browser/server and asserts the day-cell placement matches the local date, not the UTC date. This is the classic calendar bug class.

## C9 — performance budget

Baseline measured pre-gauntlet on this machine: seed 300 posts, month view with the heaviest month (40+ posts/day).
Pass: initial render + navigation ≤ baseline × 1.1; no frame gap > 200 ms during month navigation (rAF probe); numbers recorded in gates/.

## Gates (every round)

`npx tsc --noEmit` 0 · touched-file eslint 0 (no new errors) · `npm run build` 0 · C1–C9 green. Baseline on current code first (round-00) — failing scenarios are the value.

## Out of scope

Publisher lifecycle (module 01), planner runtime (module 03), content library (module 02).
