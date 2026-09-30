# IG Automation (Módulo 8) — Relatório de Gauntlet, Deploy e Cutover Meta

Data: 2026-09-30 · Branch: `fixes-monolith` · Commits do módulo: `f3c6320`
(spec+schema+migração 0015), `89fa764` (onda 1 — núcleo/APIs/UI), `186f174`
(onda 2 — engine/webhook/jobs/worker/migração n8n + fixes watcher), `2b50b63`
(harness e2e + evidência 15/15). A rodada do crítico final (fixes C1/C2/A*/M*/B*
+ G16–G19 + migração `0016`), a retenção do cron e a documentação/QA estão na
**working tree, ainda sem commit**.

---

## 1. Contexto e objetivo

Substituir o workflow n8n "Instagram Auto Reply - Otimizado" por um módulo
nativo do autoreels, com UI, logs, simulador e anti-bloqueio. O escopo congelado
em `docs/IG_AUTOMATION_SPEC.md` cobre:

- **Fase A (núcleo):** webhook seguro (verify + HMAC), engine de regras
  (comentário/DM/story/postback, keywords, prioridade, primeira interação,
  quiet hours), ações (resposta pública, private reply com botões, DM
  texto/botões/quick replies/mídia), anti-bloqueio (dedupe, cooldown 24h, limite
  diário, 30 envios/min, pausa por takeover humano), logs, simulador, saúde do
  webhook por canal com re-assinatura, catálogo de substâncias e migração do
  n8n.
- **Fase B (relacionamento):** inbox/CRM de contatos, pausa/retomada do bot,
  tags/notas, sequências com delay.
- **Fase C (crescimento):** respostas por IA (OpenRouter), tracking de
  cliques/UTM, webhook de saída assinado e rotação de variações (A/B).

## 2. Arquitetura

```
Meta/Instagram ──POST──▶ /api/webhooks/instagram ── HMAC + dedupe ──▶ IgEvent
      ▲                        │ responde 200; engine via after() (não bloqueia)
      │ GET hub.challenge      ▼
      │                engine.handleInboundEvent
      │          canal → contato → gates → matcher (1 automação vence)
      │                        │
      │        ┌───────────────┴────────────────┐
      │        ▼                                ▼
      │  ações inline (offset 0)          IgJob (delay/jitter 15–25s)
      │        └──────────► executor ◄──────────┘
      │                  Graph API (Instagram Login; proxy por canal opcional)
      │                        │
      │        IgActionLog · stats · IA (OpenRouter) · outbound webhook (HMAC)
      │
      └── worker: POST /api/cron/automation (x-cron-auth, AUTOMATION_INTERVAL=15s)
              jobs · sequências (claim atômico) · eventos órfãos (>2min)

UI: /automations (Regras | Catálogo | Sequências | Contatos | Inbox | Relatórios | Config)
Tracking: botão/DM → /r/[slug] → 302 target + UTM (incrementa IgClick/stats)
```

## 3. Arquivos por área

| Área | Arquivos |
| --- | --- |
| Spec/schema/migração | `docs/IG_AUTOMATION_SPEC.md`, `prisma/schema.prisma` (aditivo), `prisma/migrations/0015_ig_automation/migration.sql`, `prisma/migrations/0016_sequence_enrollment_attempts/migration.sql` |
| Núcleo puro | `lib/ig-automation/{types,normalize,matcher,render,limits,log,validate}.ts` |
| Graph/execução | `lib/ig-automation/{graph,actions,ai,outbound,clicks}.ts`, `app/r/[slug]/route.ts` |
| Webhook/engine/filas | `lib/ig-automation/{webhook,engine,jobs,contacts,sequences,subscription}.ts`, `app/api/webhooks/instagram/route.ts`, `app/api/cron/automation/route.ts`, `worker/index.js` (aditivo) |
| APIs CRUD/autenticadas | `app/api/automations/{route,[id]/route,logs/route,simulate/route}.ts`, `app/api/ig/{shared,analytics/route,events/route,settings/route,webhook-status/route}.ts`, `app/api/ig/contacts/**`, `app/api/ig/substances/**`, `app/api/ig/sequences/**`, `app/api/ig/outbound-webhooks/**`, `app/api/channels/oauth/callback/route.ts` (aditivo) |
| UI | `app/automations/{page,new/page,[id]/page}.tsx`, `components/ig-automation/*` (11 arquivos), `components/Sidebar.tsx` (aditivo) |
| Migração n8n | `scripts/ig-migrate-n8n.mjs`, `scripts/fixtures/n8n-workflow.fixture.json` |
| Testes/gauntlet | `scripts/gauntlet/{ig-core.mts,ig-automation-scenarios.mjs,ig-boot.sh,fetch-mock.mjs (aditivo),README.md}`, `gauntlet-runs/module-08-ig-automation/gates/**` |
| Integração/QA final | `app/api/cron/maintenance/route.ts` (retenção incl. `ig_clicks` 180d), `.env.example` (seção Instagram Automation), `docs/IG_AUTOMATION_GAUNTLET_REPORT.md`, `gauntlet-runs/README.md` |
| Rodada do crítico final | `lib/ig-automation/{webhook,types,outbound,graph,actions,jobs,engine,sequences,validate}.ts`, `app/api/automations/{route,[id]/route,simulate/route}.ts`, `app/r/[slug]/route.ts`, `components/ig-automation/*`, `prisma/schema.prisma` + migração 0016, `scripts/gauntlet/ig-automation-scenarios.mjs` |

## 4. Modelo de dados — 12 tabelas

Migration `0015_ig_automation` (aditiva; 12 `CREATE TABLE` + 22 índices, sem
DROP/ALTER em tabelas existentes):

| Tabela | Papel |
| --- | --- |
| `ig_automations` | Regra por canal (trigger, keywords, gates, settings, stats) |
| `ig_automation_actions` | Ações ordenadas da regra (tipo, delay, variants, botões) |
| `ig_substances` | Catálogo de substâncias (importado do n8n; 122 itens) |
| `ig_contacts` | CRM: tags, notas, pausa do bot, contadores por canal |
| `ig_events` | Inbox + log de entrada (dedupe_key único; status received/matched/...) |
| `ig_action_logs` | Log de execuções (sent/failed/skipped/pending) por automação/contato |
| `ig_jobs` | Fila de ações com delay (pending/running/done/failed/cancelled) |
| `ig_sequences` | Sequências/follow-ups (steps JSON com delays) |
| `ig_sequence_enrollments` | Inscrição única por (sequência, contato); claim de passo; `attempts` (0016) limita retry a 3 |
| `ig_channel_state` | Saúde do webhook por canal (status, subscribed_fields, last_event_at) |
| `ig_clicks` | Links rastreados `/r/[slug]` (UTM, contador, last_click_at) |
| `ig_outbound_webhooks` | Webhooks de saída assinados (eventos, secret) |

## 5. Segurança

- **HMAC do webhook:** body cru + `X-Hub-Signature-256` validado com
  `timingSafeEqual` (`lib/ig-automation/webhook.ts`); segredo efetivo é
  `INSTAGRAM_CLIENT_SECRET || META_APP_SECRET`; sem segredo → 500; assinatura
  inválida/sem header → 401; payload inválido → 400.
- **Verify token:** `META_WEBHOOK_VERIFY_TOKEN` (env, precedência) ou AppConfig
  `meta_webhook_verify_token` gerado com `randomBytes(32)` e exibido em
  Automações > Config; comparação constant-time (`safeEqual`); GET sem match →
  403. Não é obrigatório definir a env.
- **Auth/scoping:** todas as APIs autenticadas usam `requireUserId` +
  `findOwnedChannel`; recursos de outro dono → 404; serializers omitem
  `access_token`/`proxy_url`/`secret` (webhook de saída devolve só
  `has_secret`). Cron `/api/cron/automation` aceita apenas header
  `x-cron-auth` (constant-time).
- **SSRF:** `/r/[slug]` só redireciona http(s) — allowlist na criação do link e
  revalidação antes do 302; botões e URL de outbound validados http(s) na API.
  `dispatchOutbound` usa `lib/ssrf-guard.ts` (`isHostAllowed`: bloqueia
  loopback/privados/link-local/metadata, IPv4/IPv6 e `localhost`),
  `redirect: "manual"` com revalidação de cada salto (máx. 3) e a criação do
  webhook rejeita host privado com "URL não permitida" (`validate.ts`).
  **Nada pendente de segurança** após a rodada do crítico final (ver §7).
- **Abuso/limites:** webhook responde 200 e nunca espera a Graph (`after()`);
  payload cru truncado em 20k; dedupe por `dedupe_key`; rate limit 30/min por
  canal; dry-run e kill switch via AppConfig.

## 6. Testes e evidência

- **Unit puro (ig-core):** `npx tsx scripts/gauntlet/ig-core.mts` → **61 ok / 0
  falhas** (matcher, render, limits, normalize, validate, clicks).
- **E2E (Graph/OpenRouter mockados):** `bash scripts/gauntlet/ig-boot.sh` →
  **19/19** cenários **G1–G19** + Phase B G12 sem chave 1/1. Evidência final:
  `gauntlet-runs/module-08-ig-automation/gates/round-043114-ig-automation.md`
  (rodada final: usar o `round-*-ig-automation.md` mais recente em `gates/`).
  Evolução: `round-033339` 13/15 → `round-033646` 14/15 → `round-034027` 15/15
  → `round-042112` 16/19 (pós-crítico, com G11/G17/G19 vermelhos) →
  `round-042705` **19/19 + fase B** → `round-043114` **19/19 + fase B** (re-run
  de fechamento). `server.log`: 0 ENOENT, 0 Unhandled/TypeError, 0
  `UNMATCHED_MOCK`.
- **Watchers (2) + fixers:** **34 findings** no total — Watcher onda 1: 19
  (1 alto / 6 médios / 12 baixos; 13 corrigidos pelo Fixer A, 6 mantidos por
  contrato/decisão — mensagens PT-BR pré-existentes, 404 vs 403, envelopes de
  lista, analytics de cliques, ownership de processo, `migration_lock`);
  Watcher onda 2: 15 (F-01..F-15; 4 altos / 4 médios / 7 baixos; 13 corrigidos
  pelo Fixer B, F-13/F-15 documentadas como decisão). **26/34 corrigidos**,
  smokes dedicados dos fixers: DB 26/26, F1 2/2, sanity 11/11, worker 4/4.
- **Crítico final fresh-context:** 24 findings novos (2 críticos / 7 altos /
  10 médios / 5 baixos). Os críticos/altos/médios foram corrigidos por dois
  fixers em paralelo e ganharam regressões G16–G19 — ver §7. Segurança: nada
  pendente. O gauntlet e2e valida contra mock; ele não cobre Graph real (os
  gaps remanescentes estão em §7.2/§11).

## 7. Rodada do crítico final (pós-fixes)

Dois fixers trabalharam em paralelo sobre os 24 findings do crítico
fresh-context, e o gauntlet ganhou regressões **G16–G19** (echo do bot × echo
humano, SSRF no outbound, simulador com rascunho, throttle multi-ação +
eventos `action.sent`/`sequence.step`). Resultado: **19/19 + fase B 1/1**
(`round-043114`; primeira rodada verde em `round-042705`). Fixer C1
(segurança/Graph): 7/7 corrigidos, smoke 34/34 e
`ig-core.mts` 61/61. Fixer C2 (engine/produto): 11 fixes, smoke 9/9;
`tsc`/`eslint`/`prisma validate`/`migrate deploy` (0001–0016) limpos.

### 7.1 Tabela dos fixados

| # | O que foi corrigido | Arquivo principal |
| --- | --- | --- |
| C1 | Echo do próprio bot (`message.app_id` = nosso app, ou `message_id` correlacionado a um `IgActionLog` `sent` das últimas 24h) vira `kind="echo"`/`status="skipped"`/`error="echo_do_bot"` e **não** pausa o contato; echo humano real continua pausando 24h | `lib/ig-automation/webhook.ts` (+ `types.ts`) |
| C2 | SSRF bloqueado no outbound: `isHostAllowed` + `redirect:"manual"` com revalidação de cada salto (máx. 3) e rejeição de host privado/loopback/metadata já na criação ("URL não permitida") | `lib/ig-automation/outbound.ts`, `lib/ig-automation/validate.ts` |
| A1 | Limites da Meta no template: botão `title ≤ 20`, texto `≤ 640`, quick reply `≤ 20`, máx. 3 botões | `lib/ig-automation/graph.ts` |
| A2 | Eventos de saída `action.sent`/`action.failed`/`click`/`sequence.step` agora disparam (fire-and-forget, nunca bloqueiam o fluxo) | `lib/ig-automation/actions.ts`, `lib/ig-automation/sequences.ts`, `app/r/[slug]/route.ts` |
| A6 | Throttle no match enfileira **todas** as ações preservando offsets (1ª em +60s; demais +60s+(offset_i−offset_0)), mantendo o teto de 3 tentativas | `lib/ig-automation/engine.ts` |
| A7 | Simulador aceita o **rascunho não salvo** do editor (validado no mesmo schema), avaliado antes das persistidas, com badge "Rascunho"; fallback 400 → simula apenas as salvas | `lib/ig-automation/engine.ts`, `app/api/automations/simulate/route.ts`, `components/ig-automation/{SimulatorPanel,AutomationEditor}.tsx` |
| M1 | `postbackPayload` entra no match de keywords quando `kind="postback"` (payload não vazio) | `lib/ig-automation/engine.ts` |
| M4 | `eventId` propagado aos jobs → dedupe de `private_reply` também em retry/reclaim | `lib/ig-automation/jobs.ts` |
| M5 | `attempts` por enrollment (migração **0016**); após 3 falhas o enrollment vira `cancelled` (`next_run_at=null`) com log claro; zera ao entregar/re-enroll | `lib/ig-automation/sequences.ts`, `prisma/schema.prisma`, `prisma/migrations/0016_sequence_enrollment_attempts/` |
| M6 | Lock in-process por contato no engine (`withContactLock`): eventos concorrentes do mesmo contato serializam (cooldown/first_interaction/rate limit deixam de ser check-then-act) | `lib/ig-automation/engine.ts` |
| M8 | Falha inline transitória (rede/5xx/timeout) vira 1 job de retry (+60s); erro permanente (token/OAuth/permissão/config ausente) falha direto com motivo claro | `lib/ig-automation/engine.ts` |
| M9 | Ownership de `sequenceId`/`webhookId` validado no POST/PATCH de automações (user + canal; global quando aplicável) | `app/api/automations/route.ts`, `app/api/automations/[id]/route.ts` |
| M7 | Retenção de `ig_clicks` em 180 dias no cron, em lotes, com `ig_clicks_deleted` aditivo na resposta | `app/api/cron/maintenance/route.ts` |
| M3 | `dm_media` com texto: duas mensagens (mídia e depois texto); falha só no texto retorna ok + `warning` (mídia já entregue não vira retry duplicado) | `lib/ig-automation/graph.ts` |
| B4 | `private_reply` aceita apenas botões `web_url` (validação no backend + editor oculta/força `web_url`) | `lib/ig-automation/validate.ts`, `components/ig-automation/ActionListEditor.tsx` |
| B1 | Textos stale "Disponível após o deploy da onda 1/2" removidos da UI | `components/ig-automation/{AutomationEditor,SimulatorPanel,WebhookPanel,SubstanceManager}.tsx` |

### 7.2 Gaps remanescentes (documentados)

- **M2 — `lastVariant` não persistido:** rotação de variants aleatória sem
  memória; `render.ts` lê `config.lastVariant`, mas nada grava (melhoria
  futura).
- **A5 — janela 24h/7d:** erros da Graph ainda chegam em inglês no
  `IgActionLog`; mapeamento PT-BR acionável não implementado.
- **M10 — analytics 90d × retenção 30d:** séries aceitam até 90 dias, mas
  `RETENTION_LOGS_DAYS` default 30; janelas longas podem subestimar.
- **F-13/F-15 (decisões):** jitter default aplicado com `delay_seconds=0`
  explícito; replay contado como `duplicates` sem gravar status `duplicate`.
- **A3/A4 — operacionais:** migração n8n **sempre** por `--channel` (o
  `Config Corpo Ultra` repete o id da Homem Ultra no workflow real); só
  desligar o workflow n8n de renovação de tokens após confirmar canais com
  token IG real no app — **o que já é o caso hoje**.
- **Baixos ainda abertos (B2/B3/B5):** status `duplicate` documentado sem
  gravação, `handleEcho` no engine sem uso efetivo e URL relativa de tracking
  quando `PUBLIC_BASE_URL` não está setada.
- **Segurança:** nada pendente (C1/C2/B4 fechados; ver §5).

## 8. Runbook de deploy e cutover Meta

> Guarde o valor antigo da Callback URL do Meta antes de qualquer alteração.

1. **Backup:** rode o backup diário (ou copie o volume `/app/data`) antes do
   deploy. As migrations são aditivas, mas o backup é o rollback do banco.
2. **Deploy Easypanel** do branch `fixes-monolith` (serviço app + worker). As
   **16 migrações** (0015 + 0016) aplicam via `scripts/db-migrate.sh` /
   entrypoint. Confira no worker o log `Automação: ... (min 15s, loop
   dedicado)`.
3. **Env vars no Easypanel** (todas opcionais): `META_WEBHOOK_VERIFY_TOKEN`,
   `META_APP_SECRET`, `AUTOMATION_INTERVAL=15`; `OPENROUTER_API_KEY`/
   `OPENROUTER_MODEL` para IA. `CRON_SECRET` já é usada pelo worker.
4. **Tokens antes do cutover:** reconecte via OAuth os canais com token
   inválido (`cunhov`, `respostafitness`) e os canais legados `token_*`
   (Redis/n8n) — eles **não** entram no refresh automático do publisher. **Só
   desligue o workflow n8n de renovação de tokens depois de confirmar que
   todos os canais têm token IG real (não `token_*`) no app — o que já é o
   caso hoje.**
5. **Migração das regras n8n — SEMPRE por `--channel`**, uma conta por vez
   (nunca `--all-channels` cego): primeiro dry-run, confira o plano conta a
   conta e só depois `--apply`. Atenção ao `Config Corpo Ultra`, que **repete
   o id da Homem Ultra** no workflow real; valide as 5 contas ligadas
   (cunhov, homemultra, corpoultra, cunhov.pep, cunhov.bio) e trate
   `marinhojr_us`/`cunhov.hacks` (sem fio no workflow).
6. **Meta App Dashboard → Webhooks:** troque a Callback URL para
   `https://autoreels.cunhov.site/api/webhooks/instagram` e cole o Verify
   Token exibido em **Automações > Config** (copiar). Se
   `META_WEBHOOK_VERIFY_TOKEN` estiver setada, o valor da UI é ela.
7. **Assine os campos:** `comments`, `messages`, `messaging_postbacks`
   (o produto Instagram Login usa esses; `message_reactions` é opcional).
8. **Re-assine os canais no app:** Automações > header/Config > **Re-assinar**
   em cada canal (POST `/api/ig/webhook-status`); confirme status `ok` e
   reconecte os canais com token inválido (`cunhov`, `respostafitness`).
9. **Dry-run do app antes de ativar envios:** em Automações > Config ative
   **Dry-run**; comente a keyword de uma regra em um post de teste por conta e
   confira no Inbox/Logs o evento `matched` com ações `skipped` (`dry_run`) e
   zero chamadas à Graph.
10. **Valide um comentário real por conta** com o dry-run desligado. Nesta
    janela o n8n ainda pode responder em paralelo — é uma **dupla resposta
    controlada**; use posts de teste e acompanhe `IgActionLog`.
11. **Desative o workflow n8n** "Instagram Auto Reply - Otimizado" (não exclua
    — ele é o rollback) assim que a validação por conta terminar. Enquanto ele
    estiver ativo haverá **resposta dupla**.
12. **Monitore:** `IgActionLog`, `ig_jobs`, status do webhook por canal e o
    cron de maintenance (retenção). Mantenha o n8n desativado apenas quando
    todos os canais estiverem `ok`.

## 9. Rollback

1. **Reative o workflow n8n** (undo do passo 11) — ele volta a responder os
   comentários/DMs.
2. **Reverta a Callback URL no Meta** para o endpoint antigo do n8n e desassine
   os campos novos, se necessário.
3. **Evite resposta dupla durante a volta:** mantenha o dry-run do app ligado
   (Automações > Config) ou desabilite as regras na UI até o n8n assumir.
4. **Banco:** as tabelas `ig_*` são novas e as mudanças são aditivas; não é
   preciso reverter a migration. Para estado anterior, restaure o backup do
   passo 1 (`VACUUM INTO`/volume).

## 10. Limitações conhecidas

- **Janelas da Meta:** DM comum só pode ser enviada dentro de **24h** da última
  mensagem do usuário; private reply a comentário vale **7 dias** após o
  comentário. Fora da janela a Graph rejeita e o `IgActionLog` registra o erro
  (mensagem crua em inglês; mapeamento PT-BR é melhoria pendente — A5).
- **Tokens inválidos:** canais `cunhov` e `respostafitness` estão com token
  inválido e precisam de reconexão OAuth. Canais com token legado `token_*`
  (Redis/n8n) **não entram no refresh automático** do publisher: reconecte via
  OAuth antes de desligar o n8n de renovação.
- **Decisões F-13/F-15 (Watcher 2):** F-13 — o jitter default de 15–25s da
  resposta pública é aplicado mesmo com `delay_seconds=0` explícito (compat com
  o contrato congelado); F-15 — replay de webhook é contado como `duplicates`,
  mas o evento original não recebe status `duplicate` (status documentados no
  validador não são todos gravados).
- **Botões template:** dependem de token **Instagram Login** (caso dos canais
  atuais, `IGAA...`); canais conectados por Facebook Login podem não suportar
  `dm_buttons`/private reply com botão. Botão `postback` é omitido em
  `private_reply` (template de botão do Instagram não aceita postback).
- **Retenção:** `ig_events`/`ig_action_logs` seguem `RETENTION_LOGS_DAYS`
  (default do código: **30** dias — não 180), `ig_jobs` terminais 7 dias e
  `ig_clicks` 180 dias, todos em lotes de 5.000 (máx. 10 lotes/tabela/run).
  `ig_substances` e `ig_contacts` **não** são limpos (decisão).
- **Analytics:** séries aceitam até 90 dias, mas logs de ação duram 30 dias por
  default — séries longas/cooldown > 30 dias podem subestimar (M10).
- **Single-admin/SQLite:** o scoping por usuário existe, mas o produto opera com
  um admin; locks de escrita são do SQLite/better-sqlite3.

## 11. Próximos passos

Os bloqueadores do crítico final foram corrigidos (§7) e o gauntlet está 19/19;
o que resta:

1. **M2 — persistir `lastVariant`** para a rotação de variants ter memória
   (evitar repetir a última usada).
2. **A5 — mapear erros de janela 24h/7d** para PT-BR acionável no
   `IgActionLog` (ex.: "Fora da janela de 24h — o contato precisa responder").
3. **A3/A4 — operação:** validar a migração n8n conta a conta (`--channel`,
   dry-run antes do apply) e confirmar tokens IG reais antes de aposentar o
   workflow de renovação.
4. **M10 — alinhar analytics × retenção** (séries de 90d × logs de 30d).
5. **Baixos B2/B3/B5:** gravar/remover status `duplicate`, remover o
   `handleEcho` morto do engine e derivar a base pública do tracking quando
   `PUBLIC_BASE_URL` faltar.
6. **Opcional:** testes de contrato contra a Graph real em staging (o gauntlet
   e2e é 100% mockado).
