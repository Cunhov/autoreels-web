import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return NextResponse.json({ ok: true, ts: Date.now() }, { status: 200 });
    } catch (error) {
        console.error('[health] Database check failed:', error);
        return NextResponse.json({ ok: false, error: 'Database unavailable' }, { status: 503 });
    }
}
