# Round 00 baseline — 2026-08-16T05:44:44Z

Mode: prod | Commit: f9585f3
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.IsZaXH

## Summary

```
base=http://127.0.0.1:62884 db=/var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.IsZaXH/test.db uploads=/var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.IsZaXH/uploads
session cookie: next-auth.session-token=…
SCENARIO A: PASS — 3 files (4/4/20 chunks) finalized, hashes match, 1 item each, no warnings
SCENARIO B: PASS — completes ok=1/2 items=1 hashOk=true orphanParts=0 enoent=false
SCENARIO C: FAIL — completes ok=false/false items=0 matchesSource=false enoent=true
SCENARIO D: PASS — ChannelRefresh lines=1 (bar ≤1) terminalState=true cronStatus=200/200
SCENARIO E: PASS — statusChunks=[0,1,2] complete=200 items=1 hashOk=true

TOTAL: FAILURES PRESENT (A-E: A=PASS B=PASS C=FAIL D=PASS E=PASS)
```

## server.log greps

- MaxListenersExceededWarning: 0
- ENOENT: 0
- 'Finalizing upload error': 1
- '[ChannelRefresh]' lines: 1

## server.log (matching upload/error lines, first 80)

```
Finalizing upload error: Error: Part 0 missing while consuming staged parts (concurrent delete?)
[api-error] Error: Part 0 missing while consuming staged parts (concurrent delete?)
[ChannelRefresh] chan-gauntlet-d: INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET must be configured to refresh Facebook-based tokens. — server credentials missing; refresh paused (fix INSTAGRAM_CLIENT_ID/SECRET)
```
