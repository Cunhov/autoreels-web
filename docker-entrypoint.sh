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

# ── SQLite journal mode ───────────────────────────────────────────────────────
# Keep the DB in DELETE journal mode (db-migrate.sh does this). Do NOT enable
# WAL here: the app keeps the -shm shared-memory session open for its lifetime
# and the Prisma CLI schema engine cannot take its locks against it — that
# produced permanent "database is locked" during rolling deploys.
echo "SQLite journal mode handled by db-migrate.sh (DELETE + busy_timeout)."

echo "Starting Next.js..."
exec node server.js
