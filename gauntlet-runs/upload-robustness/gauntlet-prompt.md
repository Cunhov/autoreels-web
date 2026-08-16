# Gauntlet Loop Prompt — upload robustness

```text
Make the upload pipeline of this repo (autoreels-web) immune to the three failure signatures in gauntlet-runs/upload-robustness/refs/diagnosis.md: WriteStream listener leaks during concat, ENOENT on .part.N from racing finalizes/cancels, and ChannelRefresh log spam from invalid Instagram tokens.

The bar is gauntlet-runs/upload-robustness/refs/bar-scenarios.md — scenarios A-E with pass criteria. Get the real failing state first: before round 1, write the executable tests for A-E and prove they FAIL on the current code, recording that in gates/. A round wins only when every gate passes (npx tsc --noEmit, npm run lint, npm run build, scenario tests green) and a fresh-context harsh critic, given only the diagnosis, the bar, and the actual test output, picks the candidate over the failure log and names the single biggest remaining gap.

Break this into pieces that can be judged on their own — server finalize safety, client orchestration, token-refresh handling. For each piece, run a builder and then a separate critic with fresh context; the critic inspects real test output, never a summary. Keep the best version of each piece on disk (git commit per winning round); a challenger replaces it only by winning the head-to-head. After each wave, one fresh agent inspects the whole result and reconciles seams.

Keep gauntlet-status.html updating: piece, round, verdict, gates, running cost. I remain the brake.

Do not deploy, spend money, use credentials, or make irreversible changes without asking me first. Stop when a round produces no measurable gain and the critic cannot name a gap worth closing, or when I stop the run. Run builders and critics as parallel subagents with fresh context.
```
