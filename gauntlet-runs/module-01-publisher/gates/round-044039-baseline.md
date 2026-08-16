# Publisher baseline — 2026-08-16T07:40:39Z

Mode: prod | Commit: f3c4be6
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//publisher-gauntlet.pLQ6D5

## Summary

```
SCENARIO P1: EXCEPTION — ReferenceError: r is not defined
    at scenarioP1 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/publisher-scenarios.mjs:315:3)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async main (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/publisher-scenarios.mjs:1143:4)
SCENARIO P2: EXCEPTION — ReferenceError: r is not defined
    at scenarioP2 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/publisher-scenarios.mjs:350:3)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async main (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/publisher-scenarios.mjs:1143:4)
SCENARIO P3: PASS — child_create_calls_total=4 (t1=3+t2=1; bar: 4 = 2 ok + 1 failed attempt + 1 retry of the missing child) uniqueStored=3 after1=pending/attempts=1 final=published
SCENARIO P4: EXCEPTION — ReferenceError: r1 is not defined
    at scenarioP4 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/publisher-scenarios.mjs:591:4)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async main (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/publisher-scenarios.mjs:1143:4)
SCENARIO P5: PASS — status=failed/Publishing Failed publish_calls=1 notify=1
SCENARIO P6: PASS — status=failed attempts=5 500_calls=5 (budget finite)
SCENARIO P7: EXCEPTION — ReferenceError: r1 is not defined
    at scenarioP7 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/publisher-scenarios.mjs:734:4)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async main (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/publisher-scenarios.mjs:1143:4)
SCENARIO P8: PASS — post=failed channel=inactive/expires=true refresh_calls=1 ChannelRefresh_lines=1
  P9a: t1_elapsed=10036ms published_t1=5 oldest5=true → ok
  P9a(2): published_all=10 ok_publish_calls(all)=10 → ok
  P9b: elapsed=46024ms timeout=true slow=processing_upload queued=processing → ok
  P9b(2 recovery): queued=pending → ok
SCENARIO P9: PASS — a(ordem+bounded)=true a2(exactly-once)=true b(budget)=true b2(recovery)=true
SCENARIO P10: PASS — skipped=1/2 winner_published=2 db_published=2
SCENARIO P11: PASS — status=failed/Missing Media notify=1

=== SUMMARY ===
P1: FAIL — EXCEPTION: r is not defined
P2: FAIL — EXCEPTION: r is not defined
P3: PASS — child_create_calls_total=4 (t1=3+t2=1; bar: 4 = 2 ok + 1 failed attempt + 1 retry of the missing child) uniqueStored=3 after1=pending/attempts=1 final=published
P4: FAIL — EXCEPTION: r1 is not defined
P5: PASS — status=failed/Publishing Failed publish_calls=1 notify=1
P6: PASS — status=failed attempts=5 500_calls=5 (budget finite)
P7: FAIL — EXCEPTION: r1 is not defined
P8: PASS — post=failed channel=inactive/expires=true refresh_calls=1 ChannelRefresh_lines=1
P9: PASS — a(ordem+bounded)=true a2(exactly-once)=true b(budget)=true b2(recovery)=true
P10: PASS — skipped=1/2 winner_published=2 db_published=2
P11: PASS — status=failed/Missing Media notify=1

TOTAL: 7/11 pass
server log crash-signal lines: 0

server-log crash-signal lines: 0
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- '[ChannelRefresh]' lines: 1
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0

## server.log (matching error lines, first 60)

```
[ChannelRefresh] chan-p8: Error validating access token: Session key is malformed because of invalid user id. — access token rejected; channel deactivated (reconnect it)
```
