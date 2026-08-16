# Planners baseline — 2026-08-16T18:12:26Z

Mode: prod | Commit: 0394528
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//planner-gauntlet.QtafWW

## PL8 (visual — wizard)

```
  (c) after Finish: modalOpen=false saveError=0 consoleErrors=0
SCENARIO PL8: PASS — consoleErrors=0 pageErrors=0 created=true autoRotation=true/true edited=7h validation=true/true badAbsent=true mobileHScroll=0px
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
