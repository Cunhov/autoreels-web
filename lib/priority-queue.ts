import type { PrismaClient } from "@prisma/client";

/**
 * Fila de prioridade do Instagram.
 *
 * O worker cria um Post "avulso" (planner_id = null) para o vídeo novo e
 * registra a linha em `ig_priority_queue`. O publisher publica esse Post antes
 * do loop (a fila de pendentes ordena planner_id NULL primeiro). Depois que o
 * Post é publicado, este módulo appenda o ContentItem ao(s) planner(s)
 * configurado(s) — no FIM da lista, para não deslocar `published_indexes`.
 *
 * É o mesmo template de legenda usado pelo uploader.py da automação:
 * `{post_caption}` resolve a legenda do item e o restante é o CTA fixo.
 */
export const LOOP_CAPTION =
	" {post_caption}\n\nManipule todas as substâncias na farmácia de manipulação @farmaciajoaofalcao com cupom CUNHA pra receber até 10% desconto (Pode pedir pelo link da bio também).";

type PlannerConfigLike = {
	content?: unknown;
	[key: string]: unknown;
};

function parsePlannerIds(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string" && !!id)
			: [];
	} catch {
		return [];
	}
}

/**
 * Appenda um ContentItem ao planner se ele ainda não estiver lá.
 * Retorna true quando adicionou.
 */
export async function appendItemToPlanner(
	prisma: PrismaClient,
	plannerId: string,
	itemId: string,
): Promise<boolean> {
	return prisma.$transaction(async (tx) => {
		const planner = await tx.planner.findUnique({
			where: { id: plannerId },
			select: { id: true, config: true },
		});
		if (!planner?.config) return false;

		let config: PlannerConfigLike;
		try {
			config = JSON.parse(planner.config) as PlannerConfigLike;
		} catch {
			return false;
		}

		const content = Array.isArray(config.content)
			? (config.content as Array<Record<string, unknown>>)
			: [];
		const already = content.some((entry) => entry && entry.id === itemId);
		if (already) return false;

		content.push({
			type: "library_item",
			id: itemId,
			media_type: "REELS",
			share_to_feed: true,
			caption: LOOP_CAPTION,
			caption_fallback: "",
			title_fallback: "",
			location_id: "",
			collaborators: null,
			user_tags: null,
			audio_configuration: null,
		});
		config.content = content;

		await tx.planner.update({
			where: { id: plannerId },
			data: { config: JSON.stringify(config) },
		});
		return true;
	});
}

/**
 * Processa linhas da fila prioritária cujo Post já foi publicado (ou falhou).
 * Chamado no fim do cron do publisher; é idempotente.
 */
export async function processPublishedPriorityQueue(
	prisma: PrismaClient,
): Promise<{ checked: number; appended: number; failed: number }> {
	const rows = await prisma.igPriorityQueue.findMany({
		where: { loop_added: false },
		orderBy: { created_at: "asc" },
		take: 100,
		select: {
			id: true,
			post_id: true,
			content_item_id: true,
			planner_ids: true,
		},
	});

	let appended = 0;
	let failed = 0;

	for (const row of rows) {
		if (!row.post_id) {
			await prisma.igPriorityQueue.update({
				where: { id: row.id },
				data: { loop_added: true, status: "failed" },
			});
			failed += 1;
			continue;
		}

		const post = await prisma.post.findUnique({
			where: { id: row.post_id },
			select: { status: true },
		});

		if (!post) {
			await prisma.igPriorityQueue.update({
				where: { id: row.id },
				data: { loop_added: true, status: "failed" },
			});
			failed += 1;
			continue;
		}

		if (post.status === "failed") {
			await prisma.igPriorityQueue.update({
				where: { id: row.id },
				data: { loop_added: true, status: "failed" },
			});
			failed += 1;
			continue;
		}

		if (post.status !== "published") continue;

		let addedAny = false;
		for (const plannerId of parsePlannerIds(row.planner_ids)) {
			const added = await appendItemToPlanner(
				prisma,
				plannerId,
				row.content_item_id,
			);
			if (added) {
				addedAny = true;
				appended += 1;
			}
		}

		await prisma.igPriorityQueue.update({
			where: { id: row.id },
			data: {
				loop_added: true,
				status: "posted",
				posted_at: new Date(),
			},
		});
		// `addedAny` é só telemetria; a linha é marcada mesmo quando o item já
		// estava no planner (idempotência de retry).
		void addedAny;
	}

	return { checked: rows.length, appended, failed };
}
