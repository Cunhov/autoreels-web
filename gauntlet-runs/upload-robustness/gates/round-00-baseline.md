# Round 00 baseline — 2026-08-16T05:49:35Z

Mode: prod | Commit: 9b51aca
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.Mg8ec2

## Summary

```
base=http://127.0.0.1:62912 db=/var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.Mg8ec2/test.db uploads=/var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.Mg8ec2/uploads
session cookie: next-auth.session-token=…
SCENARIO A: PASS — 3 files (4/4/20 chunks) finalized, hashes match, 1 item each, no warnings
SCENARIO B: PASS — completes ok=1/2 items=1 hashOk=true orphanParts=0 enoent=false
SCENARIO C: FAIL — completes ok=true/false items=1 matchesSource=false enoent=false
SCENARIO D: PASS — ChannelRefresh lines=1 (bar ≤1) terminalState=true cronStatus=200/200
SCENARIO E: PASS — statusChunks=[0,1,2] complete=200 items=1 hashOk=true

TOTAL: FAILURES PRESENT (A-E: A=PASS B=PASS C=FAIL D=PASS E=PASS)
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
