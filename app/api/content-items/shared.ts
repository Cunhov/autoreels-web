/**
 * Normalize a raw tags value into a JSON array string.
 * BK-12 split por vírgula e trim cada tag, BK-07 escape HTML/sanitize, BK-16 safeJsonParse
 */
import { escapeHtml, safeJsonParse } from "@/lib/sanitize";

export function normalizeTags(value: unknown): string {
    if (value === undefined || value === null) return "[]";

    let parsed: unknown = value;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed || trimmed === "[]") return "[]";
        const maybeJson = safeJsonParse<unknown>(trimmed, "__not_json__" as unknown);
        if (maybeJson !== "__not_json__" && Array.isArray(maybeJson)) {
            parsed = maybeJson;
        } else if (maybeJson !== "__not_json__" && typeof maybeJson === "string") {
            parsed = [maybeJson];
        } else {
            // Not JSON — treat as comma-separated list BK-12 split + trim cada tag
            parsed = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
        }
    }

    if (!Array.isArray(parsed)) {
        parsed = [parsed];
    }

    const clean = (parsed as unknown[]).map((t: unknown) => {
        let str = String(t).trim();
        if (!str) return "";
        // BK-07 escape HTML e BK-14 limite razoável para tags (50 chars)
        if (str.includes("<") || str.includes(">")) str = escapeHtml(str);
        return str.slice(0, 50);
    }).filter(Boolean);
    return JSON.stringify(clean);
}
