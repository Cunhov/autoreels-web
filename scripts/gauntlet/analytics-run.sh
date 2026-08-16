#!/usr/bin/env bash
#
# Analytics/Settings/Channels-UI gauntlet driver (module 06) — boots the app
# (prod standalone or dev fallback) with the IG/Graph API mocked (fetch-mock.mjs
# preload) and runs, in order:
#   1. analytics-scenarios.mjs  (S1 aggregation, S2 metrics cron, S3 settings, S4 channels test)
#   2. analytics-visual.mjs     (S5 analytics page, S6 settings page, S7 channels page + connect)
#   3. analytics-perf.mjs       (S8 heavy analytics workload + baseline compare)
#
#   MODE=prod (default) next build + standalone server; MODE=dev dev fallback.
#   RUN_DIR=...  gates output dir (default: <repo>/gauntlet-runs/module-06-analytics).
#
# Exit 0 only if ALL parts pass. Temp DB dies with the run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$REPO_ROOT/gauntlet-runs/module-06-analytics}"
MODE="${MODE:-prod}"
OUT_DIR="$RUN_DIR/out"
mkdir -p "$RUN_DIR/gates" "$OUT_DIR"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/analytics-gauntlet.XXXXXX")"
mkdir -p "$TMP/out"

DATABASE_URL="file:$TMP/test.db"
NEXTAUTH_SECRET="gauntlet-secret-$(openssl rand -hex 8)"
CRON_SECRET="gauntlet-cron-$(openssl rand -hex 8)"
PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
IG_MOCK_STATE="$TMP/ig-mock-state.json"
IG_MOCK_CALLS="$TMP/ig-mock-calls.jsonl"
echo '{"rules":[],"consumed":{}}' >"$IG_MOCK_STATE"
: >"$IG_MOCK_CALLS"

# OAuth env — the oauth/start route calls getInstagramOAuthConfig which THROWS
# without these (S7 drives the connect flow through the UI).
INSTAGRAM_CLIENT_ID="gauntlet-client"
INSTAGRAM_CLIENT_SECRET="gauntlet-secret"
# shellcheck disable=SC2034 # used inside the server env blocks below
INSTAGRAM_REDIRECT_URI=""

if [ "$MODE" = "prod" ]; then
	UPLOADS_DIR="$REPO_ROOT/.next/standalone/data/uploads"
else
	UPLOADS_DIR="$REPO_ROOT/data/uploads"
fi
SA_DIR="$REPO_ROOT/.next/standalone"
mkdir -p "$UPLOADS_DIR"
# Keep the shared uploads dir clean for this module only (own namespace).
rm -rf "$UPLOADS_DIR/admin/mod6"

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
			INSTAGRAM_CLIENT_ID="$INSTAGRAM_CLIENT_ID" \
			INSTAGRAM_CLIENT_SECRET="$INSTAGRAM_CLIENT_SECRET" \
			INSTAGRAM_REDIRECT_URI="http://127.0.0.1:$PORT/api/channels/oauth/callback" \
			IG_MOCK_STATE="$IG_MOCK_STATE" IG_MOCK_CALLS="$IG_MOCK_CALLS" \
			node --import "$REPO_ROOT/scripts/gauntlet/fetch-mock.mjs" server.js
	) >"$TMP/server.log" 2>&1 &
else
	(
		cd "$REPO_ROOT"
		exec env DATABASE_URL="$DATABASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
			CRON_SECRET="$CRON_SECRET" PUBLIC_BASE_URL="http://127.0.0.1:$PORT" \
			ADMIN_EMAIL="admin@test.local" ADMIN_PASSWORD="TestPass123!" \
			INSTAGRAM_CLIENT_ID="$INSTAGRAM_CLIENT_ID" \
			INSTAGRAM_CLIENT_SECRET="$INSTAGRAM_CLIENT_SECRET" \
			INSTAGRAM_REDIRECT_URI="http://127.0.0.1:$PORT/api/channels/oauth/callback" \
			IG_MOCK_STATE="$IG_MOCK_STATE" IG_MOCK_CALLS="$IG_MOCK_CALLS" \
			NODE_OPTIONS="--import $REPO_ROOT/scripts/gauntlet/fetch-mock.mjs" \
			npx next dev -p "$PORT" -H 127.0.0.1
	) >"$TMP/server.log" 2>&1 &
fi
SERVER_PID=$!

ready() { curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
for _ in $(seq 1 180); do
	ready && break
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		echo "!! server died during startup"
		tail -40 "$TMP/server.log"
		exit 3
	fi
	sleep 1
done
if ! ready; then
	echo "!! server not ready after 180s"
	tail -40 "$TMP/server.log"
	exit 3
fi
echo "==> server ready on port $PORT"

run_part() {
	local label="$1" script="$2" extra="${3:-}"
	echo "==> running $label"
	set +e
	# shellcheck disable=SC2086
	node "$REPO_ROOT/scripts/gauntlet/$script" \
		--base "http://127.0.0.1:$PORT" --db "$TMP/test.db" \
		--secret "$NEXTAUTH_SECRET" --cron-secret "$CRON_SECRET" \
		--uploads-dir "$UPLOADS_DIR" \
		--mock-state "$IG_MOCK_STATE" --mock-calls "$IG_MOCK_CALLS" \
		--server-log "$TMP/server.log" --out "$TMP/out" $extra \
		>"$TMP/out/$label.txt" 2>&1
	local rc=$?
	set -e
	echo "    ($label exit $rc)"
	cat "$TMP/out/$label.txt"
	return "$rc"
}

RC_ALL=0
run_part scenarios analytics-scenarios.mjs || RC_ALL=1
run_part visual analytics-visual.mjs || RC_ALL=1
run_part perf analytics-perf.mjs \
	"--baseline $RUN_DIR/gates/analytics-perf-baseline.json" || RC_ALL=1

mkdir -p "$RUN_DIR/gates"
TS="$(date +%H%M%S)"
{
	echo "# Analytics/Settings/Channels-UI baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo
	echo "Mode: $MODE | Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
	echo "Evidence dir: $TMP"
	echo
	for part in scenarios visual perf; do
		echo "## $(basename "$part")"
		echo
		echo '```'
		cat "$TMP/out/$part.txt"
		echo '```'
		echo
	done
	echo "## server.log greps"
	echo
	echo "- ENOENT: $(grep -c ENOENT "$TMP/server.log" || true)"
	echo "- Unhandled/TypeError: $(grep -cE 'Unhandled|TypeError' "$TMP/server.log" || true)"
	echo "- 'UNMATCHED_MOCK' (accidental real-IG calls): $(grep -c UNMATCHED_MOCK "$TMP/server.log" || true)"
	echo "- '[api-error]' lines: $(grep -c '\[api-error\]' "$TMP/server.log" || true)"
	echo
	echo "## server.log (matching error lines, first 60)"
	echo
	echo '```'
	grep -E "ENOENT|Unhandled|TypeError|UNMATCHED_MOCK|\[api-error\]|error:" \
		"$TMP/server.log" | head -60 || true
	echo '```'
} >"$RUN_DIR/gates/round-$TS-baseline.md"
cp "$TMP/server.log" "$RUN_DIR/gates/round-$TS-server.log" 2>/dev/null || true
cp "$IG_MOCK_CALLS" "$RUN_DIR/gates/round-$TS-calls.jsonl" 2>/dev/null || true
mkdir -p "$OUT_DIR"
cp "$TMP"/out/analytics-*.png "$OUT_DIR/" 2>/dev/null || true
cp "$TMP"/out/settings-*.png "$OUT_DIR/" 2>/dev/null || true
cp "$TMP"/out/channels-*.png "$OUT_DIR/" 2>/dev/null || true

echo
if [ "$RC_ALL" -eq 0 ]; then
	echo "==> ALL ANALYTICS/SETTINGS/CHANNELS SCENARIOS PASS"
else
	echo "==> ANALYTICS/SETTINGS/CHANNELS SCENARIOS FAILED (exit $RC_ALL)"
fi
exit "$RC_ALL"
