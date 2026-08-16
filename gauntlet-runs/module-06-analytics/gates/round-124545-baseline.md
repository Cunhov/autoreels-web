# Analytics/Settings/Channels-UI baseline — 2026-08-16T15:45:45Z

Mode: prod | Commit: 951d20c
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//analytics-gauntlet.dNxAzg

## scenarios

```
SCENARIO S1: EXCEPTION — PrismaClientKnownRequestError: 
Invalid `prisma.post.create()` invocation:


Foreign key constraint violated on the foreign key
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:8286)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7581)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7288)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:75:5816)
    at async scenarioS1 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/analytics-scenarios.mjs:229:25)
    at async file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/analytics-scenarios.mjs:622:3
SCENARIO S2: PASS — run1: synced=3 rows=3 | run2(idempotent): synced=0 rows=3 | noAuth=401 | empty: synced=0 ok=true
SCENARIO S3: FAIL — valid: min=600 ret=90 chat="@gauntlet" | sensitive masked=false (****CDEF) | invalid: abc=400 neg=400 nonStr=400 unchanged=600 | unknown=200 | clear=null
SCENARIO S4: EXCEPTION — PrismaClientKnownRequestError: 
Invalid `prisma.channel.upsert()` invocation:


Unique constraint failed on the fields: (`user_id`, `account_id`)
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:8286)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7581)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7288)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:75:5816)
    at async seedChannel (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/analytics-scenarios.mjs:165:2)
    at async scenarioS4 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/analytics-scenarios.mjs:555:2)
    at async file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/analytics-scenarios.mjs:622:3

=== SUMMARY ===
S1: FAIL — EXCEPTION: 
Invalid `prisma.post.create()` invocation:


Foreign key constraint violated on the foreign key
S2: PASS — run1: synced=3 rows=3 | run2(idempotent): synced=0 rows=3 | noAuth=401 | empty: synced=0 ok=true
S3: FAIL — valid: min=600 ret=90 chat="@gauntlet" | sensitive masked=false (****CDEF) | invalid: abc=400 neg=400 nonStr=400 unchanged=600 | unknown=200 | clear=null
S4: FAIL — EXCEPTION: 
Invalid `prisma.channel.upsert()` invocation:


Unique constraint failed on the fields: (`user_id`, `account_id`)

TOTAL: 1/4 pass
server log crash-signal lines: 0
```

## visual

```
SCENARIO S5: FAIL — analytics: heading=true cards=true/true/false noNaN=true switch=true chanView=true zeroView=true mobileHScroll=0px consoleErrors=0 pageErrors=0
SCENARIO S6: FAIL — settings: rendered=true savedToast=true persisted=false errToast=false unchangedAfterInvalid=false masked=true mobileHScroll=0px consoleErrors=0 pageErrors=0
SCENARIO S7: FAIL — channels: list=true testOk=false testBad=false refresh=false connect=false (token=undefined) mobileHScroll=0px consoleErrors=0 pageErrors=0

=== SUMMARY ===
S5: FAIL — analytics: heading=true cards=true/true/false noNaN=true switch=true chanView=true zeroView=true mobileHScroll=0px consoleErrors=0 pageErrors=0
S6: FAIL — settings: rendered=true savedToast=true persisted=false errToast=false unchangedAfterInvalid=false masked=true mobileHScroll=0px consoleErrors=0 pageErrors=0
S7: FAIL — channels: list=true testOk=false testBad=false refresh=false connect=false (token=undefined) mobileHScroll=0px consoleErrors=0 pageErrors=0

TOTAL: 0/3 pass
```

## perf

```
seeded 144 posts across 6 channels x 12 weeks
SCENARIO S8: {"seeded":144,"renderMs":197,"fcpMs":null,"maxFrameGapMs":35.30000001192093,"framesOver200":0,"totalFrames":6,"consoleErrors":[],"bodyNoNaN":true,"measuredAt":"2026-08-16T15:45:45.127Z"}
SCENARIO S8: PASS — renderMs=197 fcpMs=null maxFrameGapMs=35.30000001192093 framesOver200=0 consoleErrors=0 bodyNoNaN=true [first run — baseline recorded]
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0
- '[api-error]' lines: 0

## server.log (matching error lines, first 60)

```
```
