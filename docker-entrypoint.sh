#!/bin/sh
set -e

echo "Ensuring persistent directories exist..."
mkdir -p /app/data
mkdir -p /app/public/uploads

echo "Running Prisma db push (SQLite)..."
npx prisma db push \
  --schema=/app/prisma/schema.prisma \
  --url="file:/app/data/prod.db"

echo "Seeding admin user..."
# Use Node.js with the pre-built Prisma Client (already in .next/standalone/node_modules)
# This upserts the admin user with a fixed id="admin" so FK constraints are satisfied
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: 'file:/app/data/prod.db' } }
});
async function seed() {
  const email = process.env.ADMIN_EMAIL || 'admin@autoreels.app';
  await prisma.user.upsert({
    where: { id: 'admin' },
    update: { email },
    create: { id: 'admin', email, name: 'Admin' },
  });
  console.log('Admin user ready:', email);
  await prisma.\$disconnect();
}
seed().catch(e => { console.error(e); process.exit(1); });
"

echo "Starting Next.js..."
exec node server.js
