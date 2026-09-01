import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getValidTiktokAccessToken, fetchTiktokCreatorInfo } from "@/lib/tiktok";
import { getChannelProxyUrl } from "@/lib/proxy";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = getSessionUserId(session);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId") || url.searchParams.get("channel_id");
  if (!channelId) return NextResponse.json({ error: "channelId é obrigatório." }, { status: 400 });

  try {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, user_id: userId },
      select: { id: true, settings: true, proxy_url: true, proxy_enabled: true, platform: true },
    });
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });

    const { accessToken } = await getValidTiktokAccessToken(channel as unknown as { id: string; settings: string | null; proxy_url: string | null; proxy_enabled: boolean | null });

    // Allow explicit platform check but not mandatory — TikTok tokens may be in mixed platform?
    // If platform is not tiktok but has tiktok token, still allow.
    const proxyUrl = channel.proxy_enabled === false ? null : getChannelProxyUrl(channel as unknown as { proxy_url: string | null; settings: string | null });

    const info = await fetchTiktokCreatorInfo(accessToken, proxyUrl);

    return NextResponse.json({
      privacy_level_options: info.privacy_level_options,
      max_video_post_duration_sec: info.max_video_post_duration_sec,
      comment_disabled: info.comment_disabled,
      duet_disabled: info.duet_disabled,
      stitch_disabled: info.stitch_disabled,
      creator_username: info.creator_username,
      creator_nickname: info.creator_nickname,
      creator_avatar_url: info.creator_avatar_url,
      raw: info,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Falha ao consultar creator_info." }, { status: 400 });
  }
}

// Also support GET for convenience (same logic)
export async function GET(req: Request) {
  return POST(req);
}
