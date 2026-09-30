#!/usr/bin/env bash
#
# IG Automation gauntlet driver (spec docs/IG_AUTOMATION_SPEC.md §15) — boots
# the REAL app with a MOCKED Instagram Graph + OpenRouter and runs G1-G15
# (scripts/gauntlet/ig-automation-scenarios.mjs).
#
# Two phases:
#   A) server WITH OPENROUTER_API_KEY → G1-G15 (G12 asserts the mocked AI reply).
#   B) server WITHOUT OPENROUTER_API_KEY → G12 only (no-key failure path).
#
#   MODE=prod (default)  next build + standalone server (matches Docker prod).
#   MODE=dev             next dev fallback (used automatically if build fails).
#   RUN_DIR=...          where gates/round-<HHMMSS>-ig-automation.md is written
#                        (default: <repo>/gauntlet-runs/module-08-ig-automation).
#
# Exit 0 only if ALL scenarios pass in BOTH phases. Restores the server on EXIT (trap).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$REPO_ROOT/gauntlet-runs/module-08-ig-automation}"
MODE="${MODE:-prod}"
SCENARIOS="$REPO_ROOT/scripts/gauntlet/ig-automation-scenarios.mjs"
FETCH_MOCK="$REPO_ROOT/scripts/gauntlet/fetch-mock.mjs"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ig-automation-gauntlet.XXXXXX")"
mkdir -p "$TMP/out-a" "$TMP/out-b"

DATABASE_URL="file:$TMP/test.db"
NEXTAUTH_SECRET="gauntlet-secret-$(openssl rand -hex 8)"
CRON_SECRET="gauntlet-cron-$(openssl rand -hex 8)"
INSTAGRAM_CLIENT_SECRET="gauntlet-ig-secret-$(openssl rand -hex 8)"
META_WEBHOOK_VERIFY_TOKEN="gauntlet-verify-$(openssl rand -hex 8)"
OPENROUTER_API_KEY="sk-or-v1-gauntlet-$(openssl rand -hex 8)"
PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
PORT2="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
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

stop_server() {
	if [ -n "$SERVER_PID" ]; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
		SERVER_PID=""
	fi
}

wait_ready() {
	local port="$1" log="$2"
	for _ in $(seq 1 120); do
		if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
			echo "    server ready on port $port"
			return 0
		fi
		if ! kill -0 "$SERVER_PID" 2>/dev/null; then
			echo "!! server died during startup (port $port)"
			tail -40 "$log"
			return 1
		fi
		sleep 1
	done
	echo "!! server not ready after 120s (port $port)"
	tail -40 "$log"
	return 1
}

# start_server <port> <log> [extra env assignments...]
start_server() {
	local port="$1" log="$2"
	shift 2
	if [ "$MODE" = "prod" ]; then
		(
			cd "$REPO_ROOT/.next/standalone"
			exec env PORT="$port" HOSTNAME=127.0.0.1 DATABASE_URL="$DATABASE_URL" \
				NEXTAUTH_SECRET="$NEXTAUTH_SECRET" CRON_SECRET="$CRON_SECRET" \
				INSTAGRAM_CLIENT_SECRET="$INSTAGRAM_CLIENT_SECRET" \
				META_WEBHOOK_VERIFY_TOKEN="$META_WEBHOOK_VERIFY_TOKEN" \
				PUBLIC_BASE_URL="http://127.0.0.1:$port" \
				IG_MOCK_STATE="$IG_MOCK_STATE" IG_MOCK_CALLS="$IG_MOCK_CALLS" \
				"$@" \
				node --import "$FETCH_MOCK" server.js
		) >"$log" 2>&1 &
	else
		(
			cd "$REPO_ROOT"
			exec env DATABASE_URL="$DATABASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
				CRON_SECRET="$CRON_SECRET" \
				INSTAGRAM_CLIENT_SECRET="$INSTAGRAM_CLIENT_SECRET" \
				META_WEBHOOK_VERIFY_TOKEN="$META_WEBHOOK_VERIFY_TOKEN" \
				PUBLIC_BASE_URL="http://127.0.0.1:$port" \
				IG_MOCK_STATE="$IG_MOCK_STATE" IG_MOCK_CALLS="$IG_MOCK_CALLS" \
				NODE_OPTIONS="--import $FETCH_MOCK" \
				"$@" \
				npx next dev -p "$port" -H 127.0.0.1
		) >"$log" 2>&1 &
	fi
	SERVER_PID=$!
	wait_ready "$port" "$log"
}

# run_scenarios <port> <out> <server-log> [extra scenario args...]
run_scenarios() {
	local port="$1" out="$2" log="$3"
	shift 3
	node "$SCENARIOS" --base "http://127.0.0.1:$port" --db "$TMP/test.db" \
		--secret "$NEXTAUTH_SECRET" --ig-secret "$INSTAGRAM_CLIENT_SECRET" \
		--verify-token "$META_WEBHOOK_VERIFY_TOKEN" --cron-secret "$CRON_SECRET" \
		--mock-state "$IG_MOCK_STATE" --mock-calls "$IG_MOCK_CALLS" \
		--server-log "$log" --out "$out" \
		--public-base "http://127.0.0.1:$port" \
		"$@" >"$out/summary.txt" 2>&1
}

echo "==> temp dir: $TMP (ports $PORT/$PORT2, mode $MODE)"

echo "==> prisma db push (test DB $TMP/test.db)"
(
	cd "$REPO_ROOT"
	DATABASE_URL="$DATABASE_URL" npx prisma db push --accept-data-loss
) >"$TMP/dbpush.log" 2>&1
echo "    db push ok"

if [ "$MODE" = "prod" ]; then
	echo "==> next build"
	if (
		cd "$REPO_ROOT"
		DATABASE_URL="$DATABASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" npm run build
	) >"$TMP/build.log" 2>&1; then
		echo "    build ok"
	else
		echo "!! next build FAILED — falling back to dev mode (see $TMP/build.log)"
		MODE=dev
	fi
fi

echo "==> phase A: G1-G15 (OpenRouter mockado)"
start_server "$PORT" "$TMP/server-a.log" \
	"OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
	"OPENROUTER_MODEL=openai/gpt-4o-mini"

set +e
run_scenarios "$PORT" "$TMP/out-a" "$TMP/server-a.log" --openrouter-key "$OPENROUTER_API_KEY"
RC_A=$?
set -e
stop_server
cat "$TMP/out-a/summary.txt" 2>/dev/null || true

echo
echo "==> phase B: G12 sem OPENROUTER_API_KEY"
# Explicit empty assignment so an exported OPENROUTER_API_KEY in the operator
# shell can never leak into the no-key phase.
start_server "$PORT2" "$TMP/server-b.log" "OPENROUTER_API_KEY="

set +e
run_scenarios "$PORT2" "$TMP/out-b" "$TMP/server-b.log" --scenarios G12
RC_B=$?
set -e
stop_server
cat "$TMP/out-b/summary.txt" 2>/dev/null || true

RC="$RC_A"
if [ "$RC_B" -ne 0 ]; then
	RC="$RC_B"
fi

TS="$(date +%H%M%S)"
mkdir -p "$RUN_DIR/gates"
GATE_MD="$RUN_DIR/gates/round-$TS-ig-automation.md"
{
	echo "# IG Automation baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo
	echo "Mode: $MODE | Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'n/a')"
	echo "Evidence dir: $TMP"
	echo
	echo "## Phase A — G1-G15 (OpenRouter mockado)"
	echo
	echo '```'
	cat "$TMP/out-a/summary.txt" 2>/dev/null || echo "(sem summary)"
	echo '```'
	echo
	echo "## Phase B — G12 sem chave (servidor sem OPENROUTER_API_KEY)"
	echo
	echo '```'
	cat "$TMP/out-b/summary.txt" 2>/dev/null || echo "(sem summary)"
	echo '```'
	echo
	echo "## server.log greps"
	echo
	echo "- ENOENT: $( { grep -h ENOENT "$TMP/server-a.log" "$TMP/server-b.log" 2>/dev/null || true; } | wc -l)"
	echo "- Unhandled/TypeError: $( { grep -hE 'Unhandled|TypeError' "$TMP/server-a.log" "$TMP/server-b.log" 2>/dev/null || true; } | wc -l)"
	echo "- 'UNMATCHED_MOCK' (accidental real calls): $( { grep -h UNMATCHED_MOCK "$TMP/server-a.log" "$TMP/server-b.log" 2>/dev/null || true; } | wc -l)"
	echo
	echo "## server.log (matching error lines, first 60)"
	echo
	echo '```'
	grep -hE "ENOENT|Unhandled|TypeError|UNMATCHED_MOCK|\[api-error\]|\[ig-|\[cron/automation\]" \
		"$TMP/server-a.log" "$TMP/server-b.log" 2>/dev/null | head -60 || true
	echo '```'
} >"$GATE_MD"
cat "$TMP/server-a.log" "$TMP/server-b.log" >"$RUN_DIR/gates/round-$TS-server.log" 2>/dev/null || true
cp "$TMP/ig-mock-calls.jsonl" "$RUN_DIR/gates/round-$TS-calls.jsonl" 2>/dev/null || true
cp -r "$TMP/out-a" "$RUN_DIR/gates/round-$TS-out-a" 2>/dev/null || true
cp -r "$TMP/out-b" "$RUN_DIR/gates/round-$TS-out-b" 2>/dev/null || true

echo
echo "==> evidence: $GATE_MD"
if [ "$RC" -eq 0 ]; then
	echo "==> ALL IG AUTOMATION SCENARIOS PASS"
else
	echo "==> IG AUTOMATION SCENARIOS FAILED (A=$RC_A B=$RC_B)"
fi
exit "$RC"
