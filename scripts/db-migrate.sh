#!/bin/sh
set -e

# ─── AutoReels DB migration bootstrap ─────────────────────────────────────────
# Idempotent baseline + migrate deploy for:
#   - legacy DBs (tables created via `prisma db push` before migrations existed)
#   - fresh DBs (no tables at all)
# Called from docker-entrypoint.sh before `node server.js`.
#
# Why a generated prisma.config.ts? Prisma 7 requires datasource.url to come
# from the config file for `migrate deploy`/`resolve` — it does NOT read
# DATABASE_URL directly. The runner image may not ship the repo's
# prisma.config.ts, so we generate one next to node_modules (cwd) and point
# every CLI invocation at it via --config.
#
# Env overrides:
#   SCHEMA      - path to schema.prisma        (default: /app/prisma/schema.prisma)
#   URL         - SQLite datasource URL        (default: file:/app/data/prod.db)
#   PRISMA_CLI  - explicit CLI command         (default: node /app/node_modules/prisma/build/index.js,
#                                                falls back to `npx prisma` for local dev)

SCHEMA="${SCHEMA:-/app/prisma/schema.prisma}"
URL="${URL:-file:/app/data/prod.db}"
MIGRATIONS_DIR="$(dirname "$SCHEMA")/migrations"

if [ -z "${PRISMA_CLI:-}" ]; then
  if [ -f /app/node_modules/prisma/build/index.js ]; then
    PRISMA_CLI="node /app/node_modules/prisma/build/index.js"
  else
    PRISMA_CLI="npx prisma"
  fi
fi

# prisma.config.ts (repo or generated) reads DATABASE_URL
export DATABASE_URL="${URL}"

echo "[db-migrate] schema=${SCHEMA}"
echo "[db-migrate] url=${URL}"
echo "[db-migrate] cli=${PRISMA_CLI}"

# ─── Prisma config (repo versioned config preferred; else generate where writable) ─
# Prisma 7 requires datasource.url to come from the config file for
# `migrate deploy`/`resolve`. The runner ships /app/prisma.config.ts (copied
# by the Dockerfile), which resolves `prisma/config` against /app/node_modules.
# Fallbacks: generate in $PWD (normal local dev) or, as a last resort, in /tmp
# with an absolute import into the project's own node_modules.
if [ -f /app/prisma.config.ts ]; then
  TMP_CONFIG="/app/prisma.config.ts"
  echo "[db-migrate] using repo prisma.config.ts"
elif touch "${PWD}/.prisma-config-write-test" 2>/dev/null; then
  rm -f "${PWD}/.prisma-config-write-test"
  TMP_CONFIG="${PWD}/prisma.config.generated.ts"
  cat > "${TMP_CONFIG}" <<EOF
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "${SCHEMA}",
  migrations: { path: "${MIGRATIONS_DIR}" },
  datasource: { url: process.env["DATABASE_URL"] ?? "file:/app/data/prod.db" },
});
EOF
  trap 'rm -f "${TMP_CONFIG}"' EXIT INT TERM
else
  TMP_CONFIG="/tmp/prisma.config.generated.ts"
  cat > "${TMP_CONFIG}" <<EOF
import { defineConfig } from "${PWD}/node_modules/prisma/config.js";

export default defineConfig({
  schema: "${SCHEMA}",
  migrations: { path: "${MIGRATIONS_DIR}" },
  datasource: { url: process.env["DATABASE_URL"] ?? "file:/app/data/prod.db" },
});
EOF
  trap 'rm -f "${TMP_CONFIG}"' EXIT INT TERM
fi

# ─── 1) Ensure journal DELETE + busy_timeout ──────────────────────────────────
# IMPORTANT: do NOT enable WAL. The app (better-sqlite3) keeps the SQLite
# shared-memory file (-shm) open for its whole lifetime; the Prisma CLI schema
# engine (libsql driver) cannot take the needed locks against that WAL session
# and fails with "database is locked" — which broke rolling deploys.
# The app is single-process and the publisher worker reaches it over HTTP, so
# WAL buys nothing here. DELETE journaling + busy_timeout is safe.
node -e '
let Database;
try { Database = require("better-sqlite3"); }
catch { Database = require("/app/node_modules/better-sqlite3"); }
const fs = require("fs");
const path = process.env.DATABASE_URL.replace(/^file:/, "");
if (!fs.existsSync(path)) { console.log("[db-migrate] new DB, will be created by migrate deploy"); process.exit(0); }
const db = new Database(path);
db.pragma("journal_mode = DELETE");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.close();
console.log("[db-migrate] journal DELETE + busy_timeout:", path);
'

# ─── 2) Detect legacy (tables exist, no _prisma_migrations) ───────────────────
STATE="$(node -e '
let Database;
try { Database = require("better-sqlite3"); }
catch { Database = require("/app/node_modules/better-sqlite3"); }
const fs = require("fs");
const path = process.env.DATABASE_URL.replace(/^file:/, "");
if (!fs.existsSync(path)) { console.log("fresh"); process.exit(0); }
const db = new Database(path, { readonly: true });
const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?)").all("table", "posts", "_prisma_migrations");
db.close();
const names = rows.map(r => r.name);
if (names.includes("posts") && !names.includes("_prisma_migrations")) console.log("legacy");
else console.log("managed");
')"
echo "[db-migrate] state=${STATE}"

# ── Retry helper for Prisma CLI calls ─────────────────────────────────────────
# During a rolling deploy (start-first), the OLD app instance is still running
# and writing to the SQLite DB while this instance runs migrations. Prisma's
# engine opens its own connection and does NOT inherit the busy_timeout pragma
# set above, so a concurrent writer can fail it with "database is locked".
# Migrations are idempotent — retrying until the lock clears is safe.
run_prisma() {
  local attempt=1 max_attempts=12
  while true; do
    local out code
    if out=$("$@" 2>&1); then
      echo "$out"
      return 0
    else
      code=$?
    fi
    if ! echo "$out" | grep -qiE "database is locked|SQLITE_BUSY"; then
      echo "$out" >&2
      return "$code"
    fi
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "$out" >&2
      echo "[db-migrate] FAILED after ${max_attempts} attempts — database kept locking" >&2
      return "$code"
    fi
    echo "[db-migrate] database is locked (attempt ${attempt}/${max_attempts}) — retrying in 5s..."
    sleep 5
    attempt=$((attempt + 1))
  done
}

# ─── 3) Align legacy schema (additive only) + baseline + deploy ───────────────
if [ "${STATE}" = "legacy" ]; then
  echo "[db-migrate] Legacy DB detected — aligning schema additively (NO --accept-data-loss)..."
  # Fails loudly on destructive drift instead of silently dropping data
  run_prisma ${PRISMA_CLI} db push --config "${TMP_CONFIG}" --schema "${SCHEMA}"

  echo "[db-migrate] Marking existing migrations as applied (baseline)..."
  for dir in "${MIGRATIONS_DIR}"/*/; do
    [ -d "${dir}" ] || continue
    name="$(basename "${dir}")"
    echo "[db-migrate]   resolve --applied ${name}"
    run_prisma ${PRISMA_CLI} migrate resolve --applied "${name}" --config "${TMP_CONFIG}" --schema "${SCHEMA}"
  done
fi

echo "[db-migrate] Running migrate deploy..."
run_prisma ${PRISMA_CLI} migrate deploy --config "${TMP_CONFIG}" --schema "${SCHEMA}"

# ─── 4) Post-deploy safety check (idempotent) ─────────────────────────────────
# Kept in DELETE journal mode — see step 1 (WAL is incompatible with the
# Prisma CLI while the app holds the shared-memory session open).
node -e '
let Database;
try { Database = require("better-sqlite3"); }
catch { Database = require("/app/node_modules/better-sqlite3"); }
const path = process.env.DATABASE_URL.replace(/^file:/, "");
const db = new Database(path);
db.pragma("journal_mode = DELETE");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.close();
console.log("[db-migrate] post-deploy journal check OK");
'

echo "[db-migrate] done."
