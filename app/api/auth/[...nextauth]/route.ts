import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, validateAuthConfig } from "@/lib/auth";

// Validate auth config at request time: if ADMIN_EMAIL/ADMIN_PASSWORD are
// missing or weak, the auth endpoints respond with a clear 500 instead of
// silently failing login (fail-closed, but diagnosable).
function configErrorResponse() {
    const check = validateAuthConfig();
    if (check.ok) return null;
    console.error(`[auth] Invalid auth configuration: ${check.error}`);
    return NextResponse.json({ error: check.error }, { status: 500 });
}

async function handler(req: Request, ctx: unknown) {
    const configError = configErrorResponse();
    if (configError) return configError;
    return NextAuth(authOptions)(req, ctx);
}

export { handler as GET, handler as POST };
