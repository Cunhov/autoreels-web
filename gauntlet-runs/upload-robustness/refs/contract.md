# Fixed API contract — Wave 1 (builders must implement EXACTLY this; no divergence allowed)

Ground rules:

- Staging identity: `{partBase}` = `<uploadDir>/<normalized-path>`; parts are `{partBase}.part.{i}`.
- Finalize lock: in-process `Map<string, {owner, startedAt}>` (single-process monolith — valid) AND a
  cross-process lock file `{partBase}.finalizing.lock` created with `fs.open(path, 'wx')` containing
  `pid + startedAt`. Stale = mtime older than 10 minutes → unlink and retry once. While the lock is
  held, EVERY route below behaves per contract. Lock is always released in a `finally`.
- `listPartIndices` matches only `{basename}.part.` — the lock file and any `.finalizing/` dir never
  pollute listings.

## POST /api/upload-chunk (chunk upload)

- If the finalize lock for `{partBase}` is held (fresh lock file) → `409 {"error": "Finalize in progress", "finalizing": true}`, do NOT write the part.
- Else unchanged: write `{partBase}.part.{chunkIndex}` with flags `"w"` (idempotent retries).

## GET /api/upload-chunk/status

- Existing response PLUS `finalizing: true` while the lock is held.
- Existing `chunks` / `file_size` behavior unchanged.

## DELETE /api/upload-chunk (cancel)

- If the lock is held → `409 {"error": "Finalize in progress", "finalizing": true}`, delete nothing
  (the finalize owns cleanup now).
- Else unchanged: unlink all `{partBase}.part.{i}`.

## POST /api/upload-chunk/complete (finalize) — the critical one

1. Acquire the lock (in-process + lock file). If already held → `409 {"error": "Finalize in progress", "finalizing": true}` (client will backoff-retry).
2. List parts. If NONE exist:
   - Look up ContentItem by (user_id, name, parent_id) with the existing dedupe query.
   - Found → `200 {"success": true, "item": existing, "idempotent": true}` (replay of an already-finalized upload).
   - Not found → `400 {"error": "No uploaded chunks found"}`.
3. If parts exist: verify every index `0..totalChunks-1` present (else `409 {"error": "Incomplete upload", missing}` as today).
4. CONSUME SAFELY: `mkdir <uploadDir>/.finalizing/<uuid>/`, then `rename()` each `{partBase}.part.{i}` →
   `<uploadDir>/.finalizing/<uuid>/part.{i}` (rename is atomic on the same filesystem; after this the
   part set is owned exclusively by this finalize — no other request can see or delete them).
   If any rename throws ENOENT → 500 with a clear log; the partial finalize dir is removed; lock released.
5. Concatenate from the finalize dir into the final file using EXACTLY ONE `pipeline()` call —
   e.g. `pipeline(Readable.from(async function* () { for (const i of indices) yield createReadStream(finalizePart(i)); }), out)`.
   A round wins only if the concat path never attaches more than 2 listeners (close/error) to the out stream.
   On error: destroy out, unlink final file, remove finalize dir, release lock, 500.
6. ffprobe / thumbnail / quota / ContentItem upsert — UNCHANGED from current code.
7. Success: remove the finalize dir (best-effort), unlink any straggler `{partBase}.part.*` (best-effort;
   normally none exist since we renamed them all), release lock, `200 {"success": true, "item"}`.
8. On ANY failure: release the lock in `finally`; never leave the lock file behind on success or failure
   paths taken by this process (the stale rule is only a crash fallback).

## Client (UploadContext.tsx)

- `buildTask`: make `targetPath` UNIQUE per task: `<folderPath>/<name>.<taskId.slice(0,8)>` (taskId is
  already unique per queued file). Kills the same-name/same-folder staging collision. Resume within a
  task (retries) keeps working because taskId is stable; cross-reload resume does not exist today anyway
  (tasks are in-memory).
- Complete: wrap in `finalizeWithRetry(task, formData)`:
  - On `409` with `finalizing: true` → wait 1.5s, re-POST (max ~5 attempts), then surface the error.
  - On `200` → done (works for both fresh finalize and idempotent replay).
  - The existing 120s timeout may stay — every retry path now converges to a safe result (409-backoff
    or idempotent replay); the client NEVER re-fires a second complete while the first may still be
    running without going through the 409 protocol.
- Chunk loop: on `409 finalizing` from a chunk POST (should not happen with unique paths — defensive),
  skip remaining chunks and jump straight to `finalizeWithRetry` (the winner's item will be replayed).

## Token refresh (publisher + lib/instagram.ts)

- `lib/instagram.ts`: export `classifyTokenRefreshError(err): "permanent" | "transient"`.
  - permanent: /error validating access token|session key is malformed|invalid oauth 2.0 access token|session has expired|revoked/i, OR INSTAGRAM_CLIENT_ID/SECRET missing (server misconfig — also permanent for retry purposes).
  - transient: everything else (network, 5xx, timeouts).
- `refreshDueChannelTokens` catch path:
  - permanent → `prisma.channel.update({ status: "inactive", token_refreshed_at: now })` for TOKEN errors
    (reconnect via OAuth callback flips status back to "active" — already implemented), or
    `token_refreshed_at: now` ONLY (no status change) for the missing-credentials case. Log ONE line
    `[ChannelRefresh] <id>: <actionable message>`.
  - transient → unchanged (retry next tick).
- `/api/channels/[id]/refresh` manual refresh: keep working; if it hits a permanent token error, surface
  a clean message (no change required beyond error passthrough).

## Harness note

Scenario D's assertion (`lines ≤ 1 && (status !== "active" || token_refreshed_at !== null)`) is
satisfied by the contract above for BOTH the missing-creds path (token_refreshed_at set) and the
bad-token path (inactive). Do not weaken the harness.
