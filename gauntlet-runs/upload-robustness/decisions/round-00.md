# Round 00 — harness + failing baseline (commit 5df9294)
- Bar: scenarios A–E (refs/bar-scenarios.md). Harness: scripts/upload-gauntlet (prod-mode server, real HTTP, minted JWT, temp DB/uploads).
- Baseline on HEAD e5f5315: A FAIL (18x MaxListenersExceededWarning), B FAIL (8x ENOENT, 0 completes, orphan parts), C FAIL (hash corruption), D FAIL (2x ChannelRefresh spam, no terminal state), E PASS.
- Verdict: failures reproduced deterministically → bar is reachable and measurable.
