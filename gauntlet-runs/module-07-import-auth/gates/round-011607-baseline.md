# Import/Storage/Auth/Worker baseline — 2026-08-19T04:16:07Z

Mode: prod | Commit: 2cbe47b
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//import-gauntlet.jHNW0u

## I1-I4 (import / file / storage / maintenance)

```
Missing required argument --fixture-state
```

## I5-I6 (auth/rate-limit + worker)

```
SCENARIO I5: PASS — login: wrongPass=401 wrongUser=401(identicalBody=true) correct=200/sessionWorks=true rateLimit: 10 wrong + correct from 192.0.2.99 → 401(lockout) otherIp=200 (per-IP keying)
SCENARIO I6: PASS — worker: publisherPOST+auth=true all4Endpoints=true 500logged=true aliveAfter500=true intervalGapOk=true(gaps=0,8s) missingSecretExit=1 (no backoff: fixed recursive-setTimeout interval — documented)

=== SUMMARY ===
I5: PASS — login: wrongPass=401 wrongUser=401(identicalBody=true) correct=200/sessionWorks=true rateLimit: 10 wrong + correct from 192.0.2.99 → 401(lockout) otherIp=200 (per-IP keying)
I6: PASS — worker: publisherPOST+auth=true all4Endpoints=true 500logged=true aliveAfter500=true intervalGapOk=true(gaps=0,8s) missingSecretExit=1 (no backoff: fixed recursive-setTimeout interval — documented)

TOTAL: 2/2 pass
```

## I7 (login visual)

```
SCENARIO I7: FAIL — render=true autofocus="none" wrongPassError=false emptySubmitError=true/noCrash=true mobileHScroll=0px successRedirect=true consoleErrors=2 pageErrors=0
  console errors: ["Failed to load resource: the server responded with a status of 401 (Unauthorized)","Failed to load resource: the server responded with a status of 401 (Unauthorized)"]
```

## I8 (perf)

```
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

page.evaluate: Target page, context or browser has been closed
    at /Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/import-perf.mjs:100:26

Node.js v25.8.1
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0
- '[api-error]' lines: 0

## server.log (matching error lines, first 60)

```
```
