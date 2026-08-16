# Module 03 — Round 00: harness + baseline (commit 856d33e, prod mode)

## Harness delivered (test infra only — no product changes)

- `scripts/gauntlet/planner-direct.mts` (PL1–PL6, tsx): in-process `runPlannerOnce` vs the temp DB. Concurrency (PL1), temporal gates (PL2), config edges (PL3), template rotation/exhaustion (PL4), channel health (PL5), post-claim revert (PL6).
- `scripts/gauntlet/planner-scenarios.mjs` (PL7 + PL8-API): HTTP — fix-planners dry-run/fix + one cron tick under the IG fetch-mock (0 real-IG calls), plus the wizard-payload acceptance check.
- `scripts/gauntlet/planner-visual.mjs` (PL8): Playwright wizard flows (list/create/edit/validation/mobile), zero console errors required.
- `scripts/gauntlet/planner-run.sh`: prod boot (CRON_SECRET + IG mock + static copy) → visual → scenarios → direct.

## Baseline (8/10 scenario-level pass; 2 FAIL — both real findings)

- PL1..PL7: PASS (claim race, gates, config edges, template wrap, health filter, claim revert, fix-planners regression all hold).
- **PL8-API FAIL (critical finding)** — the planner WIZARD's default payload (`start_time: ""`) is rejected by `validatePlannerConfig` ("start_time deve ser uma data ISO válida", HTTP 400). Because the wizard ALWAYS sends `start_time: ""` when "Start When?" is left empty, **the wizard cannot create or edit a planner in the default flow**. Reproduced independently via direct API POST. The runtime itself treats `''` as "no gate" (`if (config.start_time && ...)`) — the validation just needs to mirror that (accept empty as absent).
- **PL8 visual FAIL (UI finding)** — mobile 390×844 has `mobileHScroll=10px` on /planners (overflow source: page header/list row; 0 console errors, all functional flows pass). Bar threshold is ≤2px.

## Documented behaviors (not failures)

- PL3: unknown caption placeholders (`{unknown_var}`) stay LITERAL in the saved caption — not resolved, not rejected.
- PL4: `template_index` exhaustion WRAPS (modulo); with N channels it advances by N per run (per-post rotation).
- `invalid_frequency` skip code is unreachable via config (validation rejects those inputs first).
- PL5: template_index only written when caption templates are active (by design).

## Repro for the PL8-API bug

POST /api/planners with the wizard payload (name, channel_ids, config{ frequency, start_time: "" }) → 400 `Invalid planner config` / `start_time deve ser uma data ISO válida`. Fix candidates: server accepts `start_time` empty/whitespace as absent, or the wizard omits `start_time` when unset.
