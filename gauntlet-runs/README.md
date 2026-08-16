# Gauntlet Program — autoreels-web deep improvement

Continuous queue of per-module gauntlet loops (same method as the upload gauntlet that won:
harness proves the failure → builder waves → harsh fresh-context critics → ratchet → gates).
Evidence layers per module: invariant harnesses (required) + Playwright visual (UI modules) +
performance budgets (UI modules). Delivery: local commits on every win; push only on user order.

## Queue

| # | Module | Run dir | Status |
| --- | -------- | --------- | -------- |
| 1 | **Pipeline de publicação** (cron/publisher 912ln + planner-runtime publish path + lib/instagram) | `gauntlet-runs/module-01-publisher/` | ⏳ in flight |
| 2 | **Content Library** (ContentLibrary.tsx 2615ln + content-items API + storage/deleteFiles) | `gauntlet-runs/module-02-content/` | pending |
| 3 | **Planners** (planner-runtime.ts 713ln + PlannerWizard 1134ln + planners API) | `gauntlet-runs/module-03-planners/` | pending |
| 4 | **Canais + Media + Backup** (instagram OAuth/token lifecycle, ImageEditorModal/trim/thumbnail, backup/restore, insights) | `gauntlet-runs/module-04-channels-media/` | pending |

Live status page: `gauntlet-runs/index.html`.

## Program rules (inherited from the upload gauntlet)

- Every module bar must be fetchable + measurable: executable scenarios that FAIL on current code (recorded in the module's `gates/`), gates = `npx tsc --noEmit` + touched-file eslint + `npm run build` + scenario harness green.
- One harness framework for the program: `scripts/gauntlet/` (shared boot-server, session JWT, fetch-mock for the IG API, record/report lib). Module scenarios import the framework. The upload harness (`scripts/upload-gauntlet/`) stays as-is until a module run proves the shared framework against the same scenarios.
- Mocks: the IG/FB Graph API is mocked via a fetch preload so success/429/5xx/timeout paths are deterministic per scenario WITHOUT touching product code for testability.
- Critic rule: fresh context, binary verdict per scenario, names the single biggest gap; NOT-WIN sends it back. Reconciliation agent after each wave. Stop conditions: win / diminishing returns / user stop.
- No deploy, no spend, no credentials. Production env untouched.
