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

# ─── 1) WAL + busy_timeout (safe for concurrent cron + API) ──────────────────
node -e '
let Database;
try { Database = require("better-sqlite3"); }
catch { Database = require("/app/node_modules/better-sqlite3"); }
const fs = require("fs");
const path = process.env.DATABASE_URL.replace(/^file:/, "");
if (!fs.existsSync(path)) { console.log("[db-migrate] new DB, will be created by migrate deploy"); process.exit(0); }
const db = new Database(path);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.close();
console.log("[db-migrate] WAL enabled:", path);
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

# ─── 3) Align legacy schema (additive only) + baseline + deploy ───────────────
if [ "${STATE}" = "legacy" ]; then
  echo "[db-migrate] Legacy DB detected — aligning schema additively (NO --accept-data-loss)..."
  # Fails loudly on destructive drift instead of silently dropping data
  ${PRISMA_CLI} db push --config "${TMP_CONFIG}" --schema "${SCHEMA}"

  echo "[db-migrate] Marking existing migrations as applied (baseline)..."
  for dir in "${MIGRATIONS_DIR}"/*/; do
    [ -d "${dir}" ] || continue
    name="$(basename "${dir}")"
    echo "[db-migrate]   resolve --applied ${name}"
    ${PRISMA_CLI} migrate resolve --applied "${name}" --config "${TMP_CONFIG}" --schema "${SCHEMA}"
  done
fi

echo "[db-migrate] Running migrate deploy..."
${PRISMA_CLI} migrate deploy --config "${TMP_CONFIG}" --schema "${SCHEMA}"

# ─── 4) WAL re-check (idempotent, post-deploy) ────────────────────────────────
node -e '
let Database;
try { Database = require("better-sqlite3"); }
catch { Database = require("/app/node_modules/better-sqlite3"); }
const path = process.env.DATABASE_URL.replace(/^file:/, "");
const db = new Database(path);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.close();
console.log("[db-migrate] post-deploy WAL check OK");
'

echo "[db-migrate] done."
