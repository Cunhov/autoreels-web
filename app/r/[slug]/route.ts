import { prisma } from "@/lib/prisma";
import { appendUtm } from "@/lib/ig-automation/clicks";

export const dynamic = "force-dynamic";

function notFound(): Response {
	return new Response("Link não encontrado.", {
		status: 404,
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

	return new Response(null, { status: 302, headers: { Location: target } });
}
