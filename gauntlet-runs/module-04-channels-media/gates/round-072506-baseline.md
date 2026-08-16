# Channels/Media/Backup baseline — 2026-08-16T10:25:06Z

Mode: prod | Commit: 34e35cf
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//channels-gauntlet.dXxVc2

## channels

```
SCENARIO M1: PASS — start=true/clientId=true/state=true callback=307/success=true channel=true seq=true tampered=true expired=true invalid=true rows=1
SCENARIO M2: PASS — happy=true revoked=true/status=400/tokenUntouched=true concurrent=true/calls=2/final=IGConcurrentB redis=true/400
SCENARIO M3: PASS — a(totals)=true/likes=0 b(empty)=true/zeros=true c(400)=true/status=400 d(malformed)=true/status=400
SCENARIO M4: PASS — create=true/name=backup-20260816.db idem=true prune=true/count=7 traversal=400/400 missing=404 corrupt=422 dbUntouched=true list=true/count=7 roDir=true/500/json=true

=== SUMMARY ===
M1: PASS — start=true/clientId=true/state=true callback=307/success=true channel=true seq=true tampered=true expired=true invalid=true rows=1
M2: PASS — happy=true revoked=true/status=400/tokenUntouched=true concurrent=true/calls=2/final=IGConcurrentB redis=true/400
M3: PASS — a(totals)=true/likes=0 b(empty)=true/zeros=true c(400)=true/status=400 d(malformed)=true/status=400
M4: PASS — create=true/name=backup-20260816.db idem=true prune=true/count=7 traversal=400/400 missing=404 corrupt=422 dbUntouched=true list=true/count=7 roDir=true/500/json=true

TOTAL: 4/4 pass
```

## media

```
  setup: clip=/Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/clip.mp4 duration=3s ffmpeg=ok
SCENARIO M5: PASS — happy=true/status=201/dur=2/probe=2 invRange=true/400 tooShort=true/400 beyond=true/400 missing=true/404 corrupt=true/400 minBypass=true/400 wideEnd=true/400 notVideo=true/400
SCENARIO M6: PASS — happy=true/status=200/magic=true corrupt=true/400/partials=0 imgThumb=true/400 noItem=true/404

=== SUMMARY ===
M5: PASS — happy=true/status=201/dur=2/probe=2 invRange=true/400 tooShort=true/400 beyond=true/400 missing=true/404 corrupt=true/400 minBypass=true/400 wideEnd=true/400 notVideo=true/400
M6: PASS — happy=true/status=200/magic=true corrupt=true/400/partials=0 imgThumb=true/400 noItem=true/404

TOTAL: 2/2 pass
```

## visual

```
SCENARIO M7: PASS — consoleErrors=0 pageErrors=0 modal=true cropWidget=true saved=true editedItem=true mobileHScroll=0px
```

## restore

```
SCENARIO M4b: PASS — restore=200/{"ok":true,"restarted":true} markerGone=true integrity=ok preRestore=true serverAfter=200
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0
- '[api-error]' lines: 0

## server.log (matching error lines, first 60)

```
[channels/refresh] permanent token error: Session has expired on Tuesday, August 15th 2026
```
