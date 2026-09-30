/**
 * lib/ig-automation/sequences.ts — sequências/follow-ups com delay (spec §9).
 *
 * - `executeSequenceStep`: executa o passo atual do enrollment via
 *   `executeAction` (onda 1), usando uma ação/automação sintéticas — nenhuma
 *   linha real de `IgAutomation` é criada/alterada (os logs via
 *   `logAction`/`bumpStats` para o id sintético são best-effort e podem ser
 *   ignorados pela FK, sem quebrar a execução).
 * - `processDueSequences`: enrollments `active` com `next_run_at <= now`;
 *   em erro reagenda +15min (não trava a fila) e loga `IgActionLog` failed.
 * - `enrollContact` / `cancelEnrollment`: gestão idempotente do enrollment.
 */
import type { IgSequence, IgSequenceEnrollment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
	executeAction,
	type ExecuteActionChannel,
	type ExecuteActionContact,
} from "@/lib/ig-automation/actions";
import { getLimits } from "@/lib/ig-automation/limits";
import { logAction } from "@/lib/ig-automation/log";
import { dispatchOutbound } from "@/lib/ig-automation/outbound";
import type {
	IgAutomationActionRow,
	IgAutomationRow,
	IgRenderVars,
} from "@/lib/ig-automation/types";

export interface SequenceStepResult {
	ok: boolean;
	done: boolean;
	/** true quando o passo foi pulado (claim perdido/expirado para outro tick). */
	skipped?: boolean;
	error?: string;
}

export interface ProcessSequencesSummary {
	processed: number;
	failed: number;
}

export interface EnrollContactResult {
	enrollmentId: string;
	restarted: boolean;
}

const RETRY_DELAY_MS = 15 * 60_000;
/**
 * FIX-M5: teto de tentativas por passo antes de cancelar o enrollment
 * (evita retry infinito). Após 3 erros o enrollment vira `cancelled`
 * com `next_run_at=null` e o motivo fica no log `sequence_step` failed.
 */
const MAX_ENROLLMENT_ATTEMPTS = 3;

/* -------------------------------------------------------------------------- */
/* Parsing defensivo dos passos                                                */
/* -------------------------------------------------------------------------- */

interface SequenceStepRecord {
	delaySeconds: number;
	type: string;
	textVariants: unknown;
	buttons: unknown;
	quickReplies: unknown;
	mediaUrl: string | null;
	aiPrompt: string | null;
	config: unknown;
}

function shortError(error: unknown): string {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code !== "") return code;
	}
	if (error instanceof Error && error.name) return error.name;
	return "Error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toDelaySeconds(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return Math.trunc(parsed);
}

function toNullableString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Aceita snake_case (formato canônico do DB) e camelCase (defensivo). */
function parseSteps(raw: string | null | undefined): SequenceStepRecord[] {
	if (typeof raw !== "string" || raw.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const steps: SequenceStepRecord[] = [];
	for (const item of parsed) {
		if (!isRecord(item)) continue;
		steps.push({
			delaySeconds: toDelaySeconds(item.delay_seconds ?? item.delaySeconds),
			type: typeof item.type === "string" ? item.type : "",
			textVariants: item.text_variants ?? item.textVariants ?? null,
			buttons: item.buttons ?? null,
			quickReplies: item.quick_replies ?? item.quickReplies ?? null,
			mediaUrl: toNullableString(item.media_url ?? item.mediaUrl),
			aiPrompt: toNullableString(item.ai_prompt ?? item.aiPrompt),
			config: item.config ?? null,
		});
	}
	return steps;
}

/** Campo JSON de coluna: string já serializada passa direto. */
function jsonOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value === "" ? null : value;
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
}

/**
 * Linha sintética de `IgAutomationAction` para o passo — o executor da onda 1
 * só depende da estrutura, não do FK.
 */
function stepToActionRow(
	step: SequenceStepRecord,
	index: number,
	sequenceId: string,
	createdAt: Date,
): IgAutomationActionRow {
	return {
		id: `seq:${sequenceId}:${index}`,
		automation_id: `seq:${sequenceId}`,
		position: index,
		type: step.type,
		delay_seconds: 0,
		text_variants: jsonOrNull(step.textVariants),
		buttons: jsonOrNull(step.buttons),
		quick_replies: jsonOrNull(step.quickReplies),
		media_url: step.mediaUrl,
		tag: null,
		sequence_id: null,
		webhook_id: null,
		ai_prompt: step.aiPrompt,
		config: jsonOrNull(step.config),
		created_at: createdAt,
	};
}

/** Automação sintética (`bumpStats` para o id `seq:` é no-op silencioso). */
function syntheticAutomation(sequence: {
	id: string;
	user_id: string;
	channel_id: string;
	name: string;
	created_at: Date;
	updated_at: Date;
}): IgAutomationRow {
	return {
		id: `seq:${sequence.id}`,
		user_id: sequence.user_id,
		channel_id: sequence.channel_id,
		name: sequence.name,
		enabled: true,
		priority: 0,
		trigger: "dm",
		keywords: "[]",
		match_mode: "any",
		match_type: "contains",
		negative_keywords: null,
		media_ids: null,
		first_interaction_only: false,
		cooldown_hours: null,
		daily_limit: null,
		quiet_hours: null,
		settings: null,
		stats_sent: 0,
		stats_matched: 0,
		stats_failed: 0,
		stats_clicks: 0,
		last_run_at: null,
		created_at: sequence.created_at,
		updated_at: sequence.updated_at,
	};
}

function firstNameOf(contact: {
	name?: string | null;
	username?: string | null;
}): string {
	const source = (contact.name ?? "").trim() || (contact.username ?? "").trim();
	if (!source) return "";
	return source.split(/\s+/)[0] ?? "";
}

/* -------------------------------------------------------------------------- */
/* Execução de um passo                                                        */
/* -------------------------------------------------------------------------- */

async function markEnrollmentDone(enrollmentId: string): Promise<void> {
	await prisma.igSequenceEnrollment.updateMany({
		where: { id: enrollmentId },
		data: { status: "done", next_run_at: null, attempts: 0 },
	});
}

/**
 * Executa o passo `current_step` do enrollment. Não lança: devolve
 * `{ok, done, skipped, error}` para o chamador decidir reagendamento.
 *
 * `expectedStep` (opcional): passo reivindicado atomicamente por
 * `processDueSequences`; se o enrollment já avançou (claim expirado/outro
 * tick), o passo é pulado sem executar.
 */
export async function executeSequenceStep(
	enrollmentId: string,
	expectedStep?: number,
): Promise<SequenceStepResult> {
	if (!enrollmentId) {
		return { ok: false, done: false, error: "Inscrição de sequência inválida." };
	}

	let enrollment:
		| (IgSequenceEnrollment & { sequence: IgSequence })
		| null;
	try {
		enrollment = await prisma.igSequenceEnrollment.findUnique({
			where: { id: enrollmentId },
			include: { sequence: true },
		});
	} catch (error) {
		return { ok: false, done: false, error: `DB: ${shortError(error)}` };
	}
	if (!enrollment) {
		return { ok: false, done: false, error: "Inscrição de sequência não encontrada." };
	}
	if (enrollment.status !== "active") return { ok: true, done: true };

	const sequence = enrollment.sequence;
	if (!sequence || !sequence.enabled) {
		await markEnrollmentDone(enrollment.id);
		return { ok: true, done: true };
	}

	const steps = parseSteps(sequence.steps);
	const current =
		Number.isInteger(enrollment.current_step) && enrollment.current_step > 0
			? enrollment.current_step
			: 0;
	if (typeof expectedStep === "number" && expectedStep !== current) {
		// Outro tick/claim já avançou este enrollment — não re-executa o passo.
		return { ok: true, done: false, skipped: true };
	}
	if (steps.length === 0 || current >= steps.length) {
		await markEnrollmentDone(enrollment.id);
		return { ok: true, done: true };
	}

	const step = steps[current];

	const [channel, contact] = await Promise.all([
		prisma.channel.findUnique({
			where: { id: enrollment.channel_id },
			select: {
				id: true,
				user_id: true,
				account_id: true,
				username: true,
				access_token: true,
				proxy_url: true,
				proxy_enabled: true,
			},
		}),
		prisma.igContact.findUnique({
			where: { id: enrollment.contact_id },
			select: { id: true, ig_user_id: true, username: true, name: true },
		}),
	]);
	if (!channel) {
		return { ok: false, done: false, error: "Canal da sequência não existe mais." };
	}
	if (!contact) {
		return { ok: false, done: false, error: "Contato da sequência não existe mais." };
	}

	const vars: IgRenderVars = {
		username: contact.username ?? "",
		first_name: firstNameOf(contact),
	};

	const limits = await getLimits();
	const result = await executeAction({
		action: stepToActionRow(step, current, sequence.id, sequence.created_at),
		automation: syntheticAutomation(sequence),
		channel: channel as ExecuteActionChannel,
		contact: contact as ExecuteActionContact,
		event: {
			igEventId: "",
			kind: "dm",
			dedupeKey: `sequence:${enrollment.id}:${current}`,
			mediaId: null,
		},
		vars,
		limits,
		// Sem `IgAutomation` real: log com channel+contact (conta no rate limit),
		// sem FK sintética e sem bumpStats.
		automationIdOverride: null,
	});
	if (!result.ok) {
		return {
			ok: false,
			done: false,
			error: result.error || result.reason || "Falha ao executar o passo da sequência.",
		};
	}

	// FIX-A2: passo entregue com sucesso → webhook de saída `sequence.step`
	// (fire-and-forget, nunca bloqueia/derruba a sequência).
	if (result.skipped !== true) {
		try {
			void dispatchOutbound({
				userId: sequence.user_id,
				channelId: enrollment.channel_id,
				event: "sequence.step",
				automationId: null,
				contact: {
					igUserId: contact.ig_user_id,
					username: contact.username,
				},
				text: null,
			}).catch(() => {});
		} catch {
			/* webhooks de saída são best-effort */
		}
	}

	const isLast = current >= steps.length - 1;
	if (isLast) {
		await markEnrollmentDone(enrollment.id);
		return { ok: true, done: true };
	}

	const nextDelay = steps[current + 1]?.delaySeconds ?? 0;
	// Avanço condicional: só avança se o enrollment ainda está no passo
	// executado e ativo (count 0 = cancelado/avançado por outro tick).
	// `attempts` zera ao entregar o passo (FIX-M5).
	await prisma.igSequenceEnrollment.updateMany({
		where: { id: enrollment.id, status: "active", current_step: current },
		data: {
			current_step: current + 1,
			next_run_at: new Date(Date.now() + nextDelay * 1000),
			attempts: 0,
		},
	});
	return { ok: true, done: false };
}

/**
 * Processa enrollments vencidos. Claim atômico por enrollment
 * (`status=active` + `current_step` lido + `next_run_at<=now` → `next_run_at=null`):
 * dois ticks nunca executam o mesmo passo. Erro não trava a fila: reagenda
 * +15min e registra `IgActionLog` failed (type `sequence_step`).
 */
export async function processDueSequences(
	limit = 25,
): Promise<ProcessSequencesSummary> {
	const now = new Date();

	// Recovery: crash entre claim (next_run_at=null) e update de avanço.
	// Reagenda para agora depois de 5min sem toque.
	try {
		await prisma.igSequenceEnrollment.updateMany({
			where: {
				status: "active",
				next_run_at: null,
				updated_at: { lt: new Date(now.getTime() - 5 * 60_000) },
			},
			data: { next_run_at: now },
		});
	} catch (error) {
		console.error(
			"[ig-automation] recuperação de sequências travadas falhou:",
			shortError(error),
		);
	}

	const enrollments = await prisma.igSequenceEnrollment.findMany({
		where: { status: "active", next_run_at: { lte: now } },
		orderBy: { next_run_at: "asc" },
		take: limit,
		select: {
			id: true,
			channel_id: true,
			contact_id: true,
			current_step: true,
			attempts: true,
			sequence: { select: { user_id: true } },
		},
	});

	let processed = 0;
	let failed = 0;

	for (const enrollment of enrollments) {
		// Claim atômico: só executa quem zerar o next_run_at do passo lido.
		const claimed = await prisma.igSequenceEnrollment.updateMany({
			where: {
				id: enrollment.id,
				status: "active",
				current_step: enrollment.current_step,
				next_run_at: { lte: now },
			},
			data: { next_run_at: null },
		});
		if (claimed.count === 0) continue; // outro tick pegou

		let error: string | null = null;
		try {
			const result = await executeSequenceStep(
				enrollment.id,
				enrollment.current_step,
			);
			if (result.ok) {
				if (result.skipped !== true) processed++;
				continue;
			}
			error = result.error || "Falha ao executar o passo da sequência.";
		} catch (err) {
			error = `Erro inesperado: ${shortError(err)}`;
		}

		failed++;
		// FIX-M5: incrementa `attempts` a cada erro; após
		// MAX_ENROLLMENT_ATTEMPTS o enrollment é cancelado (sem retry infinito).
		const attempts = (enrollment.attempts ?? 0) + 1;
		const exhausted = attempts >= MAX_ENROLLMENT_ATTEMPTS;
		const finalError = exhausted
			? `${error} (${MAX_ENROLLMENT_ATTEMPTS} tentativas — inscrição cancelada)`
			: error;
		try {
			await prisma.igSequenceEnrollment.updateMany({
				where: { id: enrollment.id, status: "active" },
				data: exhausted
					? { status: "cancelled", next_run_at: null, attempts }
					: {
							next_run_at: new Date(Date.now() + RETRY_DELAY_MS),
							attempts,
						},
			});
		} catch (updateError) {
			console.error(
				"[ig-automation] reagendamento de sequência falhou:",
				shortError(updateError),
			);
		}
		await logAction({
			userId: enrollment.sequence?.user_id ?? "",
			channelId: enrollment.channel_id,
			contactId: enrollment.contact_id,
			actionType: "sequence_step",
			status: "failed",
			error: finalError,
		});
	}

	return { processed, failed };
}

/* -------------------------------------------------------------------------- */
/* Enroll / cancel                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Cancela o enrollment ativo (unique sequence+contact). Devolve true se havia
 * algo ativo para cancelar.
 */
export async function cancelEnrollment(
	sequenceId: string,
	contactId: string,
): Promise<boolean> {
	if (!sequenceId || !contactId) return false;
	const result = await prisma.igSequenceEnrollment.updateMany({
		where: {
			sequence_id: sequenceId,
			contact_id: contactId,
			status: "active",
		},
		data: { status: "cancelled", next_run_at: null },
	});
	return result.count > 0;
}

/**
 * Upsert do enrollment. Se já existir ativo, mantém o progresso; se estiver
 * `done`/`cancelled`, reinicia (re-enroll explícito). Devolve null quando
 * sequência ou contato não existem.
 */
export async function enrollContact(
	sequenceId: string,
	contactId: string,
): Promise<EnrollContactResult | null> {
	if (!sequenceId || !contactId) return null;

	const [sequence, contact, existing] = await Promise.all([
		prisma.igSequence.findUnique({
			where: { id: sequenceId },
			select: { id: true, channel_id: true },
		}),
		prisma.igContact.findUnique({
			where: { id: contactId },
			select: { id: true },
		}),
		prisma.igSequenceEnrollment.findUnique({
			where: {
				sequence_id_contact_id: { sequence_id: sequenceId, contact_id: contactId },
			},
			select: { id: true, status: true },
		}),
	]);
	if (!sequence || !contact) return null;

	if (existing && existing.status === "active") {
		return { enrollmentId: existing.id, restarted: false };
	}

	const now = new Date();
	if (existing) {
		const updated = await prisma.igSequenceEnrollment.update({
			where: { id: existing.id },
			data: {
				status: "active",
				current_step: 0,
				next_run_at: now,
				started_at: now,
				attempts: 0,
			},
			select: { id: true },
		});
		return { enrollmentId: updated.id, restarted: true };
	}

	try {
		const created = await prisma.igSequenceEnrollment.create({
			data: {
				sequence_id: sequence.id,
				contact_id: contact.id,
				channel_id: sequence.channel_id,
				status: "active",
				current_step: 0,
				next_run_at: now,
			},
			select: { id: true },
		});
		return { enrollmentId: created.id, restarted: false };
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			(error as { code?: unknown }).code === "P2002"
		) {
			const raced = await prisma.igSequenceEnrollment.findUnique({
				where: {
					sequence_id_contact_id: {
						sequence_id: sequence.id,
						contact_id: contact.id,
					},
				},
				select: { id: true },
			});
			if (raced) return { enrollmentId: raced.id, restarted: false };
		}
		throw error;
	}
}
