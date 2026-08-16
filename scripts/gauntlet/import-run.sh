#!/usr/bin/env bash
#
# Module-07 gauntlet driver (import-url / file serving / storage / auth /
# worker) — boots the app (prod standalone or dev fallback) with BOTH preloads
# (fetch-mock for IG safety, import-fixture for the import-url download cases)
# and runs:
#   1. import-scenarios.mjs   (I1-I4 — import/file/storage/maintenance)
#   2. auth-worker-scenarios.mjs (I5-I6 — login/rate-limit + worker subprocess)
#   3. auth-visual.mjs        (I7 — login page, Playwright)
#   4. import-perf.mjs        (I8 — file TTFT + login render, baseline)
#
#   MODE=prod (default)  next build + standalone server (matches Docker prod).
#   MODE=dev             next dev fallback (used automatically if build fails).
#   RUN_DIR=...          where gates/round-<timestamp>-baseline.md is written
#                        (default: <repo>/gauntlet-runs/module-07-import-auth).
#
# Env notes: UPLOAD_QUOTA_BYTES=4096 makes the I3 quota test deterministic.
# The import-url SSRF guard blocks loopback/private hosts by design (I1 asserts
# it), and the route's standalone fetch bypasses preloads — so I1 covers the
# guard + input validation + graceful failure (download-path limitation
# documented in the scenario). Exit 0 only if ALL parts pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$REPO_ROOT/gauntlet-runs/module-07-import-auth}"
MODE="${MODE:-prod}"
OUT_DIR="$RUN_DIR/out"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/import-gauntlet.XXXXXX")"
mkdir -p "$TMP/out"

DATABASE_URL="file:$TMP/test.db"
NEXTAUTH_SECRET="gauntlet-secret-$(openssl rand -hex 8)"
CRON_SECRET="unused"
ADMIN_EMAIL="admin@test.local"
ADMIN_PASSWORD="TestPass123!"
UPLOAD_QUOTA_BYTES="4096"
FIXTURE_HOST="graph.instagram.com"
IG_MOCK_STATE="$TMP/ig-mock-state.json"
IG_MOCK_CALLS="$TMP/ig-mock-calls.jsonl"
PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

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

echo "==> temp dir: $TMP (port $PORT, mode $MODE, uploads $UPLOADS_DIR)"
echo "==> import fixture host: $FIXTURE_HOST (only used if IG_FIXTURE_STATE is set; inert otherwise)"

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
			ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
			PUBLIC_BASE_URL="http://127.0.0.1:$PORT" UPLOAD_QUOTA_BYTES="$UPLOAD_QUOTA_BYTES" \
			IG_MOCK_STATE="$IG_MOCK_STATE" IG_MOCK_CALLS="$IG_MOCK_CALLS" \
			node --import "$REPO_ROOT/scripts/gauntlet/fetch-mock.mjs" \
				server.js
	) >"$TMP/server.log" 2>&1 &
else
	(
		cd "$REPO_ROOT"
		exec env DATABASE_URL="$DATABASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
			CRON_SECRET="$CRON_SECRET" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
			PUBLIC_BASE_URL="http://127.0.0.1:$PORT" UPLOAD_QUOTA_BYTES="$UPLOAD_QUOTA_BYTES" \
			IG_MOCK_STATE="$IG_MOCK_STATE" IG_MOCK_CALLS="$IG_MOCK_CALLS" \
			NODE_OPTIONS="--import $REPO_ROOT/scripts/gauntlet/fetch-mock.mjs" \
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
	local label="$1" script="$2" extra="${3:-}"
	echo "==> running $label"
	set +e
	# shellcheck disable=SC2086
	node "$REPO_ROOT/scripts/gauntlet/$script" \
		--base "http://127.0.0.1:$PORT" --db "$TMP/test.db" \
		--secret "$NEXTAUTH_SECRET" --uploads-dir "$UPLOADS_DIR" \
		--server-log "$TMP/server.log" --out "$TMP/out" \
		--admin-email "$ADMIN_EMAIL" --admin-password "$ADMIN_PASSWORD" \
		--worker-dir "$REPO_ROOT" --cron-secret "worker-test-secret" \
		--baseline "$RUN_DIR/import-perf-baseline.json" \
		$extra \
		>"$TMP/out/$label.txt" 2>&1
	local rc=$?
	set -e
	echo "    ($label exit $rc)"
	cat "$TMP/out/$label.txt"
	return "$rc"
}

RC_ALL=0
run_part scenarios import-scenarios.mjs || RC_ALL=1
run_part auth-worker auth-worker-scenarios.mjs || RC_ALL=1
run_part visual auth-visual.mjs || RC_ALL=1
run_part perf import-perf.mjs || RC_ALL=1

mkdir -p "$RUN_DIR/gates"
TS="$(date +%H%M%S)"
{
	echo "# Import/Storage/Auth/Worker baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo
	echo "Mode: $MODE | Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
	echo "Evidence dir: $TMP"
	echo
	echo "## I1-I4 (import / file / storage / maintenance)"
	echo
	echo '```'
	cat "$TMP/out/scenarios.txt"
	echo '```'
	echo
	echo "## I5-I6 (auth/rate-limit + worker)"
	echo
	echo '```'
	cat "$TMP/out/auth-worker.txt"
	echo '```'
	echo
	echo "## I7 (login visual)"
	echo
	echo '```'
	cat "$TMP/out/visual.txt"
	echo '```'
	echo
	echo "## I8 (perf)"
	echo
	echo '```'
	cat "$TMP/out/perf.txt"
	echo '```'
	echo
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
	grep -E "ENOENT|Unhandled|TypeError|\[api-error\]|error:" "$TMP/server.log" | head -60 || true
	echo '```'
} >"$RUN_DIR/gates/round-$TS-baseline.md"
cp "$TMP/server.log" "$RUN_DIR/gates/round-$TS-server.log" 2>/dev/null || true
cp "$TMP/out/perf-baseline.json" "$RUN_DIR/gates/round-$TS-perf.json" 2>/dev/null || true
cp "$TMP/out/auth-visual-report.json" "$RUN_DIR/gates/round-$TS-visual.json" 2>/dev/null || true
mkdir -p "$OUT_DIR"
cp "$TMP"/out/*.png "$OUT_DIR/" 2>/dev/null || true

echo
if [ "$RC_ALL" -eq 0 ]; then
	echo "==> ALL IMPORT/AUTH/WORKER SCENARIOS PASS"
else
	echo "==> IMPORT/AUTH/WORKER SCENARIOS FAILED (exit $RC_ALL)"
fi
exit "$RC_ALL"
