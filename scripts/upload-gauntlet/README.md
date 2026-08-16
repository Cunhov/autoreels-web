# Upload gauntlet test harness

Executable, reproducible evidence for the upload robustness gauntlet
(`gauntlet-runs/upload-robustness/`). It boots the app in **production mode**
(next build + standalone server — the same layout Docker uses) with a fresh
temp DB and uploads dir, then drives the **real HTTP endpoints** through
scenarios A–E and asserts the bar from
`gauntlet-runs/upload-robustness/refs/bar-scenarios.md`.

This harness contains **no product fixes** — it only measures. On the current
code the expected baseline is:

```text
SCENARIO A: FAIL — MaxListenersExceededWarning found in server log
SCENARIO B: FAIL — completes ok=0/2 items=0 hashOk=false orphanParts=1 enoent=true
SCENARIO C: FAIL — completes ok=true/true items=1 matchesSource=false enoent=false
SCENARIO D: FAIL — ChannelRefresh lines=2 (bar ≤1) terminalState=false cronStatus=200/200
SCENARIO E: PASS — statusChunks=[0,1,2] complete=200 items=1 hashOk=true
```

## Run

```bash
./scripts/upload-gauntlet/run-tests.sh            # full run (build + server + scenarios)
MODE=dev ./scripts/upload-gauntlet/run-tests.sh   # force dev-mode fallback
RUN_DIR=/tmp/my-gates ./scripts/upload-gauntlet/run-tests.sh  # override gates output dir
```

- Exit code 0 only if **all** scenarios pass.
- Requires: repo deps installed, `ffmpeg`/`ffprobe` optional (only adds duration
  probing), a free local port (auto-picked).
- Runtime ≈ 2–4 minutes (includes `next build` and ~400 MB of local uploads).
- On completion it writes `gates/round-00-baseline.md` (summary + server-log
  greps) and `gates/round-00-server.log` (full server stderr/stdout), and prints
  the temp evidence dir path (per-scenario JSON in `out/`).
- `run-tests.sh` restores the repo state on exit (uploads-dir symlink removed,
  server killed via an EXIT trap). The temp dir is intentionally kept for
  inspection.

## How it works

1. Creates a temp dir with a fresh SQLite DB (`DATABASE_URL=file:<tmp>/test.db`),
   runs `prisma db push`, then `next build`.
2. Runs the standalone server (`node .next/standalone/server.js`; it
   `process.chdir()`s into `.next/standalone`, so the uploads root is
   `.next/standalone/data/uploads` — redirected via a symlink to the temp
   uploads dir). Dev mode (`next dev`) redirects `<repo>/data/uploads` instead
   and restores it on exit.
3. Auth: mints a next-auth session JWT
   (`import { encode } from "next-auth/jwt"`, `sub: "admin"`, same
   `NEXTAUTH_SECRET`), sent as the `next-auth.session-token` cookie on every
   request.
4. `harness.mjs` drives real HTTP with `fetch`:
   - `/api/upload-chunk` POST (chunks) and DELETE (cancel)
   - `/api/upload-chunk/status` GET (resume)
   - `/api/upload-chunk/complete` POST (finalize, multipart form)
   - `/api/cron/publisher` POST (token refresh, `x-cron-auth` header)
   and verifies the DB (ContentItem/Channel rows via Prisma on the test DB) and
   the resulting files on disk (SHA-256 + byte size).
5. Server stdout+stderr are captured to `<tmp>/server.log`; scenario assertions
   scan the log tail for `MaxListenersExceededWarning`, `ENOENT`,
   `Finalizing upload error`, and `[ChannelRefresh]` lines.

## Scenarios (what each asserts)

| Scenario | Reproduction | Fails when |
| --- | --- | --- |
| **A — stress/leak** | 3 concurrent uploads (4/4/20 chunks) via real endpoints | any `MaxListenersExceededWarning` in the log; any hash mismatch; ≠1 ContentItem per name |
| **B — finalize race** | 40-chunk upload, then complete at t=0, complete at t=80ms, cancel-DELETE at t=150ms, chunk re-POST at t=250ms | any `ENOENT`/`Finalizing upload error`; ≠1 successful complete; ≠1 ContentItem; hash mismatch; orphan `.part.*` files |
| **C — staging collision** | two clients interleave chunks for the SAME filename/folder | `ENOENT`/500; final file matches NEITHER source (mixed/corrupt); ≠1 ContentItem |
| **D — invalid IG token** | seed `Channel` with garbage token, run cron twice | >1 `[ChannelRefresh] <id>` line; channel not in a terminal state (status≠'active' or token_refreshed_at set) |
| **E — resume contract** | upload chunks 0-2, status → expect `[0,1,2]`, upload rest, complete | status ≠ `[0,1,2]`; complete fails; hash mismatch; ≠1 ContentItem |

## Reading evidence

- `out/summary.txt` — one line per scenario with a one-line evidence string.
- `out/scenario-<x>.json` — per-scenario detail (raw statuses, log probes,
  ContentItem/channel state).
- `server.log` — the app's own stderr; the failure signatures from production
  appear here verbatim (e.g. `Finalizing upload error: [Error: ENOENT ...part.9]`).

## Notes / deviations

- Scenario D does not call the real Instagram API: `INSTAGRAM_CLIENT_ID/SECRET`
  are intentionally unset, so `refreshInstagramToken` throws instantly
  (matching the production *signature* — log spam + no terminal state — without
  needing network). The "valid tokens still refresh" half of bar D is not
  covered by this harness (needs live IG creds); it is verified by code review
  in later rounds.
- Scenario B is deliberately sized (200 MB / 40 chunks) so the racing DELETE
  deterministically lands mid-concat on current code.
- Test media is deterministic seeded PRNG bytes (`.mp4` extension for ffprobe),
  so hashes are meaningful across runs.
- `next build` regenerates `.next/standalone`; the harness creates/removes the
  uploads symlink inside it per run.
