import type { Session } from "next-auth";

type SessionWithUserId = Session & {
    user: NonNullable<Session["user"]> & { id?: string };
};

export function getSessionUserId(session: Session | null) {
    return (session as SessionWithUserId | null)?.user?.id;
}

/**
 * Convert an unknown error into a safe, user-facing message.
 * Prisma error codes are mapped to generic messages so internal schema/details
 * never leak to the client. The real error is always logged server-side.
 */
export function getErrorMessage(error: unknown) {
    const raw = error instanceof Error ? error.message : String(error ?? "Unexpected error");
    console.error("[api-error]", error);

    // Prisma known error codes → safe, generic messages
    if (raw.includes("P2025")) return "Not found";
    if (raw.includes("P2002")) return "Duplicate entry";
    if (raw.includes("P2003")) return "Invalid reference";
    if (raw.includes("P2021")) return "Database not ready";
    if (raw.includes("P1008") || raw.includes("P2028")) return "Database busy, try again";

    // Prisma validation/unknown errors leak schema internals ("Argument `x` is missing")
    if (raw.includes("Argument `") || raw.includes("Invalid value for argument") || raw.includes("PrismaClientValidationError")) {
        return "Invalid request data";
    }

    // Default: generic message (avoid leaking stack traces / internals)
    return "Internal server error";
}
