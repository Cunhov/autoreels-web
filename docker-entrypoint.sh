#!/bin/sh
set -e

echo "Ensuring persistent directories exist..."
mkdir -p /app/data
mkdir -p /app/public/uploads

# Set proper permissions if nextjs user exists, otherwise ignore
if id -u nextjs >/dev/null 2>&1; then
  chown -R nextjs:nodejs /app/data 2>/dev/null || true
  chown -R nextjs:nodejs /app/public/uploads 2>/dev/null || true
fi

echo "Running Prisma migrations/push to SQLite..."
npx prisma db push --schema=/app/prisma/schema.prisma

echo "Starting Next.js..."
exec node server.js
