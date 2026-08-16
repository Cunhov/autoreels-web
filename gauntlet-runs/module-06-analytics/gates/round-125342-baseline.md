# Analytics/Settings/Channels-UI baseline — 2026-08-16T15:53:42Z

Mode: prod | Commit: 951d20c
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//analytics-gauntlet.vGkgaJ

## scenarios

```
SCENARIO S1: PASS — dashboard window: in=s1-in-1,s1-in-2,s1-in-3,s1-pending ok=true limit2=true badDate400=true statusFilter=true | insights db: source=db posts=6 likes=210/210 cacheStable=true | zero: posts=0 zeros=true | noToken=400
SCENARIO S2: PASS — run1: synced=3 rows=3 | run2(idempotent): synced=0 rows=3 | noAuth=401 | empty: synced=0 ok=true
SCENARIO S3: PASS — valid: min=600 ret=90 chat="@gauntlet" | sensitive masked=true (****CDEF) | invalid: abc=400 neg=400 nonStr=400 unchanged=600 | unknown=200 | clear=null
SCENARIO S4: FAIL — list=4 | ok: 200/gauntlet_ok calls=1 | bad: 400 | noToken: 500 | inactive: 200/gauntlet_inactive

=== SUMMARY ===
S1: PASS — dashboard window: in=s1-in-1,s1-in-2,s1-in-3,s1-pending ok=true limit2=true badDate400=true statusFilter=true | insights db: source=db posts=6 likes=210/210 cacheStable=true | zero: posts=0 zeros=true | noToken=400
S2: PASS — run1: synced=3 rows=3 | run2(idempotent): synced=0 rows=3 | noAuth=401 | empty: synced=0 ok=true
S3: PASS — valid: min=600 ret=90 chat="@gauntlet" | sensitive masked=true (****CDEF) | invalid: abc=400 neg=400 nonStr=400 unchanged=600 | unknown=200 | clear=null
S4: FAIL — list=4 | ok: 200/gauntlet_ok calls=1 | bad: 400 | noToken: 500 | inactive: 200/gauntlet_inactive

TOTAL: 3/4 pass
server log crash-signal lines: 0
```

## visual

```
SCENARIO S5: PASS — analytics: heading=true cards=true/true/true noNaN=true switch=true chanView=true zeroView=true mobileHScroll=0px consoleErrors=0 pageErrors=0
  S6 invalid-save debug: ["Min interval between posts (same channel, seconds)","Save Settings"] apiValue= 900
SCENARIO S6: FAIL — settings: rendered=true savedToast=true persisted=true errToast=false unchangedAfterInvalid=true masked=true mobileHScroll=0px consoleErrors=0 pageErrors=0
  S7 console errors: ["Failed to load resource: the server responded with a status of 400 (Bad Request)","Failed to load resource: the server responded with a status of 401 (Unauthorized)","Failed to load resource: the server responded with a status of 401 (Unauthorized)","Failed to load resource: the server responded with a status of 401 (Unauthorized)","Failed to load resource: the server responded with a status of 401 (Unauthorized)","Failed to load resource: net::ERR_NAME_NOT_RESOLVED"]
  S7 4xx/5xx responses: ["400 http://127.0.0.1:65201/api/channels/s7-bad/test","401 http://localhost:65201/api/summary","401 http://localhost:65201/api/channels","401 http://localhost:65201/api/posts","401 http://localhost:65201/api/summary"]
SCENARIO S7: FAIL — channels: list=true testButtons=3 testOk=true testBad=true refresh=true connect=true (token=IGLongS7) mobileHScroll=0px consoleErrors=6 pageErrors=0

=== SUMMARY ===
S5: PASS — analytics: heading=true cards=true/true/true noNaN=true switch=true chanView=true zeroView=true mobileHScroll=0px consoleErrors=0 pageErrors=0
S6: FAIL — settings: rendered=true savedToast=true persisted=true errToast=false unchangedAfterInvalid=true masked=true mobileHScroll=0px consoleErrors=0 pageErrors=0
S7: FAIL — channels: list=true testButtons=3 testOk=true testBad=true refresh=true connect=true (token=IGLongS7) mobileHScroll=0px consoleErrors=6 pageErrors=0

TOTAL: 1/3 pass
```

## perf

```
seeded 144 posts across 6 channels x 12 weeks
SCENARIO S8: {"seeded":144,"renderMs":168,"fcpMs":null,"maxFrameGapMs":35.09999996423721,"framesOver200":0,"totalFrames":6,"consoleErrors":[],"bodyNoNaN":true,"measuredAt":"2026-08-16T15:53:42.710Z"}
SCENARIO S8: PASS — renderMs=168 fcpMs=null maxFrameGapMs=35.09999996423721 framesOver200=0 consoleErrors=0 bodyNoNaN=true [first run — baseline recorded]
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
