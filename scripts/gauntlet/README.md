# Publisher gauntlet harness (`scripts/gauntlet/`)

Drives the REAL app (next build + standalone server) with the Instagram/Facebook
Graph API **mocked in-process** — no real IG call can leave the machine.

## Run

```bash
bash scripts/gauntlet/boot.sh            # full: db push + build + server + P1–P11
MODE=dev bash scripts/gauntlet/boot.sh   # dev fallback (used automatically if build fails)
RUN_DIR=/tmp/my-gates bash scripts/gauntlet/boot.sh  # override evidence dir
```

Exit 0 only when all scenarios pass. Evidence: `gauntlet-runs/module-01-publisher/gates/round-<HHMMSS>-{baseline.md,server.log,calls.jsonl}`.

## Components

- `boot.sh` — temp dir, `prisma db push` on a throwaway DB, `next build`, starts the
  standalone server with `node --import …/fetch-mock.mjs server.js`, `PUBLIC_BASE_URL`,
  `CRON_SECRET`, `IG_MOCK_STATE` + `IG_MOCK_CALLS` envs; waits for `/api/health`; records baseline.
- `fetch-mock.mjs` — ESM preload patching `globalThis.fetch`:
  - hosts `graph.instagram.com` / `graph.facebook.com` / `mock-webhook.invalid` are mocked;
  - everything else passes through the original fetch;
  - rules from `IG_MOCK_STATE` (`{rules:[{match?, matchBody?, matchRegex?, method?, responses:[{status?,body?,delayMs?}]}], consumed:{}}`);
    FIFO per rule, last response repeats; every mocked call appends a JSONL row to `IG_MOCK_CALLS`
    (`{ts,method,url,body,status,kind}`; kind `mock` | `notify` | `unmatched`);
  - unmatched mock-host calls → `404 {"error":{"message":"UNMATCHED_MOCK …"}}` (recorded);
  - `delayMs` honors the caller's AbortSignal (abort → `AbortError`).
- `publisher-scenarios.mjs` — seeds DB rows (User/Channel/Post/AppConfig), writes mock rules per
  scenario, triggers `POST /api/cron/publisher` with `x-cron-auth`, asserts P1–P11
  (`gauntlet-runs/module-01-publisher/refs/bar-scenarios.md`), prints PASS/FAIL + evidence.

## Mock rule contract (used by the scenarios)

- `match` — substring of the URL (`"media_publish"`, `"?fields=status_code"`, `"refresh_access_token"`).
- `matchBody` — substring of the URL-encoded request body → distinguishes carousel children by
  their media URL (`"a.mp4"`) and the carousel group create (`"CAROUSEL"`).
- `matchRegex` — regex source tested against the full URL.
- `method` — GET/POST (optional).
- `responses` — FIFO; index advances per matching request; last entry repeats. This is how
  “first call 429, then success” (P4) and “child b fails on tick 1, succeeds on tick 2”
  (P3, via per-tick state rewrite) are expressed.

## Notification webhook

`sendNotification` (lib/notify.ts) reads AppConfig; the harness seeds
`NOTIFY_WEBHOOK_URL=https://mock-webhook.invalid/hook` (Telegram keys absent), so every
`notifyPostFailed` is recorded by the mock as `kind:"notify"` — count to assert notifications.

## Deviations from the bar (documented)

- **P1**: the bar says container polls return `FINISHED`; the harness returns `IN_PROGRESS`.
  With FINISHED, phase 2 would turn the 3h-old stuck posts into _published_ (convergent
  terminal), which is the P2 path; the deterministic way to exercise the 2h/15min reclaim
  (the actual point of P1) is IN_PROGRESS so phase 2.5's timeout marks them failed.
- **P9**: `next build`/start overhead excluded from the 60s wall assertion (measured from the
  tick HTTP call itself).
- **P2** is split into P2a/P2b/P2c rows but reported as a single P2 verdict (bar groups them).
- **P3** needs three ticks (children init → carousel group container → poll+publish): the bar's
  "exactly 3 child creates" is asserted across the first two ticks (a third tick with the same
  rules reaches `published`). Current code re-creates all children after a partial failure → 6.
- **P9** split into P9a (order + bounded tick: 10 ready posts, 5 per tick cap, each post exactly
  once) and P9b (budget: one pending post with a 44s media-create delay forces
  `results.timeout === true` — the 45s `MAX_EXEC_MS` can never fire with the phase-3 `take: 5`
  cap alone).

## Sanity checks

```bash
node --check scripts/gauntlet/fetch-mock.mjs
node --check scripts/gauntlet/publisher-scenarios.mjs
bash -n scripts/gauntlet/boot.sh
```
