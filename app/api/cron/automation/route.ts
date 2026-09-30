import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/secret";
import { processDueJobs, processStaleEvents } from "@/lib/ig-automation/jobs";
import { processDueSequences } from "@/lib/ig-automation/sequences";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/automation — chamado pelo worker a cada AUTOMATION_INTERVAL.
 *
 * Auth: apenas header `x-cron-auth: CRON_SECRET` (constant-time). Processa
 * jobs vencidos, sequências e eventos órfãos.
 */
export async function POST(request: Request) {
	try {
		const cronSecret = request.headers.get("x-cron-auth") ?? "";
		const expectedSecret = process.env.CRON_SECRET;
		if (
			!expectedSecret ||
			!cronSecret ||
			!safeEqual(cronSecret, expectedSecret)
		) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const jobs = await processDueJobs();
		const sequences = await processDueSequences();
		const events = await processStaleEvents();

		return NextResponse.json({ ok: true, jobs, sequences, events });
	} catch (error) {
		console.error(
			"[cron/automation] erro:",
			error instanceof Error ? error.name : "Error",
		);
		return NextResponse.json(
			{ ok: false, error: "Falha ao processar a fila de automações." },
			{ status: 500 },
		);
	}
}
