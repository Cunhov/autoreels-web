# Analytics/Settings/Channels-UI baseline — 2026-08-16T16:12:48Z

Mode: prod | Commit: 1aefd4a
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//analytics-gauntlet.9gKESh

## scenarios

```
SCENARIO S1: PASS — dashboard window: in=s1-in-1,s1-in-2,s1-in-3,s1-pending ok=true limit2=true badDate400=true statusFilter=true | insights db: source=db posts=6 likes=210/210 cacheStable=true | zero: posts=0 zeros=true | noToken=400
SCENARIO S2: PASS — run1: synced=3 rows=3 | run2(idempotent): synced=0 rows=3 | noAuth=401 | empty: synced=0 ok=true
SCENARIO S3: PASS — valid: min=600 ret=90 chat="@gauntlet" | sensitive masked=true (****CDEF) | invalid: abc=400 neg=400 nonStr=400 unchanged=600 | unknown=200 | clear=null
SCENARIO S4: PASS — list=4 | ok: 200/gauntlet_ok calls=1 | bad: 400 | noToken: 400 (FINDING: no-token test returns 500 server-error class instead of a 4xx) | inactive: 200/gauntlet_inactive

=== SUMMARY ===
S1: PASS — dashboard window: in=s1-in-1,s1-in-2,s1-in-3,s1-pending ok=true limit2=true badDate400=true statusFilter=true | insights db: source=db posts=6 likes=210/210 cacheStable=true | zero: posts=0 zeros=true | noToken=400
S2: PASS — run1: synced=3 rows=3 | run2(idempotent): synced=0 rows=3 | noAuth=401 | empty: synced=0 ok=true
S3: PASS — valid: min=600 ret=90 chat="@gauntlet" | sensitive masked=true (****CDEF) | invalid: abc=400 neg=400 nonStr=400 unchanged=600 | unknown=200 | clear=null
S4: PASS — list=4 | ok: 200/gauntlet_ok calls=1 | bad: 400 | noToken: 400 (FINDING: no-token test returns 500 server-error class instead of a 4xx) | inactive: 200/gauntlet_inactive

TOTAL: 4/4 pass
server log crash-signal lines: 0
```

## visual

```
SCENARIO S5: PASS — analytics: heading=true cards=true/true/true noNaN=true switch=true chanView=true zeroView=true mobileHScroll=0px consoleErrors=0 pageErrors=0
SCENARIO S6: PASS — settings: rendered=true savedToast=true persisted=true errToast=true unchangedAfterInvalid=true masked=true mobileHScroll=0px consoleErrors=2(unexpected=0) pageErrors=0
  S7 console errors: ["Failed to load resource: the server responded with a status of 400 (Bad Request)","Error saving settings: Error: PUBLISH_MIN_INTERVAL_SECONDS must be a non-negative number\n    at q (http://127.0.0.1:49304/_next/static/chunks/6d814b24ef3c29dd.js:1:6884)","Failed to load resource: the server responded with a status of 400 (Bad Request)","Failed to load resource: net::ERR_NAME_NOT_RESOLVED","Failed to load resource: net::ERR_NAME_NOT_RESOLVED"]
  S7 4xx/5xx responses: ["400 http://127.0.0.1:49304/api/channels/s7-bad/test"]
SCENARIO S7: PASS — channels: list=true testButtons=3 testOk=true testBad=true refresh=true connect=true (token=IGLongS7) mobileHScroll=0px consoleErrors=3(unexpected=0) pageErrors=0

=== SUMMARY ===
S5: PASS — analytics: heading=true cards=true/true/true noNaN=true switch=true chanView=true zeroView=true mobileHScroll=0px consoleErrors=0 pageErrors=0
S6: PASS — settings: rendered=true savedToast=true persisted=true errToast=true unchangedAfterInvalid=true masked=true mobileHScroll=0px consoleErrors=2(unexpected=0) pageErrors=0
S7: PASS — channels: list=true testButtons=3 testOk=true testBad=true refresh=true connect=true (token=IGLongS7) mobileHScroll=0px consoleErrors=3(unexpected=0) pageErrors=0

TOTAL: 3/3 pass
```

## perf

```
seeded 144 posts across 6 channels x 12 weeks
SCENARIO S8: {"seeded":144,"renderMs":164,"fcpMs":null,"maxFrameGapMs":33.90000003576279,"framesOver200":0,"totalFrames":6,"consoleErrors":[],"bodyNoNaN":true,"measuredAt":"2026-08-16T16:12:48.160Z"}
SCENARIO S8: PASS — renderMs=164 fcpMs=null maxFrameGapMs=33.90000003576279 framesOver200=0 consoleErrors=0 bodyNoNaN=true [vs baseline: render 164<=186? true | gap 33.90000003576279<=48? true]
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0
- '[api-error]' lines: 0

## server.log (matching error lines, first 60)

```
```
