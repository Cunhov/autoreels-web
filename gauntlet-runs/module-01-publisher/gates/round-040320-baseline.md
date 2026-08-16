# Publisher baseline — 2026-08-16T07:03:20Z

Mode: prod | Commit: 1eddd7d
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//publisher-gauntlet.UrWdg4

## Summary

```
SCENARIO P1: PASS — a=pending b=failed/Processing Timeout c=failed/Processing Timeout cron=200 timeout=undefined
SCENARIO P2a: PASS — status=published media_id=media-ok published=1
SCENARIO P2b: PASS — status=published publish_calls=1 published=1
SCENARIO P2c: PASS — status=published publish_calls=1 published=1
SCENARIO P2: PASS — a=true b=true c=true (sub-scenarios above)
SCENARIO P3: FAIL — child_create_calls_total=3 (bar: 3) after1=pending/attempts=1 final=processing_upload
SCENARIO P4: PASS — t1: p1=ready_to_publish/att=1 p2=ready_to_publish/att=0 429calls=1 | t2: p1=published p2=published okCalls=2
SCENARIO P5: PASS — status=failed/Publishing Failed publish_calls=1 notify=1
SCENARIO P6: PASS — status=failed attempts=5 500_calls=5 (budget finite)
SCENARIO P7: PASS — chan: t1=published/ready_to_publish->published okCalls=2 | global: t1=published/ready_to_publish->published
SCENARIO P8: PASS — post=failed channel=inactive/expires=true refresh_calls=1 ChannelRefresh_lines=1
SCENARIO P9: FAIL — t1_elapsed=45034ms timeout=false wall<60s=true published_t1=5(oldest5=true) published_all=10 ok_publish_calls=5
SCENARIO P10: FAIL — skipped=0/2 winner_published=2 db_published=2
SCENARIO P11: PASS — status=failed/Missing Media notify=1

=== SUMMARY ===
P1: PASS — a=pending b=failed/Processing Timeout c=failed/Processing Timeout cron=200 timeout=undefined
P2a: PASS — status=published media_id=media-ok published=1
P2b: PASS — status=published publish_calls=1 published=1
P2c: PASS — status=published publish_calls=1 published=1
P2: PASS — a=true b=true c=true (sub-scenarios above)
P3: FAIL — child_create_calls_total=3 (bar: 3) after1=pending/attempts=1 final=processing_upload
P4: PASS — t1: p1=ready_to_publish/att=1 p2=ready_to_publish/att=0 429calls=1 | t2: p1=published p2=published okCalls=2
P5: PASS — status=failed/Publishing Failed publish_calls=1 notify=1
P6: PASS — status=failed attempts=5 500_calls=5 (budget finite)
P7: PASS — chan: t1=published/ready_to_publish->published okCalls=2 | global: t1=published/ready_to_publish->published
P8: PASS — post=failed channel=inactive/expires=true refresh_calls=1 ChannelRefresh_lines=1
P9: FAIL — t1_elapsed=45034ms timeout=false wall<60s=true published_t1=5(oldest5=true) published_all=10 ok_publish_calls=5
P10: FAIL — skipped=0/2 winner_published=2 db_published=2
P11: PASS — status=failed/Missing Media notify=1

TOTAL: 11/14 pass
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
