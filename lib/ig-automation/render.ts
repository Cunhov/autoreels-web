/**
 * lib/ig-automation/render.ts — renderização pura de uma ação (texto com
 * variants/placeholders, botões, quick replies e wrapping de clique).
 * Módulo PURO (client-safe, sem DB/rede; `createClickLink` é injetado).
 *
 * Contrato (spec §6.3): parse 100% defensivo dos JSONs (nunca lança por JSON
 * inválido); variants via pickVariant (respeitando `config.lastVariant`);
 * `createClickLink` substitui a URL de botões web_url quando o tracking está
 * ligado (opts.trackClicks !== false && config.trackClicks !== false &&
 * botão.track !== false).
 */
import { pickVariant } from "@/lib/ig-automation/matcher";
import { applyTemplate } from "@/lib/ig-automation/normalize";
import type {
	IgAutomationActionRow,
	IgButton,
	IgQuickReply,
	IgRenderOptions,
	IgRenderedAction,
	IgRenderVars,
} from "@/lib/ig-automation/types";

function parseJson(raw: string | null | undefined): unknown {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

function parseStringArray(raw: string | null | undefined): string[] {
	const parsed = parseJson(raw);
	if (Array.isArray(parsed)) {
		return parsed.filter((item): item is string => typeof item === "string");
	}
	if (typeof parsed === "string") return [parsed];
	return [];
}

function parseButtons(raw: string | null | undefined): IgButton[] {
	const parsed = parseJson(raw);
	if (!Array.isArray(parsed)) return [];
	const buttons: IgButton[] = [];
	for (const item of parsed) {
		if (item === null || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		const type =
			candidate.type === "web_url"
				? "web_url"
				: candidate.type === "postback"
					? "postback"
					: null;
		if (type === null) continue;
		if (typeof candidate.title !== "string" || candidate.title === "") {
			continue;
		}
		const button: IgButton = { type, title: candidate.title };
		if (typeof candidate.url === "string") button.url = candidate.url;
		if (typeof candidate.payload === "string") button.payload = candidate.payload;
		if (typeof candidate.track === "boolean") button.track = candidate.track;
		buttons.push(button);
	}
	return buttons;
}

function parseQuickReplies(raw: string | null | undefined): IgQuickReply[] {
	const parsed = parseJson(raw);
	if (!Array.isArray(parsed)) return [];
	const quickReplies: IgQuickReply[] = [];
	for (const item of parsed) {
		if (item === null || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.title !== "string" || candidate.title === "") continue;
		if (typeof candidate.payload !== "string") continue;
		quickReplies.push({ title: candidate.title, payload: candidate.payload });
	}
	return quickReplies;
}

function parseConfig(raw: string | null | undefined): Record<string, unknown> {
	const parsed = parseJson(raw);
	if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}
	return {};
}

/**
 * Nunca lança: JSON inválido vira fallback vazio e falha do createClickLink
 * mantém a URL original.
 */
export async function renderAction(
	action: IgAutomationActionRow,
	vars: IgRenderVars,
	opts?: IgRenderOptions,
): Promise<IgRenderedAction> {
	const config = parseConfig(action?.config ?? null);
	const variants = parseStringArray(action?.text_variants ?? null);
	const lastVariant =
		typeof config.lastVariant === "string" ? config.lastVariant : null;

	const rendered: IgRenderedAction = {};

	if (variants.length > 0) {
		const chosen = pickVariant(variants, lastVariant);
		if (chosen !== "") rendered.text = applyTemplate(chosen, vars);
	}

	const buttons = parseButtons(action?.buttons ?? null).map((button) => ({
		...button,
		title: applyTemplate(button.title, vars),
	}));
	if (buttons.length > 0) rendered.buttons = buttons;

	const quickReplies = parseQuickReplies(action?.quick_replies ?? null).map(
		(quickReply) => ({
			...quickReply,
			title: applyTemplate(quickReply.title, vars),
		}),
	);
	if (quickReplies.length > 0) rendered.quickReplies = quickReplies;

	const trackClicks =
		opts?.trackClicks !== false && config.trackClicks !== false;
	const createClickLink = opts?.createClickLink;
	if (trackClicks && createClickLink && rendered.buttons) {
		for (const button of rendered.buttons) {
			if (button.type !== "web_url") continue;
			if (button.track === false) continue;
			if (typeof button.url !== "string" || button.url === "") continue;
			const originalUrl = button.url;
			try {
				const trackedUrl = await createClickLink(originalUrl, action);
				if (typeof trackedUrl === "string" && trackedUrl.trim() !== "") {
					button.url = trackedUrl;
				}
			} catch {
				// mantém a URL original — tracking nunca derruba o envio
			}
		}
	}

	return rendered;
}
