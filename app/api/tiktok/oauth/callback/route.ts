import { NextResponse } from "next/server";
import { getPublicOrigin, verifyOAuthState } from "@/lib/instagram";
import { prisma } from "@/lib/prisma";
import { exchangeCodeForToken, parseTiktokSettings } from "@/lib/tiktok";
import { getChannelProxyUrl } from "@/lib/proxy";

export async function GET(req: Request) {
  const publicOrigin = getPublicOrigin(req);
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    const fallback = new URL("/channels", publicOrigin);
    fallback.searchParams.set("connect", "error");
    fallback.searchParams.set("message", "Invalid request URL.");
    return NextResponse.redirect(fallback);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error =
    url.searchParams.get("error") ||
    url.searchParams.get("error_description") ||
    url.searchParams.get("error_message");
  const redirect = new URL("/channels", publicOrigin);

  if (error) {
    redirect.searchParams.set("connect", "error");
    redirect.searchParams.set("message", error);
    return NextResponse.redirect(redirect);
  }

  if (!code || !state) {
    redirect.searchParams.set("connect", "error");
    redirect.searchParams.set("message", "Missing TikTok authorization code.");
    return NextResponse.redirect(redirect);
  }

  try {
    const { userId } = verifyOAuthState(state);

    // state CSRF validated; exchange code (uses env redirectUri which already respects getPublicOrigin)
    const tokenData = await exchangeCodeForToken(code, publicOrigin, req);

    const openId = String(tokenData.open_id || "").trim();
    if (!openId) throw new Error("TikTok open_id não retornado.");

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAtSec = nowSec + Number(tokenData.expires_in || 0);
    const refreshExpiresAtSec = tokenData.refresh_expires_in ? nowSec + Number(tokenData.refresh_expires_in) : undefined;
    const expiresAt = new Date(expiresAtSec * 1000);

    // Try to fetch display name via user info is optional; fallback to openId slice
    let displayName: string | null = null;
    let avatar: string | null = null;
    // Optional: call /v2/user/info if scope allows — best effort, no throw
    try {
      const infoUrl = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username";
      const res = await fetch(infoUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (res.ok) {
        const j = (await res.json()) as { data?: { user?: { display_name?: string; avatar_url?: string; username?: string } } };
        const u = j?.data?.user;
        if (u) {
          displayName = (u.display_name || u.username || null) as string | null;
          avatar = (u.avatar_url as string | null) || null;
        }
      }
    } catch {
      // ignore
    }

    const channelName = displayName ? String(displayName).slice(0, 80) : `TikTok ${openId.slice(0, 8)}`;
    const username = displayName || openId;

    // Merge settings: preserve existing proxy etc, não sobrescrever proxy_url column
    const existing = await prisma.channel.findUnique({
      where: { user_id_account_id: { user_id: userId, account_id: openId } },
      select: { id: true, settings: true, proxy_url: true, proxy_enabled: true },
    });

    let mergedSettings: Record<string, unknown>;
    if (existing?.settings) {
      const base = parseTiktokSettings(existing.settings);
      mergedSettings = {
        ...base,
        tiktok_open_id: openId,
        tiktok_access_token: tokenData.access_token,
        tiktok_refresh_token: tokenData.refresh_token,
        tiktok_expires_at: expiresAtSec,
        tiktok_scopes: tokenData.scope,
        tiktok_token_type: tokenData.token_type,
        ...(refreshExpiresAtSec ? { tiktok_refresh_expires_at: refreshExpiresAtSec } : {}),
      };
    } else {
      mergedSettings = {
        tiktok_open_id: openId,
        tiktok_access_token: tokenData.access_token,
        tiktok_refresh_token: tokenData.refresh_token,
        tiktok_expires_at: expiresAtSec,
        tiktok_scopes: tokenData.scope,
        tiktok_token_type: tokenData.token_type,
        ...(refreshExpiresAtSec ? { tiktok_refresh_expires_at: refreshExpiresAtSec } : {}),
      };
    }

    const settingsStr = JSON.stringify(mergedSettings);

    await prisma.channel.upsert({
      where: { user_id_account_id: { user_id: userId, account_id: openId } },
      update: {
        name: channelName,
        username: username || null,
        profile_picture_url: avatar,
        // Não sobrescrever proxy_url se já existe — upsert update mantém unless explicitamente set?
        // We explicitly avoid touching proxy_url here; it stays as is in existing record.
        // To guarantee, read proxy from existing and re-apply if present (merge).
        // If existing has proxy, keep it; else leave as is (null).
        settings: settingsStr,
        token_expires_at: expiresAt,
        token_refreshed_at: new Date(),
        status: "active",
        platform: "tiktok",
      },
      create: {
        user_id: userId,
        name: channelName,
        platform: "tiktok",
        account_id: openId,
        username: username || null,
        profile_picture_url: avatar,
        access_token: null,
        token_source: "oauth",
        token_expires_at: expiresAt,
        token_refreshed_at: new Date(),
        status: "active",
        settings: settingsStr,
      },
    });

    // Ensure we didn't clobber proxy_url (prisma upsert update above does not include proxy_url, so it's preserved)
    // But if existing was null and user had no proxy, that's fine.

    redirect.searchParams.set("connect", "success");
    redirect.searchParams.set("platform", "tiktok");
    return NextResponse.redirect(redirect);
  } catch (err: unknown) {
    redirect.searchParams.set("connect", "error");
    redirect.searchParams.set("message", err instanceof Error ? err.message : "TikTok connection failed.");
    return NextResponse.redirect(redirect);
  }
}
