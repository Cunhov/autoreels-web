# Publisher gauntlet harness (`scripts/gauntlet/`)

Drives the REAL app (next build + standalone server) with the Instagram/Facebook
Graph API **mocked in-process** — no real IG call can leave the machine.

## Run

```bash
bash scripts/gauntlet/boot.sh            # full: db push + build + server + P1–P12
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
  scenario, triggers `POST /api/cron/publisher` with `x-cron-auth`, asserts P1–P12
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
- **P3** needs three ticks (children init → carousel group container → poll+publish): the bar
  asserts 4 total child-create calls (2 ok + 1 deterministic 500 + 1 retry of the missing child),
  3 unique stored ids, 0 dupes, 0 orphans (a third tick with the same
  rules reaches `published`). Current code re-creates all children after a partial failure → 6.
- **P9** split into P9a (order + bounded tick: 10 ready posts, 5 per tick cap, each post exactly
  once) and P9b (budget: one pending post with a 44s media-create delay forces
  `results.timeout === true` — the 45s `MAX_EXEC_MS` can never fire with the phase-3 `take: 5`
  cap alone).

## IG Automation harness (`ig-*`, module-08)

Bar: `docs/IG_AUTOMATION_SPEC.md` §15 (G1–G15) + regressões G16–G19 dos fixes do
crítico (echo do próprio bot, SSRF outbound, simulador com rascunho, throttle
multi-ação + outbound `action.sent`/`sequence.step`).

```bash
bash scripts/gauntlet/ig-boot.sh   # db push + build + two phases + G1-G15
```

- `ig-boot.sh` — temp dir, `prisma db push` on a throwaway DB, `next build`, then
  **two server phases** sharing the DB/mock files: phase A (G1–G15) with
  `OPENROUTER_API_KEY` set (G12 asserts the mocked AI reply); phase B (`--scenarios G12`)
  with the server started **without** `OPENROUTER_API_KEY` (G12 asserts the
  `OPENROUTER_API_KEY não configurada` failure). Envs: `DATABASE_URL`,
  `NEXTAUTH_SECRET`, `CRON_SECRET`, `INSTAGRAM_CLIENT_SECRET`,
  `INSTAGRAM_CLIENT_ID` (G16a compara com `message.app_id`),
  `META_WEBHOOK_VERIFY_TOKEN`, `PUBLIC_BASE_URL`, `IG_MOCK_STATE`/`IG_MOCK_CALLS`.
  Evidence: `gauntlet-runs/module-08-ig-automation/gates/round-<HHMMSS>-ig-automation.md`
  (+ `-server.log`, `-calls.jsonl`, `-out-a/`, `-out-b/`). Exit 0 only if both phases pass.
- `ig-automation-scenarios.mjs` — seeds User/Channel/IgAutomation(+actions)/IgSubstance/
  IgSequence/IgOutboundWebhook directly via Prisma (better-sqlite3), mints a NextAuth
  session JWT for G14 scoping, POSTs `/api/webhooks/instagram` with HMAC
  `x-hub-signature-256` computed from `INSTAGRAM_CLIENT_SECRET`, and advances time by
  editing `run_at`/`next_run_at` in the DB + `POST /api/cron/automation` (x-cron-auth) —
  no long sleeps. Every call to a mock host that misses all rules (kind `unmatched`)
  fails the scenario with `UNMATCHED_MOCK`.
- `fetch-mock.mjs` (additive) — OpenRouter hosts `openrouter.ai` (current
  `OPENROUTER_API_URL` in `lib/ai.ts`) and `api.openrouter.ai` added to the mock hosts; the
  notify branch records the request `body` and lowercased `headers` on `kind:"notify"`
  rows so G11/G19 can verify the outbound HMAC/payload. Outbound webhooks use
  `https://example.org/hook`: the SSRF guard resolves DNS before the fetch and
  `*.invalid`/`*.local` never pass, so the harness points at a public, resolvable
  host that `fetch-mock` intercepts (`mock-webhook.invalid` kept for other harnesses).
- `ig-core.mts` — unit checks (61), unchanged: `npx tsx scripts/gauntlet/ig-core.mts`.
- G16–G19 (regressões): G16 echo com `message.app_id == INSTAGRAM_CLIENT_ID` e echo
  correlacionado por `message_id` em `IgActionLog.response` → `skipped`/`echo_do_bot`
  sem pausa; echo humano → pausa 24h + DM seguinte bloqueado. G17 URL de metadata
  rejeitada na API (`400 URL não permitida`) e, se inserida direto no DB, bloqueada
  no dispatch (`failed URL bloqueada (SSRF)`, zero fetch). G18 `POST
  /api/automations/simulate` com `draft` (match → `matched.automationId="draft"`,
  inválido → 400, não-match → cai na automação persistida). G19 rate limit com 3
  ações → 3 `IgJob` de offset crescente (+60s/+70s/+75s) e, ao drenar, outbound
  assinado `action.sent` (private+public) e `sequence.step`.

Documented deviations: on `bot_pause` the engine writes `IgEvent.status="paused"`
(not `skipped`); G4 accepts either status and asserts zero sends during the pause.
G15 lowers `ig_max_sends_per_minute` to 2 via `PUT /api/ig/settings` (same throttle
code path as the 30/min default, deterministic and fast) and asserts the overflow
becomes a pending retry job at ~now+60s. G12 (fase sem chave): erro de configuração
é permanente (`isPermanentActionError` inclui "não configurad"), então o cenário
exige `IgEvent.status="failed"` + `IgActionLog failed` com `OPENROUTER_API_KEY não
configurada`, zero chamadas Graph/OpenRouter e **nenhum** job de retry.

## Sanity checks

```bash
node --check scripts/gauntlet/fetch-mock.mjs
node --check scripts/gauntlet/publisher-scenarios.mjs
node --check scripts/gauntlet/ig-automation-scenarios.mjs
bash -n scripts/gauntlet/boot.sh
bash -n scripts/gauntlet/ig-boot.sh
```
