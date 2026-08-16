#!/usr/bin/env bash
#
# Upload gauntlet driver — boots the app and runs scenarios A-E.
#
#   MODE=prod (default)  next build + standalone server (matches Docker prod).
#   MODE=dev             next dev fallback (used automatically if build fails).
#   RUN_DIR=...          where gates/round-<timestamp>-baseline.md is written (default:
#                        <repo>/gauntlet-runs/upload-robustness).
#
# Exit 0 only if ALL scenarios pass. Never leaves the repo's uploads dir or
# server processes behind (EXIT trap restores everything).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$REPO_ROOT/gauntlet-runs/upload-robustness}"
MODE="${MODE:-prod}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/upload-gauntlet.XXXXXX")"
mkdir -p "$TMP/uploads" "$TMP/out"

DATABASE_URL="file:$TMP/test.db"
NEXTAUTH_SECRET="gauntlet-secret-$(openssl rand -hex 8)"
CRON_SECRET="gauntlet-cron-$(openssl rand -hex 8)"
PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

SERVER_PID=""
SA_DATA_DIR="$REPO_ROOT/.next/standalone/data"
REPO_DATA_DIR="$REPO_ROOT/data"

cleanup() {
	set +e
	if [ -n "$SERVER_PID" ]; then
		kill "$SERVER_PID" 2>/dev/null
		wait "$SERVER_PID" 2>/dev/null
	fi
	# Restore uploads dir state.
	rm -f "$SA_DATA_DIR/uploads"
	if [ -L "$REPO_DATA_DIR/uploads" ]; then
		rm -f "$REPO_DATA_DIR/uploads"
	fi
	if [ -d "$TMP/uploads-orig" ]; then
		mv "$TMP/uploads-orig" "$REPO_DATA_DIR/uploads"
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
	# Standalone server chdir's to .next/standalone → uploads dir lives there.
	mkdir -p "$SA_DATA_DIR"
	ln -s "$TMP/uploads" "$SA_DATA_DIR/uploads"
	(
		cd "$SA_DATA_DIR/.."
		exec env PORT="$PORT" HOSTNAME=127.0.0.1 DATABASE_URL="$DATABASE_URL" \
			NEXTAUTH_SECRET="$NEXTAUTH_SECRET" CRON_SECRET="$CRON_SECRET" \
			node server.js
	) >"$TMP/server.log" 2>&1 &
else
	# Dev fallback: redirect repo data/uploads (restored by trap).
	if [ -e "$REPO_DATA_DIR/uploads" ] && [ ! -L "$REPO_DATA_DIR/uploads" ]; then
		mv "$REPO_DATA_DIR/uploads" "$TMP/uploads-orig"
	fi
	ln -s "$TMP/uploads" "$REPO_DATA_DIR/uploads"
	(
		cd "$REPO_ROOT"
		exec env DATABASE_URL="$DATABASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
			CRON_SECRET="$CRON_SECRET" npx next dev -p "$PORT" -H 127.0.0.1
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

echo "==> running scenarios (this takes a couple of minutes on 100MB uploads)"
set +e
node "$REPO_ROOT/scripts/upload-gauntlet/harness.mjs" \
	--base "http://127.0.0.1:$PORT" --db "$TMP/test.db" \
	--secret "$NEXTAUTH_SECRET" --cron-secret "$CRON_SECRET" \
	--uploads "$TMP/uploads" --out "$TMP/out" \
	>"$TMP/out/summary.txt" 2>&1
RC=$?
set -e

echo "==> summary"
cat "$TMP/out/summary.txt"

mkdir -p "$RUN_DIR/gates"
{
	echo "# Round 00 baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
	echo "- MaxListenersExceededWarning: $(grep -c MaxListenersExceededWarning "$TMP/server.log" || true)"
	echo "- ENOENT: $(grep -c ENOENT "$TMP/server.log" || true)"
	echo "- 'Finalizing upload error': $(grep -c 'Finalizing upload error' "$TMP/server.log" || true)"
	echo "- '[ChannelRefresh]' lines: $(grep -c '\[ChannelRefresh\]' "$TMP/server.log" || true)"
	echo
	echo "## server.log (matching upload/error lines, first 80)"
	echo
	echo '```'
	grep -E "MaxListeners|ENOENT|Finalizing|Local chunk|ChannelRefresh|\[api-error\]" \
		"$TMP/server.log" | head -80 || true
	echo '```'
} >"$RUN_DIR/gates/round-$(date +%H%M%S)-baseline.md"
cp "$TMP/server.log" "$RUN_DIR/gates/round-$(date +%H%M%S)-server.log" 2>/dev/null || true

echo
if [ "$RC" -eq 0 ]; then
	echo "==> ALL SCENARIOS PASS"
else
	echo "==> SCENARIOS FAILED (exit $RC) — this is the expected baseline on current code"
fi
exit "$RC"
