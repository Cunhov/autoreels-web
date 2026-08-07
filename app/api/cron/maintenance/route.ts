import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { safeEqual } from '@/lib/secret';
import { readdir, stat, unlink } from 'fs/promises';
import { join, resolve } from 'path';

/**
 * Database + disk maintenance job (called by the worker roughly once a day).
 *
 * - Deletes posts older than RETENTION_POSTS_DAYS (default 90) that are in a
 *   terminal state (published / failed / cancelled).
 * - Deletes planner_logs older than RETENTION_LOGS_DAYS (default 30).
 * - Removes orphaned `.part` chunk-upload files older than 24h from data/uploads.
 *
 * Authenticated with the `x-cron-auth` header (same secret as the publisher).
 */

function isAuthorized(req: Request): boolean {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
        console.error('[maintenance] CRON_SECRET is not set');
        return false;
    }
    const provided = req.headers.get('x-cron-auth');
    return Boolean(provided) && safeEqual(provided as string, expected);
}

async function getIntConfig(key: string, fallback: number): Promise<number> {
    try {
        const row = await prisma.appConfig.findUnique({ where: { key } });
        const value = Number(row?.value);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    } catch {
        return fallback;
    }
}

/** Recursively remove orphaned `.part` files older than maxAgeMs. Never escapes the uploads root. */
async function removeOrphanPartFiles(uploadsRoot: string, maxAgeMs: number): Promise<number> {
    let removed = 0;
    const root = resolve(uploadsRoot);

    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return; // dir does not exist — nothing to clean
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            // Safety: never operate outside the uploads root (symlinks / traversal)
            if (!full.startsWith(root)) continue;
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.name.endsWith('.part')) {
                try {
                    const st = await stat(full);
                    if (Date.now() - st.mtimeMs > maxAgeMs) {
                        await unlink(full);
                        removed++;
                    }
                } catch {
                    // already gone or unreadable — skip
                }
            }
        }
    }

    await walk(root);
    return removed;
}

async function runMaintenance(): Promise<{
    posts_deleted: number;
    logs_deleted: number;
    parts_deleted: number;
    posts_retention_days: number;
    logs_retention_days: number;
}> {
    const postsRetentionDays = await getIntConfig('RETENTION_POSTS_DAYS', 90);
    const logsRetentionDays = await getIntConfig('RETENTION_LOGS_DAYS', 30);

    const now = new Date();
    const postsCutoff = new Date(now.getTime() - postsRetentionDays * 24 * 60 * 60 * 1000);
    const logsCutoff = new Date(now.getTime() - logsRetentionDays * 24 * 60 * 60 * 1000);

    const posts = await prisma.post.deleteMany({
        where: {
            status: { in: ['published', 'failed', 'cancelled'] },
            OR: [
                { published_at: { lte: postsCutoff } },
                { published_at: null, created_at: { lte: postsCutoff } },
            ],
        },
    });

    const logs = await prisma.plannerLog.deleteMany({
        where: { created_at: { lte: logsCutoff } },
    });

    const partsDeleted = await removeOrphanPartFiles(
        join(process.cwd(), 'data', 'uploads'),
        24 * 60 * 60 * 1000
    );

    return {
        posts_deleted: posts.count,
        logs_deleted: logs.count,
        parts_deleted: partsDeleted,
        posts_retention_days: postsRetentionDays,
        logs_retention_days: logsRetentionDays,
    };
}

export async function GET(req: Request) {
    if (!isAuthorized(req)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
        return NextResponse.json({ ok: true, ...(await runMaintenance()) });
    } catch (e) {
        console.error('[maintenance] failed:', e);
        return NextResponse.json({ error: 'Maintenance failed' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    return GET(req);
}
