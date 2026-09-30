#!/usr/bin/env npx tsx
/**
 * Gauntlet unit — CORE PURO do IG Automation (spec docs/IG_AUTOMATION_SPEC.md
 * §4/§6). Sem DB e sem rede: cobre normalize, quiet hours, matcher,
 * substâncias, variants, template e render (tracking de clique com
 * createClickLink fake).
 *
 * Runner: npx tsx scripts/gauntlet/ig-core.mts
 * Exit code 0 apenas se todos os cenários passarem.
 */
import {
	applyTemplate,
	isQuietNow,
	normalizeForWordBoundary,
	normalizeText,
} from "@/lib/ig-automation/normalize";
import {
	matchSubstance,
	matchText,
	parseSubstanceKeywords,
	pickVariant,
} from "@/lib/ig-automation/matcher";
import { renderAction } from "@/lib/ig-automation/render";
import type {
	IgAutomationActionRow,
	IgRenderVars,
	IgSubstanceInput,
} from "@/lib/ig-automation/types";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		pass++;
		console.log(`✅ ${label}${detail ? " — " + detail : ""}`);
	} else {
		fail++;
		console.error(`❌ ${label}${detail ? " — " + detail : ""}`);
	}
}

function actionRow(
	partial: Partial<IgAutomationActionRow> = {},
): IgAutomationActionRow {
	return {
		id: "a1",
		automation_id: "auto1",
		position: 0,
		type: "dm_text",
		delay_seconds: 0,
		text_variants: null,
		buttons: null,
		quick_replies: null,
		media_url: null,
		tag: null,
		sequence_id: null,
		webhook_id: null,
		ai_prompt: null,
		config: null,
		created_at: new Date("2026-01-01T00:00:00Z"),
		...partial,
	};
}

async function main(): Promise<void> {
	/* ── normalizeText / normalizeForWordBoundary ───────────────────────── */
	check("normalizeText acentos", normalizeText("Ação Ção") === "acaocao");
	check(
		"normalizeText remove pontuação/espaço",
		normalizeText("Olá, Mundo! 123") === "olamundo123",
	);
	check(
		"normalizeForWordBoundary mantém espaços",
		normalizeForWordBoundary("Ação Ção!") === "acao cao!",
	);

	/* ── isQuietNow ─────────────────────────────────────────────────────── */
	const quiet: { start: string; end: string; tz: string } = {
		start: "23:00",
		end: "07:00",
		tz: "America/Bahia",
	};
	check(
		"isQuietNow dentro (02:00 Bahia)",
		isQuietNow(quiet, new Date("2026-01-15T05:00:00Z")) === true,
	);
	check(
		"isQuietNow fora (12:00 Bahia)",
		isQuietNow(quiet, new Date("2026-01-15T15:00:00Z")) === false,
	);
	check(
		"isQuietNow virada início exato (23:00)",
		isQuietNow(quiet, new Date("2026-01-15T02:00:00Z")) === true,
	);
	check(
		"isQuietNow virada fim exato (07:00)",
		isQuietNow(quiet, new Date("2026-01-15T10:00:00Z")) === false,
	);
	check(
		"isQuietNow janela normal dentro (09:00 UTC)",
		isQuietNow(
			{ start: "08:00", end: "10:00", tz: "UTC" },
			new Date("2026-01-15T09:00:00Z"),
		) === true,
	);
	check(
		"isQuietNow timezone (09:00Z = 06:00 Bahia fora)",
		isQuietNow(
			{ start: "08:00", end: "10:00", tz: "America/Bahia" },
			new Date("2026-01-15T09:00:00Z"),
		) === false,
	);
	check(
		"isQuietNow defaultTz usado quando tz vazio",
		isQuietNow(
			{ start: "08:00", end: "10:00", tz: "" },
			new Date("2026-01-15T09:00:00Z"),
			"UTC",
		) === true,
	);
	check("isQuietNow null → false", isQuietNow(null, new Date()) === false);
	check(
		"isQuietNow start===end → false",
		isQuietNow(
			{ start: "08:00", end: "08:00", tz: "UTC" },
			new Date("2026-01-15T08:30:00Z"),
		) === false,
	);

	/* ── matchText ──────────────────────────────────────────────────────── */
	check(
		"matchText contains acento/case",
		matchText("Quero saber o PREÇO!", ["preco"], "any", "contains") === true,
	);
	check(
		"matchText contains sem casar",
		matchText("Quero saber o PREÇO!", ["vitamina"], "any", "contains") ===
			false,
	);
	check(
		"matchText exact normalizado",
		matchText("  Preço! ", ["preco"], "any", "exact") === true,
	);
	check(
		"matchText exact não casa substring",
		matchText("preco bom", ["preco"], "any", "exact") === false,
	);
	check(
		"matchText starts_with casa início",
		matchText("Preço bom", ["preco"], "any", "starts_with") === true,
	);
	check(
		"matchText starts_with não casa meio",
		matchText("bom preço", ["preco"], "any", "starts_with") === false,
	);
	check(
		"matchText regex válida no texto original",
		matchText("Preço com Ç", ["^Pre[çc]o"], "any", "regex") === true,
	);
	check(
		"matchText regex inválida não casa",
		matchText("preco", ["("], "any", "regex") === false,
	);
	check(
		"matchText negativa bloqueia",
		matchText("preço sem receita", ["preco"], "any", "contains", [
			"sem receita",
		]) === false,
	);
	check(
		"matchText negativa não bloqueia quando ausente",
		matchText("preço com receita", ["preco"], "any", "contains", [
			"sem receita",
		]) === true,
	);
	check(
		"matchText mode any",
		matchText("preco", ["abc", "preco"], "any", "contains") === true,
	);
	check(
		"matchText mode all",
		matchText("quero preco", ["quero", "preco"], "all", "contains") ===
			true,
	);
	check(
		"matchText mode all parcial",
		matchText("preco", ["quero", "preco"], "all", "contains") === false,
	);
	check(
		"matchText keyword vazia = universal",
		matchText("qualquer coisa", [""], "any", "contains") === true,
	);
	check(
		"matchText lista vazia = universal",
		matchText("qualquer coisa", [], "any", "contains") === true,
	);

	/* ── matchSubstance / parseSubstanceKeywords ────────────────────────── */
	const substances: IgSubstanceInput[] = [
		{
			id: "s1",
			keyword: "creatina",
			name: "Creatina",
			keywords: '["creapure"]',
			description: "desc criatina",
			action: "acao creatina",
			dosage: "5g",
			duration: "30 dias",
			url: "https://url.test/creatina",
		},
		{
			id: "s2",
			keyword: "d3",
			name: "Vitamina D3",
			keywords: null,
			description: "desc d3",
			action: "acao d3",
			dosage: "1000UI",
			duration: "60 dias",
			url: null,
		},
	];
	const m1 = matchSubstance("Tomo CREATINA todo dia", substances);
	check("matchSubstance keyword >=4 substring", m1?.id === "s1");
	check(
		"matchSubstance campos PT (nome/descricao/acao/dosagem/duracao/url)",
		m1?.nome === "Creatina" &&
			m1?.descricao === "desc criatina" &&
			m1?.acao === "acao creatina" &&
			m1?.dosagem === "5g" &&
			m1?.duracao === "30 dias" &&
			m1?.url === "https://url.test/creatina",
	);
	check(
		"matchSubstance sinônimo (keywords JSON)",
		matchSubstance("uso creapure", substances)?.id === "s1",
	);
	check(
		"matchSubstance keyword <4 word boundary",
		matchSubstance("vitamina d3 ajuda", substances)?.id === "s2",
	);
	check(
		"matchSubstance keyword <4 não casa colado",
		matchSubstance("vitamina d3x", substances) === null,
	);
	check(
		"matchSubstance primeiro item vence",
		matchSubstance("creatina com d3", substances)?.id === "s1",
	);
	check(
		"matchSubstance url null vira string vazia",
		matchSubstance("vitamina d3", substances)?.url === "",
	);
	check("matchSubstance texto vazio → null", matchSubstance("", substances) === null);
	check(
		"matchSubstance catálogo vazio → null",
		matchSubstance("creatina", []) === null,
	);
	check(
		"parseSubstanceKeywords JSON",
		JSON.stringify(parseSubstanceKeywords('["a","b"]')) === '["a","b"]',
	);
	check(
		"parseSubstanceKeywords string solta",
		parseSubstanceKeywords("a, b;c").join("|") === "a|b|c",
	);
	check(
		"parseSubstanceKeywords inválido/null",
		parseSubstanceKeywords("{oops").length === 1 &&
			parseSubstanceKeywords(null).length === 0,
	);

	/* ── pickVariant ────────────────────────────────────────────────────── */
	check(
		"pickVariant evita repetir lastUsed",
		pickVariant(["a", "b"], "a") === "b",
	);
	check("pickVariant única retorna ela", pickVariant(["x"], "x") === "x");
	check("pickVariant vazio → \"\"", pickVariant([], null) === "");
	check(
		"pickVariant ignora vazias",
		pickVariant(["", "z"], "") === "z",
	);
	check(
		"pickVariant pertence à lista",
		["a", "b", "c"].includes(pickVariant(["a", "b", "c"], null)),
	);

	/* ── applyTemplate ──────────────────────────────────────────────────── */
	check(
		"applyTemplate simples",
		applyTemplate("Olá {nome}!", { nome: "Ana" }) === "Olá Ana!",
	);
	check(
		"applyTemplate chave pontuada",
		applyTemplate("{substancia.nome}", {
			"substancia.nome": "Creatina",
		}) === "Creatina",
	);
	check(
		"applyTemplate objeto aninhado",
		applyTemplate(
			"{substancia.nome}",
			{ substancia: { nome: "Creatina" } } as unknown as IgRenderVars,
		) === "Creatina",
	);
	check(
		"applyTemplate chave ausente intacta",
		applyTemplate("{nome} {ausente}", { nome: "Ana" }) ===
			"Ana {ausente}",
	);

	/* ── renderAction ───────────────────────────────────────────────────── */
	const vars: IgRenderVars = { username: "ana", "substancia.nome": "Creatina" };

	const plain = await renderAction(
		actionRow({ text_variants: JSON.stringify(["Oi {username}!"]) }),
		vars,
	);
	check("renderAction texto com template", plain.text === "Oi ana!");

	const withButtons = await renderAction(
		actionRow({
			buttons: JSON.stringify([
				{ type: "web_url", title: "Ver {username}", url: "https://site.test/x" },
				{ type: "postback", title: "Ok", payload: "p" },
			]),
			quick_replies: JSON.stringify([
				{ title: "Sim {username}", payload: "yes" },
			]),
		}),
		vars,
	);
	check(
		"renderAction título de botão com template",
		withButtons.buttons?.[0].title === "Ver ana",
	);
	check(
		"renderAction sem createClickLink não embrulha",
		withButtons.buttons?.[0].url === "https://site.test/x",
	);
	check(
		"renderAction quick reply com template",
		withButtons.quickReplies?.[0].title === "Sim ana",
	);

	const wrapped = await renderAction(
		actionRow({
			buttons: JSON.stringify([
				{ type: "web_url", title: "Ver", url: "https://site.test/x" },
			]),
		}),
		vars,
		{ createClickLink: (_url, action) => `https://meu.test/r/slug?c=${action.id}` },
	);
	check(
		"renderAction createClickLink embrulha web_url",
		wrapped.buttons?.[0].url === "https://meu.test/r/slug?c=a1",
	);

	const trackFalse = await renderAction(
		actionRow({
			buttons: JSON.stringify([
				{ type: "web_url", title: "Ver", url: "https://site.test/x", track: false },
			]),
		}),
		vars,
		{ createClickLink: () => "https://meu.test/r/x" },
	);
	check(
		"renderAction track:false não embrulha",
		trackFalse.buttons?.[0].url === "https://site.test/x",
	);

	const configTrackFalse = await renderAction(
		actionRow({
			config: JSON.stringify({ trackClicks: false }),
			buttons: JSON.stringify([
				{ type: "web_url", title: "Ver", url: "https://site.test/x" },
			]),
		}),
		vars,
		{ createClickLink: () => "https://meu.test/r/x" },
	);
	check(
		"renderAction config.trackClicks=false não embrulha",
		configTrackFalse.buttons?.[0].url === "https://site.test/x",
	);

	const optsTrackFalse = await renderAction(
		actionRow({
			buttons: JSON.stringify([
				{ type: "web_url", title: "Ver", url: "https://site.test/x" },
			]),
		}),
		vars,
		{ trackClicks: false, createClickLink: () => "https://meu.test/r/x" },
	);
	check(
		"renderAction opts.trackClicks=false não embrulha",
		optsTrackFalse.buttons?.[0].url === "https://site.test/x",
	);

	const postback = await renderAction(
		actionRow({
			buttons: JSON.stringify([
				{ type: "postback", title: "Ok", payload: "p" },
			]),
		}),
		vars,
		{ createClickLink: () => "https://meu.test/r/x" },
	);
	check(
		"renderAction postback nunca embrulha",
		postback.buttons?.[0].url === undefined &&
			postback.buttons?.[0].payload === "p",
	);

	const rejecting = await renderAction(
		actionRow({
			buttons: JSON.stringify([
				{ type: "web_url", title: "Ver", url: "https://site.test/x" },
			]),
		}),
		vars,
		{
			createClickLink: async () => {
				throw new Error("tracker fora do ar");
			},
		},
	);
	check(
		"renderAction createClickLink que lança mantém URL original",
		rejecting.buttons?.[0].url === "https://site.test/x",
	);

	const lastVariant = await renderAction(
		actionRow({
			text_variants: JSON.stringify(["A {username}", "B {username}"]),
			config: JSON.stringify({ lastVariant: "A {username}" }),
		}),
		vars,
	);
	check(
		"renderAction respeita config.lastVariant",
		lastVariant.text === "B ana",
	);

	const badJson = await renderAction(
		actionRow({
			text_variants: "{não é json",
			buttons: "[[[",
			quick_replies: "oops",
			config: "config quebrada",
		}),
		vars,
	);
	check(
		"renderAction JSON inválido não explode",
		badJson.text === undefined &&
			badJson.buttons === undefined &&
			badJson.quickReplies === undefined,
	);

	const invalidFields = await renderAction(
		actionRow({
			buttons: JSON.stringify([
				{ type: "web_url", title: "" },
				{ type: "nope", title: "x" },
				"string solta",
				{ type: "web_url", title: "Válido", url: "https://ok.test" },
			]),
			quick_replies: JSON.stringify([
				{ title: "sem payload" },
				{ title: "ok", payload: "p" },
			]),
		}),
		vars,
	);
	check(
		"renderAction filtra botões/quick replies inválidos",
		invalidFields.buttons?.length === 1 &&
			invalidFields.buttons?.[0].title === "Válido" &&
			invalidFields.quickReplies?.length === 1,
	);

	/* ── resumo ─────────────────────────────────────────────────────────── */
	console.log(`\n${pass} ok, ${fail} falha(s)`);
	if (fail > 0) process.exit(1);
}

main().catch((error) => {
	console.error("❌ erro inesperado no gauntlet:", error);
	process.exit(1);
});
