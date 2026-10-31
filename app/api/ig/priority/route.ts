import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";
import { sanitizeCaption } from "@/lib/sanitize";

/**
 * POST /api/ig/priority
 *
 * Cria um Post "avulso" (planner_id = null) para o vídeo novo e registra a
 * linha em `ig_priority_queue`. O publisher publica antes do loop; depois de
 * publicado, o cron do publisher appenda o ContentItem ao(s) planner(s)
 * informados em `plannerIds`.
 *
 * Body:
 *   {
 *     channelId: string,
 *     contentItemIds: string[],
 *     caption?: string,
 *     plannerIds?: string[],
 *     gapSeconds?: number,
 *     jobId?: string
 *   }
 */
export async function POST(req: Request) {
	const session = await getServerSession(authOptions);
	const userId = getSessionUserId(session);
	if (!userId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: Record<string, unknown>;
	try {
		body = (await req.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
	}

	const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
	const contentItemIds = Array.isArray(body.contentItemIds)
		? body.contentItemIds.filter(
				(id): id is string => typeof id === "string" && !!id.trim(),
			)
		: [];
	const plannerIdsRaw = Array.isArray(body.plannerIds)
		? body.plannerIds.filter(
				(id): id is string => typeof id === "string" && !!id.trim(),
			)
		: [];
	const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";

	if (!channelId) {
		return NextResponse.json({ error: "channelId é obrigatório" }, { status: 400 });
	}
	if (contentItemIds.length === 0) {
		return NextResponse.json(
			{ error: "contentItemIds é obrigatório" },
			{ status: 400 },
		);
	}

	const channel = await prisma.channel.findFirst({
		where: {
			id: channelId,
			user_id: userId,
			platform: "instagram",
		},
		select: { id: true, name: true, username: true },
	});
	if (!channel) {
		return NextResponse.json(
			{ error: "Canal Instagram não encontrado" },
			{ status: 404 },
		);
	}

	const items = await prisma.contentItem.findMany({
		where: {
			id: { in: contentItemIds },
			user_id: userId,
			type: "video",
		},
		select: {
			id: true,
			url: true,
			name: true,
			caption: true,
			caption_instagram: true,
		},
	});
	const itemById = new Map(items.map((item) => [item.id, item]));
	const missing = contentItemIds.filter((id) => !itemById.has(id));
	if (missing.length > 0) {
		return NextResponse.json(
			{ error: `ContentItem inválido: ${missing.join(", ")}` },
			{ status: 400 },
		);
	}

	const planners = plannerIdsRaw.length
		? await prisma.planner.findMany({
				where: { id: { in: plannerIdsRaw }, user_id: userId },
				select: { id: true },
			})
		: [];
	const plannerIds = planners.map((planner) => planner.id);

	// Idempotência: o worker pode repetir o job após crash/retry.
	if (jobId) {
		const existing = await prisma.igPriorityQueue.findFirst({
			where: { job_id: jobId },
		});
		if (existing) {
			return NextResponse.json({
				ok: true,
				idempotent: true,
				queue: existing,
			});
		}
	}

	const gapSeconds = Number.isFinite(Number(body.gapSeconds))
		? Math.max(60, Math.min(24 * 3600, Number(body.gapSeconds)))
		: 1800;
	const gapMs = gapSeconds * 1000;
	const now = Date.now();

	const last = await prisma.igPriorityQueue.findFirst({
		where: {
			channel_id: channelId,
			status: "pending",
			scheduled_at: { gte: new Date(now) },
		},
		orderBy: { scheduled_at: "desc" },
		select: { scheduled_at: true },
	});
	let nextAt = now + 5000;
	if (last?.scheduled_at) {
		const afterLast = last.scheduled_at.getTime() + gapMs;
		if (afterLast > nextAt) nextAt = afterLast;
	}

	// Não colar no post que o loop acabou de publicar: o primeiro prioritário
	// também respeita o gap mínimo desde o último publicado do canal.
	const lastPublished = await prisma.post.findFirst({
		where: {
			channel_id: channelId,
			status: "published",
			published_at: { not: null },
		},
		orderBy: { published_at: "desc" },
		select: { published_at: true },
	});
	if (lastPublished?.published_at) {
		const afterPublished = lastPublished.published_at.getTime() + gapMs;
		if (afterPublished > nextAt) nextAt = afterPublished;
	}

	const captionOverride =
		typeof body.caption === "string" && body.caption.trim()
			? sanitizeCaption(body.caption)
			: null;

	const created: Array<{
		queueId: string;
		postId: string;
		contentItemId: string;
		scheduledAt: string;
	}> = [];

	for (let i = 0; i < contentItemIds.length; i++) {
		const contentItemId = contentItemIds[i];
		const item = itemById.get(contentItemId);
		if (!item?.url) {
			return NextResponse.json(
				{ error: `ContentItem sem URL: ${contentItemId}` },
				{ status: 400 },
			);
		}

		const caption = sanitizeCaption(
			captionOverride || item.caption_instagram || item.caption || "",
		);
		const scheduledAt = new Date(nextAt + i * gapMs);

		const rowJobId = jobId
			? contentItemIds.length > 1
				? `${jobId}:${contentItemId}`
				: jobId
			: null;

		try {
			const result = await prisma.$transaction(async (tx) => {
				const post = await tx.post.create({
					data: {
						user_id: userId,
						channel_id: channelId,
						video_url: item.url,
						caption,
						media_type: "REELS",
						share_to_feed: true,
						status: "pending",
						scheduled_at: scheduledAt,
						planner_id: null,
					},
					select: { id: true, scheduled_at: true },
				});

				const queue = await tx.igPriorityQueue.create({
					data: {
						user_id: userId,
						channel_id: channelId,
						content_item_id: contentItemId,
						post_id: post.id,
						job_id: rowJobId,
						planner_ids: JSON.stringify(plannerIds),
						caption,
						scheduled_at: scheduledAt,
						status: "pending",
					},
					select: { id: true },
				});

				return { post, queue };
			});

			created.push({
				queueId: result.queue.id,
				postId: result.post.id,
				contentItemId,
				scheduledAt: result.post.scheduled_at?.toISOString() || scheduledAt.toISOString(),
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			return NextResponse.json(
				{ error: `Falha ao criar post prioritário: ${message}` },
				{ status: 500 },
			);
		}
	}

	return NextResponse.json({
		ok: true,
		channel: { id: channel.id, username: channel.username },
		posts: created,
		plannerIds,
	});
}
