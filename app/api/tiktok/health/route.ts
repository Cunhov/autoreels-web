import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { parseTiktokSettings, maskTiktokToken, maskTiktokOpenId, getValidTiktokAccessToken } from "@/lib/tiktok";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = getSessionUserId(session);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId") || url.searchParams.get("channel_id");

  if (!channelId) {
    // Global health without channel: just check env config
    const hasKey = Boolean((process.env.TIKTOK_CLIENT_KEY || "").trim());
    const hasSecret = Boolean((process.env.TIKTOK_CLIENT_SECRET || "").trim());
    const redirectUri = (process.env.TIKTOK_REDIRECT_URI || "").trim() || "auto (origin + /api/tiktok/oauth/callback)";
    return NextResponse.json({
      configured: hasKey && hasSecret,
      has_client_key: hasKey,
      has_client_secret: hasSecret,
      redirect_uri: redirectUri,
      // nunca expor segredo cru
      client_key_masked: hasKey ? maskTiktokToken(process.env.TIKTOK_CLIENT_KEY || "") : "",
    });
  }

  try {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, user_id: userId },
      select: { id: true, settings: true, platform: true, proxy_url: true, proxy_enabled: true, token_expires_at: true, status: true, account_id: true },
    });
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });

    const s = parseTiktokSettings(channel.settings);
    const hasToken = Boolean(typeof s.tiktok_access_token === "string" && s.tiktok_access_token.trim());
    const openId = typeof s.tiktok_open_id === "string" ? s.tiktok_open_id : "";
    const expiresAt = typeof s.tiktok_expires_at === "number" ? s.tiktok_expires_at : Number(s.tiktok_expires_at || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    const isExpired = expiresAt ? expiresAt < nowSec : false;
    const expiresInSec = expiresAt ? expiresAt - nowSec : null;

    // tentar refresh automático silencioso se <60s (mas não falhar health se refresh falhar)
    let refreshed = false;
    let refreshError: string | null = null;
    if (hasToken && expiresAt && expiresAt < nowSec + 60) {
      try {
        await getValidTiktokAccessToken(channel as unknown as { id: string; settings: string | null; proxy_url: string | null; proxy_enabled: boolean | null });
        refreshed = true;
      } catch (e: unknown) {
        refreshError = e instanceof Error ? e.message : String(e);
      }
    }

    // Re-read after potential refresh
    let finalHasToken = hasToken;
    let finalExpiresIn = expiresInSec;
    let finalMaskedToken = "";
    let finalOpenIdMasked = "";
    if (refreshed) {
      try {
        const fresh = await prisma.channel.findUnique({ where: { id: channel.id }, select: { settings: true } });
        const fs = parseTiktokSettings(fresh?.settings ?? null);
        const nt = typeof fs.tiktok_access_token === "string" ? fs.tiktok_access_token : "";
        const ne = typeof fs.tiktok_expires_at === "number" ? fs.tiktok_expires_at : Number(fs.tiktok_expires_at || 0);
        if (nt) finalMaskedToken = maskTiktokToken(nt);
        const noi = typeof fs.tiktok_open_id === "string" ? fs.tiktok_open_id : openId;
        if (noi) finalOpenIdMasked = maskTiktokOpenId(noi);
        finalHasToken = Boolean(nt);
        finalExpiresIn = ne ? ne - Math.floor(Date.now() / 1000) : null;
      } catch {}
    } else {
      if (hasToken) finalMaskedToken = maskTiktokToken(typeof s.tiktok_access_token === "string" ? s.tiktok_access_token : "");
      if (openId) finalOpenIdMasked = maskTiktokOpenId(openId);
    }

    return NextResponse.json({
      ok: finalHasToken && !isExpired,
      channel_id: channel.id,
      platform: channel.platform,
      status: channel.status,
      has_token: finalHasToken,
      open_id_masked: finalOpenIdMasked || null,
      // nunca expor token cru
      access_token_masked: finalMaskedToken || null,
      expires_at: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
      expires_in_sec: finalExpiresIn,
      is_expired: isExpired,
      refreshed,
      refresh_error: refreshError,
      has_proxy: Boolean(channel.proxy_url),
      proxy_enabled: channel.proxy_enabled ?? true,
      scopes: typeof s.tiktok_scopes === "string" ? s.tiktok_scopes : null,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Health check failed." }, { status: 400 });
  }
}
