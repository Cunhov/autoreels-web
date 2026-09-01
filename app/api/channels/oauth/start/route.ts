import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionUserId } from "@/lib/api";
import { getInstagramOAuthConfig, getPublicOrigin, signOAuthState } from "@/lib/instagram";

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const origin = getPublicOrigin(req);
        const { clientId, redirectUri } = getInstagramOAuthConfig(origin, req);
        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            state: signOAuthState(userId),
            scope: [
                "instagram_business_basic",
                "instagram_business_content_publish",
            ].join(","),
        });

        return NextResponse.json({
            url: `https://www.instagram.com/oauth/authorize?${params.toString()}`,
        });
    } catch (error: unknown) {
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Could not start Instagram OAuth.",
        }, { status: 400 });
    }
}
