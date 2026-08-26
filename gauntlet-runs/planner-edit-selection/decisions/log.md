# Decisions log — planner-edit-selection

- Bar escolhida pelo usuário: E2E real no browser (Playwright) + gates automáticos (tsc/lint/build).
- Budget: unlimited — win or user stop. Modelo: ox-alpha (atual) para builders e critics.
- Bug 1 raiz identificada em preflight: ContentLibrary.tsx — initialSelection só é useState initializer; fetchContent keepSelection poda seleção aos visibleIds da primeira página (~linha 875). PAGE_SIZE=100.
- Bug 2 raiz suspeita: planner-runtime.ts resolvePlannerRuntime ~L521 usa .replace ad-hoc de só 2 vars; preview route usa runtime.caption quando rotation=off → {date}/{hashtags}/desconhecidas podem vazar literais.
- Artefato stale .next/types/routes.d 2.ts causa erro TS2300 espúrio — limpar .next antes dos gates.
- Arquivos não-commitados pré-existentes (publisher/carousel-normalize/planner-runtime): intocados; fixes serão commitados isoladamente por arquivo.

## Round 1 (2026-08-23)

- Ambos builders caíram simultaneamente por network_error transitório do provider (bloqueiro 1× cada — não é a regra dos 3 repetidos; loop continua).
- Piece 2 (tags) REVIVIDA e COMPLETA, verde: feedback loop quebrado ({post_caption} nunca lê o snapshot caption da entrada), .replace ad-hoc eliminado, preview route usa funções compartilhadas, lane rotation=off herda caption resolvida. Gates: tsc ✅ build ✅ harness ✅ ALL PASS. Parity preview=publish provada; idempotência f(f(x))=f(x) provada.
- Legendas observadas pós-fix: S3preview/S3direct "A  B 22/08/2026 C " (zero chaves); S4 "A MinhaLegenda B 22/08/2026 C ".
- Piece 1 (seleção) revivida como run cfec81c0; aguardando gates + S1/S2 verdes.
- Piece 1 (seleção) COMPLETA, verde: poda por visibleIds removida, sync por valor de initialSelection com selectionTouchedRef (não clobbera escolhas locais), S1=130/130 PASS, S2=127 exatos PASS, console limpo, tsc/build/lint ✅.
- Round 1 completo (2/2 pieces verdes). Critics adversariais lançados (workflow ab7b8f7b): re-executam o harness sozinhos + revisão hostil do código; veredito WIN/NO-WIN/INVALID-EVIDENCE.
- Veredito critic-tags: WIN. Sobreviveu a 8 ataques (lanes sequential/random, parity, item deletado, legados, grep exaustivo, idempotência, evidência, re-execução real dos gates). Riscos residuais registrados: edge {{x}}/chaves com espaço fora do vocabulário de tag; preview cosmético usa channels[0] para {channel_name} (publish correto por canal); driver falha redirect do gate .md quando $RUN_DIR/gates não existe (corrigir na reconciliação).
- Supervisor executou gates + harness com shell: tsc ✅ build ✅ lint sem erro novo vs HEAD ✅ harness ALL PASS ✅.
- Critic-selection caiu em network_error (2ª ocorrência na sessão) e foi revivido (run 46d8a6df); foco restante: screenshots + revisão hostil do código.
- BLOQUEIO REPETIDO: critic-selection caiu 3× consecutivas em network_error (auto-retry interno esgotado). Ação que falha = revive da sessão persistida (contexto grande re-enviado). Correção do bloqueio: substituto FRESCO de sessão nova com tarefa circunscrita (workflow 9ba15622) — restaura também a pureza fresh-context do método. Se esse falhar 3×, hard stop e escalada ao usuário.

## PAUSA (2026-08-23 ~03:20) — provider em indisponibilidade

- 6ª falha de rede consecutiva na corrente do critic-selection (agora "503 status code"). Pausa automática conforme acordado com o usuário.
- Estado: builders das 2 pieces verdes; gates + harness re-executados pelo supervisor com exit 0; critic-tags WIN (8 ataques, riscos residuais registrados); critic-selection SEM veredito final (JSONs validados por ele antes de cair; falta diff hostil + veredito).
- FIX DE INSTRUMENTO aplicado pelo supervisor durante a pausa: planner-edit-run.sh agora faz mkdir -p "$RUN_DIR/gates" antes do redirect — gate .md nunca mais sai vazio/header-only. Sintaxe validada (bash -n).
- RETOMADA sugerida: 1 critic-selection fresco com tarefa circunscrita (PNGs + diff hostil nos 4 riscos + veredito ≤15 linhas) → se WIN duplo → pass de reconciliação UX micro-detalhes → commit final isolado por arquivo.
