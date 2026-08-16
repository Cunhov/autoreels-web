# Calendar baseline — 2026-08-16T15:33:41Z

Mode: prod | Commit: cffd0e9
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//calendar-gauntlet.Qy5ovo

## C1-C6 (invariant harness)

```
SCENARIO C1: PASS — window: 4 posts (A,B,C,pub in; before/after/null excluded) ordered=true fields=true | edges: start>end=200/0 missing=400 badDate=400 limit=2→2 status=published→1 no500=true
SCENARIO C2: PASS — move: true pastRejected=true(400) concurrent: 200/200 final∈{3h,4h}=true publishedProtected=true(400) intervalViolationAllowedAtSchedulingLayer=true
SCENARIO C3: PASS — delete: 200 inBefore=true rowGone=true inAfter=true again=404 channelIntact=true plannerIntact=true
SCENARIO C4: PASS — statuses returned: cancelled,failed,pending,processing,processing_children,processing_upload,published,ready_to_publish,scheduled (expected cancelled,failed,pending,processing,processing_children,processing_upload,published,ready_to_publish,scheduled) → all=true
SCENARIO C5: PASS — planner post: found=true planner_id=cal-planner-5 channel_id=cal-chan-5 (modal planner-name rendering is checked in the visual part)
SCENARIO C6: PASS — 340 posts window (300 monthly + 40 burst) → 340 (burst day = 40/40) limit=250→250
SCENARIO C6b: PASS — 520-post window: limit=1000 → 520/520 newestPresent=true | default(500 cap) → 500 newestAbsent=true

=== SUMMARY ===
C1: PASS — window: 4 posts (A,B,C,pub in; before/after/null excluded) ordered=true fields=true | edges: start>end=200/0 missing=400 badDate=400 limit=2→2 status=published→1 no500=true
C2: PASS — move: true pastRejected=true(400) concurrent: 200/200 final∈{3h,4h}=true publishedProtected=true(400) intervalViolationAllowedAtSchedulingLayer=true
C3: PASS — delete: 200 inBefore=true rowGone=true inAfter=true again=404 channelIntact=true plannerIntact=true
C4: PASS — statuses returned: cancelled,failed,pending,processing,processing_children,processing_upload,published,ready_to_publish,scheduled (expected cancelled,failed,pending,processing,processing_children,processing_upload,published,ready_to_publish,scheduled) → all=true
C5: PASS — planner post: found=true planner_id=cal-planner-5 channel_id=cal-chan-5 (modal planner-name rendering is checked in the visual part)
C6: PASS — 340 posts window (300 monthly + 40 burst) → 340 (burst day = 40/40) limit=250→250
C6b: PASS — 520-post window: limit=1000 → 520/520 newestPresent=true | default(500 cap) → 500 newestAbsent=true

TOTAL: 7/7 pass
server log crash-signal lines: 0
```

## C7/C8 (visual — console errors + TZ placement)

```
SCENARIO C4: PASS — status badge "9" (expected 9) consoleErrors=0 pageErrors=0
SCENARIO C5: PASS — day modal open=true caption=true plannerNameRendered=true (bar: planner name REQUIRED in modal)
SCENARIO C7: PASS — week=true nav(August 2026→September 2026→August 2026) mobileHScroll=0px consoleErrors=0 pageErrors=0
SCENARIO C8: PASS — TZ placement: post at 22:00 local → local day 20 cell cards=1 (badge 1) utc day 21 cell cards=0 → trap=avoided sampleTimes=["No Media09:00 AM","No Media10:00 AM","No Media11:00 AM","No Media02:30 PM","No Media10:00 PM","No Media09:00 AM","No Media09:10 AM","No Media09:20 AM"]
SCENARIO C6-render: PASS — 40-post burst day: "+N more" chip visible=true
```

## C9 (perf baseline)

```
seeded 310 posts (current month, burst day 10)
  C9-BASELINE: recorded (310 posts, burst day 10)
SCENARIO C9: renderMs=254 fcpMs=188 maxFrameGapMs=117 framesOver200=0/6 burstChip=true consoleErrors=0 [first run — baseline recorded]
{"workload":{"seeded":310,"burstDay":10},"renderMs":254,"fcpMs":188,"maxFrameGapMs":117,"framesOver200ms":0,"totalFrames":6,"consoleErrors":[],"burstChipRendered":true,"measuredAt":"2026-08-16T15:33:41.622Z"}
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- '[api-error]' lines: 0

## server.log (matching error lines, first 60)

```
```
