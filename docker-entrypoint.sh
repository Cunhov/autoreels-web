#!/bin/sh
set -e

echo "Ensuring persistent directories exist..."
mkdir -p /app/data
mkdir -p /app/data/uploads

# ── Database schema ──────────────────────────────────────────────────────────
# Prefer the migration script (baseline for legacy DBs + `prisma migrate deploy`).
# If it is not present (e.g. partial checkout), fall back to a plain deploy.
# prisma.config.ts is copied into the image, and DATABASE_URL is set via env,
# so `prisma migrate deploy` works without network access (CLI is vendored).
if [ -f /app/scripts/db-migrate.sh ]; then
  echo "Running database migration script..."
  sh /app/scripts/db-migrate.sh
else
  echo "scripts/db-migrate.sh not found — running plain 'prisma migrate deploy'..."
  node node_modules/prisma/build/index.js migrate deploy \
    --schema=/app/prisma/schema.prisma
fi

# ── SQLite WAL mode ──────────────────────────────────────────────────────────
# WAL greatly reduces SQLITE_BUSY contention between the cron writer and the
# API readers. better-sqlite3 is traced into the standalone output, so this
# runs offline.
echo "Enabling SQLite WAL mode..."
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/prod.db');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.close();
console.log('WAL enabled');
"

echo "Starting Next.js..."
exec node server.js
