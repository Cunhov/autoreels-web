#!/usr/bin/env bash
#
# Planner "edit selection + caption tags" gauntlet driver — boots the app
# (prod standalone with dev fallback) on a throwaway SQLite DB and runs:
#   1. planner-edit-scenarios.mjs  (S1/S2 wizard UI + S3/S4 preview HTTP)
#   2. planner-edit-direct.mts     (S3/S4 publish lane via runPlannerOnce)
#
#   MODE=prod (default)  next build + standalone server (matches Docker prod).
#   MODE=dev             skip the build, run next dev directly.
#   BASELINE=1           copy merged reports to $REPO_ROOT/gauntlet-runs/planner-edit-selection/out/baseline.json
#   LABEL=<name>         gate file suffix (default: baseline)
#   RUN_DIR=...          where gates/round-<ts>-<label>.md is written
#                        (default: <repo>/gauntlet-runs/planner-edit-selection).
#
# Exit 0 only if ALL parts pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$REPO_ROOT/gauntlet-runs/planner-edit-selection}"
MODE="${MODE:-prod}"
BASELINE="${BASELINE:-0}"
LABEL="${LABEL:-baseline}"
OUT_DIR="$RUN_DIR/out"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/planner-edit-gauntlet.XXXXXX")"
mkdir -p "$TMP" "$OUT_DIR"

DATABASE_URL="file:$TMP/test.db"
NEXTAUTH_SECRET="gauntlet-secret-$(openssl rand -hex 8)"
CRON_SECRET="gauntlet-cron-$(openssl rand -hex 8)"
PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
IG_MOCK_STATE="$TMP/ig-mock-state.json"
IG_MOCK_CALLS="$TMP/ig-mock-calls.jsonl"
echo '{"rules":[],"consumed":{}}' >"$IG_MOCK_STATE"
: >"$IG_MOCK_CALLS"

if [ "$MODE" = "prod" ]; then
	UPLOADS_DIR="$REPO_ROOT/.next/standalone/data/uploads"
else
	UPLOADS_DIR="$REPO_ROOT/data/uploads"
fi
SA_DIR="$REPO_ROOT/.next/standalone"
mkdir -p "$UPLOADS_DIR"

SERVER_PID=""
cleanup() {
	set +e
	if [ -n "$SERVER_PID" ]; then
		kill "$SERVER_PID" 2>/dev/null
		wait "$SERVER_PID" 2>/dev/null
	fi
	set -e
}
trap cleanup EXIT

echo "==> temp dir: $TMP (port $PORT, mode $MODE)"

echo "==> prisma db push (test DB $TMP/test.db)"
DATABASE_URL="$DATABASE_URL" npx prisma db push --accept-data-loss >"$TMP/dbpush.log" 2>&1
echo "    db push ok"

if [ "$MODE" = "prod" ]; then
	echo "==> next build"
	if DATABASE_URL="$DATABASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
		npm run build >"$TMP/build.log" 2>&1; then
		echo "    build ok"
		if [ -d "$REPO_ROOT/.next/static" ]; then
			mkdir -p "$SA_DIR/.next"
			rm -rf "$SA_DIR/.next/static"
			cp -r "$REPO_ROOT/.next/static" "$SA_DIR/.next/static"
			echo "    static copied into standalone"
		else
			echo "!! .next/static missing — page will not hydrate in browser scenarios"
		fi
	else
		echo "!! next build FAILED — falling back to dev mode (see $TMP/build.log)"
		MODE=dev
		UPLOADS_DIR="$REPO_ROOT/data/uploads"
		mkdir -p "$UPLOADS_DIR"
	fi
fi

if [ "$MODE" = "prod" ]; then
	(
		cd "$SA_DIR"
		exec env PORT="$PORT" HOSTNAME=127.0.0.1 DATABASE_URL="$DATABASE_URL" \
			NEXTAUTH_SECRET="$NEXTAUTH_SECRET" CRON_SECRET="$CRON_SECRET" \
			ADMIN_EMAIL="admin@test.local" ADMIN_PASSWORD="TestPass123!" \
			PUBLIC_BASE_URL="http://127.0.0.1:$PORT" \
			IG_MOCK_STATE="$IG_MOCK_STATE" IG_MOCK_CALLS="$IG_MOCK_CALLS" \
			node --import "$REPO_ROOT/scripts/gauntlet/fetch-mock.mjs" server.js
	) >"$TMP/server.log" 2>&1 &
else
	(
		cd "$REPO_ROOT"
		exec env DATABASE_URL="$DATABASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
			CRON_SECRET="$CRON_SECRET" ADMIN_EMAIL="admin@test.local" ADMIN_PASSWORD="TestPass123!" \
			PUBLIC_BASE_URL="http://127.0.0.1:$PORT" \
			IG_MOCK_STATE="$IG_MOCK_STATE" IG_MOCK_CALLS="$IG_MOCK_CALLS" \
			npx next dev -p "$PORT" -H 127.0.0.1
	) >"$TMP/server.log" 2>&1 &
fi
SERVER_PID=$!

ready() { curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
for _ in $(seq 1 120); do
	ready && break
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		echo "!! server died during startup"
		tail -40 "$TMP/server.log"
		exit 3
	fi
	sleep 1
done
if ! ready; then
	echo "!! server not ready after 120s"
	tail -40 "$TMP/server.log"
	exit 3
fi
echo "==> server ready on port $PORT"

RC_ALL=0

echo "==> running scenarios (S1/S2 UI + S3/S4 preview)"
set +e
node "$REPO_ROOT/scripts/gauntlet/planner-edit-scenarios.mjs" \
	--base "http://127.0.0.1:$PORT" --db "$TMP/test.db" --secret "$NEXTAUTH_SECRET" \
	--uploads-dir "$UPLOADS_DIR" --out "$OUT_DIR" >"$TMP/scenarios.txt" 2>&1
RC_SCEN=$?
set -e
echo "    (scenarios exit $RC_SCEN)"
cat "$TMP/scenarios.txt"
[ "$RC_SCEN" -eq 0 ] || RC_ALL=1

echo "==> running direct (S3/S4 publish lane via runPlannerOnce)"
set +e
(cd "$REPO_ROOT" && npx --no-install tsx scripts/gauntlet/planner-edit-direct.mts \
	--db "$TMP/test.db" --out "$OUT_DIR/planner-edit-direct-report.json") >"$TMP/direct.txt" 2>&1
RC_DIRECT=$?
set -e
echo "    (direct exit $RC_DIRECT)"
cat "$TMP/direct.txt"
[ "$RC_DIRECT" -eq 0 ] || RC_ALL=1

TS="$(date +%H%M%S)"
mkdir -p "$RUN_DIR/gates"
{
	echo "# Planner edit-selection/tags — round-$TS-$LABEL — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo
	echo "Mode: $MODE | Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD) | BASELINE=$BASELINE"
	echo
	echo "## S1/S2 (wizard UI) + S3/S4 preview (HTTP)"
	echo
	echo '```'
	cat "$TMP/scenarios.txt"
	echo '```'
	echo
	echo "## S3/S4 direct (runPlannerOnce)"
	echo
	echo '```'
	cat "$TMP/direct.txt"
	echo '```'
	echo
	echo "## server.log greps"
	echo
	echo "- Unhandled/TypeError: $(grep -cE 'Unhandled|TypeError' "$TMP/server.log" || true)"
	echo "- '[api-error]' lines: $(grep -c '\[api-error\]' "$TMP/server.log" || true)"
	echo "- 'UNMATCHED_MOCK' (accidental real-IG calls): $(grep -c UNMATCHED_MOCK "$TMP/server.log" || true)"
	echo
	echo "## reports"
	echo
	echo '```'
	cat "$OUT_DIR/planner-edit-report.json" 2>/dev/null || echo "(missing)"
	echo '```'
	echo
	echo '```'
	cat "$OUT_DIR/planner-edit-direct-report.json" 2>/dev/null || echo "(missing)"
	echo '```'
} >"$RUN_DIR/gates/round-$TS-$LABEL.md"
cp "$TMP/server.log" "$RUN_DIR/gates/round-$TS-$LABEL-server.log" 2>/dev/null || true

# Merge both reports for tooling (lead/critic agents read a single JSON).
MERGED="$OUT_DIR/round-$TS-merged.json"
node -e '
const fs = require("fs");
const read = (i) => { try { return JSON.parse(fs.readFileSync(process.argv[i], "utf8")); } catch { return null; } };
// with -e, process.argv[1] is the FIRST user argument
const scen = read(1) || {};
const dir = read(2) || {};
const merged = {
	label: process.argv[3],
	mode: process.argv[4],
	commit: process.argv[5],
	scenarios: { ...(scen.scenarios || {}), S3direct: dir.S3direct || null, S4direct: dir.S4direct || null },
	consoleErrors: scen.consoleErrors || [],
	pageErrors: scen.pageErrors || [],
	pass: Boolean(scen.pass) && Boolean(dir.S3direct?.pass) && Boolean(dir.S4direct?.pass),
};
fs.writeFileSync(process.argv[6], JSON.stringify(merged, null, 2));
' \
	"$OUT_DIR/planner-edit-report.json" \
	"$OUT_DIR/planner-edit-direct-report.json" \
	"$LABEL" "$MODE" "$(git -C "$REPO_ROOT" rev-parse --short HEAD)" \
	"$MERGED" || true

if [ "$BASELINE" = "1" ]; then
	cp "$MERGED" "$OUT_DIR/baseline.json" 2>/dev/null || true
	echo "==> baseline written to $OUT_DIR/baseline.json"
fi

echo
if [ "$RC_ALL" -eq 0 ]; then
	echo "==> ALL PLANNER-EDIT SCENARIOS PASS"
else
	echo "==> PLANNER-EDIT SCENARIOS FAILED (exit $RC_ALL)"
fi
exit "$RC_ALL"
