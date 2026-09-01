import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { getPublicOrigin, signOAuthState } from "@/lib/instagram";
import { getTiktokOAuthConfig } from "@/lib/tiktok";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = getSessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const origin = getPublicOrigin(req);
    const { clientKey, redirectUri } = getTiktokOAuthConfig(origin, req);
    const state = signOAuthState(userId);
    const scope = ["user.info.basic", "video.publish"].join(",");

    const params = new URLSearchParams({
      client_key: clientKey,
      response_type: "code",
      scope,
      redirect_uri: redirectUri,
      state,
    });

    const url = `https://www.tiktok.com/v2/auth/authorize?${params.toString()}`;

    return NextResponse.json({ url });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not start TikTok OAuth.",
      },
      { status: 400 }
    );
  }
}
