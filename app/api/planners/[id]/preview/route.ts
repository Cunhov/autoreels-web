import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSessionUserId } from '@/lib/api';
import { describeChannelHealth, resolvePlannerRuntime, substituteCaptionTemplate } from '@/lib/planner-runtime';

/** Wall-clock "HH:MM" in a given IANA timezone. */
function getTimeInTimeZone(date: Date, tz: string): { hh: string; mm: string } {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const hh = parts.find(p => p.type === 'hour')?.value ?? '00';
    const mm = parts.find(p => p.type === 'minute')?.value ?? '00';
    return { hh, mm };
}

function isInSleep(hhmm: string, start: string, end: string): boolean {
    if (start <= end) {
        return hhmm >= start && hhmm < end;
    }
    return hhmm >= start || hhmm < end;
}

/** Resolve the variables available to caption templates (same semantics as the cron). */
async function resolveTemplateVars(
    selectedContent: { id?: string; title?: string | null; caption?: string | null; title_fallback?: string | null; caption_fallback?: string | null } | null | undefined,
    planner: { user_id: string },
    config: { timezone?: string },
    channelName: string,
    now: Date
): Promise<Record<string, string>> {
    let title = selectedContent?.title_fallback || selectedContent?.title || '';
    let itemCaption = selectedContent?.caption_fallback || selectedContent?.caption || '';
    if (selectedContent?.id) {
        const libItem = await prisma.contentItem.findFirst({
            where: { id: selectedContent.id, user_id: planner.user_id },
            select: { title: true, caption: true },
        });
        if (libItem) {
            title = libItem.title || title;
            itemCaption = libItem.caption || itemCaption;
        }
    }
    const tz = config.timezone || 'America/Sao_Paulo';
    const dateStr = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(now);
    return {
        '{post_title}': title || '',
        '{post_caption}': itemCaption || '',
        '{date}': dateStr,
        '{channel_name}': channelName || '',
        '{hashtags}': '',
    };
}

/** Parse the planner publish state from the new `state` column, falling back to config.state. */
function readPlannerState(planner: { state?: string | null }, config: Record<string, unknown>): Record<string, unknown> {
    if (planner.state) {
        try {
            const parsed = JSON.parse(planner.state);
            if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
        } catch { /* fall through */ }
    }
    const configState = config.state;
    if (configState && typeof configState === 'object') return configState as Record<string, unknown>;
    return {};
}

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const planner = await prisma.planner.findFirst({
        where: { id, user_id: userId },
        include: { channels: true },
    });

    if (!planner) {
        return NextResponse.json({ error: 'Planner not found' }, { status: 404 });
    }

    const now = new Date();
    const runtime = await resolvePlannerRuntime(prisma, planner, now);
    const config = runtime.config || {};

    // ── Caption templates (same semantics as the cron Phase 0) ────────────────
    let finalCaption = runtime.caption || '';
    // Config shape is defined by the core worktree (fix3-core); cast for forward-compat.
    const plannerConfig = config as Record<string, unknown>;
    const captionTemplates: string[] = Array.isArray(plannerConfig.caption_templates)
        ? (plannerConfig.caption_templates as unknown[]).filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
        : [];
    const captionRotation = plannerConfig.caption_rotation || 'off';
    const useCaptionTemplates = captionTemplates.length > 0 && captionRotation !== 'off';
    if (useCaptionTemplates) {
        const state = readPlannerState(planner, config);
        const templateIndex = typeof state.template_index === 'number' ? Number(state.template_index) : 0;
        const chosen = captionRotation === 'random'
            ? captionTemplates[Math.floor(Math.random() * captionTemplates.length)]
            : captionTemplates[templateIndex % captionTemplates.length];
        const vars = await resolveTemplateVars(runtime.selectedContent, planner, config, (planner.channels || [])[0]?.name || '', now);
        finalCaption = substituteCaptionTemplate(chosen, vars);
    }

    // ── Gating + next_run_at (best-effort estimation, mirrors cron Phase 0) ────
    const freqVal = Number(config.frequency?.value) || 10;
    const freqUnit = config.frequency?.unit || 'minutes';
    let intervalMs = freqVal * 60 * 1000;
    if (freqUnit === 'hours') intervalMs = freqVal * 60 * 60 * 1000;
    else if (freqUnit === 'days') intervalMs = freqVal * 24 * 60 * 60 * 1000;
    else if (freqUnit === 'weeks') intervalMs = freqVal * 7 * 24 * 60 * 60 * 1000;

    let gated: 'interval' | 'start_time' | 'sleep' | null = null;
    let nextRunAt: Date | null = null;

    if (planner.status === 'paused') {
        gated = 'interval'; // informational: not running while paused
    } else {
        const lastRun = planner.last_run ? new Date(planner.last_run) : null;
        const due = !lastRun || (now.getTime() >= lastRun.getTime() + intervalMs - 15000);
        if (!due) {
            gated = 'interval';
            nextRunAt = new Date((lastRun?.getTime() ?? now.getTime()) + intervalMs);
        }

        if (config.start_time) {
            const start = new Date(config.start_time);
            if (start.getTime() > now.getTime()) {
                gated = 'start_time';
                nextRunAt = start;
            }
        }

        const sleep = config.sleep_schedule;
        if (sleep?.start && sleep?.end) {
            const tz = config.timezone || 'America/Sao_Paulo';
            const hhmm = `${getTimeInTimeZone(now, tz).hh}:${getTimeInTimeZone(now, tz).mm}`;
            if (isInSleep(hhmm, sleep.start, sleep.end)) {
                gated = 'sleep';
                // Estimate: end of the sleep window (same day unless it crosses midnight).
                const [eh, em] = sleep.end.split(':').map(Number);
                const next = new Date(now);
                next.setHours(eh, em, 0, 0);
                if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
                nextRunAt = next;
            }
        }

        if (!gated) {
            // Not gated → the next run is one interval after the current "run time".
            const base = lastRun ? lastRun.getTime() + intervalMs : now.getTime();
            nextRunAt = new Date(base);
            if (nextRunAt.getTime() <= now.getTime()) nextRunAt = new Date(now.getTime() + intervalMs);
        }
    }

    const channels = (planner.channels || []).map((channel: any) => ({
        id: channel.id,
        name: channel.name,
        status: channel.status,
        account_id: channel.account_id,
        username: channel.username,
        token_source: channel.token_source,
        token_expires_at: channel.token_expires_at,
        health: describeChannelHealth(channel, now),
    }));

    return NextResponse.json({
        planner: {
            id: planner.id,
            name: planner.name,
            status: planner.status,
            last_run: planner.last_run,
        },
        runtime: {
            ...runtime,
            // Override the runtime caption with the template-resolved one for preview.
            caption: finalCaption,
            preview: {
                ...(runtime.preview || {}),
                caption: finalCaption,
            },
        },
        channels,
        publishable_channels: channels.filter((channel: any) => channel.health.ok),
        gating: {
            gated,
            next_run_at: nextRunAt ? nextRunAt.toISOString() : null,
        },
    });
}
