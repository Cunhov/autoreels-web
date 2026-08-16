# Content Library baseline — 2026-08-16T08:29:41Z

Mode: prod | Commit: f8e40eb
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//content-gauntlet.i9vTLf

## L1-L6 (invariant harness)

```
SCENARIO L1a: PASS — delete: status=200 rowGone=true fileGone=true thumbGone=true orphans=0
SCENARIO L1b: PASS — delete-with-missing-file: status=200 rowGone=true (no 500, no crash)
SCENARIO L2: PASS — rename: patch=200 name=l2-video-renamed.mp4 urlUnchanged=true fileExists=true fileServes=200 rowCount=1 folderPatch=200 childParentOk=true
SCENARIO L3: FAIL — moveIntoFolder=200/true cycleMove=200 cycleDetected=true wrongParent=200 cascade: del=200 bGone=true cGone=true itemParentValid=true orphansAfter=0 files=[] (bar: 4xx on cycle + 4xx on non-folder parent + cascade)
SCENARIO L4: PASS — move=200/20 moveToVideo=400(bar:400)/unchanged=20 delete+missingId: status=200 affected=20 remaining=0 orphans=0 files=[] (bar: whole-batch reject; code: permissive subset) renameDup=200 uniqueNames=50/50
SCENARIO L5a: FAIL — content-items POST same name: rows=2 (bar: 1 via dedupe; code: creates 2 — dedupe lives in upload-finalize, documented) statuses=200/200 filesIntact=true
SCENARIO L5b: PASS — upload-finalize dedupe: c1=200 c2=200 sameId=true rows=1 finalFileOk=true (declaredSize=600)
SCENARIO L6: PASS — patchFields=200/200 finalName=l6-item-renamed.mp4 finalCaption=l6-caption | moves=200/200 finalParent∈{a,b}=true | delPatch=200/404 finalRow=gone

=== SUMMARY ===
L1a: PASS — delete: status=200 rowGone=true fileGone=true thumbGone=true orphans=0
L1b: PASS — delete-with-missing-file: status=200 rowGone=true (no 500, no crash)
L2: PASS — rename: patch=200 name=l2-video-renamed.mp4 urlUnchanged=true fileExists=true fileServes=200 rowCount=1 folderPatch=200 childParentOk=true
L3: FAIL — moveIntoFolder=200/true cycleMove=200 cycleDetected=true wrongParent=200 cascade: del=200 bGone=true cGone=true itemParentValid=true orphansAfter=0 files=[] (bar: 4xx on cycle + 4xx on non-folder parent + cascade)
L4: PASS — move=200/20 moveToVideo=400(bar:400)/unchanged=20 delete+missingId: status=200 affected=20 remaining=0 orphans=0 files=[] (bar: whole-batch reject; code: permissive subset) renameDup=200 uniqueNames=50/50
L5a: FAIL — content-items POST same name: rows=2 (bar: 1 via dedupe; code: creates 2 — dedupe lives in upload-finalize, documented) statuses=200/200 filesIntact=true
L5b: PASS — upload-finalize dedupe: c1=200 c2=200 sameId=true rows=1 finalFileOk=true (declaredSize=600)
L6: PASS — patchFields=200/200 finalName=l6-item-renamed.mp4 finalCaption=l6-caption | moves=200/200 finalParent∈{a,b}=true | delPatch=200/404 finalRow=gone

TOTAL: 6/8 pass
server log crash-signal lines: 0
```

## L7 (visual — console errors)

```
  sanity GET /api/content-items -> status=200 rootItems=0
SCENARIO L7: FAIL — consoleErrors=0 pageErrors=3 mobileHScroll=226px screens=empty,grid,select,mobile
  page errors:
    - TypeError: Cannot read properties of null (reading 'appendChild')
    - TypeError: Cannot read properties of null (reading 'appendChild')
    - TypeError: Cannot read properties of null (reading 'appendChild')
```

## L8 (perf baseline)

```
seeded 1200 items
SCENARIO L8: renderMs=154 fcpMs=124 maxFrameGapMs=63 framesOver200=0/26 consoleErrors=0
{"seeded":1200,"renderMs":154,"fcpMs":124,"maxFrameGapMs":63,"framesOver200ms":0,"totalFrames":26,"consoleErrors":[],"measuredAt":"2026-08-16T08:29:41.705Z"}
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- '[api-error]' lines: 0

## server.log (matching error lines, first 60)

```
```
