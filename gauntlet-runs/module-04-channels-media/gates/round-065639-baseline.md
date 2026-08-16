# Channels/Media/Backup baseline — 2026-08-16T09:56:39Z

Mode: prod | Commit: 221d5ac
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//channels-gauntlet.tc2YbF

## channels

```
SCENARIO M1: FAIL — start=true/clientId=true/state=true callback=307/success=false channel=false seq=false tampered=true expired=true invalid=true rows=0
SCENARIO M2: FAIL — happy=false revoked=true/status=500/tokenUntouched=true concurrent=false/calls=2/final=IGConcurrentStart redis=true/400
SCENARIO M3: FAIL — a(totals)=false/likes=0 b(empty)=true/zeros=true c(400)=true/status=200 d(malformed)=true/status=200
SCENARIO M4: FAIL — create=false/name=backup-20260816.db idem=true prune=true/count=7 traversal=400/400 missing=404 corrupt=422 dbUntouched=true list=true/count=7

=== SUMMARY ===
M1: FAIL — start=true/clientId=true/state=true callback=307/success=false channel=false seq=false tampered=true expired=true invalid=true rows=0
M2: FAIL — happy=false revoked=true/status=500/tokenUntouched=true concurrent=false/calls=2/final=IGConcurrentStart redis=true/400
M3: FAIL — a(totals)=false/likes=0 b(empty)=true/zeros=true c(400)=true/status=200 d(malformed)=true/status=200
M4: FAIL — create=false/name=backup-20260816.db idem=true prune=true/count=7 traversal=400/400 missing=404 corrupt=422 dbUntouched=true list=true/count=7

TOTAL: 0/4 pass
```

## media

```
  setup: clip=/Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/clip.mp4 duration=3s ffmpeg=ok
SCENARIO M5: PASS — happy=true/status=201/dur=2/probe=2 invRange=true/400 tooShort=true/400 beyond=true/400 missing=true/404 corrupt=true/500
SCENARIO M6: FAIL — happy=true/status=200/magic=true corrupt=false/500/partials=-1 noItem=true/404

=== SUMMARY ===
M5: PASS — happy=true/status=201/dur=2/probe=2 invRange=true/400 tooShort=true/400 beyond=true/400 missing=true/404 corrupt=true/500
M6: FAIL — happy=true/status=200/magic=true corrupt=false/500/partials=-1 noItem=true/404

TOTAL: 1/2 pass
```

## visual

```
SCENARIO M7: PASS — consoleErrors=0 pageErrors=0 modal=true cropWidget=true saved=true editedItem=true mobileHScroll=0px
```

## restore

```
M4b FATAL: SqliteError: no such table: ContentItem
    at Database.prepare (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/better-sqlite3/lib/methods/wrappers.js:5:21)
    at main (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/channels-restore.mjs:100:4)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 4
- '[api-error]' lines: 6

## server.log (matching error lines, first 60)

```
[api-error] Error: UNMATCHED_MOCK host=graph.instagram.com url=https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=IGRevokableToken
[api-error] Error: UNMATCHED_MOCK host=graph.instagram.com url=https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=IGRevokedToken
[api-error] Error: UNMATCHED_MOCK host=graph.instagram.com url=https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=IGConcurrentStart
[api-error] Error: UNMATCHED_MOCK host=graph.instagram.com url=https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=IGConcurrentStart
[video/trim] error: Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
[api-error] Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
[video/thumbnail] error: Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
[api-error] Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
```
