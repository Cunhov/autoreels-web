import { createHmac, timingSafeEqual } from "crypto";

export const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v24.0";

export function cleanToken(token: string) {
	return (token || "")
		.trim()
		.replace(/^["']|["']$/g, "")
		.trim();
}

export function getGraphBaseUrl(token: string) {
	const cleaned = cleanToken(token);
	return cleaned.startsWith("IG")
		? "https://graph.instagram.com"
		: "https://graph.facebook.com";
}

// Messages the Graph API returns for a token that is NOT a valid IG/FB token
// (the API literally calls it a malformed "session key"), plus revoked/expired
// tokens. These are permanent: retrying every tick only spams the log.
const PERMANENT_TOKEN_ERROR_RE =
	/error validating access token|session key is malformed|invalid oauth 2\.0 access token|session has expired|session has been invalidated|reauthorization is required|revoked/i;
// Missing client credentials is a server misconfiguration — every refresh
// attempt fails identically, so it is also permanent for retry purposes.
const MISSING_CREDENTIALS_RE =
	/must be configured to refresh facebook-based tokens/i;

/**
 * Classify a token-refresh failure.
 *
 * "permanent" → the attempt will never succeed on its own (invalid/revoked
 * token, or missing INSTAGRAM_CLIENT_ID/SECRET): the caller should mark the
 * channel and stop retrying every tick.
 * "transient" → network/5xx/timeout style failures: retry next tick.
 */
export function classifyTokenRefreshError(
	err: unknown,
): "permanent" | "transient" {
	const message = err instanceof Error ? err.message : String(err ?? "");
	if (
		PERMANENT_TOKEN_ERROR_RE.test(message) ||
		MISSING_CREDENTIALS_RE.test(message)
	) {
		return "permanent";
	}
	return "transient";
}

export async function fetchWithTimeout(
	url: string,
	options: RequestInit = {},
	timeoutMs = 15_000,
	proxyUrl?: string | null,
) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let dispatcher: unknown | undefined;
		if (proxyUrl) {
			try {
				const { getProxyDispatcher } = await import("@/lib/proxy");
				dispatcher = getProxyDispatcher(proxyUrl);
			} catch {
				// proxy helper not available
			}
		}
		const fetchOpts: RequestInit & { dispatcher?: unknown } = { ...options, signal: controller.signal };
		if (dispatcher) (fetchOpts as any).dispatcher = dispatcher;
		return await fetch(url, fetchOpts as RequestInit);
	} finally {
		clearTimeout(timer);
	}
}

export async function resolveAccessToken(tokenOrKey: string | null) {
	if (!tokenOrKey) return "";

	const input = cleanToken(tokenOrKey);
	let resolvedToken = input;

	if (input.startsWith("token_")) {
		let redisUrl = process.env.REDIS_URL || "";
		let redisToken = process.env.REDIS_TOKEN || "";

		if (redisUrl && redisUrl.startsWith("rediss://")) {
			const match = redisUrl.match(/rediss:\/\/[^:]+:([^@]+)@([^:]+)/);
			if (match) {
				redisToken = match[1];
				redisUrl = `https://${match[2]}`;
			}
		}

		if (!redisUrl) {
			throw new Error(`Redis URL missing, cannot resolve ${input}`);
		}

		const { Redis } = await import("@upstash/redis");
		const redis = new Redis({ url: redisUrl, token: redisToken });
		let val: string | null = null;
		const keyType = await redis.type(input);

		if (keyType === "string") {
			val = await redis.get<string>(input);
		} else if (keyType === "list") {
			const lv = await redis.lindex(input, 0);
			if (lv) val = lv as string;
		} else if (keyType === "hash") {
			const hashData = await redis.hgetall(input);
			if (hashData && typeof hashData === "object") {
				const firstVal = Object.values(hashData).find(
					(value) => value && typeof value === "string" && value.length > 10,
				);
				if (firstVal) val = firstVal as string;
			}
		}

		if (!val) {
			throw new Error(
				`Token key ${input} yielded no value in Redis. Please re-connect the channel.`,
			);
		}

		resolvedToken = val;
	}

	return cleanToken(resolvedToken);
}

export function getInstagramOAuthConfig(origin: string) {
	const clientId =
		process.env.INSTAGRAM_CLIENT_ID ||
		process.env.NEXT_PUBLIC_INSTAGRAM_CLIENT_ID ||
		"";
	const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET || "";
	const redirectUri =
		process.env.INSTAGRAM_REDIRECT_URI ||
		`${origin.replace(/\/$/, "")}/api/channels/oauth/callback`;

	if (!clientId || !clientSecret) {
		throw new Error(
			"INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET must be configured.",
		);
	}

	return { clientId, clientSecret, redirectUri };
}

export function signOAuthState(userId: string) {
	const secret =
		process.env.NEXTAUTH_SECRET || process.env.CRON_SECRET || "autoreels";
	const payload = Buffer.from(
		JSON.stringify({ userId, ts: Date.now() }),
	).toString("base64url");
	const sig = createHmac("sha256", secret).update(payload).digest("base64url");
	return `${payload}.${sig}`;
}

export function verifyOAuthState(state: string) {
	const secret =
		process.env.NEXTAUTH_SECRET || process.env.CRON_SECRET || "autoreels";
	const [payload, sig] = state.split(".");
	if (!payload || !sig) throw new Error("Invalid OAuth state.");

	const expected = createHmac("sha256", secret)
		.update(payload)
		.digest("base64url");
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		throw new Error("Invalid OAuth state signature.");
	}

	let parsed: { userId: string; ts: number };
	try {
		parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
			userId: string;
			ts: number;
		};
	} catch {
		throw new Error("Invalid OAuth state payload.");
	}
	if (!parsed.userId || Date.now() - parsed.ts > 10 * 60 * 1000) {
		throw new Error("OAuth state expired.");
	}
	return parsed;
}

export async function exchangeInstagramCode(code: string, origin: string) {
	const { clientId, clientSecret, redirectUri } =
		getInstagramOAuthConfig(origin);

	const shortRes = await fetchWithTimeout(
		"https://api.instagram.com/oauth/access_token",
		{
			method: "POST",
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				grant_type: "authorization_code",
				redirect_uri: redirectUri,
				code,
			}),
		},
		30_000,
	);
	const shortData = await shortRes.json();
	if (!shortRes.ok || shortData.error_message || !shortData.access_token) {
		throw new Error(
			shortData.error_message ||
				shortData.error?.message ||
				"Instagram OAuth exchange failed.",
		);
	}

	const longRes = await fetchWithTimeout(
		`https://graph.instagram.com/access_token?${new URLSearchParams({
			grant_type: "ig_exchange_token",
			client_secret: clientSecret,
			access_token: shortData.access_token,
		}).toString()}`,
		{},
		30_000,
	);
	const longData = await longRes.json();
	if (!longRes.ok || longData.error || !longData.access_token) {
		throw new Error(
			longData.error?.message || "Instagram long-lived token exchange failed.",
		);
	}

	return {
		token: cleanToken(longData.access_token),
		expiresIn: Number(longData.expires_in || 60 * 24 * 60 * 60),
		instagramUserId: String(shortData.user_id || ""),
	};
}

export async function refreshInstagramToken(accessToken: string, proxyUrl?: string | null) {
	const token = cleanToken(accessToken);
	if (token.startsWith("IG")) {
		const res = await fetchWithTimeout(
			`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({
				grant_type: "ig_refresh_token",
				access_token: token,
			}).toString()}`,
			{},
			30_000,
			proxyUrl ?? null,
		);
		const data = await res.json();
		if (!res.ok || data.error || !data.access_token) {
			throw new Error(data.error?.message || "Instagram token refresh failed.");
		}

		return {
			token: cleanToken(data.access_token),
			expiresIn: Number(data.expires_in || 60 * 24 * 60 * 60),
		};
	} else {
		const clientId =
			process.env.INSTAGRAM_CLIENT_ID ||
			process.env.NEXT_PUBLIC_INSTAGRAM_CLIENT_ID ||
			"";
		const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET || "";
		if (!clientId || !clientSecret) {
			throw new Error(
				"INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET must be configured to refresh Facebook-based tokens.",
			);
		}

		const res = await fetchWithTimeout(
			`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?${new URLSearchParams(
				{
					grant_type: "fb_exchange_token",
					client_id: clientId,
					client_secret: clientSecret,
					fb_exchange_token: token,
				},
			).toString()}`,
			{},
			30_000,
			proxyUrl ?? null,
		);
		const data = await res.json();
		if (!res.ok || data.error || !data.access_token) {
			throw new Error(
				data.error?.message ||
					"Facebook/Instagram Professional token refresh failed.",
			);
		}

		return {
			token: cleanToken(data.access_token),
			expiresIn: Number(data.expires_in || 60 * 24 * 60 * 60),
		};
	}
}

export async function fetchInstagramProfile(accessToken: string, proxyUrl?: string | null) {
	const token = cleanToken(accessToken);
	const baseUrl = getGraphBaseUrl(token);
	const res = await fetchWithTimeout(
		`${baseUrl}/${GRAPH_API_VERSION}/me?fields=id,user_id,username,profile_picture_url&access_token=${encodeURIComponent(token)}`,
		{},
		15_000,
		proxyUrl ?? null,
	);
	const data = await res.json();
	if (!res.ok || data.error) {
		throw new Error(data.error?.message || "Could not read Instagram profile.");
	}
	return {
		id: String(data.user_id || data.id || ""),
		username: data.username ? String(data.username) : "",
		profilePictureUrl: data.profile_picture_url
			? String(data.profile_picture_url)
			: "",
	};
}
