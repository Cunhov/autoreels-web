import { createHash, timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison.
 * Both inputs are SHA-256 hashed first so that length differences don't leak
 * timing information and so inputs of different lengths can be compared safely.
 */
export function safeEqual(a: string, b: string): boolean {
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);
}
