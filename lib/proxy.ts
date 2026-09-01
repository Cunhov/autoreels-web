/**
 * lib/proxy.ts — proxy por canal (HTTP/HTTPS)
 * Suporta http://user:pass@host:porta
 * NUNCA expor proxy_url cru ao client.
 */

export interface ParsedProxy {
  protocol: "http:" | "https:";
  host: string;
  port: number;
  username?: string;
  password?: string;
  raw: string;
}

/**
 * Valida formato: http:// ou https:// com host e porta
 */
export function isValidProxyUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname) return false;
    if (!u.port) return false;
    const portNum = Number(u.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return false;
    return true;
  } catch {
    return false;
  }
}

export function parseProxyUrl(url: string): ParsedProxy | null {
  if (!isValidProxyUrl(url)) return null;
  try {
    const u = new URL(url.trim());
    const portNum = Number(u.port);
    return {
      protocol: u.protocol as "http:" | "https:",
      host: u.hostname,
      port: portNum,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      raw: url.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Mascara senha: http://user:***@host:porta
 * Se não houver auth, retorna host:port mascarado parcial
 */
export function maskProxyUrl(url: string | null | undefined): string {
  if (!url || typeof url !== "string" || !url.trim()) return "";
  try {
    const u = new URL(url.trim());
    if (u.password) {
      u.password = "***";
    } else if (u.username) {
      // tem user sem senha — mantém user visível
    }
    // URL.toString() adiciona / no final se não houver path; remover
    let masked = u.toString();
    // Se original não tinha path "/" explícito, remover trailing /
    const originalHasPath = (() => {
      try {
        const orig = new URL(url.trim());
        return orig.pathname !== "/" || orig.search || orig.hash;
      } catch { return false; }
    })();
    if (!originalHasPath && masked.endsWith("/") && !url.trim().endsWith("/")) {
      masked = masked.slice(0, -1);
    }
    return masked;
  } catch {
    // fallback: esconde tudo após ://
    const idx = url.indexOf("://");
    if (idx !== -1) {
      const after = url.slice(idx + 3);
      const atIdx = after.indexOf("@");
      if (atIdx !== -1) return url.slice(0, idx + 3) + "***@" + after.slice(atIdx + 1);
    }
    return "***";
  }
}

/**
 * Retorna dispatcher para fetch via proxy.
 * Tenta usar undici ProxyAgent se disponível, senão retorna undefined
 * (fetch sem proxy, mas loga warning).
 * O caller deve passar dispatcher em options.dispatcher.
 */
export function getProxyDispatcher(proxyUrl: string | null | undefined): unknown | undefined {
  if (!proxyUrl || !isValidProxyUrl(proxyUrl)) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require("undici") as { ProxyAgent?: new (url: string) => unknown };
    if (undici?.ProxyAgent) {
      // @ts-ignore
      return new undici.ProxyAgent(proxyUrl.trim());
    }
  } catch {
    // undici não disponível
  }
  // Fallback: tenta import dinâmico ESM
  // Se não houver ProxyAgent, retorna undefined e caller faz fetch direto
  // (não quebra; apenas sem proxy). Em produção, instalar undici resolve.
  console.warn("[proxy] ProxyAgent não disponível — instale 'undici' para suporte a proxy. Proxy ignorado:", maskProxyUrl(proxyUrl));
  return undefined;
}

/**
 * Extrai proxy_url do Channel.settings JSON ou coluna dedicada.
 * Preferência: coluna proxy_url; fallback para settings.proxy_url
 */
export function getChannelProxyUrl(channel: { proxy_url?: string | null; settings?: string | null } | null | undefined): string | null {
  if (!channel) return null;
  // coluna dedicada tem prioridade
  if (typeof (channel as any).proxy_url === "string" && (channel as any).proxy_url.trim()) {
    const v = (channel as any).proxy_url.trim();
    if (isValidProxyUrl(v)) return v;
  }
  // fallback: settings JSON
  if (channel.settings) {
    try {
      const parsed = JSON.parse(channel.settings) as Record<string, unknown>;
      const fromSettings = parsed.proxy_url;
      if (typeof fromSettings === "string" && fromSettings.trim() && isValidProxyUrl(fromSettings.trim())) {
        return fromSettings.trim();
      }
      // também suporta proxyUrl camelCase legado
      const alt = (parsed as any).proxyUrl;
      if (typeof alt === "string" && alt.trim() && isValidProxyUrl(alt.trim())) return alt.trim();
    } catch {}
  }
  return null;
}
