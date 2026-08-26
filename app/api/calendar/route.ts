import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/api";
import { Prisma } from "@prisma/client";

/**
 * Calendar feed: lean post list for the calendar view.
 *
 * GET /api/calendar?start=<ISO>&end=<ISO>[&channel_id=a,b][&status=pending,failed][&media_type=REELS,IMAGE][&limit=N]
 *
 * - `start` and `end` are REQUIRED ISO strings (the calendar is date-bounded);
 *   missing or invalid values return 400.
 * - Posts without `scheduled_at` (NULL) are intentionally excluded — the
 *   calendar groups by date; NULL-scheduled posts surface in the publisher
 *   queue instead.
 * - Returns `{ posts: [...] }` ordered by `scheduled_at` ascending, with only
 *   the fields the calendar UI needs.
 */
export async function GET(req: Request) {
	const session = await getServerSession(authOptions);
	const userId = getSessionUserId(session);
	if (!userId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let searchParams: URLSearchParams;
	try {
		searchParams = new URL(req.url).searchParams;
	} catch {
		return NextResponse.json({ error: "Invalid request URL" }, { status: 400 });
	}
	const startRaw = searchParams.get("start");
	const endRaw = searchParams.get("end");

	if (!startRaw || !endRaw) {
		return NextResponse.json(
			{ error: "start and end are required ISO date params" },
			{ status: 400 },
		);
	}

	const start = new Date(startRaw);
	const end = new Date(endRaw);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
		return NextResponse.json(
			{ error: "start and end must be valid ISO dates" },
			{ status: 400 },
		);
	}

	const channelId = searchParams.get("channel_id");
	const status = searchParams.get("status");
	const mediaType = searchParams.get("media_type");
	const requestedLimit = Number(searchParams.get("limit") || "500");
	const limit = Number.isFinite(requestedLimit)
		? Math.min(Math.max(requestedLimit, 1), 1000)
		: 500;

	const where: Prisma.PostWhereInput = {
		user_id: userId,
		scheduled_at: { gte: start, lte: end },
	};

	if (channelId) {
		const ids = channelId
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		if (ids.length > 0) where.channel_id = { in: ids };
	}
	if (status) {
		const statuses = status
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		if (statuses.length > 0) where.status = { in: statuses };
	}
	if (mediaType) {
		const types = mediaType
			.split(",")
			.map((item) => item.trim().toUpperCase())
			.filter(Boolean);
		if (types.length > 0) where.media_type = { in: types };
	}

	const posts = await prisma.post.findMany({
		where,
		orderBy: { scheduled_at: "asc" },
		take: limit,
		select: {
			id: true,
			status: true,
			scheduled_at: true,
			published_at: true,
			media_type: true,
			video_url: true,
			image_url: true,
			thumbnail_url: true,
			caption: true,
			channel_id: true,
			planner_id: true,
			planner: { select: { name: true } },
			error_message: true,
			failed_reason: true,
			children_urls: true,
			instagram_media_id: true,
			// YouTube: preserva tipo/opções na duplicação e habilita o deep link
			// do vídeo publicado (watch_url) nos modais de status.
			youtube_type: true,
			youtube_options: true,
			youtube_video_id: true,
			youtube_post_id: true,
			collaborators: true,
			audio_configuration: true,
			user_tags: true,
			share_to_feed: true,
			location_id: true,
		},
	});

	return NextResponse.json({ posts });
}
