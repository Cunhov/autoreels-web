/**
 * lib/publisher-race-guard.ts — M13 guard de race cancelamento×publisher.
 *
 * O publisher (`app/api/cron/publisher/route.ts`) é o ÚNICO writer de
 * desfechos de posts em voo (`pending/queued/processing/processing_upload/
 * processing_children/ready_to_publish`). O PATCH de planner (remover canal,
 * bug-remove) pode cancelar um post NO MEIO do processamento — sem este guard,
 * uma escrita incondicional por `id` sobrescreveria o `cancelled`:
 *   - escrita final `published` → post zombie (publicou mesmo cancelado);
 *   - retry transiente revertendo para `pending` → post "ressuscitado" e
 *     republicado no tick seguinte (viola o cancelamento);
 *   - falha definitiva escrevendo `failed` → cancelamento mascarado.
 *
 * Guard é ADICIONAL ao fluxo bug-remove (que continua criando `cancelled`):
 * não altera o cancelamento, só impede que o publisher o sobrescreva.
 *
 * Extraído da route para o f5-races poder importá-lo diretamente — route
 * files do Next só podem exportar métodos HTTP (exportar helpers quebra
 * `next build`).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Status NÃO-terminais em que o publisher pode gravar o desfecho de um post. */
export const PUBLISHABLE_IN_FLIGHT_STATUSES = [
	"pending",
	"queued",
	"processing",
	"processing_upload",
	"processing_children",
	"ready_to_publish",
] as const;

/** O post ainda está em voo (não foi cancelado/finalizado por outro writer)? */
export async function isPostStillInFlight(
	postId: string,
): Promise<boolean> {
	const row = await prisma.post.findUnique({
		where: { id: postId },
		select: { status: true },
	});
	if (!row) return false;
	return (PUBLISHABLE_IN_FLIGHT_STATUSES as readonly string[]).includes(
		row.status ?? "",
	);
}

/**
 * Grava o desfecho de um post SOMENTE se ele ainda estiver em voo (M13).
 * Retorna false quando a escrita foi bloqueada (status virou terminal — ex.:
 * cancelado durante o processamento). Nesse caso nenhum bookkeeping de erro/
 * sucesso deve rodar: o cancelamento foi uma decisão deliberada do usuário.
 */
export async function finalizePostWrite(
	postId: string,
	plannerId: string,
	lane: string,
	data: Prisma.PostUncheckedUpdateInput,
): Promise<boolean> {
	const res = await prisma.post.updateMany({
		where: { id: postId, status: { in: [...PUBLISHABLE_IN_FLIGHT_STATUSES] } },
		data,
	});
	if (res.count === 0) {
		const msg = `[${lane}] Post ${postId}: desfecho bloqueado — o status mudou no meio do processamento (cancelado/finalizado). Nenhuma escrita sobrescreveu o estado terminal.`;
		// Registro diagnóstico no planner log (best-effort; o teste/mock pode
		// não ter plannerLog) + console para o operador.
		if (plannerId && plannerId !== "unknown") {
			await prisma.plannerLog
				?.create({
					data: {
						planner_id: plannerId,
						message: msg,
						level: "warning",
						details: JSON.stringify({ postId, lane }),
					},
				})
				.catch(() => {});
		}
		console.warn(`[RaceGuard] ${msg}`);
		return false;
	}
	return true;
}