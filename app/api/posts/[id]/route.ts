import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { Prisma } from "@prisma/client";

/**
 * Post lifecycle management: cancel, reschedule, retry, delete.
 *
 * PATCH body (all optional, at least one required):
 *   { status: "cancelled" }                       → cancel a non-published post
 *   { status: "pending" }                         → retry a failed/cancelled/scheduled post (due ASAP)
 *   { scheduled_at: "<ISO future>" }              → reschedule; reactivates failed/cancelled posts
 *   { scheduled_at: null, status: "pending" }     → clear schedule → due on next cron tick
 *   { status: "pending", scheduled_at: "<ISO>" }  → retry at a specific future time
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

        if (status !== undefined && status !== "cancelled" && status !== "pending") {
            return NextResponse.json({ error: "Invalid status" }, { status: 400 });
        }
        if (rawScheduledAt !== undefined && rawScheduledAt !== null && typeof rawScheduledAt !== "string") {
            return NextResponse.json({ error: "scheduled_at must be an ISO string or null" }, { status: 400 });
        }
        if (status === undefined && rawScheduledAt === undefined) {
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
                const d = new Date(rawScheduledAt);
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
                data.scheduled_at = scheduledAt;
            } else if (!post.scheduled_at || post.scheduled_at.getTime() <= Date.now()) {
                // No explicit schedule → due on the next cron tick.
                data.scheduled_at = null;
            }
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
