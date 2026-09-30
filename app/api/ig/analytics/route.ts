import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getErrorMessage } from "@/lib/api";
import {
    badRequest,
    firstParam,
    parseDaysParam,
    requireUserId,
    unauthorized,
} from "../shared";

const DAY_MS = 24 * 60 * 60 * 1000;

interface SeriesPoint {
    date: string;
    matched: number;
    sent: number;
    failed: number;
    clicks: number;
}

interface AutomationStats {
    id: string;
    name: string;
    matched: number;
    sent: number;
    failed: number;
    clicks: number;
    stats_matched: number;
    stats_sent: number;
    stats_failed: number;
    stats_clicks: number;
}

function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/**
 * GET /api/ig/analytics?channelId=&days=7
 *   → { totals:{matched,sent,failed,clicks,contacts},
 *       series:[{date,matched,sent,failed,clicks}],
 *       byAutomation:[top 20] }
 * `days` limitado a 1..90. Agregação em JS (volume baixo, sem raw SQL).
 */
export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();

    try {
        const { searchParams } = new URL(req.url);
        const channelId = firstParam(searchParams, "channelId", "channel_id");
        const days = parseDaysParam(searchParams.get("days"), 7, 1, 90);

        const now = new Date();
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const start = new Date(today.getTime() - (days - 1) * DAY_MS);

        const channelFilter = channelId ? { channel_id: channelId } : {};

        const [events, logs, clicks, contactsCount, automations] = await Promise.all([
            prisma.igEvent.findMany({
                where: { user_id: userId, status: "matched", created_at: { gte: start }, ...channelFilter },
                select: { created_at: true, automation_id: true },
            }),
            prisma.igActionLog.findMany({
                where: {
                    user_id: userId,
                    status: { in: ["sent", "failed"] },
                    created_at: { gte: start },
                    ...channelFilter,
                },
                select: { created_at: true, status: true, automation_id: true },
            }),
            prisma.igClick.findMany({
                where: {
                    user_id: userId,
                    ...(channelId ? { channel_id: channelId } : {}),
                    OR: [
                        { created_at: { gte: start } },
                        { last_click_at: { gte: start } },
                    ],
                },
                select: { clicks: true, created_at: true, last_click_at: true, automation_id: true },
            }),
            prisma.igContact.count({
                where: { user_id: userId, created_at: { gte: start }, ...channelFilter },
            }),
            prisma.igAutomation.findMany({
                where: { user_id: userId, ...(channelId ? { channel_id: channelId } : {}) },
                select: {
                    id: true,
                    name: true,
                    stats_matched: true,
                    stats_sent: true,
                    stats_failed: true,
                    stats_clicks: true,
                },
            }),
        ]);

        // Série diária — todos os dias do período, inclusive os zerados.
        const seriesMap = new Map<string, SeriesPoint>();
        for (let i = 0; i < days; i++) {
            const date = isoDay(new Date(start.getTime() + i * DAY_MS));
            seriesMap.set(date, { date, matched: 0, sent: 0, failed: 0, clicks: 0 });
        }

        const bump = (when: Date, key: "matched" | "sent" | "failed" | "clicks", amount = 1) => {
            const point = seriesMap.get(isoDay(when));
            if (point) point[key] += amount;
        };

        for (const event of events) bump(event.created_at, "matched");
        for (const log of logs) {
            if (log.status === "sent") bump(log.created_at, "sent");
            else if (log.status === "failed") bump(log.created_at, "failed");
        }
        let clicksTotal = 0;
        for (const click of clicks) {
            clicksTotal += click.clicks;
            bump(click.last_click_at ?? click.created_at, "clicks", click.clicks);
        }

        const byId = new Map<string, AutomationStats>();
        for (const automation of automations) {
            byId.set(automation.id, {
                id: automation.id,
                name: automation.name,
                matched: 0,
                sent: 0,
                failed: 0,
                clicks: 0,
                stats_matched: automation.stats_matched,
                stats_sent: automation.stats_sent,
                stats_failed: automation.stats_failed,
                stats_clicks: automation.stats_clicks,
            });
        }
        for (const event of events) {
            if (!event.automation_id) continue;
            const stats = byId.get(event.automation_id);
            if (stats) stats.matched += 1;
        }
        for (const log of logs) {
            if (!log.automation_id) continue;
            const stats = byId.get(log.automation_id);
            if (!stats) continue;
            if (log.status === "sent") stats.sent += 1;
            else if (log.status === "failed") stats.failed += 1;
        }
        for (const click of clicks) {
            if (!click.automation_id) continue;
            const stats = byId.get(click.automation_id);
            if (stats) stats.clicks += click.clicks;
        }

        const byAutomation = [...byId.values()]
            .sort((a, b) => b.matched - a.matched || b.sent - a.sent || a.name.localeCompare(b.name))
            .slice(0, 20);

        const sent = logs.filter((log) => log.status === "sent").length;
        const failed = logs.filter((log) => log.status === "failed").length;

        return NextResponse.json({
            totals: {
                matched: events.length,
                sent,
                failed,
                clicks: clicksTotal,
                contacts: contactsCount,
            },
            series: [...seriesMap.values()],
            byAutomation,
        });
    } catch (error: unknown) {
        console.error("Get ig analytics error:", error);
        return badRequest(getErrorMessage(error));
    }
}
