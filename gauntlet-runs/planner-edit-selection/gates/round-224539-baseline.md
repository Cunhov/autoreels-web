# Planner edit-selection/tags — round-224539-baseline — 2026-08-23T01:45:39Z

Mode: prod | Commit: 2cbe47b | BASELINE=1

## S1/S2 (wizard UI) + S3/S4 preview (HTTP)

```
FATAL: locator.waitFor: Error: strict mode violation: getByText('130 items') resolved to 2 elements:
    1) <span class="text-xs text-ios-secondary bg-ios-card border border-ios-separator px-2.5 py-2 rounded-xl whitespace-nowrap">130 items</span> aka getByText('130 items', { exact: true })
    2) <span class="text-xs text-ios-secondary">Showing 100 of 130 items</span> aka getByText('Showing 100 of 130 items')

Call log:
[2m  - waiting for getByText('130 items') to be visible[22m

    at main (/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-edit-scenarios.mjs:287:48)
```

## S3/S4 direct (runPlannerOnce)

```
FATAL: PrismaClientKnownRequestError: 
Invalid `prisma.channel.create()` invocation in
/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-edit-direct.mts:51:23

  48 	update: {},
  49 	create: { id: "admin", email: "admin@test.local", name: "admin" },
  50 });
→ 51 await prisma.channel.create(
Unique constraint failed on the fields: (`user_id`, `account_id`)
    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/src/runtime/RequestHandler.ts:237:13)
    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/src/runtime/RequestHandler.ts:183:12)
    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/src/runtime/RequestHandler.ts:152:12)
    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/src/runtime/getPrismaClient.ts:808:24)
    at async seedBase (/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-edit-direct.mts:51:2)
    at async main (/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-edit-direct.mts:113:2)
```

## server.log greps

- Unhandled/TypeError: 0
- '[api-error]' lines: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0

## reports

```
(missing)
```

```
{
  "fatal": "PrismaClientKnownRequestError: \nInvalid `prisma.channel.create()` invocation in\n/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-edit-direct.mts:51:23\n\n  48 \tupdate: {},\n  49 \tcreate: { id: \"admin\", email: \"admin@test.local\", name: \"admin\" },\n  50 });\n→ 51 await prisma.channel.create(\nUnique constraint failed on the fields: (`user_id`, `account_id`)\n    at zr.handleRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/src/runtime/RequestHandler.ts:237:13)\n    at zr.handleAndLogRequestError (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/src/runtime/RequestHandler.ts:183:12)\n    at zr.request (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/src/runtime/RequestHandler.ts:152:12)\n    at async a (/Users/bestoptionnotebook/Documents/autoreels-web/node_modules/@prisma/client/src/runtime/getPrismaClient.ts:808:24)\n    at async seedBase (/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-edit-direct.mts:51:2)\n    at async main (/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/planner-edit-direct.mts:113:2)"
}```
