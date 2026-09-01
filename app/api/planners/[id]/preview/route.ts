import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";
import {
    describeChannelHealth,
    resolveCaptionTemplateVars,
    resolvePlannerRuntime,
    substituteCaptionTemplate,
} from "@/lib/planner-runtime";
import { getPlannerPlatformType, PLANNER_MIX_ERROR } from "@/lib/planner-config";

/** Wall-clock "HH:MM" in a given IANA timezone. */
function getTimeInTimeZone(date: Date, tz: string): { hh: string; mm: string } {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
    const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
    return { hh, mm };
}

function isInSleep(hhmm: string, start: string, end: string): boolean {
    if (start <= end) {
        return hhmm >= start && hhmm < end;
    }
    return hhmm >= start || hhmm < end;
}

/** Channel shape accepted by describeChannelHealth, plus the identity fields
 * the preview response exposes (present on Prisma rows, absent from ChannelLike). */
type ChannelHealthInput = Parameters<typeof describeChannelHealth>[0] & {
    account_id?: string | null;
    username?: string | null;
};

/** Parse the planner publish state from the new `state` column, falling back to config.state. */
function readPlannerState(
    planner: { state?: string | null },
    config: Record<string, unknown>,
): Record<string, unknown> {
    if (planner.state) {
        try {
            const parsed = JSON.parse(planner.state);
            if (parsed && typeof parsed === "object")
                return parsed as Record<string, unknown>;
        } catch {
            /* fall through */
        }
    }
    const configState = config.state;
    if (configState && typeof configState === "object")
        return configState as Record<string, unknown>;
    return {};
}

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const planner = await prisma.planner.findFirst({
        where: { id, user_id: userId },
        include: { channels: true },
    });

    if (!planner) {
        return NextResponse.json(
            { error: "Planner not found" },
            { status: 404 },
        );
    }

    const now = new Date();
    const runtime = await resolvePlannerRuntime(prisma, planner, now);
    const config = runtime.config || {};

    // ── Caption templates (same semantics as the cron Phase 0) ────────────────
    // rotation=off: resolvePlannerRuntime já resolve a caption da entrada via o
    // caminho único (resolveCaptionTemplateVars + substituteCaptionTemplate) —
    // o MESMO usado pelo applyCaptionTemplate no lane de publicação. Não
    // re-substituir aqui (idempotência: valores contendo "{" seriam stripados
    // numa segunda passada).
    let finalCaption = runtime.caption || "";
    // Config shape is defined by the core worktree (fix3-core); cast for forward-compat.
    const plannerConfig = config as Record<string, unknown>;
    const captionTemplates: string[] = Array.isArray(
        plannerConfig.caption_templates,
    )
        ? (plannerConfig.caption_templates as unknown[]).filter(
              (t: unknown): t is string =>
                  typeof t === "string" && t.trim().length > 0,
          )
        : [];
    const captionRotation = plannerConfig.caption_rotation || "off";
    const useCaptionTemplates =
        captionTemplates.length > 0 && captionRotation !== "off";
    if (useCaptionTemplates) {
        const state = readPlannerState(planner, config);
        const templateIndex =
            typeof state.template_index === "number"
                ? Number(state.template_index)
                : 0;
        const chosen =
            captionRotation === "random"
                ? captionTemplates[
                      Math.floor(Math.random() * captionTemplates.length)
                  ]
                : captionTemplates[templateIndex % captionTemplates.length];
        // Resolver compartilhado com o runtime de publicação — mesma semântica,
        // mesmo feedback-loop guard ({post_caption} nunca lê o snapshot da
        // entrada, onde o próprio template vive). O resolver local que existia
        // aqui hardcodava {hashtags}: '' e divergia do publish.
        const vars = await resolveCaptionTemplateVars(
            prisma,
            runtime.selectedContent,
            planner,
            config,
            (planner.channels || [])[0]?.name || "",
            now,
        );
        finalCaption = substituteCaptionTemplate(chosen, vars);
    }

    // ── Gating + next_run_at (best-effort estimation, mirrors cron Phase 0) ────
    const freqObj = plannerConfig.frequency as Record<string, unknown> | undefined;
    const freqVal = Number(freqObj?.value) || 10;
    const freqUnit = String(freqObj?.unit || "minutes");
    let intervalMs = freqVal * 60 * 1000;
    if (freqUnit === "hours") intervalMs = freqVal * 60 * 60 * 1000;
    else if (freqUnit === "days") intervalMs = freqVal * 24 * 60 * 60 * 1000;
    else if (freqUnit === "weeks")
        intervalMs = freqVal * 7 * 24 * 60 * 60 * 1000;

    let gated: "interval" | "start_time" | "sleep" | null = null;
    let nextRunAt: Date | null = null;

    if (planner.status === "paused") {
        gated = "interval"; // informational: not running while paused
    } else {
        const lastRun = planner.last_run ? new Date(planner.last_run) : null;
        const due =
            !lastRun || now.getTime() >= lastRun.getTime() + intervalMs - 15000;
        if (!due) {
            gated = "interval";
            nextRunAt = new Date(
                (lastRun?.getTime() ?? now.getTime()) + intervalMs,
            );
        }

        if (plannerConfig.start_time) {
            const start = new Date(String(plannerConfig.start_time));
            if (start.getTime() > now.getTime()) {
                gated = "start_time";
                nextRunAt = start;
            }
        }

        const sleep = plannerConfig.sleep_schedule as Record<string, unknown> | undefined;
        const sleepStart = typeof sleep?.start === "string" ? sleep.start : "";
        const sleepEnd = typeof sleep?.end === "string" ? sleep.end : "";
        if (sleepStart && sleepEnd) {
            const tz =
                typeof plannerConfig.timezone === "string"
                    ? plannerConfig.timezone
                    : "America/Sao_Paulo";
            const hhmm = `${getTimeInTimeZone(now, tz).hh}:${getTimeInTimeZone(now, tz).mm}`;
            if (isInSleep(hhmm, sleepStart, sleepEnd)) {
                gated = "sleep";
                // Estimate: end of the sleep window (same day unless it crosses midnight).
                const [eh, em] = sleepEnd.split(":").map(Number);
                const next = new Date(now);
                next.setHours(eh, em, 0, 0);
                if (next.getTime() <= now.getTime())
                    next.setDate(next.getDate() + 1);
                nextRunAt = next;
            }
        }

        if (!gated) {
            // Not gated → the next run is one interval after the current "run time".
            const base = lastRun
                ? lastRun.getTime() + intervalMs
                : now.getTime();
            nextRunAt = new Date(base);
            if (nextRunAt.getTime() <= now.getTime())
                nextRunAt = new Date(now.getTime() + intervalMs);
        }
    }

    const channels = (planner.channels || []).map((channel: ChannelHealthInput) => ({
        id: channel.id,
        name: channel.name,
        status: channel.status,
        platform: channel.platform,
        account_id: channel.account_id,
        username: channel.username,
        token_source: channel.token_source,
        token_expires_at: channel.token_expires_at,
        health: describeChannelHealth(channel, now),
    }));

    // YouTube fields do planner (para preview do wizard/runtime)
    const youtubeFields = {
        youtube_title: typeof plannerConfig.youtube_title === "string" ? String(plannerConfig.youtube_title) : null,
        youtube_description: typeof plannerConfig.youtube_description === "string" ? String(plannerConfig.youtube_description) : null,
        youtube_products: typeof plannerConfig.youtube_products === "string" ? String(plannerConfig.youtube_products) : Array.isArray(plannerConfig.youtube_products) ? (plannerConfig.youtube_products as unknown[]).join(",") : null,
        youtube_privacy: typeof plannerConfig.youtube_privacy === "string" ? String(plannerConfig.youtube_privacy) : null,
        youtube_made_for_kids: plannerConfig.youtube_made_for_kids ?? null,
        youtube_monetize_with_ads: plannerConfig.youtube_monetize_with_ads ?? null,
        youtube_category_id: plannerConfig.youtube_category_id ?? null,
        youtube_pinned_comment: typeof (plannerConfig.youtube_pinned_comment ?? plannerConfig.youtube_pinned_comment_text) === "string" ? String(plannerConfig.youtube_pinned_comment ?? plannerConfig.youtube_pinned_comment_text) : null,
    };

    // Isolation: detectar planners mistos (grandfathered) — não bloqueia preview, mas expõe warning
    const platformType = getPlannerPlatformType(config, planner.channels as Array<{ platform?: string | null }>);
    const isMixed = platformType === "mixed";
    const isolationWarning = isMixed ? PLANNER_MIX_ERROR : null;

    return NextResponse.json({
        planner: {
            id: planner.id,
            name: planner.name,
            status: planner.status,
            last_run: planner.last_run,
        },
        youtube: youtubeFields,
        youtube_fields: youtubeFields,
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
        publishable_channels: channels.filter(
            (channel: { health: { ok: boolean } }) => channel.health.ok,
        ),
        platform_type: platformType,
        isolation_warning: isolationWarning,
        gating: {
            gated,
            next_run_at: nextRunAt ? nextRunAt.toISOString() : null,
        },
    });
}
