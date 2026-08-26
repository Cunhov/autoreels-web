# Round 01 — piece 1 (seleção) — gates + cenários

Commit base: 2cbe47b (+ edits não-commitados de piece 1 e piece 2 na árvore)

## Gates
1. `rm -rf .next && npx tsc --noEmit` → exit 0, zero erros
2. `npx eslint components/ContentLibrary.tsx components/PlannerWizard.tsx` → mesmos 5 erros pré-existentes (no-explicit-any L27/115/194/248/394) + warnings antigos; NENHUM problema novo das edições
3. `npm run build` → exit 0
4. `scripts/gauntlet/planner-edit-run.sh` → ALL SCENARIOS PASS

## Cenários
- S1: PASS — reabrir edição: badge 130/130, contador wizard 130, checked=130/130 após Load More
- S2: PASS — 127 selecionados; itens desmarcados (pág.1 e além) permanecem desmarcados
- S3-preview/S4-preview: PASS (piece 2 intacta)
- S3direct/S4direct: PASS (lane de publicação intacta)
- consoleErrors=0 pageErrors=0
