# Round 00 baseline — 2026-08-16T06:21:56Z

Mode: prod | Commit: 383dc09
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.CvsMCX

## Summary

```
base=http://127.0.0.1:63006 db=/var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.CvsMCX/test.db uploads=/var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.CvsMCX/uploads
session cookie: next-auth.session-token=…
SCENARIO A: PASS — 3 files (4/4/20 chunks) finalized, hashes match, 1 item each, no warnings
SCENARIO B: PASS — completes ok=1/2 items=1 hashOk=true orphanParts=0 enoent=false
SCENARIO C1: PASS — unique paths: completes ok=true/true items=1 matchesSource=true enoent=false
SCENARIO C2: PASS — shared path: completes ok=true/true (409-retry) items=1 enoent=false
SCENARIO D: PASS — ChannelRefresh lines=1 (bar ≤1) terminalState=true cronStatus=200/200
SCENARIO E: PASS — statusChunks=[0,1,2] complete=200 items=1 hashOk=true

TOTAL: ALL PASS (A-E: A=PASS B=PASS C1=PASS C2=PASS D=PASS E=PASS)
```

## server.log greps

- MaxListenersExceededWarning: 0
- ENOENT: 0
- 'Finalizing upload error': 0
- '[ChannelRefresh]' lines: 1

## server.log (matching upload/error lines, first 80)

```
[ChannelRefresh] chan-gauntlet-d: INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET must be configured to refresh Facebook-based tokens. — server credentials missing; refresh paused (fix INSTAGRAM_CLIENT_ID/SECRET)
```
