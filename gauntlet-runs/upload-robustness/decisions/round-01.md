# Round 01 — three parallel piece builders (commits 0a4822f/ad25cd1/0002dcb, merged 4032c1d/1e3e39c/4d4ff71)
- Server: finalize lock (in-process + lock file wx), safe-consume via rename into .finalizing/<uuid>, single-pipeline concat, 409 protocol, idempotent replay.
- Client: unique targetPath per task, finalizeWithRetry with 409 backoff, chunk-409 jump.
- Token: classifyTokenRefreshError permanent/transient; terminal state (inactive / token_refreshed_at) + one log line.
- Harness after merge: A PASS, B PASS, C FAIL (ok=true/false, mixed hash), D PASS, E PASS.
- Gap named: C — ENOENT fixed but the 409 loser's `finally` still ran cleanupParts (bug found via harness).
