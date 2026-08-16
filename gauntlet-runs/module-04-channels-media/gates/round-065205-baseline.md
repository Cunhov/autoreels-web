# Channels/Media/Backup baseline — 2026-08-16T09:52:05Z

Mode: prod | Commit: 221d5ac
Evidence dir: /var/folders/28/xppyht0s0w9cmfv134s0zxcm0000gn/T//channels-gauntlet.8yIBne

## channels

```
file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/channels-scenarios.mjs:30
	createHash,
	^^^^^^^^^^
SyntaxError: The requested module 'node:fs' does not provide an export named 'createHash'
    at #asyncInstantiate (node:internal/modules/esm/module_job:319:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:422:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:639:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.8.1
```

## media

```
  setup: clip=/Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/clip.mp4 duration=3s ffmpeg=ok
SCENARIO M5: PASS — happy=true/status=201/dur=2/probe=2 invRange=true/400 tooShort=true/400 beyond=true/400 missing=true/404 corrupt=true/500
SCENARIO M6: EXCEPTION — ReferenceError: readFileSync is not defined
    at scenarioM6 (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/media-scenarios.mjs:233:3)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async main (file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/media-scenarios.mjs:309:4)

=== SUMMARY ===
M5: PASS — happy=true/status=201/dur=2/probe=2 invRange=true/400 tooShort=true/400 beyond=true/400 missing=true/404 corrupt=true/500
M6: FAIL — EXCEPTION: readFileSync is not defined

TOTAL: 1/2 pass
```

## visual

```
M7 FATAL: locator.click: Timeout 5000ms exceeded.
Call log:
[2m  - waiting for getByTitle('Edit Image').first()[22m

    at /Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/media-visual.mjs:133:17
    at async main (/Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/media-visual.mjs:131:2)
```

## restore

```
file:///Users/bestoptionnotebook/Documents/autoreels-web/scripts/gauntlet/channels-restore.mjs:27
	createHash,
	^^^^^^^^^^
SyntaxError: The requested module 'node:fs' does not provide an export named 'createHash'
    at #asyncInstantiate (node:internal/modules/esm/module_job:319:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:422:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:639:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.8.1
```

## server.log greps

- ENOENT: 0
- Unhandled/TypeError: 0
- 'UNMATCHED_MOCK' (accidental real-IG calls): 0
- '[api-error]' lines: 1

## server.log (matching error lines, first 60)

```
[video/trim] error: Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
[api-error] Error: ffprobe failed: Command failed: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /Users/bestoptionnotebook/Documents/autoreels-web/.next/standalone/data/uploads/admin/gauntlet-mod4/corrupt.mp4
```
