# Content Library baseline — 2026-08-16T08:25:18Z

Mode: prod | Commit: f8e40eb
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//content-gauntlet.vdQAHk

## L1-L6 (invariant harness)

```
SCENARIO L1a: PASS — delete: status=200 rowGone=true fileGone=true thumbGone=true orphans=0
SCENARIO L1b: PASS — delete-with-missing-file: status=200 rowGone=true (no 500, no crash)
SCENARIO L2: PASS — rename: patch=200 name=l2-video-renamed.mp4 urlUnchanged=true fileExists=true fileServes=200 rowCount=1 folderPatch=200 childParentOk=true
SCENARIO L3: FAIL — moveIntoFolder=200/true cycleMove=200 cycleDetected=true wrongParent=200 cascade: del=200 bGone=true cGone=true itemParentValid=true orphansAfter=1 (bar: 4xx on cycle + 4xx on non-folder parent + cascade)
SCENARIO L4: FAIL — move=200/20 moveToVideo=400(bar:400)/unchanged=20 delete+missingId: status=200 affected=20 remaining=0 orphans=2 (bar: whole-batch reject; code: permissive subset) renameDup=200 uniqueNames=50/50
SCENARIO L5a: FAIL — content-items POST same name: rows=2 (bar: 1 via dedupe; code: creates 2 — dedupe lives in upload-finalize, documented) statuses=200/200 filesIntact=true
SCENARIO L5b: PASS — upload-finalize dedupe: c1=200 c2=200 sameId=true rows=1 finalFileOk=true (declaredSize=600)
SCENARIO L6: PASS — patchFields=200/200 finalName=l6-item-renamed.mp4 finalCaption=l6-caption | moves=200/200 finalParent∈{a,b}=true | delPatch=200/404 finalRow=gone

=== SUMMARY ===
L1a: PASS — delete: status=200 rowGone=true fileGone=true thumbGone=true orphans=0
L1b: PASS — delete-with-missing-file: status=200 rowGone=true (no 500, no crash)
L2: PASS — rename: patch=200 name=l2-video-renamed.mp4 urlUnchanged=true fileExists=true fileServes=200 rowCount=1 folderPatch=200 childParentOk=true
L3: FAIL — moveIntoFolder=200/true cycleMove=200 cycleDetected=true wrongParent=200 cascade: del=200 bGone=true cGone=true itemParentValid=true orphansAfter=1 (bar: 4xx on cycle + 4xx on non-folder parent + cascade)
L4: FAIL — move=200/20 moveToVideo=400(bar:400)/unchanged=20 delete+missingId: status=200 affected=20 remaining=0 orphans=2 (bar: whole-batch reject; code: permissive subset) renameDup=200 uniqueNames=50/50
L5a: FAIL — content-items POST same name: rows=2 (bar: 1 via dedupe; code: creates 2 — dedupe lives in upload-finalize, documented) statuses=200/200 filesIntact=true
L5b: PASS — upload-finalize dedupe: c1=200 c2=200 sameId=true rows=1 finalFileOk=true (declaredSize=600)
L6: PASS — patchFields=200/200 finalName=l6-item-renamed.mp4 finalCaption=l6-caption | moves=200/200 finalParent∈{a,b}=true | delPatch=200/404 finalRow=gone

TOTAL: 5/8 pass
server log crash-signal lines: 0
```

## L7 (visual — console errors)

```
  sanity GET /api/content-items -> status=200 rootItems=0
  VISUAL-FAIL: populated grid not visible (url=http://127.0.0.1:63314/content)
  BODY-DUMP: "(no body)"
  CONSOLE-ERRORS: ["Refused to apply style from 'http://127.0.0.1:63314/_next/static/chunks/09635ef086b867b8.css' because its MIME type ('text/plain') is not a supported stylesheet MIME type, and strict MIME checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)","Refused to execute script from 'http://127.0.0.1:63314/_next/static/chunks/5efbbc4e25486d78.js' because its MIME type ('text/plain') is not executable, and strict MIME type checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)","Refused to execute script from 'http://127.0.0.1:63314/_next/static/chunks/1627bf2f54f2038d.js' because its MIME type ('text/plain') is not executable, and strict MIME type checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)","Refused to execute script from 'http://127.0.0.1:63314/_next/static/chunks/d92d666a1b1bf2a7.js' because its MIME type ('text/plain') is not executable, and strict MIME type checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)","Refused to execute script from 'http://127.0.0.1:63314/_next/static/chunks/61b29ad7ee8afb6c.js' because its MIME type ('text/plain') is not executable, and strict MIME type checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)"]
```

## L8 (perf baseline)

```
seeded 1200 items
  PERF-FAIL: grid not visible (url=http://127.0.0.1:63314/content)
  BODY-DUMP: "(no body)"
  CONSOLE-ERRORS: ["Refused to apply style from 'http://127.0.0.1:63314/_next/static/chunks/09635ef086b867b8.css' because its MIME type ('text/plain') is not a supported stylesheet MIME type, and strict MIME checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)","Refused to execute script from 'http://127.0.0.1:63314/_next/static/chunks/5efbbc4e25486d78.js' because its MIME type ('text/plain') is not executable, and strict MIME type checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)","Refused to execute script from 'http://127.0.0.1:63314/_next/static/chunks/1627bf2f54f2038d.js' because its MIME type ('text/plain') is not executable, and strict MIME type checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)","Refused to execute script from 'http://127.0.0.1:63314/_next/static/chunks/61b29ad7ee8afb6c.js' because its MIME type ('text/plain') is not executable, and strict MIME type checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)","Refused to execute script from 'http://127.0.0.1:63314/_next/static/chunks/10cbf02e6fc36465.js' because its MIME type ('text/plain') is not executable, and strict MIME type checking is enabled.","Failed to load resource: the server responded with a status of 404 (Not Found)"]
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- '[api-error]' lines: 0

## server.log (matching error lines, first 60)

```
```
