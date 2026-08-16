# Lint baseline (round 01 gates)

- Full repo: 71 pre-existing errors + 51 warnings (identical at ce8c485 pre-gauntlet and at HEAD — verified via stash-compare; the repo was never lint-clean).
- Errors live in old files: planner-runtime.ts, PlannerWizard.tsx, ImageEditorModal.tsx, CommandPalette.tsx, app/planners, app/api/planners/*, admin/fix-planners, etc.
- Gauntlet-touched files (upload-chunk/*, lib/upload-lock.ts, contexts/UploadContext.tsx, cron/publisher, lib/instagram.ts): ZERO lint errors (npx eslint exit 0).
- Gate ruling: gauntlet rounds must not ADD lint errors; pre-existing baseline recorded and out of scope.
- Incident log: a git stash pop against a clean tree applied an old session stash and injected conflict markers; restored from HEAD; stash@{0} preserved untouched.
