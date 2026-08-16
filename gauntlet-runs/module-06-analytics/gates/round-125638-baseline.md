# Analytics/Settings/Channels-UI baseline — 2026-08-16T15:56:38Z

Mode: prod | Commit: 951d20c
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//analytics-gauntlet.sNku0u

## scenarios

```
SCENARIO S1: PASS — dashboard window: in=s1-in-1,s1-in-2,s1-in-3,s1-pending ok=true limit2=true badDate400=true statusFilter=true | insights db: source=db posts=6 likes=210/210 cacheStable=true | zero: posts=0 zeros=true | noToken=400
SCENARIO S2: PASS — run1: synced=3 rows=3 | run2(idempotent): synced=0 rows=3 | noAuth=401 | empty: synced=0 ok=true
SCENARIO S3: PASS — valid: min=600 ret=90 chat="@gauntlet" | sensitive masked=true (****CDEF) | invalid: abc=400 neg=400 nonStr=400 unchanged=600 | unknown=200 | clear=null
SCENARIO S4: FAIL — list=4 | ok: 200/gauntlet_ok calls=1 | bad: 400 | noToken: 500 (FINDING: no-token test returns 500 server-error class instead of a 4xx) | inactive: 200/gauntlet_inactive

=== SUMMARY ===
S1: PASS — dashboard window: in=s1-in-1,s1-in-2,s1-in-3,s1-pending ok=true limit2=true badDate400=true statusFilter=true | insights db: source=db posts=6 likes=210/210 cacheStable=true | zero: posts=0 zeros=true | noToken=400
S2: PASS — run1: synced=3 rows=3 | run2(idempotent): synced=0 rows=3 | noAuth=401 | empty: synced=0 ok=true
S3: PASS — valid: min=600 ret=90 chat="@gauntlet" | sensitive masked=true (****CDEF) | invalid: abc=400 neg=400 nonStr=400 unchanged=600 | unknown=200 | clear=null
S4: FAIL — list=4 | ok: 200/gauntlet_ok calls=1 | bad: 400 | noToken: 500 (FINDING: no-token test returns 500 server-error class instead of a 4xx) | inactive: 200/gauntlet_inactive

TOTAL: 3/4 pass
server log crash-signal lines: 0
```

## visual

```
SCENARIO S5: PASS — analytics: heading=true cards=true/true/true noNaN=true switch=true chanView=true zeroView=true mobileHScroll=0px consoleErrors=0 pageErrors=0
  S6 invalid-save debug: inputAfterFill= -5 snippet= ["Min interval between posts (same channel, seconds)","Save Settings"] apiValue= 900
SCENARIO S6: FAIL — settings: rendered=true savedToast=true persisted=true errToast=false unchangedAfterInvalid=true masked=true mobileHScroll=0px consoleErrors=2 pageErrors=0
SCENARIO S7: EXCEPTION — ReferenceError: Cannot access 'connectPage' before initialization
    at scenarioS7 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/analytics-visual.mjs:492:2)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/analytics-visual.mjs:573:3

=== SUMMARY ===
S5: PASS — analytics: heading=true cards=true/true/true noNaN=true switch=true chanView=true zeroView=true mobileHScroll=0px consoleErrors=0 pageErrors=0
S6: FAIL — settings: rendered=true savedToast=true persisted=true errToast=false unchangedAfterInvalid=true masked=true mobileHScroll=0px consoleErrors=2 pageErrors=0
S7: FAIL — EXCEPTION: Cannot access 'connectPage' before initialization

TOTAL: 1/3 pass
```

## perf

```
seeded 144 posts across 6 channels x 12 weeks
SCENARIO S8: {"seeded":144,"renderMs":172,"fcpMs":null,"maxFrameGapMs":45.60000002384186,"framesOver200":0,"totalFrames":6,"consoleErrors":[],"bodyNoNaN":true,"measuredAt":"2026-08-16T15:56:38.711Z"}
SCENARIO S8: PASS — renderMs=172 fcpMs=null maxFrameGapMs=45.60000002384186 framesOver200=0 consoleErrors=0 bodyNoNaN=true [first run — baseline recorded]
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0
- '[api-error]' lines: 1

## server.log (matching error lines, first 60)

```
[api-error] Error: Could not resolve access token
```
