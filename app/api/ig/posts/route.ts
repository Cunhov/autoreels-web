import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId, unauthorized, badRequest } from "../shared";

/** Local published Instagram posts for automation media selection. */
export async function GET(req: Request) {
    const userId = await requireUserId();
    if (!userId) return unauthorized();
    const { searchParams } = new URL(req.url);
    const rawIds = searchParams.get("channelIds") ?? "";
    const channelIds = [...new Set(rawIds.split(",").map((id) => id.trim()).filter(Boolean))];
    if (!channelIds.length) return badRequest("Perfis são obrigatórios");
    const limitRaw = Number(searchParams.get("limit") ?? 50);
    const offsetRaw = Number(searchParams.get("offset") ?? 0);
    const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.trunc(limitRaw))) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
    const query = (searchParams.get("query") ?? "").trim();
    const channels = await prisma.channel.findMany({ where: { id: { in: channelIds }, user_id: userId, platform: "instagram" }, select: { id: true } });
    if (channels.length !== channelIds.length) return NextResponse.json({ error: "Perfil não encontrado" }, { status: 404 });
    const where = { user_id: userId, channel_id: { in: channelIds }, status: "published", instagram_media_id: { not: null }, ...(query ? { caption: { contains: query } } : {}) };
    try {
        const [rows, total] = await Promise.all([
            prisma.post.findMany({ where, orderBy: [{ published_at: "desc" }, { created_at: "desc" }], skip: offset, take: limit, select: { id: true, channel_id: true, caption: true, thumbnail_url: true, image_url: true, video_url: true, instagram_media_id: true } }),
            prisma.post.count({ where }),
        ]);
        const posts = rows.map((row) => ({
            id: row.id,
            mediaId: row.instagram_media_id!,
            channelId: row.channel_id!,
            caption: row.caption,
            thumbnailUrl: row.thumbnail_url ?? row.image_url ?? row.video_url,
            permalink: null as string | null,
        }));
        const nextOffset = offset + rows.length;
        return NextResponse.json({ posts, hasMore: nextOffset < total, nextOffset, total });
    } catch (error) {
        console.error("List Instagram posts error:", error);
        return NextResponse.json({ error: "Não foi possível carregar posts publicados" }, { status: 400 });
    }
}
