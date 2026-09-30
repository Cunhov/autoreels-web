/**
 * lib/ig-automation/limits.ts — anti-bloqueio (spec §6.4).
 *
 * Lê AppConfig com defaults e conta envios reais no DB (`IgActionLog` status
 * "sent") para robustez multi-processo:
 *   ig_automation_enabled            "1"  → ligado
 *   ig_automation_dry_run            "0"  → desligado
 *   ig_cooldown_hours                "24"
 *   ig_daily_limit_per_contact       "0"  → desligado
 *   ig_max_sends_per_minute          "30"
 *   ig_human_takeover_pause_hours    "24"
 *
 * Números/booleanos inválidos caem no default.
 */
import { prisma } from "@/lib/prisma";

export interface IgLimits {
	enabled: boolean;
	dryRun: boolean;
	cooldownHours: number;
	dailyLimitPerContact: number;
	maxSendsPerMinute: number;
	humanTakeoverPauseHours: number;
}

export const IG_LIMIT_DEFAULTS: IgLimits = {
	enabled: true,
	dryRun: false,
	cooldownHours: 24,
	dailyLimitPerContact: 0,
	maxSendsPerMinute: 30,
	humanTakeoverPauseHours: 24,
};

const CONFIG_KEYS = [
	"ig_automation_enabled",
	"ig_automation_dry_run",
	"ig_cooldown_hours",
	"ig_daily_limit_per_contact",
	"ig_max_sends_per_minute",
	"ig_human_takeover_pause_hours",
] as const;

function parseBool(
	value: string | null | undefined,
	fallback: boolean,
): boolean {
	if (value === null || value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "on", "yes", "sim"].includes(normalized)) return true;
	if (["0", "false", "off", "no", "nao", "não"].includes(normalized)) {
		return false;
	}
	return fallback;
}

function parseNonNegativeInt(
	value: string | null | undefined,
	fallback: number,
): number {
	if (value === null || value === undefined) return fallback;
	const trimmed = value.trim();
	if (trimmed === "") return fallback;
	const parsed = Number(trimmed);
	if (!Number.isInteger(parsed) || parsed < 0) return fallback;
	return parsed;
}

function shortError(error: unknown): string {
	if (error instanceof Error) return error.name || "Error";
	return "unknown";
}

/** Lê as flags/limites do AppConfig; erro de DB → defaults (nunca lança). */
export async function getLimits(): Promise<IgLimits> {
	try {
		const rows = await prisma.appConfig.findMany({
			where: { key: { in: [...CONFIG_KEYS] } },
			select: { key: true, value: true },
		});
		const values = new Map<string, string | null>(
			rows.map((row) => [row.key, row.value]),
		);
		return {
			enabled: parseBool(
				values.get("ig_automation_enabled"),
				IG_LIMIT_DEFAULTS.enabled,
			),
			dryRun: parseBool(
				values.get("ig_automation_dry_run"),
				IG_LIMIT_DEFAULTS.dryRun,
			),
			cooldownHours: parseNonNegativeInt(
				values.get("ig_cooldown_hours"),
				IG_LIMIT_DEFAULTS.cooldownHours,
			),
			dailyLimitPerContact: parseNonNegativeInt(
				values.get("ig_daily_limit_per_contact"),
				IG_LIMIT_DEFAULTS.dailyLimitPerContact,
			),
			maxSendsPerMinute: parseNonNegativeInt(
				values.get("ig_max_sends_per_minute"),
				IG_LIMIT_DEFAULTS.maxSendsPerMinute,
			),
			humanTakeoverPauseHours: parseNonNegativeInt(
				values.get("ig_human_takeover_pause_hours"),
				IG_LIMIT_DEFAULTS.humanTakeoverPauseHours,
			),
		};
	} catch (error) {
		console.error("[ig-automation] getLimits falhou:", shortError(error));
		return { ...IG_LIMIT_DEFAULTS };
	}
}

/**
 * Cooldown por (automação, contato): existe envio "sent" na janela (horas)?
 * Ações de baixo impacto (assign_tag/start_sequence) não contam.
 */
export async function isCooldownBlocked(
	automationId: string,
	contactId: string,
	hours: number,
): Promise<boolean> {
	if (!automationId || !contactId) return false;
	if (!Number.isFinite(hours) || hours <= 0) return false;
	const since = new Date(Date.now() - hours * 3_600_000);
	const count = await prisma.igActionLog.count({
		where: {
			automation_id: automationId,
			contact_id: contactId,
			status: "sent",
			action_type: { notIn: ["assign_tag", "start_sequence"] },
			created_at: { gte: since },
		},
	});
	return count > 0;
}

/**
 * Limite diário por (automação, contato). `limit <= 0` = desligado.
 * Janela = desde 00:00 local do servidor.
 */
export async function isDailyLimitReached(
	automationId: string,
	contactId: string,
	limit: number,
): Promise<boolean> {
	if (!automationId || !contactId) return false;
	if (!Number.isFinite(limit) || limit <= 0) return false;
	const startOfDay = new Date();
	startOfDay.setHours(0, 0, 0, 0);
	const count = await prisma.igActionLog.count({
		where: {
			automation_id: automationId,
			contact_id: contactId,
			status: "sent",
			created_at: { gte: startOfDay },
		},
	});
	return count >= limit;
}

/**
 * Rate limit do canal: envios "sent" nos últimos 60s >= maxPerMinute.
 * `maxPerMinute <= 0` = desligado.
 */
export async function isRateLimited(
	channelId: string,
	maxPerMinute: number,
): Promise<boolean> {
	if (!channelId) return false;
	if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) return false;
	const since = new Date(Date.now() - 60_000);
	const count = await prisma.igActionLog.count({
		where: {
			channel_id: channelId,
			status: "sent",
			created_at: { gte: since },
		},
	});
	return count >= maxPerMinute;
}

/* Aliases com os nomes da spec §6.4 (compatibilidade com o engine). */
export const checkCooldown = isCooldownBlocked;
export const checkDailyLimit = isDailyLimitReached;
export const checkRateLimit = isRateLimited;
