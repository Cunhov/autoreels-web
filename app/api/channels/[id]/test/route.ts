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
import { isValidProxyUrl, getChannelProxyUrl, maskProxyUrl } from "@/lib/proxy";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const url = new URL(req.url);
	const checkProxy = url.searchParams.get("checkProxy") === "true" || url.searchParams.get("proxy") === "true";
	const proxyParam = url.searchParams.get("proxy_url");
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

	// ── Teste de proxy isolado (sem exigir token) ──
	if (checkProxy) {
		let proxyToTest: string | null = null;
		if (proxyParam && proxyParam.trim()) {
			if (!isValidProxyUrl(proxyParam.trim())) {
				return NextResponse.json({ error: "Proxy inválido. Use http://user:pass@host:porta" }, { status: 400 });
			}
			proxyToTest = proxyParam.trim();
		} else {
			proxyToTest = getChannelProxyUrl(channel as any);
			if (!proxyToTest) {
				return NextResponse.json({ error: "Canal sem proxy configurado." }, { status: 400 });
			}
		}
		// Verifica se proxy está habilitado
		if ((channel as any).proxy_enabled === false && !proxyParam) {
			return NextResponse.json({ error: "Proxy desabilitado para este canal." }, { status: 400 });
		}
		try {
			// Testa proxy fazendo HEAD via proxy para endpoint neutro
			// Usa httpbin ou graph API base — com timeout curto
			const testUrl = "https://api.ipify.org?format=json";
			const res = await fetchWithTimeout(testUrl, { method: "GET" }, 10_000, proxyToTest);
			const body = await res.text().catch(() => "");
			if (!res.ok) {
				return NextResponse.json({ ok: false, error: `Proxy respondeu HTTP ${res.status}`, proxy: maskProxyUrl(proxyToTest), response: body.slice(0, 500) }, { status: 400 });
			}
			return NextResponse.json({ ok: true, proxy: maskProxyUrl(proxyToTest), response: body.slice(0, 500) });
		} catch (err: unknown) {
			return NextResponse.json({ ok: false, error: getErrorMessage(err), proxy: maskProxyUrl(proxyToTest) }, { status: 400 });
		}
	}

	// ── Teste padrão de token (via proxy se configurado) ──
	if (!channel.access_token) {
		return NextResponse.json(
			{ error: "Channel has no token." },
			{ status: 400 },
		);
	}

	try {
		const accessToken = await resolveAccessToken(channel.access_token);
		if (!accessToken) {
			return NextResponse.json(
				{ error: "Could not resolve access token — reconnect the channel." },
				{ status: 400 },
			);
		}

		const baseUrl = getGraphBaseUrl(accessToken);
		const proxyUrl = getChannelProxyUrl(channel as any);
		const effectiveProxy = (channel as any).proxy_enabled === false ? null : proxyUrl;

		const testUrl = `${baseUrl}/${GRAPH_API_VERSION}/${channel.account_id}?fields=username,id&access_token=${accessToken}`;
		const res = await fetchWithTimeout(testUrl, {}, 15_000, effectiveProxy);
		const data = await res.json().catch(() => ({}));

		if (!res.ok || data.error) {
			return NextResponse.json(
				{
					error: data.error?.message || `API error (status ${res.status})`,
					details: data,
					proxy: effectiveProxy ? maskProxyUrl(effectiveProxy) : null,
				},
				{ status: 400 },
			);
		}

		return NextResponse.json({ ok: true, username: data.username, proxy: effectiveProxy ? maskProxyUrl(effectiveProxy) : null });
	} catch (error: unknown) {
		return NextResponse.json(
			{ error: getErrorMessage(error) },
			{ status: 500 },
		);
	}
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const session = await getServerSession(authOptions);
	const userId = getSessionUserId(session);
	if (!userId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const channel = await prisma.channel.findUnique({ where: { id, user_id: userId } });
	if (!channel) {
		return NextResponse.json({ error: "Channel not found" }, { status: 404 });
	}
	try {
		const body = await req.json().catch(() => ({} as any));
		let proxyToTest: string | null = null;
		if (body.proxy_url && String(body.proxy_url).trim()) {
			const raw = String(body.proxy_url).trim();
			if (!isValidProxyUrl(raw)) {
				return NextResponse.json({ error: "Proxy inválido. Use http://user:pass@host:porta" }, { status: 400 });
			}
			proxyToTest = raw;
		} else {
			proxyToTest = getChannelProxyUrl(channel as any);
			if (!proxyToTest) return NextResponse.json({ error: "Nenhum proxy para testar. Informe proxy_url." }, { status: 400 });
		}
		const testUrl = "https://api.ipify.org?format=json";
		const res = await fetchWithTimeout(testUrl, { method: "GET" }, 10_000, proxyToTest);
		const text = await res.text().catch(() => "");
		if (!res.ok) {
			return NextResponse.json({ ok: false, error: `Proxy respondeu HTTP ${res.status}`, proxy: maskProxyUrl(proxyToTest), response: text.slice(0, 500) }, { status: 400 });
		}
		return NextResponse.json({ ok: true, proxy: maskProxyUrl(proxyToTest), response: text.slice(0, 500) });
	} catch (err: unknown) {
		return NextResponse.json({ ok: false, error: getErrorMessage(err) }, { status: 400 });
	}
}
