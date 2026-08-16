import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
	fetchWithTimeout,
	getGraphBaseUrl,
	GRAPH_API_VERSION,
	resolveAccessToken,
} from "@/lib/instagram";
import { getErrorMessage, getSessionUserId } from "@/lib/api";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
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
	// A channel without a usable token is a user-side problem (connect it), not
	// a server fault — 4xx with an actionable message (mirrors the refresh route).
	if (!channel.access_token) {
		return NextResponse.json(
			{ error: "Channel has no token." },
			{ status: 400 },
		);
	}

	try {
		const accessToken = await resolveAccessToken(channel.access_token);
		if (!accessToken) {
			// Unresolvable token (e.g. Redis-backed or empty after clean) — user-side.
			return NextResponse.json(
				{ error: "Could not resolve access token — reconnect the channel." },
				{ status: 400 },
			);
		}

		// Test against /me or /account_id to verify token validity
		// For Instagram Professional, we test /me or /{account_id}
		// graph.facebook.com is the standard for content publishing
		const baseUrl = getGraphBaseUrl(accessToken);

		const testUrl = `${baseUrl}/${GRAPH_API_VERSION}/${channel.account_id}?fields=username,id&access_token=${accessToken}`;
		const res = await fetchWithTimeout(testUrl);
		const data = await res.json().catch(() => ({}));

		if (!res.ok || data.error) {
			return NextResponse.json(
				{
					error: data.error?.message || `API error (status ${res.status})`,
					details: data,
				},
				{ status: 400 },
			);
		}

		return NextResponse.json({ ok: true, username: data.username });
	} catch (error: unknown) {
		return NextResponse.json(
			{ error: getErrorMessage(error) },
			{ status: 500 },
		);
	}
}
