#!/usr/bin/env bash
#
# Planners gauntlet driver — boots the app (prod standalone or dev fallback)
# with the IG fetch-mock preload (the cron tick in PL7 must never hit the real
# Graph API) and runs:
#   1. planner-visual.mjs      (PL8 — wizard flows, Playwright)
#   2. planner-scenarios.mjs   (PL7 — fix-planners + cron tick over HTTP)
#   3. planner-direct.mts      (PL1-PL6 — runPlannerOnce in-process via tsx)
#
#   MODE=prod (default)  next build + standalone server (matches Docker prod).
#   MODE=dev             next dev fallback (used automatically if build fails).
#   RUN_DIR=...          where gates/round-<timestamp>-baseline.md is written
#                        (default: <repo>/gauntlet-runs/module-03-planners).
#
# Exit 0 only if ALL parts pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$REPO_ROOT/gauntlet-runs/module-03-planners}"
MODE="${MODE:-prod}"
OUT_DIR="$RUN_DIR/out"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/planner-gauntlet.XXXXXX")"
mkdir -p "$TMP/out"

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

run_part() {
	local label="$1" cmd="$2"
	echo "==> running $label"
	set +e
	# shellcheck disable=SC2086
	eval "$cmd" >"$TMP/out/$label.txt" 2>&1
	local rc=$?
	set -e
	echo "    ($label exit $rc)"
	cat "$TMP/out/$label.txt"
	return "$rc"
}

RC_ALL=0
run_part visual "node $REPO_ROOT/scripts/gauntlet/planner-visual.mjs \
	--base http://127.0.0.1:$PORT --db $TMP/test.db --secret $NEXTAUTH_SECRET \
	--uploads-dir $UPLOADS_DIR --out $TMP/out" || RC_ALL=1
run_part scenarios "node $REPO_ROOT/scripts/gauntlet/planner-scenarios.mjs \
	--base http://127.0.0.1:$PORT --db $TMP/test.db --secret $NEXTAUTH_SECRET --cron-secret $CRON_SECRET \
	--mock-state $IG_MOCK_STATE --mock-calls $IG_MOCK_CALLS \
	--server-log $TMP/server.log --out $TMP/out" || RC_ALL=1
run_part direct "cd $REPO_ROOT && npx --no-install tsx scripts/gauntlet/planner-direct.mts \
	--db $TMP/test.db" || RC_ALL=1

mkdir -p "$RUN_DIR/gates"
TS="$(date +%H%M%S)"
{
	echo "# Planners baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo
	echo "Mode: $MODE | Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
	echo "Evidence dir: $TMP"
	echo
	echo "## PL8 (visual — wizard)"
	echo
	echo '```'
	cat "$TMP/out/visual.txt"
	echo '```'
	echo
	echo "## PL7 (fix-planners + cron)"
	echo
	echo '```'
	cat "$TMP/out/scenarios.txt"
	echo '```'
	echo
	echo "## PL1-PL6 (direct)"
	echo
	echo '```'
	cat "$TMP/out/direct.txt"
	echo '```'
	echo
	echo "## server.log greps"
	echo
	echo "- ENOENT: $(grep -c ENOENT "$TMP/server.log" || true)"
	echo "- Unhandled/TypeError: $(grep -cE 'Unhandled|TypeError' "$TMP/server.log" || true)"
	echo "- '[api-error]' lines: $(grep -c '\[api-error\]' "$TMP/server.log" || true)"
	echo "- 'UNMATCHED_MOCK' (accidental real-IG calls): $(grep -c UNMATCHED_MOCK "$TMP/server.log" || true)"
	echo "- '[ChannelRefresh]' lines: $(grep -c '\[ChannelRefresh\]' "$TMP/server.log" || true)"
	echo
	echo "## server.log (matching error lines, first 60)"
	echo
	echo '```'
	grep -E "ENOENT|Unhandled|TypeError|\[api-error\]|UNMATCHED_MOCK|ChannelRefresh|error:" \
		"$TMP/server.log" | head -60 || true
	echo '```'
} >"$RUN_DIR/gates/round-$TS-baseline.md"
cp "$TMP/server.log" "$RUN_DIR/gates/round-$TS-server.log" 2>/dev/null || true
mkdir -p "$OUT_DIR"
cp "$TMP"/out/planners-*.png "$OUT_DIR/" 2>/dev/null || true

echo
if [ "$RC_ALL" -eq 0 ]; then
	echo "==> ALL PLANNER SCENARIOS PASS"
else
	echo "==> PLANNER SCENARIOS FAILED (exit $RC_ALL)"
fi
exit "$RC_ALL"
