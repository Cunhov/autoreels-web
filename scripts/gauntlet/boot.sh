#!/usr/bin/env bash
#
# Publisher gauntlet driver — boots the app with a MOCKED Instagram Graph API
# and runs scenarios P1-P11 (scripts/gauntlet/publisher-scenarios.mjs).
#
#   MODE=prod (default)  next build + standalone server (matches Docker prod).
#   MODE=dev             next dev fallback (used automatically if build fails).
#   RUN_DIR=...          where gates/round-<timestamp>-baseline.md is written
#                        (default: <repo>/gauntlet-runs/module-01-publisher).
#
# Exit 0 only if ALL scenarios pass. Restores everything on EXIT (trap).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$REPO_ROOT/gauntlet-runs/module-01-publisher}"
MODE="${MODE:-prod}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/publisher-gauntlet.XXXXXX")"
mkdir -p "$TMP/out"

DATABASE_URL="file:$TMP/test.db"
NEXTAUTH_SECRET="gauntlet-secret-$(openssl rand -hex 8)"
CRON_SECRET="gauntlet-cron-$(openssl rand -hex 8)"
PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
IG_MOCK_STATE="$TMP/ig-mock-state.json"
IG_MOCK_CALLS="$TMP/ig-mock-calls.jsonl"
echo '{"rules":[],"consumed":{}}' >"$IG_MOCK_STATE"
: >"$IG_MOCK_CALLS"

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
	else
		echo "!! next build FAILED — falling back to dev mode (see $TMP/build.log)"
		MODE=dev
	fi
fi

if [ "$MODE" = "prod" ]; then
	SA_DIR="$REPO_ROOT/.next/standalone"
	(
		cd "$SA_DIR"
		exec env PORT="$PORT" HOSTNAME=127.0.0.1 DATABASE_URL="$DATABASE_URL" \
			NEXTAUTH_SECRET="$NEXTAUTH_SECRET" CRON_SECRET="$CRON_SECRET" \
			PUBLIC_BASE_URL="http://127.0.0.1:$PORT" \
			IG_MOCK_STATE="$IG_MOCK_STATE" IG_MOCK_CALLS="$IG_MOCK_CALLS" \
			node --import "$REPO_ROOT/scripts/gauntlet/fetch-mock.mjs" server.js
	) >"$TMP/server.log" 2>&1 &
else
	(
		cd "$REPO_ROOT"
		exec env DATABASE_URL="$DATABASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
			CRON_SECRET="$CRON_SECRET" \
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
echo "==> running publisher scenarios P1-P11"

set +e
node "$REPO_ROOT/scripts/gauntlet/publisher-scenarios.mjs" \
	--base "http://127.0.0.1:$PORT" --db "$TMP/test.db" \
	--cron-secret "$CRON_SECRET" \
	--mock-state "$IG_MOCK_STATE" --mock-calls "$IG_MOCK_CALLS" \
	--server-log "$TMP/server.log" --out "$TMP/out" \
	>"$TMP/out/summary.txt" 2>&1
RC=$?
set -e

echo "==> summary"
cat "$TMP/out/summary.txt"

mkdir -p "$RUN_DIR/gates"
{
	echo "# Publisher baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo
	echo "Mode: $MODE | Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
	echo "Evidence dir: $TMP"
	echo
	echo "## Summary"
	echo
	echo '```'
	cat "$TMP/out/summary.txt"
	echo '```'
	echo
	echo "## server.log greps"
	echo
	echo "- ENOENT: $(grep -c ENOENT "$TMP/server.log" || true)"
	echo "- Unhandled/TypeError: $(grep -cE 'Unhandled|TypeError' "$TMP/server.log" || true)"
	echo "- '[ChannelRefresh]' lines: $(grep -c '\[ChannelRefresh\]' "$TMP/server.log" || true)"
	echo "- 'UNMATCHED_MOCK' (accidental real-IG calls): $(grep -c UNMATCHED_MOCK "$TMP/server.log" || true)"
	echo
	echo "## server.log (matching error lines, first 60)"
	echo
	echo '```'
	grep -E "ENOENT|Unhandled|TypeError|ChannelRefresh|UNMATCHED_MOCK|\[api-error\]|\[PlannerLog\]\[ERROR\]" \
		"$TMP/server.log" | head -60 || true
	echo '```'
} >"$RUN_DIR/gates/round-$(date +%H%M%S)-baseline.md"
cp "$TMP/server.log" "$RUN_DIR/gates/round-$(date +%H%M%S)-server.log" 2>/dev/null || true
cp "$TMP/ig-mock-calls.jsonl" "$RUN_DIR/gates/round-$(date +%H%M%S)-calls.jsonl" 2>/dev/null || true

echo
if [ "$RC" -eq 0 ]; then
	echo "==> ALL SCENARIOS PASS"
else
	echo "==> SCENARIOS FAILED (exit $RC)"
fi
exit "$RC"
