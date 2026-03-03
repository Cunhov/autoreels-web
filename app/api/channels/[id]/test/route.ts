import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const GRAPH_API_VERSION = 'v22.0';

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function cleanToken(token: string): string {
    return (token || '').trim().replace(/^["']|["']$/g, '').trim();
}

/** Robust token resolution copied from publisher/route.ts */
async function resolveAccessToken(tokenOrKey: string | null): Promise<string> {
    if (!tokenOrKey) return '';
    const input = tokenOrKey.trim().replace(/^["']|["']$/g, '').trim();
    let resolvedToken = input;

    if (input.startsWith('token_')) {
        try {
            let redisUrl = process.env.REDIS_URL || '';
            let redisToken = process.env.REDIS_TOKEN || '';

            if (redisUrl && redisUrl.startsWith('rediss://')) {
                const match = redisUrl.match(/rediss:\/\/[^:]+:([^@]+)@([^:]+)/);
                if (match) { redisToken = match[1]; redisUrl = `https://${match[2]}`; }
            }

            if (redisUrl) {
                const { Redis } = await import('@upstash/redis');
                const redis = new Redis({ url: redisUrl, token: redisToken });
                let val: string | null = null;
                try { val = await redis.get<string>(input); } catch { /* ignore */ }
                if (!val) { try { const lv = await redis.lindex(input, 0); if (lv) val = lv as string; } catch { /* ignore */ } }
                if (val) resolvedToken = val;
            }
        } catch { /* ignore */ }
    }

    return cleanToken(resolvedToken);
}

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const channel = await prisma.channel.findUnique({
        where: { id, user_id: (session.user as any).id },
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
        const baseUrl = accessToken.startsWith('IG') ? 'https://graph.instagram.com' : 'https://graph.facebook.com';

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
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
