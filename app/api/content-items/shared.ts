/**
 * Normalize a raw tags value into a JSON array string.
 * Accepts: JSON array string ("[\"a\",\"b\"]"), comma-separated string ("a, b"),
 * or an actual array. Always stores a JSON array (or "[]").
 */
export function normalizeTags(value: unknown): string {
    if (value === undefined || value === null) return "[]";

    let parsed: unknown = value;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed || trimmed === "[]") return "[]";
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            // Not JSON — treat as comma-separated list
            parsed = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
        }
    }

    if (!Array.isArray(parsed)) {
        parsed = [parsed];
    }

    const clean = (parsed as unknown[]).map((t: unknown) => String(t).trim()).filter(Boolean);
    return JSON.stringify(clean);
}
