# The Bar — adversarial scenarios the upload pipeline must survive

The bar is NOT a visual reference. It is a set of reproducible failure scenarios that the
production log proves the current code fails. The candidate wins by surviving every scenario
with zero errors, verified by an executable test suite (the measurable half).

## Scenario A — listener leak under stress

Reproduce: N files × M chunks through the real endpoints (or route-handler harness) with
concurrent tasks (client MAX_CONCURRENT=3).

Pass:

- Zero `MaxListenersExceededWarning` in process stderr (assert: no process warnings of any
  kind during the run).
- All files finalize; final byte size equals source; SHA-256 of final file equals source hash.
- No dangling listeners after completion: process can `process.emitWarning`-free close; or
  (harness) listener count on the shared WriteStream never exceeds 2 during concat.
- `npx tsc --noEmit`, `npm run lint`, `npm run build` all green.

## Scenario B — overlapping finalize (client timeout → retry race)

Reproduce: upload all parts for path P, then fire TWO `/api/upload-chunk/complete` POSTs for P
simultaneously (also: fire the second one 80% through the first, e.g. with a slow thumbnail).
Also fire a `DELETE /api/upload-chunk?path=P` mid-finalize (simulating user cancel during
finalize) and a chunk POST for a part index mid-finalize.

Pass:

- Exactly one final ContentItem; no 500; the loser gets a clean, idempotent result (e.g. the
  same item, or a 409 with a retryable/terminal contract the client handles).
- No ENOENT anywhere in server logs during the scenario.
- Final file intact and hash-matches; no orphan `.part.*` files; no `.finalizing`/lock litter.
- All subsequent uploads to the same path work normally.

## Scenario C — duplicate names / staging collision

Reproduce: two tasks uploading the SAME filename into the SAME folder concurrently (the
production log shows identical filenames failing repeatedly — e.g. Botox…mp4 × 5 attempts).

Pass:

- No chunk from task B can clobber a part task A is reading; no ENOENT; both finalize
  successfully (dedupe-by-name semantics may merge them into one ContentItem — that is the
  existing contract — but never a corrupt file or a 500).
- Resume (status endpoint) still works within a retry of the same task.

## Scenario D — invalid IG token (ChannelRefresh)

Reproduce: create a Channel row with `platform: 'instagram'`, `status: 'active'`,
`access_token` = a garbage/non-IG token (e.g. a JWT-looking string), then run the
refresh-due-channel-tokens logic.

Pass:

- Channel is marked (status/error field) and NOT re-attempted on every tick (no log spam —
  at most one `[ChannelRefresh]` error line per channel, then a terminal state).
- Valid tokens still refresh normally (existing behavior preserved).
- The error message shown is actionable (e.g. "reconnect channel") without leaking secrets.

## Scenario E — recovery after failure

Reproduce: an upload that fails mid-chunks (simulate network drop after chunk 3 of 10), then
a retry via the status endpoint (resume contract).

Pass:

- Resume re-sends only missing chunks; complete succeeds; file hash-matches.
- A stale `.part` set with no active client gets cleaned eventually (no unbounded litter) —
  e.g. finalize failure cleans its own parts, cancel cleans its parts.

## Gate commands (every round, every candidate revision)

- `npx tsc --noEmit` — zero errors
- `npm run lint` — zero errors
- `npm run build` — exit 0
- New executable test(s) covering A–E, runnable via a script (prefer `scripts/` + node
  harness that imports the route handlers or exercises them via a local server; a `npm test`
  script addition is welcome). Tests must FAIL on the current code (prove it: run them once
  against HEAD before the first builder round and record the failures in gates/).

## Recording

- `gates/` — per-round gate output (tsc, lint, build, scenario runs) with timestamps.
- `out/` — per-round: the scenario test results + hash manifest + server log excerpts.
- `decisions/` — one line per round: verdict and the single biggest remaining gap named by
  the critic.
