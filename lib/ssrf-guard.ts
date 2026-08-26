/**
 * Guardas SSRF compartilhados entre app/api/import-url e o cron publisher.
 *
 * O publisher baixa URLs absolutas de mídia (ex.: conteúdo da biblioteca com
 * `url` http(s) externo) ao publicar posts da Comunidade do YouTube — o MESMO
 * vetor que app/api/import-url já mitigava no momento da importação. Como o
 * owner de um conteúdo consegue gravar qualquer URL http(s) em um content item
 * (validação de storage só checa o esquema), o fetch do cron reexecuta a
 * mesma validação: rejeita loopback / link-local / privado / reservado.
 */

import { lookup } from "dns/promises";

/**
 * SSRF guard — reject loopback / link-local / private / reserved addresses.
 * Returns true when the address is NOT reachable from outside (blocked).
 */
function isBlockedAddress(ip: string): boolean {
    const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, ""); // strip IPv4-mapped prefix
    if (normalized === "" || normalized === "::" || normalized === "::1" || normalized === "0.0.0.0") return true;
    // IPv6 link-local / unique-local / loopback / unspecified
    if (normalized.includes(":")) {
        if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
        return false; // other IPv6 — allow (public ranges)
    }
    // IPv4
    const parts = normalized.split(".").map(Number);
    if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // 127.0.0.0/8 (loopback)
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 169 && b === 254) return true;         // 169.254.0.0/16 (link-local)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    return false;
}

/** Reject private/loopback hostnames up-front (fast path, before DNS). */
function isBlockedHostname(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (
        h === "localhost" ||
        h === "localhost.localdomain" ||
        h.endsWith(".local") ||
        h.endsWith(".internal") ||
        h.endsWith(".home.arpa")
    ) return true;
    // IP-literal hostnames
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isBlockedAddress(h);
    if (h.includes(":")) return isBlockedAddress(h);
    // Private ranges as bare hostnames (e.g. http://10.0.0.1/x)
    if (
        /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
        /^169\.254\./.test(h) || /^0\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    ) return true;
    return false;
}

/**
 * Validate that a host is publicly reachable (SSRF guard).
 * - Rejects private/loopback hostnames and IP literals (returns false).
 * - Resolves DNS and rejects if ANY resolved address is private/loopback.
 * - If the DNS lookup ITSELF fails (transient — NXDOMAIN propagation, resolver
 *   outage, ENOTFOUND), it THROWS instead of returning false: callers that map
 *   `false` to a definitive error would otherwise burn a permanently-failed
 *   post on a transient DNS blip (see publisher: uma pane de DNS em
 *   readCommunityImage virava "Host não é publicamente acessível" definitivo).
 *   Erros de resolução devem ser retentáveis; só endereços REALMENTE
 *   privados/loopback são bloqueio definitivo.
 */
export async function isHostAllowed(hostname: string): Promise<boolean> {
    if (isBlockedHostname(hostname)) return false;

    const literal = hostname.replace(/^\[|\]$/g, "");
    // Pure IP literal — validated above by isBlockedHostname; nothing more to resolve
    if (/^\d+\.\d+\.\d+\.\d+$/.test(literal) || literal.includes(":")) return true;

    try {
        const addresses = await lookup(hostname, { all: true });
        if (addresses.length === 0) {
            // Nenhum endereço resolvido — indistinguível de falha transitória
            // do resolver; lança para o caller tratar como retryável.
            throw new Error(
                `Falha ao resolver o host ${hostname}: nenhum endereço encontrado`,
            );
        }
        return addresses.every(({ address }) => !isBlockedAddress(address));
    } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("Falha ao resolver")) {
            throw err;
        }
        // DNS lookup failure (ENOTFOUND/ETIMEDOUT/EAI_AGAIN…) — transiente.
        throw new Error(
            `Falha ao resolver o host ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}