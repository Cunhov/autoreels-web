# Diagnosis — upload pipeline failures (production logs, Docker)

Source: production log of autoreels-web (Docker, path `/app/data/uploads`, volume `autoreels-data`).
Three distinct failure signatures, three root causes.

## 1. MaxListenersExceededWarning on WriteStream (memory-leak symptom)

```
(node:1) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 close listeners added to [WriteStream]. MaxListeners is 10.
... 11 error listeners added to [WriteStream] ...
```

**Root cause — `app/api/upload-chunk/complete/route.ts`, concat loop:**

```ts
const out = createWriteStream(finalDiskPath, { flags: "w" });
for (let i = 0; i < totalChunks; i++) {
    await pipeline(createReadStream(`${partBase}.part.${i}`), out, { end: i === totalChunks - 1 });
}
```

Each `pipeline()` call registers `close` + `error` listeners on the SAME `out` WriteStream
and never removes them (they are only released when the stream closes, i.e. at the last chunk).
`10 listeners + 1 default = 11` is reached at 5 chunks. A 100 MB file in 5 MB chunks = 20 chunks
= 40 dangling listener closures per finalize. Under many concurrent uploads this grows memory
and is a real leak, not just noise.

## 2. ENOENT on `.part.N` at finalize (the dominant failure)

```
Finalizing upload error: [Error: ENOENT: no such file or directory,
open '/app/data/uploads/admin/Ansiedade Zero Sem Zumbi.mp4.part.1']
```

Repeated up to 5× for the same file (Botox...) — each repeat is a NEW finalize attempt that
re-found missing parts. ENOENT happens at `createReadStream(part)` INSIDE the concat loop,
meaning the part existed at `listPartIndices()` time but was deleted WHILE concatenating.

**Root cause: concurrent/overlapping finalize + cancel racing the part files.**

- Client finalize call has a hard timeout: `COMPLETE_FETCH_TIMEOUT_MS = 120_000` in
  `contexts/UploadContext.tsx`. A slow finalize (concat + ffprobe + thumbnail) aborts the
  fetch client-side; the catch path schedules an auto-retry → a SECOND complete request
  arrives while the first is still running server-side.
- Both completes run `listPartIndices` (both see all parts), both enter the concat loop,
  and the FIRST one to finish runs `cleanupParts()` → unlinks every `.part.{i}` → the second
  one hits ENOENT mid-loop (exactly part.1 if part.0 was already read).
- `DELETE /api/upload-chunk?path=...` (user cancel, `cancelTask` in UploadContext) has the
  same effect: it unlinks parts while a finalize is concatenating.
- `app/api/upload-chunk/route.ts` POST with `flags: "w"` overwrites a part that a running
  finalize may be reading → truncated concat.
- `listPartIndices` + verify + concat is a check-then-act window with zero locking.

**Secondary hazard:** `targetPath` = `${folderPath}/${file.name}` (client). Two tasks with the
same file name in the same folder share the SAME staging path → parts clobber each other and
completes race. `normalizeUploadPath(userId, path)` is the only identity.

## 3. ChannelRefresh: "Session key is malformed because of invalid user id"

```
[ChannelRefresh] d29a8cd1-...: Error validating access token: Session key is malformed because of invalid user id.
```

**Root cause — `app/api/cron/publisher/route.ts` → `refreshDueChannelTokens()` →
`refreshInstagramToken()` (`lib/instagram.ts`).**

- The message is the Instagram/Facebook Graph API OAuth error for a token that is NOT a valid
  IG token (the API literally calls it a malformed "session key").
- Some `Channel` rows in the DB hold garbage tokens (likely a next-auth session JWT saved as
  the IG access token by an older connect flow, or a revoked token).
- The cron query selects channels with `access_token NOT LIKE 'token_%'` and refreshes them
  EVERY tick (60s). Each attempt throws, logged as `[ChannelRefresh] ...`, forever. No
  backoff, no marking, no status change. Log spam + wasted IG API calls + noise burying real errors.
- `resolveAccessToken`/publish paths can hit the same garbage token later.

## Files involved (map)

| File | Role |
| --- | --- |
| `app/api/upload-chunk/route.ts` | POST chunk (`.part.{i}` staging), DELETE cancel |
| `app/api/upload-chunk/status/route.ts` | GET resume info |
| `app/api/upload-chunk/complete/route.ts` | POST finalize: verify → concat → ffprobe → thumbnail → quota → ContentItem upsert → cleanupParts |
| `contexts/UploadContext.tsx` | client orchestrator: chunk loop, resume, retry (MAX_AUTO_RETRIES=2), freeze monitor, 120s complete timeout |
| `app/upload/page.tsx` | upload UI |
| `app/api/cron/publisher/route.ts` | cron: `refreshDueChannelTokens` (~line 260-295) |
| `lib/instagram.ts` | `refreshInstagramToken` (~line 153) |
| `app/api/import-url/route.ts` | separate single-pipeline stream (OK, no accumulation) |
| `app/api/upload/route.ts` | legacy route, no longer called by the client (leave alone) |

## Production constraints

- Runs in Docker at `/app/data/uploads` (volume). Container restarts are possible (OOM is a
  realistic trigger given the listener leak) — parts survive only if the volume is intact.
- SQLite (better-sqlite3) — keep DB work minimal; no new tables unless unavoidable.
- Next.js App Router route handlers; the app is a single-process monolith (in-process locks
  are valid; cross-process = lock file).
- Do not break the resume contract (status endpoint) or the ContentItem dedupe-by-name+parent
  behavior (used by carousel/folder flows).
