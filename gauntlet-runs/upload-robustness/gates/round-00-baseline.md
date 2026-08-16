# Round 00 baseline — 2026-08-16T05:32:20Z

Mode: prod | Commit: e5f5315
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.jfCYAy

## Summary

```
base=http://127.0.0.1:62795 db=/var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.jfCYAy/test.db uploads=/var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//upload-gauntlet.jfCYAy/uploads
session cookie: next-auth.session-token=…
SCENARIO A: FAIL — MaxListenersExceededWarning found in server log
SCENARIO B: FAIL — completes ok=0/2 items=0 hashOk=false orphanParts=1 enoent=true
SCENARIO C: FAIL — completes ok=true/true items=1 matchesSource=false enoent=false
SCENARIO D: FAIL — ChannelRefresh lines=2 (bar ≤1) terminalState=false cronStatus=200/200
SCENARIO E: PASS — statusChunks=[0,1,2] complete=200 items=1 hashOk=true

TOTAL: FAILURES PRESENT (A-E: A=FAIL B=FAIL C=FAIL D=FAIL E=PASS)
```

## server.log greps

- MaxListenersExceededWarning: 18
- ENOENT: 8
- 'Finalizing upload error': 2
- '[ChannelRefresh]' lines: 2

## server.log (matching upload/error lines, first 80)

```
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 error listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 finish listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 end listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 error listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 finish listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 end listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
Finalizing upload error: [Error: ENOENT: no such file or directory, open '/Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-b-1.mp4.part.10'] {
  code: 'ENOENT',
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 error listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
Finalizing upload error: [Error: ENOENT: no such file or directory, open '/Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-b-1.mp4.part.4'] {
  code: 'ENOENT',
[api-error] [Error: ENOENT: no such file or directory, open '/Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-b-1.mp4.part.4'] {
  code: 'ENOENT',
[api-error] [Error: ENOENT: no such file or directory, open '/Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-b-1.mp4.part.10'] {
  code: 'ENOENT',
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
[ChannelRefresh] chan-gauntlet-d: INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET must be configured to refresh Facebook-based tokens.
[ChannelRefresh] chan-gauntlet-d: INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET must be configured to refresh Facebook-based tokens.
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 error listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 finish listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
(node:87724) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 end listeners added to [WriteStream]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
```
