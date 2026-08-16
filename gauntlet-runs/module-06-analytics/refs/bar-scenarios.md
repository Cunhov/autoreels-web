# Module 06 — Analytics + Settings + Channels UI: the bar (scenarios S1–S8)

Reference: `app/analytics/page.tsx` (975 ln), `app/api/channels/[id]/insights/route.ts` + `app/api/ig-insights.ts` (module-04 already hardened the API honesty), `app/api/cron/metrics/route.ts` (111 ln), `app/settings/page.tsx` (422 ln) + `app/api/settings/route.ts` (134 ln), `app/channels/page.tsx` (337 ln) + `components/ChannelModal.tsx`, `app/api/channels/[id]/test/route.ts`.

Harness: shared `scripts/gauntlet/` boot + fetch-mock (IG insights/me endpoints already mocked). Evidence layers: invariants (S1–S4) + visual/perf (S5–S8).

## S1 — analytics aggregation correctness

Seed PostMetric rows across: the current week, previous weeks, zero-data months, a month with a single metric.
Pass: the analytics API/page aggregates correctly per the UI's period selector (week/month): totals match the seeded rows summed; a zero-data period renders zeros (no crash, no NaN, no '-'); the 'previous period' comparison handles a zero previous period (no division-by-zero, no NaN%). Read app/api/cron/metrics + how the page fetches (probably /api/channels/[id]/insights or a metrics route — read first) and assert the REAL contract.

## S2 — metrics cron idempotency & bounds

The metrics cron (app/api/cron/metrics/route.ts) upserts PostMetric rows.
Pass: running it twice for the same period does NOT double-count (same totals); posts without a published_at or with status != published are excluded or handled per the documented contract; the cron respects an execution budget if one exists; no crash on an empty posts table.

## S3 — settings CRUD + validation

GET/PATCH /api/settings (AppConfig): read the model — keys, value types, validation rules (e.g. PUBLISH_MIN_INTERVAL_SECONDS numeric, webhook URL format?).
Pass: PATCH with a valid payload persists and GET returns it; PATCH with an invalid value (wrong type / out of range / bad URL) → 4xx with a message, value unchanged; PATCH of an unknown key → 4xx or documented behavior; the settings page (UI) renders the saved values after reload and shows inline errors on invalid input without submitting (Playwright).

## S4 — channels page + test endpoint

Seed channels in states: active with valid token, inactive, no token, garbage token.
Pass: /api/channels/[id]/test with the mock returns the right classification (mock 200 → ok; mock 400 → error surfaced; no crash); the channels page renders each state without console errors; the ChannelModal (add/edit) flows work: open, fill, save → channel appears; validation on empty fields.

## S5 — analytics page visual (Playwright)

Seed a realistic metric set (several channels, weeks of data). Flows: page renders with numbers, period selector switches week/month without errors, channel filter, empty-state for a zero-data channel.
Pass: console errors == 0; screenshots desktop + mobile (390×844 no h-scroll); no layout regression vs pre-gauntlet baseline captures (pixel-diff); the critic judges blind if visuals changed.

## S6 — settings page visual (Playwright)

Flows: render with saved values, edit a value + save → persisted (API verified), invalid input shows inline error and does not submit, mobile no h-scroll.
Pass: console errors == 0; screenshots; interactions verified against the API (not just the DOM).

## S7 — channels page visual (Playwright)

Flows: list renders with status badges, connect flow (start OAuth with the mock → callback → channel appears), test button shows result, refresh button works, mobile no h-scroll.
Pass: console errors == 0; screenshots; the full connect flow works end-to-end against the mock (module-04 M1 covers the API; here the UI drives it).

## S8 — performance budgets

Analytics with 6 channels × 12 weeks of metrics: initial render + period switch ≤ baseline × 1.1 (baseline measured pre-gauntlet, stored in gates/); max frame gap < 200 ms during switch; numbers recorded.

## Gates (every round)

`npx tsc --noEmit` 0 · touched-file eslint 0 (no new errors) · `npm run build` 0 · S1–S8 green. Baseline on current code first (round-00) — failing scenarios are the value.

## Out of scope

Insights API honesty (module 04 — must not regress), channels OAuth token lifecycle (module 04), calendar (module 05).
