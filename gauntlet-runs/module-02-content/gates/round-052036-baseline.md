# Content Library baseline — 2026-08-16T08:20:36Z

Mode: prod | Commit: f8e40eb
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//content-gauntlet.fwhy3C

## L1-L6 (invariant harness)

```
SCENARIO L1: EXCEPTION — PrismaClientKnownRequestError: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:8286)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7581)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7288)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:75:5816)
    at async scenarioL1 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:205:15)
    at async file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:657:3
SCENARIO L2: EXCEPTION — PrismaClientKnownRequestError: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:8286)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7581)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7288)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:75:5816)
    at async scenarioL2 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:255:17)
    at async file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:657:3
SCENARIO L3: EXCEPTION — PrismaClientKnownRequestError: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:8286)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7581)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7288)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:75:5816)
    at async scenarioL3 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:322:12)
    at async file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:657:3
SCENARIO L4: EXCEPTION — PrismaClientKnownRequestError: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:8286)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7581)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7288)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:75:5816)
    at async scenarioL4 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:397:17)
    at async file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:657:3
SCENARIO L5a: FAIL — content-items POST same name: rows=0 (bar: 1 via dedupe; code: creates 2 — dedupe lives in upload-finalize, documented) statuses=400/400 filesIntact=true
SCENARIO L5b: FAIL — upload-finalize dedupe: c1=500 c2=400 sameId=true rows=0 finalFileOk=false (declaredSize=600)
SCENARIO L6: EXCEPTION — PrismaClientKnownRequestError: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:8286)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7581)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7288)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:75:5816)
    at async scenarioL6 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:568:13)
    at async file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-scenarios.mjs:657:3

=== SUMMARY ===
L1: FAIL — EXCEPTION: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
L2: FAIL — EXCEPTION: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
L3: FAIL — EXCEPTION: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
L4: FAIL — EXCEPTION: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
L5a: FAIL — content-items POST same name: rows=0 (bar: 1 via dedupe; code: creates 2 — dedupe lives in upload-finalize, documented) statuses=400/400 filesIntact=true
L5b: FAIL — upload-finalize dedupe: c1=500 c2=400 sameId=true rows=0 finalFileOk=false (declaredSize=600)
L6: FAIL — EXCEPTION: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key

TOTAL: 0/7 pass
server log crash-signal lines: 0
```

## L7 (visual — console errors)

```
FATAL: PrismaClientKnownRequestError: 
Invalid `prisma.contentItem.create()` invocation:


Foreign key constraint violated on the foreign key
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:8286)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7581)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7288)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:75:5816)
    at async main (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-visual.mjs:84:17)
```

## L8 (perf baseline)

```
FATAL: PrismaClientKnownRequestError: 
Invalid `prisma.contentItem.createMany()` invocation:


Foreign key constraint violated on the foreign key
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:8286)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7581)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:65:7288)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/runtime/client.js:75:5816)
    at async main (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/content-perf.mjs:60:15)
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- '[api-error]' lines: 3

## server.log (matching error lines, first 60)

```
Create content item error: Error [PrismaClientKnownRequestError]: 
[api-error] Error [PrismaClientKnownRequestError]: 
Create content item error: Error [PrismaClientKnownRequestError]: 
[api-error] Error [PrismaClientKnownRequestError]: 
Finalizing upload error: Error [PrismaClientKnownRequestError]: 
[api-error] Error [PrismaClientKnownRequestError]: 
```
