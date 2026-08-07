import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";

/**
 * GET/PUT /api/settings — admin configuration backed by the AppConfig table.
 *
 * Keys (contract with the cron publisher / maintenance worker):
 *   TELEGRAM_BOT_TOKEN           - Telegram bot token (sensitive)
 *   TELEGRAM_CHAT_ID             - Telegram chat id (numeric or @username)
 *   NOTIFY_WEBHOOK_URL           - generic webhook receiving POST {text, ts} (sensitive)
 *   PUBLISH_MIN_INTERVAL_SECONDS - min gap between posts on the SAME channel (0 = off)
 *   RETENTION_POSTS_DAYS         - delete old posts after N days (default 90)
 *   RETENTION_LOGS_DAYS          - delete planner logs after N days (default 30)
 *
 * Security: sensitive values are NEVER returned in full — only {set, masked}.
 * Empty string in PUT clears a key.
 */

const SETTINGS_KEYS = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "NOTIFY_WEBHOOK_URL",
    "PUBLISH_MIN_INTERVAL_SECONDS",
    "RETENTION_POSTS_DAYS",
    "RETENTION_LOGS_DAYS",
] as const;

type SettingsKey = (typeof SETTINGS_KEYS)[number];

const NUMERIC_KEYS: SettingsKey[] = [
    "PUBLISH_MIN_INTERVAL_SECONDS",
    "RETENTION_POSTS_DAYS",
    "RETENTION_LOGS_DAYS",
];

const SENSITIVE_KEYS: SettingsKey[] = ["TELEGRAM_BOT_TOKEN", "NOTIFY_WEBHOOK_URL"];

function mask(value: string): string {
    if (value.length <= 4) return "****";
    return `****${value.slice(-4)}`;
}

async function loadSettings(): Promise<Record<string, string>> {
    const rows = await prisma.appConfig.findMany({
        where: { key: { in: [...SETTINGS_KEYS] } },
    });
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value ?? "";
    return out;
}

function serializeSettings(settings: Record<string, string>): Record<string, unknown> {
    const response: Record<string, unknown> = {};
    for (const key of SETTINGS_KEYS) {
        const value = settings[key] ?? "";
        if (SENSITIVE_KEYS.includes(key)) {
            response[key] = { set: Boolean(value), masked: value ? mask(value) : "" };
        } else if (NUMERIC_KEYS.includes(key)) {
            response[key] = value === "" ? null : Number(value);
        } else {
            response[key] = value;
        }
    }
    return response;
}

export async function GET() {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const settings = await loadSettings();
        return NextResponse.json(serializeSettings(settings));
    } catch (error) {
        console.error("[settings] GET failed:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function PUT(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const updates: Partial<Record<SettingsKey, string>> = {};
    for (const key of SETTINGS_KEYS) {
        const raw = (body as Record<string, unknown>)[key];
        if (raw === undefined) continue;
        if (typeof raw !== "string") {
            return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
        }
        const trimmed = raw.trim();
        if (NUMERIC_KEYS.includes(key) && trimmed !== "") {
            const num = Number(trimmed);
            if (!Number.isFinite(num) || num < 0) {
                return NextResponse.json({ error: `${key} must be a non-negative number` }, { status: 400 });
            }
        }
        updates[key] = trimmed;
    }

    try {
        for (const [key, value] of Object.entries(updates) as [SettingsKey, string][]) {
            await prisma.appConfig.upsert({
                where: { key },
                create: { key, value: value || null },
                update: { value: value || null },
            });
        }
        const settings = await loadSettings();
        return NextResponse.json(serializeSettings(settings));
    } catch (error) {
        console.error("[settings] PUT failed:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
