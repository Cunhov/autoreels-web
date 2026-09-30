import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { appendUtm, isHttpUrl } from "@/lib/ig-automation/clicks";
import { dispatchOutbound } from "@/lib/ig-automation/outbound";

export const dynamic = "force-dynamic";

function notFound(): Response {
	return new Response("Link não encontrado.", {
		status: 404,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

function invalidTarget(): Response {
	return new Response("Link inválido.", {
		status: 400,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const { slug } = await params;
	const cleanSlug = String(slug || "").trim();
	if (!cleanSlug) return notFound();

	const click = await prisma.igClick.findUnique({ where: { slug: cleanSlug } });
	if (!click) return notFound();

	const target = appendUtm(click.target_url, {
		source: click.utm_source || "instagram",
		medium: click.utm_medium ?? undefined,
		campaign: click.utm_campaign ?? undefined,
	});
	if (!target) return notFound();
	// Revalida no redirect: destino fora de http(s) nunca vira Location.
	if (!isHttpUrl(target)) return invalidTarget();

	try {
		await prisma.igClick.update({
			where: { id: click.id },
			data: { clicks: { increment: 1 }, last_click_at: new Date() },
		});
		if (click.automation_id) {
			await prisma.igAutomation.update({
				where: { id: click.automation_id },
				data: { stats_clicks: { increment: 1 } },
			});
		}
	} catch {
		/* contagem não pode impedir o redirecionamento */
	}

	// Evento `click` p/ webhooks de saída — fire-and-forget, nunca bloqueia o
	// redirect; qualquer erro é ignorado.
	const dispatchClick = async (): Promise<void> => {
		try {
			await dispatchOutbound({
				userId: click.user_id,
				channelId: click.channel_id ?? "",
				event: "click",
				automationId: click.automation_id,
				contact: null,
				text: target,
			});
		} catch {
			/* erro ignorado — nunca bloqueia o redirect */
		}
	};
	try {
		after(dispatchClick);
	} catch {
		void dispatchClick();
	}

	return new Response(null, { status: 302, headers: { Location: target } });
}
