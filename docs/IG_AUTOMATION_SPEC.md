# IG Automation — Spec congelada (v1: Automações Instagram no autoreels)

> Fonte única de verdade para os agentes do swarm. Nenhum agente pode alterar este
> contrato sem autorização do integrador. Tudo em PT-BR (UI e erros). Stack: Next.js 16
> (App Router) + Prisma 7 (SQLite, adapter better-sqlite3) + NextAuth (single-admin).
> Deploy: Easypanel (branch `fixes-monolith`), migrações via `prisma/migrations` + `db-migrate.sh`.

## 0. Objetivo

Substituir o workflow n8n "Instagram Auto Reply - Otimizado" por um módulo nativo do
autoreels, com muito mais liberdade:

- Fase A (núcleo): webhook seguro de comentários/DMs, engine de regras configuráveis,
  ações (resposta pública no comentário, private reply com botões, DM texto/botões/quick
  replies), anti-bloqueio (dedupe/cooldown/limites/quiet hours/takeover humano), regra por
  post e primeira interação, logs/execuções, simulador, saúde do webhook por canal com
  re-assinatura via API, catálogo de substâncias, migração automática do n8n.
- Fase B (relacionamento): inbox/CRM de contatos, pausar/retomar bot por contato, tags,
  sequências/follow-ups com delay.
- Fase C (crescimento): resposta por IA (OpenRouter), tracking de cliques/UTM + relatórios,
  webhook de saída (n8n/planilha/CRM) assinado, A/B de variações (variants rotativas).

## 1. Regras de ouro

1. **Não quebrar o existente**: mudanças em arquivos já existentes devem ser estritamente
   aditivas. Nunca alterar comportamento de publisher/canais/planners.
2. **Ownership de arquivos**: cada agente só escreve nos arquivos listados na sua onda
   (seção 12). Fora do ownership = conflito de swarm.
3. **Segredos**: nunca logar/serializar `access_token`, `proxy_url`, `INSTAGRAM_CLIENT_SECRET`,
   `OPENROUTER_API_KEY`. APIs nunca devolvem esses campos.
4. **Multi-user**: todo endpoint autenticado filtra por `session.user.id` (ver `lib/api.ts`
   `getSessionUserId`). Canal precisa pertencer ao usuário.
5. **Erros**: mensagens PT-BR, tipadas, sem stack trace na resposta. Logs internos via
   `IgActionLog`/`IgEvent` (nunca console com token).
6. **Sem novas dependências npm** (nada de zod/axios). Validação manual.
7. **Verificação**: `npx tsc --noEmit` + eslint dos arquivos tocados + `npm run build`.
   Testes puros via `npx tsx scripts/gauntlet/ig-*.mts` (fake timers manuais, sem rede real).

## 2. Arquitetura e fluxo

```
Meta (webhook) ──POST──▶ /api/webhooks/instagram
                          1. valida X-Hub-Signature-256 (HMAC do body cru com INSTAGRAM_CLIENT_SECRET)
                          2. parseia entry[] → IgInboundEvent[]
                          3. grava IgEvent (dedupe_key único) — status "received"
                          4. responde 200 imediatamente; processa via after()
                                  │
                                  ▼
                       engine.handleInboundEvent(event)
                          canal → contato → gates → matcher
                                  │ match
                                  ▼
                    executa ações sem delay inline; ações com delay → IgJob
                                  │
              worker (a cada AUTOMATION_INTERVAL, default 15s)
              POST /api/cron/automation (x-cron-auth) ──▶ processa IgJob/sequências/eventos órfãos
```

- `POST /api/webhooks/instagram` NUNCA espera Graph API: só persiste e responde.
  A recuperação é idempotente: worker reprocessa `IgEvent.status="received"` com mais de 2 min.
- `GET /api/webhooks/instagram` responde ao desafio da Meta.
- Kill switch global: AppConfig `ig_automation_enabled` ("0" desliga o processamento de
  eventos; webhook segue gravando). Dry-run: AppConfig `ig_automation_dry_run` ("1" loga as
  ações como `skipped` com motivo `dry_run`, sem chamar a Graph API).

## 3. Modelo de dados

Congelado em `prisma/schema.prisma` + `prisma/migrations/0015_ig_automation/migration.sql`.
Modelos: `IgAutomation`, `IgAutomationAction`, `IgSubstance`, `IgContact`, `IgEvent`,
`IgActionLog`, `IgJob`, `IgSequence`, `IgSequenceEnrollment`, `IgChannelState`, `IgClick`,
`IgOutboundWebhook`. Relações aditivas em `User` e `Channel`.

## 4. Tipos congelados — `lib/ig-automation/types.ts`

```ts
export type IgTrigger = "comment" | "dm" | "story_reply" | "story_mention" | "postback";
export type IgMatchType = "contains" | "exact" | "starts_with" | "regex";
export type IgMatchMode = "any" | "all";
export type IgActionType =
  | "public_comment_reply" | "private_reply" | "dm_text" | "dm_buttons"
  | "dm_quick_replies" | "dm_media" | "ai_reply" | "assign_tag"
  | "start_sequence" | "outbound_webhook";

export interface IgButton { type: "web_url" | "postback"; title: string; url?: string; payload?: string; track?: boolean; }
export interface IgQuickReply { title: string; payload: string; }
export interface IgQuietHours { start: string; end: string; tz: string; } // "23:00"/"07:00"

export interface IgInboundEvent {
  channelIgId: string;        // entry[].id (ID IG da conta profissional)
  kind: IgTrigger;
  dedupeKey: string;          // comment:<id> | message:<mid> | postback:<mid> | reaction:<mid> | story:<mid>
  igEventId: string;          // id do comentário / mid da mensagem
  fromIgId?: string;
  fromUsername?: string;
  text?: string;
  mediaId?: string;
  postbackPayload?: string;
  isEcho?: boolean;           // message.is_echo
  raw: unknown;               // payload cru do evento
}

export interface IgGateResult { gate: string; passed: boolean; reason?: string; }

export interface IgMatchedAction {
  actionId: string;
  type: IgActionType;
  position: number;
  runAtOffsetMs: number;      // delay acumulado (delay_seconds + jitter p/ público)
  renderedText?: string;      // já com variants/placeholders resolvidos (quando aplicável)
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
```

## 5. Semântica do engine (`engine.ts`) — ordem determinística

1. **Kill switch** (`ig_automation_enabled=0`) → evento `skipped`.
2. **Resolver canal** por `account_id = channelIgId`, `platform="instagram"`; inativo/inexistente → `skipped`.
3. **Echo** (`isEcho`): grava evento `kind="echo"`; seta `contact.bot_paused_until = now + ig_human_takeover_pause_hours` (default 24h); não responde.
4. **Dedupe**: `dedupe_key` já existe → ignora (status `duplicate`). Edição de comentário é ignorada.
5. **Autor**: se `fromIgId === channel.account_id` ou `fromUsername === channel.username` → ignora.
6. **Contato**: upsert por `(channel_id, ig_user_id)`; atualiza username/last_*_at e
   `interactions_count` (incremento só ao final, após gates de “primeira interação”).
7. **Automações candidatas**: `enabled=true`, `channel_id`, ordem `priority DESC, created_at ASC`.
8. **Gates por automação** (todos logados; primeiro match vence — apenas UMA automação por evento):
   - `trigger`: kind do evento ∈ trigger (story_mention/story_reply mapeados do payload de `messages`).
   - `media_ids`: lista vazia/null = qualquer post; senão `event.mediaId ∈ lista`.
   - `first_interaction_only`: exige `contact.interactions_count === 0` (antes do incremento).
   - `negatives`: se qualquer negativa casar → falha.
   - `keywords`: normaliza texto (minúsculas, sem acento); `match_mode=any` (≥1) / `all` (todas).
     `match_type` aplicado a cada keyword; keyword vazia = match universal.
   - `substance`: se a automação tem flag `settings.substanceCatalog=true`, o matcher consulta
     `IgSubstance` no texto (ver §6.4) e injeta `vars.substancia`.
   - `quiet_hours`: respeita `{start,end,tz}` (America/Bahia default); cruzando meia-noite.
   - `bot_pause`: `contact.bot_paused_until > now` → `paused`.
   - `cooldown`: `cooldown_hours` (override) ou AppConfig `ig_cooldown_hours` (default 24):
     existe `IgActionLog` `sent` p/ (automation, contact) dentro da janela → `skipped`.
   - `daily_limit`: `daily_limit` (override) ou AppConfig `ig_daily_limit_per_contact` (default 0 = off):
     nº de `sent` da automação p/ o contato hoje ≥ limite → `skipped`.
   - `rate_limit`: janela 60s por canal; AppConfig `ig_max_sends_per_minute` (default 30) →
     `throttled` (o job volta para a fila com `run_at=now+60s`, máx 3 tentativas).
9. **Match**: cria/atualiza `IgEvent` (status `matched`, automation_id) e incrementa `stats_matched`/`last_run_at`.
10. **Ações**: monta `IgMatchedAction[]` ordenadas por `position`; `runAtOffsetMs` = soma dos
    `delay_seconds` anteriores. `public_comment_reply` sem delay explícito recebe default 15s
    + jitter 0–10s. Ações com offset 0 executam inline; com offset > 0 viram `IgJob`
    (`type="action"`, payload = `{eventId, automationId, contactId, actionId, channelId}`).
11. **Contato**: incrementa `interactions_count`.
12. Toda ação executada gera `IgActionLog` (`sent`/`failed`/`skipped`).

### 5.1 Executor de ação (`actions.ts`)
- `public_comment_reply`: `POST {base}/{igEventId}/replies` `{message}`.
- `private_reply`: `POST {base}/{channel.account_id}/messages` com
  `recipient.comment_id=igEventId` e `message.attachment` template button (quando há botões)
  ou `message.text`. Só existe 1 private reply por comentário (dedupe por evento).
- `dm_text` / `dm_buttons` / `dm_quick_replies` / `dm_media`: `POST {base}/{account_id}/messages`
  com `recipient.id = contact.ig_user_id`; botões → attachment template; quick replies →
  `message.quick_replies`; mídia → attachment `image` (URL pública).
- `assign_tag`: adiciona tag no contato.
- `start_sequence`: cria `IgSequenceEnrollment` (único por sequência+contato), `next_run_at=now`.
- `outbound_webhook`: dispara webhook de saída (ver §10).
- `ai_reply`: gera texto via `lib/ig-automation/ai.ts` e envia como `dm` (evento dm) ou
  `private_reply` (evento comment).
- `{base}` = `resolveAccessToken(channel.access_token)` → `getGraphBaseUrl(token)` do
  `lib/instagram.ts`, versão `GRAPH_API_VERSION` (default v24.0), com
  `fetchWithTimeout(..., proxy)` respeitando `channel.proxy_enabled/proxy_url`.
- Placeholders nos textos: `{username}`, `{first_name}`, `{substancia.nome}`,
  `{substancia.descricao}`, `{substancia.acao}`, `{substancia.dosagem}`,
  `{substancia.duracao}`, `{substancia.url}`.
- Rotação de variants: aleatória, evitando repetir a última usada quando houver >1.

## 6. Módulos puros (`lib/ig-automation/`)

### 6.1 `normalize.ts`
- `normalizeText(s)`: minúsculas, NFD, remove acentos, remove `[^a-z0-9]`.
- `normalizeForWordBoundary(s)`: minúsculas + sem acentos (mantém espaços).
- `isQuietNow(quiet, at, defaultTz)`.
- `applyTemplate(text, vars)`: substituição de placeholders.

### 6.2 `matcher.ts`
- `matchText(text, keywords, mode, matchType, negatives)` → boolean.
- `matchSubstance(text, substances)` → mesma regra do n8n: normalizado; keyword normalizada
  ≥4 chars → substring; <4 → word-boundary (`\b`); primeiro item vence.
- `pickVariant(variants, lastUsed?)` → string.

### 6.3 `render.ts`
- `renderAction(action, vars, opts)` → `{ text?, buttons?, quickReplies? }` com placeholders e
  wrapping de clique (`track`): se `buttons[].track !== false` e tipo `web_url` e
  `config.trackClicks !== false`, chama `createClickLink` (injetado) e troca a URL por
  `${PUBLIC_BASE_URL}/r/{slug}?c={contactId}`.

### 6.4 `limits.ts`
- Leitura de AppConfig com defaults: `ig_automation_enabled=1`,
  `ig_automation_dry_run=0`, `ig_cooldown_hours=24`, `ig_daily_limit_per_contact=0`,
  `ig_max_sends_per_minute=30`, `ig_human_takeover_pause_hours=24`.
- `checkCooldown`, `checkDailyLimit`, `checkRateLimit` (janela 60s por canal; contagem no DB
  via `IgActionLog` para robustez multi-processo).

### 6.5 `log.ts`
- `logEvent(...)`, `logAction(...)`, `bumpStats(...)` (fire-and-forget com catch).

## 7. Webhook (`webhook.ts` + rota)

- `verifySignature(rawBody: string, signatureHeader: string|undefined, secret: string)`:
  HMAC-SHA256 `sha256=<hex>`; comparação `timingSafeEqual`; sem header = inválido.
- `parseWebhookPayload(body)` → `IgInboundEvent[]`:
  - `entry[].changes[]`: `field="comments"` → kind `comment` (`value.id`, `value.text`,
    `value.from`, `value.media.id`); `field="message_reactions"` → `reaction`.
  - `entry[].messaging[]`: `message.text` → `dm`; `message.is_echo` → `echo`; anexo
    `story_mention` → `story_mention`; `reply_to.story` → `story_reply`; `postback` → `postback`.
  - Ignora `read`, `delivery`, `reaction` sem mid, e entries malformadas.
- `GET`: `hub.mode=subscribe` + `hub.verify_token` match em (env `META_WEBHOOK_VERIFY_TOKEN`
  se setado, senão AppConfig `meta_webhook_verify_token`) → `200 text/plain` com
  `hub.challenge`; senão `403`.
- `POST`: assinatura inválida → `401`; body inválido → `400`; senão persiste e responde
  `200 {"received":N}`.

## 8. Subscription por canal (`subscription.ts` + APIs)

- `getSubscribedFields(token, proxy)` → `GET {base}/{version}/me/subscribed_apps`.
- `ensureSubscription(token, proxy)` → `POST {base}/{version}/me/subscribed_apps` com
  `subscribed_fields=comments,messages,messaging_postbacks` (idempotente), grava
  `IgChannelState` (`status`: `ok` | `partial` | `missing` | `token_invalid`).
- `app/api/channels/oauth/callback/route.ts`: após conectar/atualizar canal IG, chamar
  `ensureSubscription` best-effort (falha não bloqueia o OAuth).
- API autenticada: `GET /api/ig/webhook-status` (todos os canais IG do usuário),
  `POST /api/ig/webhook-status` `{channelId}` (re-assina e devolve estado).

## 9. Filas e worker

- `jobs.ts`: `enqueueJob`, `processDueJobs(limit=25)` (marca `running` com `locked_at`,
  reclaim de `running` >2min, backoff `run_at=now+60s` em erro; máx `max_attempts`),
  `processStaleEvents(limit=25)` (events `received` >2min), `processDueSequences(limit=25)`
  (enrollment `next_run_at<=now`; executa o passo via executor; avança passo/`done`).
- `POST /api/cron/automation` (auth `x-cron-auth === CRON_SECRET`, mesmo padrão do
  publisher) → `{ok, jobs:{processed,failed}, events:{processed}, sequences:{processed}}`.
- `worker/index.js`: agenda a chamada a cada `AUTOMATION_INTERVAL` (default 15s, min 5s),
  independente do loop principal do publisher; loga resumido.

## 10. Webhooks de saída

- `outbound.ts`: `dispatchOutbound(userId, channelId, event, payload)` → percorre
  `IgOutboundWebhook` habilitados que aceitam `event`; POST JSON com headers
  `X-Autoreels-Event`, `X-Autoreels-Signature: sha256=<HMAC do body com secret>`,
  timeout 10s; resultado em `IgActionLog` (type `outbound_webhook`).
- Eventos: `comment.matched`, `dm.matched`, `action.sent`, `action.failed`, `click`,
  `sequence.step`.
- Payload base: `{event, automationId, channelId, contact:{igUserId,username}, text, mediaId, ts}`.

## 11. APIs autenticadas (contratos)

Todas: `401 {error:"Unauthorized"}` sem sessão; `403` se o recurso não é do usuário.
Paginação por `limit` (máx 100, default 30) + `cursor` (id) → `{items, nextCursor}`.

- `GET /api/automations?channelId=` → `{automations:[Auto & {actions:Action[], channel:{id,name,username}}]}`
- `POST /api/automations` → body `{channelId,name,enabled?,priority?,trigger?,keywords?,matchMode?,
  matchType?,negativeKeywords?,mediaIds?,firstInteractionOnly?,cooldownHours?,dailyLimit?,
  quietHours?,settings?,actions?:ActionInput[]}`; valida; cria com actions.
- `GET|PATCH|DELETE /api/automations/[id]`; PATCH aceita os mesmos campos; se `actions` vier,
  substitui o conjunto inteiro (transação).
- `POST /api/automations/simulate` → body `{channelId,kind,text,mediaId?,username?,igUserId?}`
  → `IgSimulationResult` (zero efeitos colaterais; mesmos gates/matcher/render reais).
- `GET /api/automations/logs?automationId=&channelId=&status=&kind=&limit=&cursor=`
  → `{items: IgActionLog & {contact?, automation?}, nextCursor}`.
- `GET /api/ig/events?channelId=&direction=&kind=&limit=&cursor=` → idem p/ IgEvent.
- `GET /api/ig/contacts?channelId=&q=&tag=&limit=&cursor=`; `PATCH /api/ig/contacts/[id]`
  `{tags?,notes?,customFields?,botPausedUntil?}`; `POST .../pause {hours}`; `POST .../resume`.
- `GET|POST /api/ig/substances`; `PATCH|DELETE /api/ig/substances/[id]`;
  `POST /api/ig/substances/import {substances:[...]}` (upsert por keyword).
- `GET|POST /api/ig/sequences`; `GET|PATCH|DELETE /api/ig/sequences/[id]`;
  `POST /api/ig/sequences/[id]/enroll {contactId}`.
- `GET /api/ig/webhook-status`; `POST /api/ig/webhook-status {channelId}`.
- `GET /api/ig/settings` → `{webhookUrl, verifyToken, envOverride, limits, enabled, dryRun}`;
  `PUT /api/ig/settings` → atualiza limites/flags; `POST /api/ig/settings` `{action:"regenerate-token"
  |"toggle-enabled"}`.
- `GET|POST /api/ig/outbound-webhooks`; `PATCH|DELETE /api/ig/outbound-webhooks/[id]`.
- `GET /api/ig/analytics?channelId=&days=7` → `{totals:{matched,sent,failed,clicks,contacts},
  series:[{date,matched,sent,failed,clicks}], byAutomation:[...]}`.
- `GET /r/[slug]` (público): incrementa `IgClick.clicks`, `last_click_at`, `stats_clicks` da
  automação e redireciona 302 para `target_url` com UTM (`utm_source=instagram&utm_medium=dm
  |comment&utm_campaign={automationId}`) + `sub` se configurado.

## 12. UI (`app/automations/**`, `components/ig-automation/**`)

- Sidebar: novo item `{ name: 'Automações', path: '/automations', icon: Bot }` (lucide `Bot`).
- `/automations` — dashboard com abas internas: **Regras | Catálogo | Sequências | Contatos |
  Inbox | Relatórios | Config**. Header mostra status do webhook por canal + botão
  "Re-assinar" + link "Copiar URL/token p/ Meta". Regras: cards por canal com toggle,
  contadores (matched/sent/failed/clicks) e botão editar/duplicar/excluir/testar.
- `/automations/new` e `/automations/[id]` — editor (`AutomationEditor.tsx`): canal, nome,
  prioridade, gatilho, keywords (chips), modo/tipo de match, negativas, posts específicos,
  primeira interação, cooldown/limite, quiet hours, ações ordenáveis (tipo, delay, variants
  editor, botões, quick replies, tag, sequência, webhook, prompt IA) + **Simulador** lateral
  (input texto/tipo/media → mostra gates e ações renderizadas).
- `SubstanceManager.tsx` (CRUD + importar JSON do n8n), `SequenceEditor.tsx` (steps com
  delay), `ContactsPanel.tsx` (busca/tags/pausa/notas), `InboxPanel.tsx` (timeline de
  IgEvent/IgActionLog com filtros), `AnalyticsPanel.tsx` (série + cliques + tabela por automação).
- Padrões: componentes iOS já existentes (`IOSButton`, `IOSComponents`, `IOSSwitch`,
  `IOSToast`), fetch client com `credentials:"include"`, estados de loading/erro PT-BR,
  acessibilidade (labels/aria) e responsivo.

## 13. IA (`ai.ts`)

- `generateReply({prompt, history, contact, maxChars})` usa `getOpenRouterConfig()` de
  `lib/ai.ts` (não editar `lib/ai.ts`), endpoint `OPENROUTER_API_URL`, timeout 25s,
  `temperature 0.6`, resposta texto limpo (remove fences/aspas). Sem chave → erro claro
  `OPENROUTER_API_KEY não configurada`.
- Sem chave configurada, a ação `ai_reply` falha com `IgActionLog.failed` e motivo claro
  (nunca derruba o webhook).

## 14. Migração n8n (`scripts/ig-migrate-n8n.mjs`)

- Uso: `node scripts/ig-migrate-n8n.mjs --file <workflow.json> --user <id> [--channel <username|id>]
  [--apply]` (default: dry-run imprime o plano; `--apply` grava via Prisma).
- Extrai do export:
  - nó `🧠 Identificar Substância` → catálogo `IgSubstance` (122 itens; `url =
    https://url.cunhov.site/{keyword}`; preservar `name/description/action/dosage/duration`).
  - pares `🔍 <tipo>: <Nome>` + `💬 Resposta: <Nome> (<tipo>)` → 1 automação por par
    (keywords do filtro, `match_type=contains`, trigger comment/dm, ações:
    comment → `private_reply` [template do nó, com botão] + `public_comment_reply` [default 15s,
    variants de `Isolar Mensagem`], dm → `dm_buttons`).
  - automação de substância → flag `settings.substanceCatalog=true` com texto template do nó.
- Ignora nós de token/Redis. Nunca imprime tokens.
- Testar com fixture sintético em `scripts/fixtures/` (sem segredos); validar contagem e mapeamento.

## 15. Gauntlet (bar de aceitação)

Harness `scripts/gauntlet/ig-automation-*.mjs|mts` + boot com `fetch-mock` (adicionar
`api.openrouter.ai` ao mock; hosts graph já existem). Cenários mínimos:

| # | Cenário | Esperado |
|---|---|---|
| G1 | GET verify ok/inválido | 200 challenge / 403 |
| G2 | POST assinatura inválida | 401, zero IgEvent |
| G3 | POST comentário válido → replay | 1º: private reply + job do reply público; replay: 0 chamadas novas |
| G4 | DM keyword | 1 DM; echo → pausa 24h; DM durante pausa → skipped |
| G5 | Cooldown 24h | 2º evento do mesmo contato sem envio |
| G6 | Quiet hours | skipped com motivo |
| G7 | media_ids + first_interaction_only | filtra corretamente após 1ª interação |
| G8 | Substância | texto renderizado com dados do catálogo |
| G9 | Sequência | enrollment criado; passo entregue quando due |
| G10 | `/r/[slug]` | 302 com UTM + contador incrementado |
| G11 | Outbound webhook | POST assinado com HMAC correto |
| G12 | IA fallback (OpenRouter mockado) | texto enviado; sem chave → failed claro |
| G13 | Subscription | POST /me/subscribed_apps com campos corretos; estado persistido |
| G14 | Auth | 401 sem sessão; dados de outro user inacessíveis |
| G15 | Rate limit 30/min | excedente vira job reagendado (`throttled`) |

## 16. Ownership por onda (swarm)

**Onda 1 (paralela):**
- `core-pure`: `lib/ig-automation/{types,normalize,matcher,render,limits,log}.ts`
- `graph-actions`: `lib/ig-automation/{graph,actions,ai,outbound,clicks}.ts`, `app/r/[slug]/route.ts`
- `api-crud`: `app/api/automations/**`, `app/api/ig/{substances,contacts,sequences,events,outbound-webhooks,analytics}/**`
- `ui`: `app/automations/**`, `components/ig-automation/**`, `components/Sidebar.tsx`

**Onda 2 (paralela):**
- `engine-webhook`: `lib/ig-automation/{webhook,engine,jobs,contacts,sequences,subscription}.ts`,
  `app/api/webhooks/instagram/route.ts`, `app/api/cron/automation/route.ts`, `worker/index.js`,
  `app/api/ig/webhook-status/route.ts`, `app/api/ig/settings/route.ts`,
  `app/api/channels/oauth/callback/route.ts` (aditivo)
- `migration`: `scripts/ig-migrate-n8n.mjs`, `scripts/fixtures/**`
- `gauntlet`: `scripts/gauntlet/ig-*`, `scripts/gauntlet/fetch-mock.mjs` (aditivo)

**Onda 3:** watcher (relatório), fixers por falha, crítico fresh-context, integrador/QA.

## 17. Verificação (comandos)

```bash
cd /tmp/opencode/autoreels-web        # working tree do swarm
source /root/.nvm/nvm.sh && nvm use 20.20.2
npx tsc --noEmit
npx eslint app/automations components/ig-automation lib/ig-automation app/api/automations app/api/ig app/api/webhooks/instagram app/r 2>/dev/null || true
npx prisma validate
DATABASE_URL=file:/tmp/opencode/ig-fresh.db npx prisma migrate deploy
npm run build
npx tsx scripts/gauntlet/ig-core.mts          # unit puro
bash scripts/gauntlet/ig-boot.sh              # e2e com Graph mockado
```
