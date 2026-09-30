#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const DEFAULT_SUBSTANCE_URL_BASE = "https://url.cunhov.site/";
const FILTER_RE = /^\s*🔍\s*(Comentário|Direct)\s*:\s*(.+?)\s*$/u;
const SUBSTANCE_FILTER_LABEL = "Substância";
const ISOLAR_NODE_NAME = "📋 Isolar Mensagem";
const PUBLIC_REPLY_NODE_RE = /Responder Comentário \(No Post\)/;
const PLACEHOLDER_KEYS = new Set([
  "nome",
  "descricao",
  "acao",
  "dosagem",
  "duracao",
  "url",
]);

class CliError extends Error {}

function log(message = "") {
  console.log(`[ig-migrate-n8n] ${message}`);
}

function warn(message) {
  console.warn(`[ig-migrate-n8n] AVISO: ${message}`);
}

function usage() {
  console.log(`Uso: node scripts/ig-migrate-n8n.mjs --file <workflow.json> --user <userId> [opções]

Opções:
  --file <path>                    Export JSON do workflow n8n (obrigatório)
  --user <id>                      userId dono dos canais/automações (obrigatório)
  --channel <username|canalId>     Canal alvo (username, @username, account_id ou id)
  --all-channels                   Aplica em todos os canais IG ativos do usuário
  --apply                          Grava no banco (default: dry-run)
  --force                          Atualiza automações existentes com o mesmo nome
  --substance-url-base <base>      Base da URL do catálogo (default: ${DEFAULT_SUBSTANCE_URL_BASE})
  --i-know                         Confirma execução contra DATABASE_URL de produção
  --help                           Mostra esta ajuda

Regras:
  - Sem --channel: dry-run lista os canais IG ativos; --apply exige --channel ou --all-channels.
  - DATABASE_URL é obrigatório (ex.: file:/tmp/opencode/mig-test.db).
  - Path de produção (/app/data/prod.db ou autoreels-data) exige --i-know.`);
}

function parseArgs(argv) {
  const opts = {
    file: null,
    userId: null,
    channel: null,
    allChannels: false,
    apply: false,
    force: false,
    substanceUrlBase: DEFAULT_SUBSTANCE_URL_BASE,
    iKnow: false,
    help: false,
  };
  const valueOptions = new Set([
    "--file",
    "--user",
    "--channel",
    "--substance-url-base",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let name = arg;
    let inlineValue = null;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      i += 1;
      if (i >= argv.length) throw new CliError(`opção ${name} exige um valor`);
      return argv[i];
    };
    if (name === "--help" || name === "-h") opts.help = true;
    else if (name === "--apply") opts.apply = true;
    else if (name === "--force") opts.force = true;
    else if (name === "--all-channels") opts.allChannels = true;
    else if (name === "--i-know") opts.iKnow = true;
    else if (valueOptions.has(name)) {
      const value = takeValue();
      if (name === "--file") opts.file = value;
      else if (name === "--user") opts.userId = value;
      else if (name === "--channel") opts.channel = value;
      else opts.substanceUrlBase = value;
    } else {
      throw new CliError(`opção desconhecida: ${arg}`);
    }
  }
  if (opts.channel && opts.allChannels) {
    throw new CliError("use --channel OU --all-channels, não os dois");
  }
  if (opts.substanceUrlBase && !opts.substanceUrlBase.endsWith("/")) {
    opts.substanceUrlBase = `${opts.substanceUrlBase}/`;
  }
  return opts;
}

function requireDatabaseUrl() {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    throw new CliError(
      "DATABASE_URL é obrigatório (ex.: DATABASE_URL=file:/tmp/opencode/mig-test.db)",
    );
  }
  return url;
}

function assertProdGuard(databaseUrl, iKnow) {
  const normalized = databaseUrl.toLowerCase();
  const looksProd =
    normalized.includes("/app/data/prod.db") ||
    normalized.includes("autoreels-data");
  if (looksProd && !iKnow) {
    throw new CliError(
      "DATABASE_URL aponta para produção (contém '/app/data/prod.db' ou 'autoreels-data'). " +
        "Confirme com --i-know se for intencional.",
    );
  }
}

function loadWorkflow(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new CliError(`não foi possível ler o arquivo "${file}": ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`JSON inválido em "${file}": ${error.message}`);
  }
  if (!parsed || !Array.isArray(parsed.nodes)) {
    throw new CliError(`workflow inválido em "${file}": campo "nodes" ausente ou não é array`);
  }
  const connections =
    parsed.connections && typeof parsed.connections === "object" && !Array.isArray(parsed.connections)
      ? parsed.connections
      : {};
  return { nodes: parsed.nodes, connections };
}

function findNode(nodes, name) {
  if (!name) return null;
  return nodes.find((node) => node && node.name === name) ?? null;
}

function targetsOf(connections, nodeName) {
  const result = [];
  const connection = connections[nodeName];
  if (!connection || typeof connection !== "object") return result;
  for (const branches of Object.values(connection)) {
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!Array.isArray(branch)) continue;
      for (const link of branch) {
        if (link && typeof link.node === "string") result.push(link.node);
      }
    }
  }
  return result;
}

function reachesNode(connections, from, target, maxDepth = 12) {
  if (!from || !target) return false;
  const queue = [{ name: from, depth: 0 }];
  const seen = new Set();
  while (queue.length > 0) {
    const { name, depth } = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    if (depth > 0 && name === target) return true;
    if (depth >= maxDepth) continue;
    for (const next of targetsOf(connections, name)) {
      queue.push({ name: next, depth: depth + 1 });
    }
  }
  return false;
}

function findMatchingBracket(text, start) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractSubstances(nodes) {
  const node =
    nodes.find(
      (candidate) =>
        candidate &&
        typeof candidate.parameters?.jsCode === "string" &&
        candidate.parameters.jsCode.includes("const substances"),
    ) ?? findNode(nodes, "🧠 Identificar Substância");
  if (!node) {
    return { node: null, substances: [], warning: "nó 🧠 Identificar Substância não encontrado" };
  }
  const code = typeof node.parameters?.jsCode === "string" ? node.parameters.jsCode : "";
  const declaration = code.indexOf("const substances");
  if (declaration < 0) {
    return { node, substances: [], warning: "array 'const substances' não encontrado no nó de substâncias" };
  }
  const start = code.indexOf("[", declaration);
  const end = start >= 0 ? findMatchingBracket(code, start) : -1;
  if (start < 0 || end < 0) {
    return { node, substances: [], warning: "array de substâncias malformado no nó de substâncias" };
  }
  let parsed;
  try {
    parsed = JSON.parse(code.slice(start, end + 1));
  } catch (error) {
    return { node, substances: [], warning: `JSON de substâncias inválido: ${error.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { node, substances: [], warning: "array de substâncias inválido" };
  }
  const substances = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const keyword = String(item.keyword ?? "").trim();
    if (!keyword) continue;
    const keywords = Array.isArray(item.keywords)
      ? item.keywords.map((kw) => String(kw).trim()).filter(Boolean)
      : [];
    substances.push({
      keyword,
      name: String(item.name ?? keyword).trim() || keyword,
      keywords,
      description: String(item.description ?? ""),
      action: String(item.action ?? ""),
      dosage: String(item.dosage ?? ""),
      duration: String(item.duration ?? ""),
    });
  }
  return { node, substances, warning: null };
}

function extractConditionGroup(node) {
  const group = node?.parameters?.conditions;
  if (Array.isArray(group)) return { conditions: group, combinator: "or" };
  if (group && Array.isArray(group.conditions)) {
    return { conditions: group.conditions, combinator: group.combinator ?? "or" };
  }
  return { conditions: [], combinator: "or" };
}

function mapMatchType(conditions) {
  const operations = conditions
    .map((condition) => condition?.operator?.operation)
    .filter((operation) => typeof operation === "string");
  if (operations.length === 0) return "contains";
  if (operations.every((operation) => operation === "regex" || operation === "regexp")) return "regex";
  if (operations.every((operation) => operation === "startsWith" || operation === "starts_with")) return "starts_with";
  if (operations.every((operation) => operation === "equals" || operation === "equal")) return "exact";
  return "contains";
}

function extractKeywords(node, kind) {
  const { conditions, combinator } = extractConditionGroup(node);
  const keywords = [];
  for (const condition of conditions) {
    if (!condition || typeof condition !== "object") continue;
    const operation = condition.operator?.operation;
    if (typeof operation === "string" && ["notEmpty", "empty", "exists", "notExists"].includes(operation)) {
      continue;
    }
    const left = typeof condition.leftValue === "string" ? condition.leftValue : "";
    const leftOk = kind === "comment" ? /mensagem/.test(left) : /direct_message/.test(left);
    if (!leftOk) continue;
    const right = typeof condition.rightValue === "string" ? condition.rightValue.trim() : "";
    if (right && !keywords.includes(right)) keywords.push(right);
  }
  return {
    keywords,
    matchMode: combinator === "and" ? "all" : "any",
    matchType: mapMatchType(conditions),
  };
}

function normalizeButtons(raw) {
  if (!Array.isArray(raw)) return [];
  const buttons = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") continue;
    const type = candidate.type === "postback" ? "postback" : candidate.type === "web_url" ? "web_url" : null;
    if (!type) continue;
    const title = typeof candidate.title === "string" ? candidate.title : "";
    if (!title) continue;
    const button = { type, title };
    if (typeof candidate.url === "string" && candidate.url) button.url = candidate.url;
    if (typeof candidate.payload === "string" && candidate.payload) button.payload = candidate.payload;
    buttons.push(button);
  }
  return buttons;
}

function parseBodyFallback(text) {
  const textMatch = text.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!textMatch) return null;
  let decoded = textMatch[1];
  try {
    decoded = JSON.parse(`"${textMatch[1]}"`);
  } catch {
    decoded = textMatch[1];
  }
  return { message: { text: decoded } };
}

function parseResponseNode(node) {
  const rawBody = node?.parameters?.jsonBody;
  let body = null;
  if (rawBody && typeof rawBody === "object") {
    body = rawBody;
  } else if (typeof rawBody === "string") {
    const cleaned = rawBody.replace(/^\s*=/, "");
    try {
      body = JSON.parse(cleaned);
    } catch {
      body = parseBodyFallback(cleaned);
    }
  }
  const message = body?.message && typeof body.message === "object" ? body.message : {};
  const payload = message.attachment?.payload ?? null;
  const text =
    typeof payload?.text === "string"
      ? payload.text
      : typeof message.text === "string"
        ? message.text
        : "";
  const recipient = body?.recipient && typeof body.recipient === "object" ? body.recipient : {};
  const target =
    recipient.comment_id != null ? "comment" : recipient.id != null ? "dm" : "unknown";
  return {
    text,
    buttons: normalizeButtons(payload?.buttons),
    target,
    url: typeof node?.parameters?.url === "string" ? node.parameters.url : "",
  };
}

function convertPlaceholders(value) {
  if (typeof value !== "string" || value === "") return value;
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (full, expression) => {
    const match = expression.match(/substancia(?:\[['"]([A-Za-z_]+)['"]\]|\.([A-Za-z_]+))/);
    if (!match) return full;
    const key = String(match[1] ?? match[2] ?? "").toLowerCase();
    return PLACEHOLDER_KEYS.has(key) ? `{substancia.${key}}` : full;
  });
}

function findResponseForFilter(nodes, connections, filterName, label, kind) {
  const expectedSuffix = kind === "comment" ? "(Comentário)" : "(Direct)";
  const candidates = targetsOf(connections, filterName)
    .map((name) => findNode(nodes, name))
    .filter((candidate) => candidate && candidate.parameters?.jsonBody != null);
  const preferred = candidates.find((candidate) => {
    const name = String(candidate.name ?? "");
    return name.includes(label) && name.includes(expectedSuffix);
  });
  return preferred ?? candidates[0] ?? null;
}

function buildAction(type, position, text, buttons) {
  const variants = text ? [text] : [];
  const action = {
    type,
    position,
    delay_seconds: 0,
    text_variants: variants,
    buttons: buttons.length > 0 ? buttons : null,
  };
  return action;
}

function buildPairActions(kind, response, publicVariants) {
  const text = convertPlaceholders(response.text);
  const buttons = response.buttons.map((button) => {
    const converted = { ...button };
    converted.title = convertPlaceholders(button.title);
    if (typeof button.url === "string") converted.url = convertPlaceholders(button.url);
    return converted;
  });
  const actions = [];
  if (kind === "comment") {
    if (text || buttons.length > 0) actions.push(buildAction("private_reply", actions.length, text, buttons));
    if (publicVariants.length > 0) {
      actions.push({
        type: "public_comment_reply",
        position: actions.length,
        delay_seconds: 15,
        text_variants: publicVariants,
        buttons: null,
      });
    }
  } else if (text || buttons.length > 0) {
    actions.push(buildAction(buttons.length > 0 ? "dm_buttons" : "dm_text", actions.length, text, buttons));
  }
  return actions;
}

function extractPublicVariants(nodes) {
  const node = findNode(nodes, ISOLAR_NODE_NAME);
  if (!node) return [];
  const params = node.parameters ?? {};
  const lists = [params.assignments?.assignments, params.assignments?.values, params.values];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const assignment of list) {
      if (!assignment || assignment.name !== "mensagens") continue;
      if (typeof assignment.value !== "string") continue;
      const cleaned = assignment.value.replace(/^\s*=/, "");
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      return parsed
        .map((item) => (item && typeof item.texto === "string" ? convertPlaceholders(item.texto) : null))
        .filter(Boolean);
    }
  }
  return [];
}

function hasPublicCommentChain(nodes, connections, responseNodeName) {
  const isolar = findNode(nodes, ISOLAR_NODE_NAME);
  const publicReply = nodes.find((node) => PUBLIC_REPLY_NODE_RE.test(String(node?.name ?? ""))) ?? null;
  if (!isolar || !publicReply || !responseNodeName) return false;
  return (
    reachesNode(connections, responseNodeName, isolar.name) &&
    reachesNode(connections, isolar.name, publicReply.name)
  );
}

function extractAutomations(nodes, connections, warnings) {
  const automations = [];
  const usedNames = new Set();
  const publicVariants = extractPublicVariants(nodes);
  for (const node of nodes) {
    const match = FILTER_RE.exec(String(node?.name ?? ""));
    if (!match) continue;
    const kind = match[1] === "Direct" ? "dm" : "comment";
    const label = match[2].trim();
    if (label === SUBSTANCE_FILTER_LABEL) continue;
    const responseNode = findResponseForFilter(nodes, connections, node.name, label, kind);
    if (!responseNode) {
      warnings.push(`filtro "${node.name}" sem nó de resposta HTTP conectado — par ignorado`);
      continue;
    }
    const response = parseResponseNode(responseNode);
    if (response.target !== "unknown" && response.target !== (kind === "comment" ? "comment" : "dm")) {
      warnings.push(
        `filtro "${node.name}" responde para destinatário "${response.target}" diferente do esperado (${kind})`,
      );
    }
    const conditionInfo = extractKeywords(node, kind);
    if (conditionInfo.keywords.length === 0 && !/Substância/.test(label)) {
      warnings.push(`filtro "${node.name}" sem keywords reconhecidas — automação criada com match universal`);
    }
    const baseName = `N8N ${label}`;
    let name = baseName;
    if (kind === "dm" && usedNames.has(baseName)) name = `${baseName} (Direct)`;
    usedNames.add(name);
    const variants = kind === "comment" ? publicVariants : [];
    if (kind === "comment" && variants.length === 0) {
      warnings.push(`filtro "${node.name}": cadeia Wait → Isolar Mensagem → Responder Comentário ausente — sem public_comment_reply`);
    }
    automations.push({
      name,
      label,
      trigger: kind === "comment" ? "comment" : "dm",
      keywords: conditionInfo.keywords,
      matchMode: conditionInfo.matchMode,
      matchType: conditionInfo.matchType,
      settings: null,
      actions: buildPairActions(kind, response, variants),
      source: responseNode.name,
      kindLabel: kind,
    });
  }
  return automations;
}

function extractSubstanceAutomations(nodes, connections, publicVariants, warnings) {
  const plans = [
    {
      filter: "🔍 Comentário: Substância",
      response: "💬 Resposta: Substância (Comentário)",
      name: "N8N Substâncias (Comentário)",
      trigger: "comment",
      kind: "comment",
    },
    {
      filter: "🔍 Direct: Substância",
      response: "💬 Resposta: Substância (Direct)",
      name: "N8N Substâncias (Direct)",
      trigger: "dm",
      kind: "dm",
    },
  ];
  const automations = [];
  for (const plan of plans) {
    const filterNode = findNode(nodes, plan.filter);
    const responseNode = findNode(nodes, plan.response);
    if (!filterNode && !responseNode) continue;
    if (!responseNode) {
      warnings.push(`nó "${plan.response}" não encontrado — automação de substâncias ignorada`);
      continue;
    }
    const response = parseResponseNode(responseNode);
    const chainOk =
      plan.kind === "comment" &&
      Boolean(filterNode) &&
      hasPublicCommentChain(nodes, connections, filterNode.name);
    if (plan.kind === "comment" && !chainOk) {
      warnings.push(
        `cadeia pública ${ISOLAR_NODE_NAME} não confirmada para "${plan.filter}" — sem public_comment_reply`,
      );
    }
    automations.push({
      name: plan.name,
      label: "Substâncias",
      trigger: plan.trigger,
      keywords: [],
      matchMode: "any",
      matchType: "contains",
      settings: { substanceCatalog: true },
      actions: buildPairActions(plan.kind, response, chainOk ? publicVariants : []),
      source: responseNode.name,
      kindLabel: plan.kind,
    });
  }
  return automations;
}

async function resolveUser(prisma, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true },
  });
  if (!user) throw new CliError(`usuário "${userId}" não encontrado no banco`);
  return user;
}

function formatChannel(channel) {
  if (channel.username) return `@${channel.username} (id=${channel.id})`;
  return `id=${channel.id}`;
}

async function resolveChannels(prisma, opts) {
  const channels = await prisma.channel.findMany({
    where: { user_id: opts.userId, platform: "instagram" },
    orderBy: { created_at: "asc" },
  });
  const active = channels.filter((channel) => channel.status === "active");
  if (opts.channel) {
    const needle = opts.channel.replace(/^@/, "").toLowerCase();
    const found = channels.find(
      (channel) =>
        channel.id === opts.channel ||
        channel.account_id === opts.channel ||
        String(channel.username ?? "").replace(/^@/, "").toLowerCase() === needle,
    );
    if (!found) {
      const available = channels.map(formatChannel).join(", ") || "nenhum";
      throw new CliError(
        `canal "${opts.channel}" não encontrado para o usuário ${opts.userId} — canais IG: ${available}`,
      );
    }
    if (found.status !== "active") warn(`canal ${formatChannel(found)} não está ativo (status=${found.status})`);
    return [found];
  }
  if (active.length === 0) {
    throw new CliError("nenhum canal IG ativo encontrado para o usuário — use --channel <username|id> ou --all-channels");
  }
  return active;
}

async function loadSubstanceStatus(prisma, substances) {
  const status = new Map();
  for (const substance of substances) {
    const existing = await prisma.igSubstance.findUnique({ where: { keyword: substance.keyword } });
    status.set(substance.keyword, existing ? (existing.user_id === null ? "global" : "outro") : "novo");
  }
  return status;
}

async function loadAutomationStatus(prisma, channel, automations) {
  const existing = await prisma.igAutomation.findMany({
    where: { channel_id: channel.id },
    select: { name: true },
  });
  const names = new Set(existing.map((row) => row.name));
  const status = new Map();
  for (const automation of automations) {
    status.set(automation.name, names.has(automation.name) ? "existente" : "nova");
  }
  return status;
}

function summarizeText(text, max = 72) {
  const single = String(text ?? "").replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}

function summarizeActions(actions) {
  if (actions.length === 0) return ["(sem ações mapeadas)"];
  return actions.map((action) => {
    const bits = [`delay=${action.delay_seconds ?? 0}s`];
    if (action.buttons?.length) bits.push(`botões=${action.buttons.length}`);
    if (action.text_variants?.length) bits.push(`variants=${action.text_variants.length}`);
    const preview = action.text_variants?.length ? ` | "${summarizeText(action.text_variants[0])}"` : "";
    return `    #${action.position} ${action.type} ${bits.join(" ")}${preview}`;
  });
}

function printPlan(plan, channels, substanceStatus, automationStatus) {
  log(`modo=${plan.apply ? "APPLY" : "DRY-RUN"}${plan.force ? " + --force" : ""} arquivo=${plan.file}`);
  log(`usuário=${plan.user.id}${plan.user.name ? ` (${plan.user.name})` : ""}`);
  log("");
  const counts = { novo: 0, global: 0, outro: 0 };
  for (const status of substanceStatus.values()) counts[status] += 1;
  log(
    `Substâncias (catálogo global): ${plan.substances.length} no workflow — ${counts.novo} a criar, ` +
      `${counts.global + counts.outro} já existentes`,
  );
  for (const substance of plan.substances) {
    const status = substanceStatus.get(substance.keyword);
    const marker = status === "novo" ? "+" : "=";
    const note =
      status === "global" ? " [existente: global protegido, não altera]" : status === "outro" ? " [existente: outro usuário, não altera]" : "";
    log(
      `  ${marker} ${substance.keyword} | ${substance.name} | keywords=[${substance.keywords.join(", ")}]` +
        ` | url=${substance.url}${note}`,
    );
  }
  log("");
  log("Automações por canal:");
  for (const channel of channels) {
    log(`  Canal ${formatChannel(channel)}`);
    const status = automationStatus.get(channel.id);
    for (const automation of plan.automations) {
      const current = status.get(automation.name);
      let marker;
      if (current === "nova") marker = "[criar]";
      else if (plan.force) marker = plan.apply ? "[atualizar]" : "[atualizar (dry-run)]";
      else marker = "[pular: já existe]";
      log(
        `    ${marker} ${automation.name} — trigger=${automation.trigger} match=${automation.matchType}/${automation.matchMode}` +
          ` keywords=[${automation.keywords.join(", ")}]${automation.settings ? ` settings=${JSON.stringify(automation.settings)}` : ""}`,
      );
      if (current === "existente" && !plan.force) log("      motivo: mesmo nome no canal (use --force para atualizar actions)");
      for (const line of summarizeActions(automation.actions)) log(line);
    }
  }
  if (plan.warnings.length > 0) {
    log("");
    log("Avisos:");
    for (const message of plan.warnings) warn(message);
  }
}

function actionDbData(action) {
  return {
    position: action.position,
    type: action.type,
    delay_seconds: action.delay_seconds ?? 0,
    text_variants: action.text_variants?.length ? JSON.stringify(action.text_variants) : null,
    buttons: action.buttons?.length ? JSON.stringify(action.buttons) : null,
  };
}

function automationDbData(plan, channel, automation) {
  return {
    user_id: plan.user.id,
    channel_id: channel.id,
    name: automation.name,
    enabled: true,
    priority: 0,
    trigger: automation.trigger,
    keywords: JSON.stringify(automation.keywords),
    match_mode: automation.matchMode,
    match_type: automation.matchType,
    negative_keywords: null,
    media_ids: null,
    first_interaction_only: false,
    cooldown_hours: null,
    daily_limit: null,
    quiet_hours: null,
    settings: automation.settings ? JSON.stringify(automation.settings) : null,
  };
}

async function applyPlan(prisma, plan, channels) {
  const counters = {
    substancesCreated: 0,
    substancesSkipped: 0,
    automationsCreated: 0,
    automationsUpdated: 0,
    automationsSkipped: 0,
  };
  for (const substance of plan.substances) {
    const existing = await prisma.igSubstance.findUnique({ where: { keyword: substance.keyword } });
    if (existing) {
      counters.substancesSkipped += 1;
      continue;
    }
    await prisma.igSubstance.create({
      data: {
        user_id: null,
        keyword: substance.keyword,
        name: substance.name,
        keywords: JSON.stringify(substance.keywords),
        description: substance.description,
        action: substance.action,
        dosage: substance.dosage,
        duration: substance.duration,
        url: substance.url,
        enabled: true,
      },
    });
    counters.substancesCreated += 1;
  }
  for (const channel of channels) {
    for (const automation of plan.automations) {
      const existing = await prisma.igAutomation.findFirst({
        where: { channel_id: channel.id, name: automation.name },
        select: { id: true },
      });
      const base = automationDbData(plan, channel, automation);
      const actionsCreate = automation.actions.map(actionDbData);
      if (!existing) {
        await prisma.igAutomation.create({
          data: { ...base, actions: { create: actionsCreate } },
        });
        counters.automationsCreated += 1;
      } else if (!plan.force) {
        counters.automationsSkipped += 1;
      } else {
        await prisma.igAutomation.update({
          where: { id: existing.id },
          data: {
            ...base,
            stats_sent: 0,
            stats_matched: 0,
            stats_failed: 0,
            stats_clicks: 0,
            actions: { deleteMany: {}, create: actionsCreate },
          },
        });
        counters.automationsUpdated += 1;
      }
    }
  }
  return counters;
}

function validatePlan(plan) {
  if (plan.substances.length === 0 && plan.automations.length === 0) {
    throw new CliError("nada para migrar: nenhuma substância ou automação reconhecida no workflow");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!opts.file) throw new CliError("--file é obrigatório (export JSON do workflow n8n)");
  if (!opts.userId) throw new CliError("--user é obrigatório (userId dono do canal)");
  const databaseUrl = requireDatabaseUrl();
  assertProdGuard(databaseUrl, opts.iKnow);
  if (opts.apply && !opts.channel && !opts.allChannels) {
    throw new CliError("com --apply informe --channel <username|id> ou --all-channels");
  }

  const { nodes, connections } = loadWorkflow(opts.file);
  const warnings = [];
  const substanceInfo = extractSubstances(nodes);
  if (substanceInfo.warning) warnings.push(substanceInfo.warning);
  const substances = substanceInfo.substances.map((substance) => ({
    ...substance,
    url: `${opts.substanceUrlBase}${substance.keyword}`,
  }));
  const publicVariants = extractPublicVariants(nodes);
  if (substanceInfo.node && publicVariants.length === 0) {
    warnings.push(`${ISOLAR_NODE_NAME}: nenhuma variant encontrada`);
  }
  const specificAutomations = extractAutomations(nodes, connections, warnings);
  const substanceAutomations =
    substances.length > 0
      ? extractSubstanceAutomations(nodes, connections, publicVariants, warnings)
      : [];
  const automations = [...specificAutomations, ...substanceAutomations];

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter, log: ["error"] });
  try {
    const user = await resolveUser(prisma, opts.userId);
    const channels = await resolveChannels(prisma, opts);
    if (!opts.channel && !opts.apply) {
      warn(
        `--channel não informado: planejando dry-run para ${channels.length} canal(is) IG ativo(s). ` +
          "Para gravar use --channel <username|id> ou --all-channels.",
      );
    }
    const plan = {
      file: opts.file,
      user,
      substances,
      automations,
      warnings,
      apply: opts.apply,
      force: opts.force,
    };
    validatePlan(plan);
    const substanceStatus = await loadSubstanceStatus(prisma, substances);
    const automationStatus = new Map();
    for (const channel of channels) {
      automationStatus.set(channel.id, await loadAutomationStatus(prisma, channel, automations));
    }
    printPlan(plan, channels, substanceStatus, automationStatus);
    if (!opts.apply) {
      log("");
      log("Dry-run concluído — nada foi gravado. Use --apply para escrever.");
      return;
    }
    const counters = await applyPlan(prisma, plan, channels);
    log("");
    log(
      `APPLY concluído: substâncias ${counters.substancesCreated} criadas / ${counters.substancesSkipped} existentes; ` +
        `automações ${counters.automationsCreated} criadas / ${counters.automationsUpdated} atualizadas / ` +
        `${counters.automationsSkipped} puladas.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(`\n[ig-migrate-n8n] ERRO: ${error.message}\n`);
  } else {
    console.error("\n[ig-migrate-n8n] ERRO inesperado:", error);
  }
  process.exitCode = 1;
});
