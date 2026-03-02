/**
 * Prisma seed script — creates the initial admin user.
 *
 * Usage:
 *   npx ts-node --compiler-options '{"module":"commonjs"}' prisma/seed.ts
 *   or: npm run seed
 *
 * Set SEED_EMAIL and SEED_PASSWORD env vars, or use the defaults below.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const email = process.env.SEED_EMAIL || 'admin@autoreels.local';
    const password = process.env.SEED_PASSWORD || 'changeme123';

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
        console.log(`✅ User "${email}" already exists — skipping.`);
        return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
        data: {
            email,
            password: hashedPassword,
            name: 'Admin',
        },
    });

    console.log(`✅ Created user "${user.email}" (id: ${user.id})`);
}

main()
    .catch((e) => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
