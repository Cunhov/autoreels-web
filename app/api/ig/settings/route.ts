import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getLimits, IG_LIMIT_DEFAULTS } from "@/lib/ig-automation/limits";
import {
	badRequest,
	readJsonBody,
	requireUserId,
	unauthorized,
} from "../shared";

export const dynamic = "force-dynamic";

const VERIFY_TOKEN_KEY = "meta_webhook_verify_token";
const WEBHOOK_PATH = "/api/webhooks/instagram";

function envToken(): string {
	return (process.env.META_WEBHOOK_VERIFY_TOKEN || "").trim();
}

function webhookUrl(): string {
	const base = (process.env.PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || "")
		.trim()
		.replace(/\/+$/, "");
	return `${base}${WEBHOOK_PATH}`;
}

/**
 * Garante um verify token persistido (AppConfig). Se `META_WEBHOOK_VERIFY_TOKEN`
 * estiver setado, ele é o efetivo (envOverride) e não é sobrescrito.
 */
async function resolveVerifyToken(): Promise<string> {
	const fromEnv = envToken();
	if (fromEnv) return fromEnv;
	const row = await prisma.appConfig.findUnique({
		where: { key: VERIFY_TOKEN_KEY },
		select: { value: true },
	});
	const stored = (row?.value ?? "").trim();
	if (stored) return stored;
	const generated = randomBytes(32).toString("hex");
	await prisma.appConfig.upsert({
		where: { key: VERIFY_TOKEN_KEY },
		create: { key: VERIFY_TOKEN_KEY, value: generated },
		update: { value: generated },
	});
	return generated;
}

async function putConfig(key: string, value: string): Promise<void> {
	await prisma.appConfig.upsert({
		where: { key },
		create: { key, value },
		update: { value },
	});
}

/**
 * GET /api/ig/settings — URL do webhook, verify token efetivo, flags do
 * ambiente, limites atuais e configuração detectada. Nunca devolve segredos
 * (apenas booleanos de "configurado").
 */
export async function GET() {
	const userId = await requireUserId();
	if (!userId) return unauthorized();

	try {
		const [verifyToken, limits] = await Promise.all([
			resolveVerifyToken(),
			getLimits(),
		]);
		return NextResponse.json({
			webhookUrl: webhookUrl(),
			verifyToken,
			envOverride: envToken() !== "",
			limits,
			enabled: limits.enabled,
			dryRun: limits.dryRun,
			configured: {
				instagramSecret: !!process.env.INSTAGRAM_CLIENT_SECRET,
				openrouter: !!process.env.OPENROUTER_API_KEY,
			},
		});
	} catch (error: unknown) {
		console.error("Get ig settings error:", error);
		return NextResponse.json(
			{ error: getErrorMessage(error) },
			{ status: 500 },
		);
	}
}

interface NumericFieldSpec {
	configKey: string;
	names: string[];
	label: string;
	min: number;
	max: number;
	defaultValue: number;
}

const NUMERIC_FIELDS: NumericFieldSpec[] = [
	{
		configKey: "ig_cooldown_hours",
		names: ["cooldownHours", "cooldown_hours", "ig_cooldown_hours"],
		label: "Cooldown por contato (horas)",
		min: 0,
		max: 8760,
		defaultValue: IG_LIMIT_DEFAULTS.cooldownHours,
	},
	{
		configKey: "ig_daily_limit_per_contact",
		names: [
			"dailyLimitPerContact",
			"daily_limit_per_contact",
			"ig_daily_limit_per_contact",
		],
		label: "Limite diário por contato",
		min: 0,
		max: 10000,
		defaultValue: IG_LIMIT_DEFAULTS.dailyLimitPerContact,
	},
	{
		configKey: "ig_max_sends_per_minute",
		names: [
			"maxSendsPerMinute",
			"max_sends_per_minute",
			"ig_max_sends_per_minute",
		],
		label: "Envios por minuto",
		min: 0,
		max: 6000,
		defaultValue: IG_LIMIT_DEFAULTS.maxSendsPerMinute,
	},
	{
		configKey: "ig_human_takeover_pause_hours",
		names: [
			"humanTakeoverPauseHours",
			"human_takeover_pause_hours",
			"ig_human_takeover_pause_hours",
		],
		label: "Pausa por takeover humano (horas)",
		min: 0,
		max: 8760,
		defaultValue: IG_LIMIT_DEFAULTS.humanTakeoverPauseHours,
	},
];

const BOOLEAN_FIELDS: Array<{
	configKey: string;
	names: string[];
	label: string;
}> = [
	{
		configKey: "ig_automation_enabled",
		names: ["enabled", "ig_automation_enabled"],
		label: "Automações habilitadas",
	},
	{
		configKey: "ig_automation_dry_run",
		names: ["dryRun", "dry_run", "ig_automation_dry_run"],
		label: "Dry-run",
	},
];

function readField(
	body: Record<string, unknown>,
	names: string[],
): { found: boolean; value: unknown } {
	for (const name of names) {
		if (Object.prototype.hasOwnProperty.call(body, name)) {
			return { found: true, value: body[name] };
		}
	}
	return { found: false, value: undefined };
}

function parseBooleanInput(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "on", "yes", "sim"].includes(normalized)) return true;
		if (["0", "false", "off", "no", "nao", "não"].includes(normalized)) {
			return false;
		}
	}
	return null;
}

/**
 * PUT /api/ig/settings — atualiza limites/flags (aceita camelCase e as chaves
 * do AppConfig). `null`/vazio reseta para o default. Retorna os limites novos.
 */
export async function PUT(req: Request) {
	const userId = await requireUserId();
	if (!userId) return unauthorized();

	try {
		const raw = await readJsonBody(req);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			return badRequest("Corpo JSON inválido.");
		}
		const body = raw as Record<string, unknown>;

		const updates: Array<{ key: string; value: string }> = [];

		for (const spec of NUMERIC_FIELDS) {
			const { found, value } = readField(body, spec.names);
			if (!found) continue;
			if (value === null || value === undefined || value === "") {
				updates.push({
					key: spec.configKey,
					value: String(spec.defaultValue),
				});
				continue;
			}
			const parsed = typeof value === "string" ? Number(value) : value;
			if (
				typeof parsed !== "number" ||
				!Number.isInteger(parsed) ||
				parsed < spec.min ||
				parsed > spec.max
			) {
				return badRequest(
					`${spec.label} deve ser um inteiro entre ${spec.min} e ${spec.max}.`,
				);
			}
			updates.push({ key: spec.configKey, value: String(parsed) });
		}

		for (const spec of BOOLEAN_FIELDS) {
			const { found, value } = readField(body, spec.names);
			if (!found) continue;
			const parsed = parseBooleanInput(value);
			if (parsed === null) {
				return badRequest(`${spec.label} deve ser verdadeiro ou falso.`);
			}
			updates.push({ key: spec.configKey, value: parsed ? "1" : "0" });
		}

		if (updates.length === 0) {
			return badRequest("Nenhum campo válido para atualizar.");
		}

		for (const update of updates) {
			await putConfig(update.key, update.value);
		}

		const limits = await getLimits();
		return NextResponse.json({
			ok: true,
			limits,
			enabled: limits.enabled,
			dryRun: limits.dryRun,
		});
	} catch (error: unknown) {
		console.error("Put ig settings error:", error);
		return NextResponse.json(
			{ error: getErrorMessage(error) },
			{ status: 400 },
		);
	}
}

/**
 * POST /api/ig/settings — `{action: "regenerate-token" | "toggle-enabled" |
 * "toggle-dry-run"}`. Retorna o estado (nunca segredos).
 */
export async function POST(req: Request) {
	const userId = await requireUserId();
	if (!userId) return unauthorized();

	try {
		const raw = await readJsonBody(req);
		const action =
			raw !== null && typeof raw === "object" && !Array.isArray(raw)
				? (raw as { action?: unknown }).action
				: null;
		if (typeof action !== "string" || !action.trim()) {
			return badRequest("Ação é obrigatória.");
		}

		if (action === "regenerate-token") {
			if (envToken() !== "") {
				return badRequest(
					"META_WEBHOOK_VERIFY_TOKEN está definido no ambiente — remova a variável para gerenciar o token pela interface.",
				);
			}
			const verifyToken = randomBytes(32).toString("hex");
			await putConfig(VERIFY_TOKEN_KEY, verifyToken);
			return NextResponse.json({
				ok: true,
				verifyToken,
				envOverride: false,
			});
		}

		if (action === "toggle-enabled" || action === "toggle-dry-run") {
			const current = await getLimits();
			const next =
				action === "toggle-enabled" ? !current.enabled : !current.dryRun;
			await putConfig(
				action === "toggle-enabled"
					? "ig_automation_enabled"
					: "ig_automation_dry_run",
				next ? "1" : "0",
			);
			return NextResponse.json({
				ok: true,
				enabled: action === "toggle-enabled" ? next : current.enabled,
				dryRun: action === "toggle-dry-run" ? next : current.dryRun,
			});
		}

		return badRequest("Ação inválida.");
	} catch (error: unknown) {
		console.error("Post ig settings error:", error);
		return NextResponse.json(
			{ error: getErrorMessage(error) },
			{ status: 400 },
		);
	}
}
