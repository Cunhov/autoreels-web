import { NextResponse } from "next/server";
import {
    exchangeInstagramCode,
    fetchInstagramProfile,
    verifyOAuthState,
} from "@/lib/instagram";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error") || url.searchParams.get("error_message");
    const redirect = new URL("/channels", url.origin);

    if (error) {
        redirect.searchParams.set("connect", "error");
        redirect.searchParams.set("message", error);
        return NextResponse.redirect(redirect);
    }

    if (!code || !state) {
        redirect.searchParams.set("connect", "error");
        redirect.searchParams.set("message", "Missing Instagram authorization code.");
        return NextResponse.redirect(redirect);
    }

    try {
        const { userId } = verifyOAuthState(state);
        const tokenData = await exchangeInstagramCode(code, url.origin);
        const profile = await fetchInstagramProfile(tokenData.token);
        const accountId = profile.id || tokenData.instagramUserId;
        if (!accountId) throw new Error("Instagram account id was not returned.");

        const expiresAt = new Date(Date.now() + tokenData.expiresIn * 1000);
        await prisma.channel.upsert({
            where: {
                user_id_account_id: {
                    user_id: userId,
                    account_id: accountId,
                },
            },
            update: {
                name: profile.username || `Instagram ${accountId}`,
                username: profile.username || null,
                profile_picture_url: profile.profilePictureUrl || null,
                access_token: tokenData.token,
                token_source: "oauth",
                token_expires_at: expiresAt,
                token_refreshed_at: new Date(),
                status: "active",
            },
            create: {
                user_id: userId,
                name: profile.username || `Instagram ${accountId}`,
                platform: "instagram",
                account_id: accountId,
                username: profile.username || null,
                profile_picture_url: profile.profilePictureUrl || null,
                access_token: tokenData.token,
                token_source: "oauth",
                token_expires_at: expiresAt,
                token_refreshed_at: new Date(),
                status: "active",
            },
        });

        redirect.searchParams.set("connect", "success");
        return NextResponse.redirect(redirect);
    } catch (err: unknown) {
        redirect.searchParams.set("connect", "error");
        redirect.searchParams.set("message", err instanceof Error ? err.message : "Instagram connection failed.");
        return NextResponse.redirect(redirect);
    }
}
