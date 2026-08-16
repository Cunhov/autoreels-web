# Planners baseline — 2026-08-16T09:02:54Z

Mode: prod | Commit: 856d33e
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//planner-gauntlet.ipcoH7

## PL8 (visual — wizard)

```
FATAL: locator.click: Error: strict mode violation: getByRole('button', { name: 'Next' }) resolved to 2 elements:
    1) <button title="Preview next run" class="p-1.5 rounded-lg text-ios-text-secondary bg-ios-gray-5/40 hover:bg-ios-gray-5 transition-colors">…</button> aka getByRole('button', { name: 'Preview next run' })
    2) <button type="button" class="ios-btn px-4 py-3 rounded-xl font-semibold text-[17px] w-full flex items-center justify-center transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-ios-blue text-white shadow-sm hover:bg-blue-600 min-w-[120px] justify-center">…</button> aka getByRole('button', { name: 'Next', exact: true })

Call log:
[2m  - waiting for getByRole('button', { name: 'Next' })[22m

    at main (/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-visual.mjs:145:51)
```

## PL7 (fix-planners + cron)

```
SCENARIO PL7: PASS — dry=200/flagged=true fix=200/count=1 fixedStatus=active/configObject=true tick=200/posts=1/lastRun=true unmatched=0 refreshLines=0 crashes=0

=== SUMMARY (scenarios) ===
PL7: PASS — dry=200/flagged=true fix=200/count=1 fixedStatus=active/configObject=true tick=200/posts=1/lastRun=true unmatched=0 refreshLines=0 crashes=0
```

## PL1-PL6 (direct)

```
SCENARIO PL1: PASS — ok=1 already_running=1 posts=2 lastRunAdvanced=true (r1=ok, r2=already_running)
SCENARIO PL2: PASS — due:not_due/0→true/1 start:start_time/0→true/1 sleep:sleep/0→true/1
SCENARIO PL3: PASS — arr=invalid_config freq0=invalid_config noCh=no_channels res=resolution_failed tpl=ok/caption="Hello {unknown_var} and " (literal unknown var = finding, documented)
SCENARIO PL4: PASS — idx2→"C-third"(state 3) idx3(exhausted)→"A-first"(state 4, WRAP documented) 2ch→["B-second","C-third"](state 3)
SCENARIO PL5: PASS — ok created=1 channels=[pl5-ok] template_index=1 allBlocked=no_publishable_channels
SCENARIO PL6: PASS — fail=true/reverted=true/postsAfter=0 nextRun=ok/postsFinal=1

=== SUMMARY (direct) ===
PL1: PASS — ok=1 already_running=1 posts=2 lastRunAdvanced=true (r1=ok, r2=already_running)
PL2: PASS — due:not_due/0→true/1 start:start_time/0→true/1 sleep:sleep/0→true/1
PL3: PASS — arr=invalid_config freq0=invalid_config noCh=no_channels res=resolution_failed tpl=ok/caption="Hello {unknown_var} and " (literal unknown var = finding, documented)
PL4: PASS — idx2→"C-third"(state 3) idx3(exhausted)→"A-first"(state 4, WRAP documented) 2ch→["B-second","C-third"](state 3)
PL5: PASS — ok created=1 channels=[pl5-ok] template_index=1 allBlocked=no_publishable_channels
PL6: PASS — fail=true/reverted=true/postsAfter=0 nextRun=ok/postsFinal=1
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- '[api-error]' lines: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0
- '[ChannelRefresh]' lines: 0

## server.log (matching error lines, first 60)

```
```
