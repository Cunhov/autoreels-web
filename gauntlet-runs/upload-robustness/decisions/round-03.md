# Round 03 — close critic gaps (in flight)
- Gap 1 (D): permanent failure also sets token_expires_at = null (SQL NULL never matches `<= now+14d`); harness D seeds token_expires_at = now+7d.
- Gap 2 (GC): sweepStaleStaging — .finalizing/* older than 10min + orphan .part.* older than 15min, respecting fresh locks, debounced 60s, wired into status + chunk-0 POST, never throws.
- Process: evidence trail reconstructed (true failing baseline restored from git, decisions/ + out/ populated, run-tests.sh writes timestamped files).
