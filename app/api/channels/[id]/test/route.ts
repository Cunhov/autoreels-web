import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { fetchWithTimeout, getGraphBaseUrl, GRAPH_API_VERSION, resolveAccessToken } from "@/lib/instagram";
import { getErrorMessage, getSessionUserId } from "@/lib/api";

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const channel = await prisma.channel.findUnique({
        where: { id, user_id: userId },
    });

    if (!channel) {
        return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    try {
        const accessToken = await resolveAccessToken(channel.access_token);
        if (!accessToken) throw new Error("Could not resolve access token");

        // Test against /me or /account_id to verify token validity
        // For Instagram Professional, we test /me or /{account_id}
        // graph.facebook.com is the standard for content publishing
        const baseUrl = getGraphBaseUrl(accessToken);

        const testUrl = `${baseUrl}/${GRAPH_API_VERSION}/${channel.account_id}?fields=username,id&access_token=${accessToken}`;
        const res = await fetchWithTimeout(testUrl);
        const data = await res.json();

        if (data.error) {
            return NextResponse.json({
                error: data.error.message || "Token invalid",
                details: data
            }, { status: 400 });
        }

        return NextResponse.json({ ok: true, username: data.username });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
