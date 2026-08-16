#!/usr/bin/env bash
#
# Channels/Media/Backup gauntlet driver (module 04) — boots the app with the
# IG/Graph API mocked (fetch-mock.mjs preload, extended to api.instagram.com
# for the OAuth short-token exchange) and runs, in order:
#   1. channels-scenarios.mjs  (M1 OAuth, M2 refresh, M3 insights, M4a/M4c backup+abuse)
#   2. media-scenarios.mjs     (M5 trim, M6 thumbnail — real ffmpeg, real files)
#   3. media-visual.mjs        (M7 ImageEditorModal — Playwright)
#   4. channels-restore.mjs    (M4b restore-SUCCESS — MUST run last: in prod the
#      restore route schedules process.exit(0) after responding, which kills the
#      standalone server; all file/DB assertions happen in that process before
#      the server dies, so the run can still record a full baseline).
#
#   MODE=prod (default) next build + standalone server; MODE=dev dev fallback.
#   RUN_DIR=...  gates output dir (default: <repo>/gauntlet-runs/module-04-channels-media).
#
# Exit 0 only if ALL parts pass. Temp DB/uploads/backups die with the run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$REPO_ROOT/gauntlet-runs/module-04-channels-media}"
MODE="${MODE:-prod}"
OUT_DIR="$RUN_DIR/out"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/channels-gauntlet.XXXXXX")"
mkdir -p "$TMP/out"

DATABASE_URL="file:$TMP/test.db"
NEXTAUTH_SECRET="gauntlet-secret-$(openssl rand -hex 8)"
PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
IG_MOCK_STATE="$TMP/ig-mock-state.json"
IG_MOCK_CALLS="$TMP/ig-mock-calls.jsonl"
echo '{"rules":[],"consumed":{}}' >"$IG_MOCK_STATE"
: >"$IG_MOCK_CALLS"

# OAuth env — the callback route calls getInstagramOAuthConfig which THROWS
# without these. Values are arbitrary (the mock answers every IG endpoint).
INSTAGRAM_CLIENT_ID="gauntlet-client"
INSTAGRAM_CLIENT_SECRET="gauntlet-secret"
INSTAGRAM_REDIRECT_URI=""

if [ "$MODE" = "prod" ]; then
	UPLOADS_DIR="$REPO_ROOT/.next/standalone/data/uploads"
	BACKUPS_DIR="$REPO_ROOT/.next/standalone/data/backups"
else
	UPLOADS_DIR="$REPO_ROOT/data/uploads"
	BACKUPS_DIR="$REPO_ROOT/data/backups"
fi
SA_DIR="$REPO_ROOT/.next/standalone"
mkdir -p "$UPLOADS_DIR" "$BACKUPS_DIR"
# Keep the shared uploads dir clean for this module only (own namespace).
rm -rf "$UPLOADS_DIR/admin/gauntlet-mod4"
rm -f "$BACKUPS_DIR"/backup-*.db "$BACKUPS_DIR"/test.db.pre-restore

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

echo "==> temp dir: $TMP (port $PORT, mode $MODE, uploads $UPLOADS_DIR, backups $BACKUPS_DIR)"

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
		BACKUPS_DIR="$REPO_ROOT/data/backups"
		mkdir -p "$UPLOADS_DIR" "$BACKUPS_DIR"
	fi
fi

if [ "$MODE" = "prod" ]; then
	(
		cd "$SA_DIR"
		exec env PORT="$PORT" HOSTNAME=127.0.0.1 DATABASE_URL="$DATABASE_URL" \
			NEXTAUTH_SECRET="$NEXTAUTH_SECRET" CRON_SECRET="unused" \
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
			CRON_SECRET="unused" PUBLIC_BASE_URL="http://127.0.0.1:$PORT" \
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
		--secret "$NEXTAUTH_SECRET" --uploads-dir "$UPLOADS_DIR" \
		--backups-dir "$BACKUPS_DIR" \
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
run_part channels channels-scenarios.mjs || RC_ALL=1
run_part media media-scenarios.mjs || RC_ALL=1
run_part visual media-visual.mjs || RC_ALL=1
# M4b restore-success LAST (prod schedules process.exit after responding).
run_part restore channels-restore.mjs || RC_ALL=1

mkdir -p "$RUN_DIR/gates"
TS="$(date +%H%M%S)"
{
	echo "# Channels/Media/Backup baseline — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo
	echo "Mode: $MODE | Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
	echo "Evidence dir: $TMP"
	echo
	for part in channels media visual restore; do
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
cp "$TMP"/out/editor-*.png "$OUT_DIR/" 2>/dev/null || true

echo
if [ "$RC_ALL" -eq 0 ]; then
	echo "==> ALL CHANNELS/MEDIA/BACKUP SCENARIOS PASS"
else
	echo "==> CHANNELS/MEDIA/BACKUP SCENARIOS FAILED (exit $RC_ALL)"
fi
exit "$RC_ALL"
