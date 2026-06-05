import type { Session } from "next-auth";

type SessionWithUserId = Session & {
    user: NonNullable<Session["user"]> & { id?: string };
};

export function getSessionUserId(session: Session | null) {
    return (session as SessionWithUserId | null)?.user?.id;
}

export function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Unexpected error";
}
