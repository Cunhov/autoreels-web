/**
 * lib/ig-automation/types.ts — tipos do módulo IG Automation.
 *
 * Contrato congelado em docs/IG_AUTOMATION_SPEC.md §4. Este arquivo é
 * client-safe: NÃO importa Prisma, prisma client nem nada server-only, para
 * poder ser usado em componentes/editor sem arrastar dependências de servidor.
 *
 * Os tipos `IgAutomationRow`/`IgAutomationActionRow` são espelhos estruturais
 * mínimos das colunas do Prisma (campos JSON como `string | null`), para que
 * módulos puros (render/normalize/matcher) não dependam do Prisma Client.
 */

export type IgTrigger =
	| "comment"
	| "dm"
	| "story_reply"
	| "story_mention"
	| "postback";

export type IgMatchType = "contains" | "exact" | "starts_with" | "regex";

export type IgMatchMode = "any" | "all";

export type IgActionType =
	| "public_comment_reply"
	| "private_reply"
	| "dm_text"
	| "dm_buttons"
	| "dm_quick_replies"
	| "dm_media"
	| "ai_reply"
	| "assign_tag"
	| "start_sequence"
	| "outbound_webhook";

export interface IgButton {
	type: "web_url" | "postback";
	title: string;
	url?: string;
	payload?: string;
	track?: boolean;
}

export interface IgQuickReply {
	title: string;
	payload: string;
}

/** "23:00"/"07:00" no fuso `tz` (default America/Bahia no engine). */
export interface IgQuietHours {
	start: string;
	end: string;
	tz: string;
}

export interface IgInboundEvent {
	channelIgId: string; // entry[].id (ID IG da conta profissional)
	kind: IgTrigger;
	dedupeKey: string; // comment:<id> | message:<mid> | postback:<mid> | reaction:<mid> | story:<mid>
	igEventId: string; // id do comentário / mid da mensagem
	fromIgId?: string;
	fromUsername?: string;
	text?: string;
	mediaId?: string;
	postbackPayload?: string;
	isEcho?: boolean; // message.is_echo
	raw: unknown; // payload cru do evento
}

export interface IgGateResult {
	gate: string;
	passed: boolean;
	reason?: string;
}

export interface IgMatchedAction {
	actionId: string;
	type: IgActionType;
	position: number;
	runAtOffsetMs: number; // delay acumulado (delay_seconds + jitter p/ público)
	renderedText?: string; // já com variants/placeholders resolvidos (quando aplicável)
	buttons?: IgButton[];
	quickReplies?: IgQuickReply[];
	target: "comment" | "dm" | "contact" | "sequence" | "webhook";
}

export interface IgSimulationResult {
	matched: { automationId: string; name: string } | null;
	actions: IgMatchedAction[];
	gates: IgGateResult[];
	contact: { igUserId?: string; username?: string; firstInteraction: boolean };
}

/* -------------------------------------------------------------------------- */
/* Tipos auxiliares estáveis (não fazem parte do contrato congelado, mas o     */
/* swarm pode usá-los sem depender do Prisma Client).                          */
/* -------------------------------------------------------------------------- */

export type IgEventKind = IgTrigger | "reaction" | "echo" | "system";

export type IgEventStatus =
	| "received"
	| "matched"
	| "sent"
	| "failed"
	| "skipped"
	| "paused"
	| "duplicate";

export type IgActionStatus = "pending" | "sent" | "failed" | "skipped";

export type IgDirection = "in" | "out";

/** Espelho estrutural mínimo da row `ig_automations` (schema.prisma). */
export interface IgAutomationRow {
	id: string;
	user_id: string;
	channel_id: string;
	name: string;
	enabled: boolean;
	priority: number;
	trigger: string; // IgTrigger serializado
	keywords: string; // JSON string[]
	match_mode: string; // IgMatchMode
	match_type: string; // IgMatchType
	negative_keywords: string | null; // JSON string[]
	media_ids: string | null; // JSON string[]
	first_interaction_only: boolean;
	cooldown_hours: number | null;
	daily_limit: number | null;
	quiet_hours: string | null; // JSON IgQuietHours
	settings: string | null; // JSON livre
	stats_sent: number;
	stats_matched: number;
	stats_failed: number;
	stats_clicks: number;
	last_run_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

/** Espelho estrutural mínimo da row `ig_automation_actions` (schema.prisma). */
export interface IgAutomationActionRow {
	id: string;
	automation_id: string;
	position: number;
	type: string; // IgActionType serializado
	delay_seconds: number;
	text_variants: string | null; // JSON string[]
	buttons: string | null; // JSON IgButton[]
	quick_replies: string | null; // JSON IgQuickReply[]
	media_url: string | null;
	tag: string | null;
	sequence_id: string | null;
	webhook_id: string | null;
	ai_prompt: string | null;
	config: string | null; // JSON extra (ex.: {"trackClicks":true,"lastVariant":"..."})
	created_at: Date;
}

/**
 * Variáveis de template aceitas por `applyTemplate`.
 * Também aceita chaves pontuadas ("substancia.nome") ou objetos aninhados.
 */
export type IgRenderVars = Record<string, string | undefined>;

/** Estrutura tolerada do JSON em `IgAutomationAction.config`. */
export interface IgActionConfig {
	trackClicks?: boolean;
	lastVariant?: string;
	[key: string]: unknown;
}

export interface IgRenderOptions {
	createClickLink?: (
		targetUrl: string,
		action: IgAutomationActionRow,
	) => Promise<string> | string;
	trackClicks?: boolean;
}

export interface IgRenderedAction {
	text?: string;
	buttons?: IgButton[];
	quickReplies?: IgQuickReply[];
}

/** Entrada de `matchSubstance` — aceita a row do Prisma estruturalmente. */
export interface IgSubstanceInput {
	id: string;
	keyword: string;
	name: string;
	keywords?: string | string[] | null; // JSON string[] (sinônimos) ou lista
	description?: string | null;
	action?: string | null;
	dosage?: string | null;
	duration?: string | null;
	url?: string | null;
}

/** Campos em PT-BR injetados como `vars.substancia` no template. */
export interface IgSubstanceTemplateVars {
	nome: string;
	url: string;
	descricao: string;
	acao: string;
	dosagem: string;
	duracao: string;
}

/** Item do catálogo vencedor + campos PT para template (primeiro vence). */
export type IgSubstanceMatch = IgSubstanceInput & IgSubstanceTemplateVars;

/** Delta aceito por `bumpStats` (log.ts). */
export interface IgStatsDelta {
	matched?: number;
	sent?: number;
	failed?: number;
	clicks?: number;
}
