# Planners baseline — 2026-08-16T19:12:49Z

Mode: prod | Commit: b62245e
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//planner-gauntlet.zaMjGt

## PL8 (visual — wizard)

```
  (c) EDIT pre-selection: preSelected=false (bar: the selected item must survive the edit open)
FATAL: locator.click: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for getByRole('button', { name: 'Next', exact: true })[22m
[2m    - locator resolved to <button disabled type="button" class="ios-btn px-4 py-3 rounded-xl font-semibold text-[17px] w-full flex items-center justify-center transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-ios-blue text-white shadow-sm hover:bg-blue-600 min-w-[120px] justify-center">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    58 × waiting for element to be visible, enabled and stable[22m
[2m       - element is not enabled[22m
[2m     - retrying click action[22m
[2m       - waiting 500ms[22m

    at main (/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-visual.mjs:272:64)
```

## PL7 (fix-planners + cron)

```
SCENARIO PL7: PASS — dry=200/flagged=true fix=200/count=1 fixedStatus=active/configObject=true tick=200/posts=1/lastRun=true unmatched=0 refreshLines=0 crashes=0
SCENARIO PL8-API: PASS — wizard default payload (start_time:"") → HTTP 200 accepted — pre-fix this FAILS: the wizard cannot save without an explicit start time
SCENARIO PL8b: PASS — preview caption="Hello  and 16/08/2026!" → 200=true bracesStripped=true knownResolved=true — pre-fix the preview kept {unknown_var} LITERAL while the runtime stripped it
SCENARIO PL3b: PASS — sleep start==end → HTTP 400 details=["Sleep start and end must be different times."] — pre-fix the server accepted the never-sleeping window (wizard-only check)

=== SUMMARY (scenarios) ===
PL7: PASS — dry=200/flagged=true fix=200/count=1 fixedStatus=active/configObject=true tick=200/posts=1/lastRun=true unmatched=0 refreshLines=0 crashes=0
PL8-API: PASS — wizard default payload (start_time:"") → HTTP 200 accepted — pre-fix this FAILS: the wizard cannot save without an explicit start time
PL8b: PASS — preview caption="Hello  and 16/08/2026!" → 200=true bracesStripped=true knownResolved=true — pre-fix the preview kept {unknown_var} LITERAL while the runtime stripped it
PL3b: PASS — sleep start==end → HTTP 400 details=["Sleep start and end must be different times."] — pre-fix the server accepted the never-sleeping window (wizard-only check)
```

## PL1-PL6 (direct)

```
SCENARIO PL1: PASS — ok=1 already_running=1 posts=2 lastRunAdvanced=true (r1=ok, r2=already_running)
SCENARIO PL2: PASS — due:not_due/0→true/1 start:start_time/0→true/1 sleep:sleep/0→true/1
SCENARIO PL3: PASS — arr=invalid_config freq0=invalid_config noCh=no_channels res=resolution_failed tpl=ok/caption="Hello  and " (unknown vars → "", no literal leak)
SCENARIO PL3-hashtags: PASS — hashtags="#fitness #dicas #marketing | 16/08/2026" offRotationCaption="base caption" (tags → #tags; rotation off keeps base caption)
SCENARIO PL3-basecaption: PASS — baseCaption="Veja CAPTION FROM LIBRARY" (must be "Veja CAPTION FROM LIBRARY", never the literal {post_caption})
SCENARIO PL4: PASS — idx2→"C-third"(state 3) idx3(exhausted)→"A-first"(state 4, WRAP documented) 2ch→["B-second","C-third"](state 3)
SCENARIO PL5: PASS — ok created=1 channels=[pl5-ok] template_index=1 allBlocked=no_publishable_channels
SCENARIO PL6: PASS — fail=true/reverted=true/postsAfter=0 nextRun=ok/postsFinal=1

=== SUMMARY (direct) ===
PL1: PASS — ok=1 already_running=1 posts=2 lastRunAdvanced=true (r1=ok, r2=already_running)
PL2: PASS — due:not_due/0→true/1 start:start_time/0→true/1 sleep:sleep/0→true/1
PL3: PASS — arr=invalid_config freq0=invalid_config noCh=no_channels res=resolution_failed tpl=ok/caption="Hello  and " (unknown vars → "", no literal leak)
PL3-hashtags: PASS — hashtags="#fitness #dicas #marketing | 16/08/2026" offRotationCaption="base caption" (tags → #tags; rotation off keeps base caption)
PL3-basecaption: PASS — baseCaption="Veja CAPTION FROM LIBRARY" (must be "Veja CAPTION FROM LIBRARY", never the literal {post_caption})
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
