#!/usr/bin/env node
/**
 * Smoke F3 — ROTAÇÃO de library com DEDUPE + REINÍCIO automático.
 *
 * Exercita a ÚNICA fonte da seleção de itens (selectContentIndex em
 * lib/planner-runtime.ts) sem banco — direto sobre o state (published_indexes
 * / last_index persistido em Planner.state):
 *   - random_loop legado: dedupe por ciclo + reset automático ao esgotar
 *   - old_to_new / new_to_old: cursores com wrap/clamp preservados (não quebrou)
 *   - item_rotation { mode:'sequential'|'random', repeat:true } → dedupe + reset
 *   - item_rotation { repeat:false } → para em -1 sem consumir item (state intacto)
 *   - conteúdo que ENCOLHEU (índices órfãos) → reset limpo, nunca wedge
 *   - parseItemRotation / resolveRotationStrategy (retrocompat)
 *   - validatePlannerConfig aceita/rejeita item_rotation corretamente
 *
 * Runner: npx --no-install tsx scripts/gauntlet/rotation-repeat.mts
 * Exit code 0 only if every scenario passes.
 */
import {
	selectContentIndex,
	parseItemRotation,
	resolveRotationStrategy,
	type ItemRotationConfig,
} from "../../lib/planner-runtime";
import { validatePlannerConfig } from "../../lib/planner-config";

let pass = 0,
	fail = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}`);
	} else {
		fail++;
		console.error(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`);
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type ContentLike = {
	type?: string;
	id?: string;
	url?: string;
	media_type?: string;
	caption?: string;
};

function makeContent(n: number): ContentLike[] {
	return Array.from({ length: n }, (_, i) => ({
		type: "config",
		id: `c${i}`,
		url: `https://example.com/${i}.mp4`,
		media_type: "REELS",
	}));
}

/** Simula a sequência de picks a partir de um state, empurrando o nextState. */
function simulate(
	n: number,
	sortOrder: string,
	itemRotation?: ItemRotationConfig,
	seedState?: Record<string, unknown>,
	maxPicks = n * 2 + 2,
) {
	const content = makeContent(n);
	let state: Record<string, unknown> = { ...(seedState ?? {}) };
	const picks: number[] = [];
	for (let i = 0; i < maxPicks; i++) {
		const r = selectContentIndex(content, sortOrder, state, itemRotation);
		if (r.selectedIndex === -1) {
			picks.push(-1);
			break;
		}
		picks.push(r.selectedIndex);
		state = r.nextState;
	}
	return { picks, state };
}

// ─── 1. random_loop legado: dedupe + reset automático ────────────────────────

{
	const { picks, state } = simulate(3, "random_loop");
	check(
		"random_loop: nunca para (reinício automático ao esgotar)",
		picks.length > 6 && !picks.includes(-1),
		`picks=${picks.join(",")}`,
	);
	check(
		"random_loop: todos os picks dentro da faixa",
		picks.every((p) => p >= 0 && p < 3),
	);
	// A estrutura é determinística: cada ciclo de 3 picks é distinto e o pick de
	// reset (fecho do ciclo) nunca é igual ao anterior (sem repetição imediata).
	const groups = Math.floor(picks.length / 3);
	for (let g = 0; g < groups; g++) {
		const group = picks.slice(g * 3, g * 3 + 3);
		check(
			`random_loop: ciclo ${g + 1} com dedupe (3 distintos) + sem repetição imediata`,
			new Set(group).size === 3 && group[1] !== group[2],
			`group=${group.join(",")}`,
		);
	}
	check(
		"random_loop: registro zerado a cada ciclo (nunca cresce além de N itens)",
		Array.isArray(state.published_indexes) &&
			(state.published_indexes as unknown[]).length <= 3 &&
			(state.published_indexes as unknown[]).length < picks.length,
		`state=${JSON.stringify(state)}`,
	);
}

// ─── 2. cursores legados preservados (não quebrar) ───────────────────────────

{
	const seq = simulate(3, "old_to_new");
	check(
		"old_to_new: wrap 0,1,2,0,1,…",
		seq.picks.slice(0, 5).join(",") === "0,1,2,0,1",
		`picks=${seq.picks.join(",")}`,
	);
	check(
		"old_to_new: state final last_index = último pick",
		(seq.state as { last_index?: unknown }).last_index ===
			seq.picks[seq.picks.length - 1],
	);

	const n2o = simulate(2, "new_to_old");
	check(
		"new_to_old: começa do último item, depois clampa (1,0,1,…)",
		n2o.picks.slice(0, 3).join(",") === "1,0,1",
		`picks=${n2o.picks.join(",")}`,
	);

	// cursor com last_index fora da faixa (conteúdo encolheu) → clamp, sem wedge
	const stale = simulate(2, "new_to_old", undefined, { last_index: 7 });
	check(
		"new_to_old: last_index órfão (7) clampa para o último item",
		stale.picks[0] === 1,
		`picks=${stale.picks.join(",")}`,
	);
}

// ─── 3. item_rotation sequential + repeat (dedupe determinístico + reset) ─────

{
	const s = simulate(3, "random_loop", { mode: "sequential", repeat: true });
	check(
		"item_rotation sequential: ciclo 0,1,2 → reset → 0,1",
		s.picks.slice(0, 5).join(",") === "0,1,2,0,1",
		`picks=${s.picks.join(",")}`,
	);
	check(
		"item_rotation sequential: 8 picks = 0,1,2,0,1,2,0,1 (repeat fecha ciclo)",
		s.picks.join(",") === "0,1,2,0,1,2,0,1",
		`picks=${s.picks.join(",")}`,
	);
	check(
		"item_rotation sequential: state final reflete só o ciclo corrente",
		(s.state.published_indexes as unknown[]).join(",") === "0,1",
		`state=${JSON.stringify(s.state)}`,
	);
}

// ─── 4. item_rotation random + repeat ─────────────────────────────────────────

{
	const r = simulate(3, "old_to_new", { mode: "random", repeat: true });
	check(
		"item_rotation random: nunca para e sem -1",
		r.picks.length > 6 && !r.picks.includes(-1),
		`picks=${r.picks.join(",")}`,
	);
	check(
		"item_rotation random: todos dentro da faixa",
		r.picks.every((p) => p >= 0 && p < 3),
	);
	const groups = Math.floor(r.picks.length / 3);
	for (let g = 0; g < groups; g++) {
		const group = r.picks.slice(g * 3, g * 3 + 3);
		check(
			`item_rotation random: ciclo ${g + 1} dedupe + sem repetição imediata`,
			new Set(group).size === 3 && group[1] !== group[2],
			`group=${group.join(",")}`,
		);
	}
}

// ─── 5. item_rotation repeat=false → esgota e PARA (state intacto) ───────────

{
	const randomNoRepeat = simulate(3, "random_loop", {
		mode: "random",
		repeat: false,
	});
	check(
		"random repeat=false: 3 picks distintos + para em -1",
		randomNoRepeat.picks.length === 4 &&
			randomNoRepeat.picks[3] === -1 &&
			new Set(randomNoRepeat.picks.slice(0, 3)).size === 3,
		`picks=${randomNoRepeat.picks.join(",")}`,
	);
	check(
		"random repeat=false: state intacto após parada (registro não cresce)",
		(randomNoRepeat.state.published_indexes as unknown[]).length === 3,
		`state=${JSON.stringify(randomNoRepeat.state)}`,
	);

	const seqNoRepeat = simulate(3, "random_loop", {
		mode: "sequential",
		repeat: false,
	});
	check(
		"sequential repeat=false: para em -1 após 0,1,2",
		seqNoRepeat.picks.slice(0, 4).join(",") === "0,1,2,-1",
		`picks=${seqNoRepeat.picks.join(",")}`,
	);

	// repeat=false com fila JÁ esgotada no state → para imediatamente
	const exhausted = simulate(2, "random_loop", { mode: "random", repeat: false }, {
		published_indexes: [0, 1],
	});
	check(
		"repeat=false com fila já esgotada: para na primeira chamada (-1)",
		exhausted.picks.join(",") === "-1",
		`picks=${exhausted.picks.join(",")}`,
	);
}

// ─── 6. conteúdo ENCOLHEU com published_indexes órfãos → reset limpo ─────────

{
	// state diz que 5 índices foram usados, mas só restam 3 itens (2 deletados):
	// os órfãos não podem wedgar — a fila esgota de verdade → reset automático.
	// Simula UM pick só (maxPicks=1) para inspecionar o estado logo após o reset.
	const shrunk = simulate(3, "random_loop", undefined, {
		published_indexes: [0, 1, 2, 3, 4],
	}, 1);
	check(
		"conteúdo encolheu: reset limpo, pick válido e registro zerado para 1",
		shrunk.picks[0] >= 0 &&
			shrunk.picks[0] < 3 &&
			(shrunk.state.published_indexes as unknown[]).length === 1,
		`picks=${shrunk.picks.join(",")} state=${JSON.stringify(shrunk.state)}`,
	);
	// Se todos os 3 itens reais já foram usados (sem órfãos) com repeat=false → -1
	const exhaustedShrunk = simulate(3, "random_loop", { mode: "random", repeat: false }, {
		published_indexes: [0, 1, 2, 3, 4],
	}, 1);
	check(
		"conteúdo encolheu + repeat=false: para em -1 (não wedga em órfão)",
		exhaustedShrunk.picks.join(",") === "-1",
		`picks=${exhaustedShrunk.picks.join(",")}`,
	);
}

// ─── 7. parseItemRotation / resolveRotationStrategy (retrocompat) ─────────────

{
	check("sem item_rotation → null (comportamento legado)", parseItemRotation({}) === null);
	check(
		"item_rotation inválido (string) → null",
		parseItemRotation({ item_rotation: "random" }) === null,
	);
	const def = parseItemRotation({ item_rotation: { mode: "random" } });
	check(
		"mode random sem repeat → repeat default true",
		def?.mode === "random" && def.repeat === true,
	);
	const explicit = parseItemRotation({
		item_rotation: { mode: "sequential", repeat: false },
	});
	check(
		"repeat=false explícito preservado",
		explicit?.mode === "sequential" && explicit.repeat === false,
	);
	const badMode = parseItemRotation({ item_rotation: { mode: "shuffle" } });
	check(
		"mode desconhecido → '' (fallback para sort_order, nunca lança)",
		badMode?.mode === "" && badMode.repeat === true,
	);

	check(
		"random_loop → dedupe-random repeat ON (comportamento atual)",
		resolveRotationStrategy("random_loop")?.kind === "dedupe-random" &&
			(resolveRotationStrategy("random_loop") as { repeat: boolean }).repeat === true,
	);
	check(
		"old_to_new → cursor-old-to-new (wrap preservado)",
		resolveRotationStrategy("old_to_new")?.kind === "cursor-old-to-new",
	);
	check(
		"new_to_old → cursor-new-to-old (clamp preservado)",
		resolveRotationStrategy("new_to_old")?.kind === "cursor-new-to-old",
	);
	check(
		"item_rotation vence sort_order",
		resolveRotationStrategy("old_to_new", { mode: "random", repeat: false })
			?.kind === "dedupe-random" &&
			(resolveRotationStrategy("old_to_new", {
				mode: "random",
				repeat: false,
			}) as { repeat: boolean }).repeat === false,
	);
}

// ─── 8. validatePlannerConfig com item_rotation ───────────────────────────────

{
	const base = {
		frequency: { value: 5, unit: "minutes" as const },
		content: [],
	};
	check(
		"validate: item_rotation válido aceito",
		validatePlannerConfig({ ...base, item_rotation: { mode: "random", repeat: true } }).ok === true,
	);
	const bad1 = validatePlannerConfig({ ...base, item_rotation: { mode: "shuffle" } });
	check(
		"validate: mode inválido rejeitado",
		!bad1.ok && bad1.errors.some((e) => e.includes("item_rotation.mode")),
		bad1.errors.join("; "),
	);
	const bad2 = validatePlannerConfig({
		...base,
		item_rotation: { mode: "random", repeat: "yes" },
	});
	check(
		"validate: repeat não-boolean rejeitado",
		!bad2.ok && bad2.errors.some((e) => e.includes("item_rotation.repeat")),
		bad2.errors.join("; "),
	);
	const bad3 = validatePlannerConfig({ ...base, item_rotation: "random" });
	check(
		"validate: shape de item_rotation inválido rejeitado",
		!bad3.ok && bad3.errors.some((e) => e.includes("item_rotation")),
		bad3.errors.join("; "),
	);
	check(
		"validate: config legado sem item_rotation continua ok",
		validatePlannerConfig({
			...base,
			sort_order: "random_loop",
			caption_rotation: "sequential",
		}).ok === true,
	);
}

console.log(`\nrotation-repeat F3: ${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);