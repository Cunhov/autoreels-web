import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { parseYoutubeOptions } from "@/lib/youtube-post-options";
import { escapeHtml, safeJsonParse, CAPTION_MAX } from "@/lib/sanitize";
import { Prisma } from "@prisma/client";

/**
 * Post lifecycle management: cancel, reschedule, retry, delete.
 *
 * PATCH body (all optional, at least one required):
 *   { status: "cancelled" }                       → cancel a non-published post
 *   { status: "pending" }                         → retry a failed/cancelled/scheduled post (preserves its date)
 *   { scheduled_at: "<ISO future>" }              → reschedule; reactivates failed/cancelled posts
 *   { scheduled_at: null, status: "pending" }     → clear schedule → due on next cron tick
 *   { status: "pending", scheduled_at: "<ISO>" }  → retry at a specific future time
 *   { caption: "..." }                            → edit caption of a non-published post
 *   { youtube_options: {...} | null }             → edit/clear YouTube options (title,
 *                                                    privacy, etc.) of a non-published post
 *
 * A plain retry ({ status: "pending" } without scheduled_at) preserves the
 * existing scheduled_at — even when it is in the past (the cron treats past
 * dates as due), so the post keeps its place on the calendar. Posts that never
 * had a date stay NULL (due on the next cron tick).
 */

const RETRYABLE_STATUSES = ["failed", "cancelled", "scheduled"] as const;
const RESCHEDULEABLE_STATUSES = ["pending", "scheduled", "cancelled", "failed"] as const;

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const post = await prisma.post.findFirst({
            where: { id, user_id: userId },
        });
        if (!post) {
            return NextResponse.json({ error: "Post not found" }, { status: 404 });
        }
        if (post.status === "published") {
            return NextResponse.json({ error: "Cannot modify a published post" }, { status: 400 });
        }

        const body = await req.json();
        const status = body.status as string | undefined;
        const rawScheduledAt = body.scheduled_at as string | null | undefined;
        let rawCaption = body.caption as string | undefined;
        // undefined = não enviado; null = limpar as opções do YouTube
        const rawYoutubeOptions = body.youtube_options as
            | string
            | Record<string, unknown>
            | null
            | undefined;

        if (rawCaption !== undefined && typeof rawCaption !== "string") {
            return NextResponse.json({ error: "caption deve ser uma string" }, { status: 400 });
        }
        if (rawCaption !== undefined) {
            // BK-07 XSS sanitização + BK-14 maxLength 2200
            let cap = String(rawCaption);
            if (cap.length > CAPTION_MAX) cap = cap.slice(0, CAPTION_MAX);
            if (cap.includes("<") || cap.includes(">")) rawCaption = escapeHtml(cap);
            else rawCaption = cap;
        }
        let youtubeOptions: string | null | undefined;
        if (rawYoutubeOptions !== undefined) {
            try {
                const parsed = parseYoutubeOptions(rawYoutubeOptions);
                youtubeOptions = parsed; // BK-19 null padronizado (vazio vira null)
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : "youtube_options inválido";
                return NextResponse.json({ error: message }, { status: 400 });
            }
        }

        if (status !== undefined && status !== "cancelled" && status !== "pending") {
            return NextResponse.json({ error: "Invalid status" }, { status: 400 });
        }
        if (rawScheduledAt !== undefined && rawScheduledAt !== null && typeof rawScheduledAt !== "string") {
            return NextResponse.json({ error: "scheduled_at must be an ISO string or null" }, { status: 400 });
        }
        if (
            status === undefined &&
            rawScheduledAt === undefined &&
            rawCaption === undefined &&
            rawYoutubeOptions === undefined
        ) {
            return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
        }

        // ── scheduled_at (reschedule) ───────────────────────────────────────
        let scheduledAt: Date | null | undefined;
        let rescheduleReactivates = false;

        if (rawScheduledAt !== undefined) {
            if (!RESCHEDULEABLE_STATUSES.includes(post.status as (typeof RESCHEDULEABLE_STATUSES)[number])) {
                return NextResponse.json(
                    { error: "Post cannot be rescheduled in its current status" },
                    { status: 400 }
                );
            }
            if (rawScheduledAt === null) {
                // Clearing the schedule is only meaningful when re-queueing for immediate processing.
                if (status !== "pending") {
                    return NextResponse.json(
                        { error: "Only a pending retry may clear scheduled_at" },
                        { status: 400 }
                    );
                }
                scheduledAt = null;
            } else {
                const raw = String(rawScheduledAt);
                if (!/(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
                    return NextResponse.json(
                        { error: "scheduled_at must be an ISO date with explicit offset (e.g. ...Z or ...+03:00)" },
                        { status: 400 }
                    );
                }
                const ts = Date.parse(raw);
                if (Number.isNaN(ts)) {
                    return NextResponse.json({ error: "Invalid scheduled_at" }, { status: 400 });
                }
                const d = new Date(ts);
                if (Number.isNaN(d.getTime())) {
                    return NextResponse.json({ error: "Invalid scheduled_at" }, { status: 400 });
                }
                if (d.getTime() <= Date.now()) {
                    return NextResponse.json(
                        { error: "scheduled_at must be in the future" },
                        { status: 400 }
                    );
                }
                scheduledAt = d;
            }
            rescheduleReactivates = post.status === "failed" || post.status === "cancelled";
        }

        // ── status transition ───────────────────────────────────────────────
        const data: Prisma.PostUpdateInput = {};

        // Edição de conteúdo (posts ainda não publicados): corrige typos de
        // título/descrição/comentário fixado sem cancelar e recriar o post.
        if (rawCaption !== undefined) data.caption = rawCaption;
        if (youtubeOptions !== undefined) data.youtube_options = youtubeOptions;

        // ── Revalidação cruzada YouTube: a edição não pode deixar o post
        // inválido até o cron falhar (Short sem título, Comunidade sem texto). ──
        if (
            post.youtube_type &&
            (rawCaption !== undefined || rawYoutubeOptions !== undefined)
        ) {
            const finalCaption =
                rawCaption !== undefined ? rawCaption : post.caption || "";
            const rawOptions =
                rawYoutubeOptions !== undefined
                    ? rawYoutubeOptions
                    : post.youtube_options;
            const opts = safeJsonParse<{title?: unknown}>(String(rawOptions ?? ""), {} as any) as { title?: unknown };
            const optTitle = typeof opts.title === "string" ? opts.title.trim() : "";
            if (post.youtube_type === "short") {
                // Mesma resolução do publisher: options.title || caption.
                const effectiveTitle = optTitle || finalCaption.trim();
                if (!effectiveTitle) {
                    return NextResponse.json(
                        { error: "Short do YouTube exige um título (youtube_options.title ou caption)" },
                        { status: 400 },
                    );
                }
            } else if (post.youtube_type === "community") {
                if (!finalCaption.trim()) {
                    return NextResponse.json(
                        { error: "Post na Comunidade exige texto (caption)" },
                        { status: 400 },
                    );
                }
            }
        }

        if (status === "cancelled") {
            // Cancel wins over any schedule change (destructive action).
            data.status = "cancelled";
            data.error_message = null;
            data.failed_reason = null;
        } else if (status === "pending") {
            if (!RETRYABLE_STATUSES.includes(post.status as (typeof RETRYABLE_STATUSES)[number])) {
                return NextResponse.json(
                    { error: "Post cannot be retried in its current status" },
                    { status: 400 }
                );
            }
            data.status = "pending";
            data.attempts = 0;
            data.last_attempt_at = null;
            data.container_created_at = null;
            data.instagram_container_id = null;
            data.instagram_child_ids = null;
            data.error_message = null;
            data.failed_reason = null;
            if (scheduledAt !== undefined) {
                // Explicit reschedule wins over any preserved date.
                data.scheduled_at = scheduledAt;
            }
            // Otherwise preserve the existing scheduled_at — even if it is in
            // the past (the cron treats past dates as due), so the post keeps
            // its place on the calendar. A post that never had a date stays
            // NULL → due on the next cron tick.
        } else if (rescheduleReactivates) {
            // scheduled_at alone on a failed/cancelled post reactivates it.
            data.scheduled_at = scheduledAt;
            data.status = "pending";
            data.attempts = 0;
            data.last_attempt_at = null;
            data.container_created_at = null;
            data.instagram_container_id = null;
            data.instagram_child_ids = null;
            data.error_message = null;
            data.failed_reason = null;
        } else if (scheduledAt !== undefined) {
            // Plain reschedule of a pending/scheduled post.
            data.scheduled_at = scheduledAt;
        }

        const updated = await prisma.post.update({
            where: { id },
            data,
        });

        return NextResponse.json(updated);
    } catch (error: unknown) {
        console.error("Update post error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Deleting a PUBLISHED post is allowed at the API layer (the record is
    // removed; the media files are shared across posts and stay on disk). The
    // UI deliberately hides the delete action for published posts — this is a
    // documented contract (bar C3: "rejected or documented"), not an omission.

    try {
        const post = await prisma.post.findFirst({
            where: { id, user_id: userId },
            select: { id: true },
        });
        if (!post) {
            return NextResponse.json({ error: "Post not found" }, { status: 404 });
        }

        // Record-only delete: media files are shared across posts and stay on disk.
        await prisma.post.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error("Delete post error:", error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
