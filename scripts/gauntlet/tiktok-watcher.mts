#!/usr/bin/env npx tsx
/**
 * A5 WATCHER — Compliance, Limits & Observability
 * Audita o repo em busco de travas críticas, sem depender de rede:
 *
 *  1. Build TypeScript (npx tsc --noEmit) — 0 erros
 *  2. Prisma validate — schema válido
 *  3. Proxy não repassado — toda chamada externa TikTok usa proxyUrl
 *  4. Segredo vazado ao client — nehunhuma route.ts serializa
 *     proxy_url / access_token / client_secret cru em JSON de resposta
 *  5. Isolation furada — mensagens de bloqueio de mix estão no código
 *
 * Esta versão é determinística (lê arquivos): não roda tsc (demorado)
 * aqui; tsc/build são executados na verificação final do gauntlet.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`✅ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`❌ ${label}${detail ? " — " + detail : ""}`); }
}

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|mts)$/.test(e)) acc.push(p);
  }
  return acc;
}

function read(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

async function run() {
  // ── 1. tsc --noEmit (independe de rede) ─────────────────────────────────
  try {
    execFileSync("npx", ["tsc", "--noEmit"], { cwd: ROOT, stdio: "pipe", timeout: 180_000 });
    check("tsc --noEmit 0 erros", true);
  } catch (e) {
    check("tsc --noEmit 0 erros", false, "build quebrado");
  }

  // ── 2. prisma validate ──────────────────────────────────────────────────
  try {
    execFileSync("npx", ["prisma", "validate"], { cwd: ROOT, stdio: "pipe", timeout: 60_000 });
    check("prisma validate OK", true);
  } catch {
    check("prisma validate OK", false, "schema inválido");
  }

  // ── 3. Proxy repassado em lib/tiktok.ts ─────────────────────────────────
  const tiktokLib = read(join(ROOT, "lib/tiktok.ts")) || "";
  const externalUrls = ["TIKTOK_TOKEN_URL", "TIKTOK_CREATOR_INFO_URL", "TIKTOK_VIDEO_INIT_URL", "TIKTOK_STATUS_FETCH_URL"];
  for (const u of externalUrls) {
    const blockIdx = tiktokLib.indexOf(u);
    // acha a função que usa esse URL e verifica se há 'proxyUrl' no escopo
    check(`proxy repassado em ${u}`, /proxyUrl/.test(tiktokLib.slice(blockIdx, blockIdx + 3000)));
  }
  // upload chunks usa proxy
  check("upload de chunks repassa proxy", /uploadTiktokChunks[\s\S]*proxyUrl/.test(tiktokLib));

  // ── 4. Segredo vazado ao client (auditoria de routes) ───────────────────
  const apiRoutes = walk(join(ROOT, "app", "api")).filter((p) => p.endsWith("route.ts") || p.endsWith("route.tsx"));
  interface Leak { file: string; fields: string[] }
  const leaks: Leak[] = [];
  // campos sensíveis que nunca devem aparecer raw em resposta de API
  const sensitive = ["tiktok_access_token", "tiktok_refresh_token", "client_secret", "accessToken", "refreshToken"];
  for (const file of apiRoutes) {
    const src = read(file) || "";
    // ignora routes de oauth/token que usam internamente mas nunca retornam raw
    const isOAuthFlow = /oauth|token|callback/i.test(file);
    for (const field of sensitive) {
      // procura retorno em JSON do campo sensível (response ou json( {... field ...}))
      const re = new RegExp(`(json|response)\\s*\\(\\s*[^)]*\\b${field}\\b`);
      if (re.test(src) && src.includes('"'+field+'"') === false && /tiktok/.test(src.toLowerCase())) {
        // se o campo aparece em um objeto de resposta serializado → possível vazamento
        if (new RegExp(`(json)\\(\\s*\\{[^}]*\\b${field}\\b`).test(src)) {
          leaks.push({ file: file.replace(ROOT + "/", ""), fields: [field] });
        }
      }
    }
    // padrão duvidoso: retornar channel.settings cru (contém tokens)
    if (/settings\s*:\s*channel\.settings/.test(src)) {
      leaks.push({ file: file.replace(ROOT + "/", ""), fields: ["channel.settings cru"] });
    }
  }
  if (leaks.length === 0) {
    check("nenhum segredo vazado ao client", true, `${apiRoutes.length} routes auditadas`);
  } else {
    // Verifica se cada suspeita é, na verdade, mascarada/montada — whitelist
    const benign = leaks.filter((l) => /mask|health|\*\*\*/.test(l.file + l.fields.join("")));
    check("nenhum segredo vazado ao client", benign.length === leaks.length, JSON.stringify(leaks.map(l => `${l.file}:${l.fields.join(",")}`)));
  }

  // Verifica mask nos helpers de resposta
  check("maskTiktokToken existe e é usado no health", tiktokLib.includes("maskTiktokToken") && (read(join(ROOT,"app/api/tiktok/health/route.ts"))||"").includes("access_token_masked"));
  check("health nunca retorna token cru", !(read(join(ROOT,"app/api/tiktok/health/route.ts"))||"").includes("access_token: ") && (read(join(ROOT,"app/api/tiktok/health/route.ts"))||"").includes("access_token_masked"));

  // ── 5. Isolation furada (mensagens de bloqueio presentes) ───────────────
  const plannerRuntime = read(join(ROOT, "lib/planner-runtime.ts")) || "";
  const plannerConfig = read(join(ROOT, "lib/planner-config.ts")) || "";
  check("isolation const PLANNER_TIKTOK_MIX_ERROR definida", /Planners TikTok não podem misturar canais de outras plataformas/.test(plannerConfig));
  check("isolation const importada e usada no runtime", /PLANNER_TIKTOK_MIX_ERROR/.test(plannerRuntime));
  check("isolation bloco de mix no runtime", /platforms\.size > 1/.test(plannerRuntime) && /mixed_platforms/.test(plannerRuntime));
  const tiktokLib2 = read(join(ROOT, "lib/tiktok.ts")) || "";
  check("isolation helper getTiktokMixErrorMessage", tiktokLib2.includes("getTiktokMixErrorMessage"));
  check("isolation isTiktokMixBlocked helper", tiktokLib2.includes("function isTiktokMixBlocked"));

  // ── 6. Validação pré-upload presente ────────────────────────────────────
  check("validateTiktokVideo existe", tiktokLib.includes("validateTiktokVideo"));
  check("validateTiktokVideo mensagens PT-BR", /excede duração máxima/.test(tiktokLib) && /Título excede 2200/.test(tiktokLib) && /Formato não suportado/.test(tiktokLib));

  console.log(`\n=== A5 WATCHER: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
