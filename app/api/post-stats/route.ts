import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";
import { Prisma } from "@prisma/client";

const OPEN_STATUSES = ["pending", "scheduled", "processing", "processing_upload", "processing_children", "ready_to_publish"];

/** Compact, user-scoped aggregates for local Analytics and channel totals. */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const params = new URL(req.url).searchParams;
    const requestedDays = Number(params.get("days") || "30");
    const days = Number.isFinite(requestedDays) ? Math.min(Math.max(Math.floor(requestedDays), 1), 3650) : 30;
    const allTime = params.get("all") === "1";
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    try {
        if (allTime) {
            const grouped = await prisma.post.groupBy({
                by: ["channel_id", "status"],
                where: { user_id: userId },
                _count: { _all: true },
            });
            const channels: Record<string, Record<string, number>> = {};
            let total = 0;
            for (const group of grouped) {
                const count = group._count._all;
                total += count;
                if (!group.channel_id) continue;
                channels[group.channel_id] ??= {};
                channels[group.channel_id][group.status] = count;
            }
            return NextResponse.json({ total, channels });
        }
        // Fetch only fields needed for aggregation; media, captions and post payloads stay in the DB.
        const rows = await prisma.post.findMany({
            where: {
                user_id: userId,
                OR: [
                    { published_at: { gte: start, lte: end } },
                    { scheduled_at: { gte: start, lte: end } },
                    { created_at: { gte: start, lte: end } },
                ],
            },
            select: { status: true, channel_id: true, published_at: true, scheduled_at: true, created_at: true },
        });

        const statuses: Record<string, number> = {};
        const channels: Record<string, Record<string, number>> = {};
        const daily: Record<string, number> = {};
        const dailyPublished: Record<string, number> = {};
        const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0)) as number[][];
        let total = 0;
        for (const post of rows) {
            const status = post.status || "unknown";
            statuses[status] = (statuses[status] || 0) + 1;
            total++;
            if (post.channel_id) {
                channels[post.channel_id] ??= {};
                channels[post.channel_id][status] = (channels[post.channel_id][status] || 0) + 1;
            }
            const date = post.published_at || post.scheduled_at || post.created_at;
            if (date >= start && date <= end) {
                const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
                daily[key] = (daily[key] || 0) + 1;
                if (status === "published") {
                    dailyPublished[key] = (dailyPublished[key] || 0) + 1;
                    heatmap[date.getDay()][date.getHours()]++;
                }
            }
        }
        const recentFailures = await prisma.post.findMany({
            where: { user_id: userId, status: "failed", OR: [{ published_at: { gte: start, lte: end } }, { scheduled_at: { gte: start, lte: end } }, { created_at: { gte: start, lte: end } }] },
            orderBy: { created_at: "desc" },
            take: 5,
            select: { id: true, status: true, scheduled_at: true, published_at: true, channel_id: true, caption: true, error_message: true, failed_reason: true, video_url: true, image_url: true, thumbnail_url: true, media_type: true },
        });
        return NextResponse.json({ start: start.toISOString(), end: end.toISOString(), days, total, statuses, channels, daily, dailyPublished, heatmap, openStatuses: OPEN_STATUSES, recentFailures });
    } catch (error) {
        console.error("Post stats error:", error);
        return NextResponse.json({ error: error instanceof Prisma.PrismaClientKnownRequestError ? "Não foi possível calcular as métricas dos posts." : "Não foi possível carregar as métricas dos posts." }, { status: 500 });
    }
}
