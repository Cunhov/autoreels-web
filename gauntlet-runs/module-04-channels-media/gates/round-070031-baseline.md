# Channels/Media/Backup baseline — 2026-08-16T10:00:31Z

Mode: prod | Commit: 221d5ac
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//channels-gauntlet.y4MOHf

## channels

```
SCENARIO M1: PASS — start=true/clientId=true/state=true callback=307/success=true channel=true seq=true tampered=true expired=true invalid=true rows=1
SCENARIO M2: PASS — happy=true revoked=true/status=500/tokenUntouched=true concurrent=true/calls=2/final=IGConcurrentB redis=true/400
SCENARIO M3: PASS — a(totals)=true/likes=0 b(empty)=true/zeros=true c(400)=true/status=200 d(malformed)=true/status=200
SCENARIO M4: PASS — create=true/name=backup-20260816.db idem=true prune=true/count=7 traversal=400/400 missing=404 corrupt=422 dbUntouched=true list=true/count=7

=== SUMMARY ===
M1: PASS — start=true/clientId=true/state=true callback=307/success=true channel=true seq=true tampered=true expired=true invalid=true rows=1
M2: PASS — happy=true revoked=true/status=500/tokenUntouched=true concurrent=true/calls=2/final=IGConcurrentB redis=true/400
M3: PASS — a(totals)=true/likes=0 b(empty)=true/zeros=true c(400)=true/status=200 d(malformed)=true/status=200
M4: PASS — create=true/name=backup-20260816.db idem=true prune=true/count=7 traversal=400/400 missing=404 corrupt=422 dbUntouched=true list=true/count=7

TOTAL: 4/4 pass
```

## media

```
  setup: clip=/Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/clip.mp4 duration=3s ffmpeg=ok
SCENARIO M5: PASS — happy=true/status=201/dur=2/probe=2 invRange=true/400 tooShort=true/400 beyond=true/400 missing=true/404 corrupt=true/500
SCENARIO M6: PASS — happy=true/status=200/magic=true corrupt=true/500/partials=0 noItem=true/404

=== SUMMARY ===
M5: PASS — happy=true/status=201/dur=2/probe=2 invRange=true/400 tooShort=true/400 beyond=true/400 missing=true/404 corrupt=true/500
M6: PASS — happy=true/status=200/magic=true corrupt=true/500/partials=0 noItem=true/404

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
- '[api-error]' lines: 3

## server.log (matching error lines, first 60)

```
[api-error] Error: Session has expired on Tuesday, August 15th 2026
[video/trim] error: Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
[api-error] Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
[video/thumbnail] error: Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
[api-error] Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
```
