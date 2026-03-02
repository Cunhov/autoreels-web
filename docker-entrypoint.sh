#!/bin/sh
set -e

echo "Ensuring persistent directories exist..."
mkdir -p /app/data
mkdir -p /app/data/uploads

echo "Running Prisma db push (SQLite)..."
npx prisma db push \
  --schema=/app/prisma/schema.prisma \
  --url="file:/app/data/prod.db"

echo "Seeding admin user..."
# Use better-sqlite3 directly (avoids all Prisma Client constructor issues)
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/prod.db');
const email = process.env.ADMIN_EMAIL || 'admin@autoreels.app';
const existing = db.prepare('SELECT id FROM \"User\" WHERE id = ?').get('admin');
if (!existing) {
  db.prepare('INSERT INTO \"User\" (id, email, name) VALUES (?, ?, ?)').run('admin', email, 'Admin');
  console.log('Admin user created:', email);
} else {
  db.prepare('UPDATE \"User\" SET email = ? WHERE id = ?').run(email, 'admin');
  console.log('Admin user updated:', email);
}
db.close();
"

echo "Starting Next.js..."
exec node server.js
