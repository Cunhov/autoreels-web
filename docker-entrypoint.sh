#!/bin/sh
set -e

echo "Ensuring persistent directories exist..."
mkdir -p /app/data
mkdir -p /app/public/uploads

echo "Running Prisma db push (SQLite)..."
# Use --url flag directly to bypass prisma.config.ts (avoids import errors in standalone container)
npx prisma db push \
  --schema=/app/prisma/schema.prisma \
  --url="file:/app/data/prod.db"

echo "Starting Next.js..."
exec node server.js
