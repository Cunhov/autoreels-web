# Planners baseline — 2026-08-16T09:10:43Z

Mode: dev | Commit: 856d33e
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//planner-gauntlet.G5SPvv

## PL8 (visual — wizard)

```
FATAL: locator.click: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for getByText('Wizard Created').first().locator('xpath=ancestor::div[.//button[@title=\'Edit planner\']][1]').locator('button[title="Edit planner"]')[22m
[2m    - locator resolved to <button title="Edit planner" class="p-1.5 rounded-lg text-ios-blue bg-ios-blue/5 hover:bg-ios-blue/10 transition-colors">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is visible, enabled and stable[22m
[2m      - scrolling into view if needed[22m
[2m      - done scrolling[22m
[2m      - <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">…</div> intercepts pointer events[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is visible, enabled and stable[22m
[2m      - scrolling into view if needed[22m
[2m      - done scrolling[22m
[2m      - <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">…</div> intercepts pointer events[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    57 × waiting for element to be visible, enabled and stable[22m
[2m       - element is visible, enabled and stable[22m
[2m       - scrolling into view if needed[22m
[2m       - done scrolling[22m
[2m       - <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">…</div> intercepts pointer events[22m
[2m     - retrying click action[22m
[2m       - waiting 500ms[22m

    at main (/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-visual.mjs:173:59)
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
  error: {
  error: {
```
