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
    let start = new Date(end);
    start.setDate(start.getDate() - days + 1);
    start.setHours(0, 0, 0, 0);
    if (params.has("start")) {
        const requestedStart = new Date(params.get("start") || "");
        if (Number.isNaN(requestedStart.getTime()) || requestedStart > end || requestedStart.getTime() < end.getTime() - 3651 * 86_400_000) {
            return NextResponse.json({ error: "Período de métricas inválido." }, { status: 400 });
        }
        start = requestedStart;
    }
    const timeZone = params.get("tz") || "UTC";
    let dateFormatter: Intl.DateTimeFormat;
    try {
        dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" });
    } catch {
        return NextResponse.json({ error: "Fuso horário inválido." }, { status: 400 });
    }

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
        // Match the same effective timestamp used by the charts. Posts created
        // today for a future schedule must not inflate this period's KPIs.
        const period: Prisma.PostWhereInput = { OR: [
            { published_at: { gte: start, lte: end } },
            { published_at: null, scheduled_at: { gte: start, lte: end } },
            { published_at: null, scheduled_at: null, created_at: { gte: start, lte: end } },
        ] };
        // Fetch only fields needed for aggregation; media, captions and post payloads stay in the DB.
        const rows = await prisma.post.findMany({
            where: {
                user_id: userId,
                ...period,
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
                const parts = Object.fromEntries(dateFormatter.formatToParts(date).map(part => [part.type, part.value]));
                const key = `${parts.year}-${parts.month}-${parts.day}`;
                daily[key] = (daily[key] || 0) + 1;
                if (status === "published") {
                    dailyPublished[key] = (dailyPublished[key] || 0) + 1;
                    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
                    heatmap[weekday][Number(parts.hour)]++;
                }
            }
        }
        const recentFailures = await prisma.post.findMany({
            where: { user_id: userId, status: "failed", ...period },
            orderBy: { created_at: "desc" },
            take: 5,
            select: { id: true, status: true, scheduled_at: true, published_at: true, channel_id: true, caption: true, error_message: true, failed_reason: true, video_url: true, image_url: true, thumbnail_url: true, media_type: true },
        });
        return NextResponse.json({ start: start.toISOString(), end: end.toISOString(), timeZone, days, total, statuses, channels, daily, dailyPublished, heatmap, openStatuses: OPEN_STATUSES, recentFailures });
    } catch (error) {
        console.error("Post stats error:", error);
        return NextResponse.json({ error: error instanceof Prisma.PrismaClientKnownRequestError ? "Não foi possível calcular as métricas dos posts." : "Não foi possível carregar as métricas dos posts." }, { status: 500 });
    }
}
