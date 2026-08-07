import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { safeEqual } from "@/lib/secret";

// ─── Rate limiting (in-memory, per-IP) ───────────────────────────────────────

const MAX_LOGIN_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, number[]>();

function pruneLoginAttempts(now: number) {
    if (loginAttempts.size === 0) return;
    for (const [ip, timestamps] of loginAttempts) {
        const fresh = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (fresh.length === 0) loginAttempts.delete(ip);
        else loginAttempts.set(ip, fresh);
    }
}

function isRateLimited(ip: string): boolean {
    const now = Date.now();
    pruneLoginAttempts(now);
    const attempts = loginAttempts.get(ip) || [];
    if (attempts.length >= MAX_LOGIN_ATTEMPTS) {
        return true;
    }
    attempts.push(now);
    loginAttempts.set(ip, attempts);
    return false;
}

// ─── Auth config validation ──────────────────────────────────────────────────

/**
 * Validate that ADMIN_EMAIL/ADMIN_PASSWORD are set and not weak.
 * Returns { ok: true } or { ok: false, error } — never throws.
 */
export function validateAuthConfig(): { ok: true } | { ok: false; error: string } {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
        return { ok: false, error: "ADMIN_EMAIL and ADMIN_PASSWORD must be set in environment variables." };
    }
    if (adminPassword.length < 8) {
        return { ok: false, error: "ADMIN_PASSWORD must be at least 8 characters long." };
    }
    const weakPasswords = ["adminpassword", "changeme", "change_me", "password", "12345678"];
    if (weakPasswords.includes(adminPassword.toLowerCase())) {
        return { ok: false, error: "ADMIN_PASSWORD is too weak. Choose a stronger password." };
    }
    return { ok: true };
}

// ─── NextAuth options ────────────────────────────────────────────────────────

export const authOptions: NextAuthOptions = {
    session: {
        strategy: "jwt",
    },
    pages: {
        signIn: "/login",
    },
    providers: [
        CredentialsProvider({
            name: "Credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" }
            },
            async authorize(credentials, req) {
                if (!credentials?.email || !credentials?.password) {
                    return null;
                }

                const configCheck = validateAuthConfig();
                if (!configCheck.ok) {
                    console.error(`[auth] ${configCheck.error}`);
                    return null;
                }

                // Rate limit by client IP (x-forwarded-for set by reverse proxy / Docker)
                const headers = req?.headers as Record<string, unknown> | Headers | undefined;
                const forwarded = headers instanceof Headers
                    ? headers.get("x-forwarded-for") || undefined
                    : headers?.["x-forwarded-for"];
                const ip = typeof forwarded === "string"
                    ? forwarded.split(",")[0].trim()
                    : "unknown";
                if (isRateLimited(ip)) {
                    console.error(`[auth] Rate limited login attempt from ${ip}`);
                    return null;
                }

                const adminEmail = process.env.ADMIN_EMAIL as string;
                const adminPassword = process.env.ADMIN_PASSWORD as string;

                const emailOk = safeEqual(credentials.email.trim().toLowerCase(), adminEmail.trim().toLowerCase());
                const passwordOk = safeEqual(credentials.password, adminPassword);

                if (emailOk && passwordOk) {
                    return { id: "admin", email: adminEmail };
                }

                return null;
            }
        })
    ],
    callbacks: {
        session: ({ session, token }) => {
            return {
                ...session,
                user: {
                    ...session.user,
                    id: token.sub, // Will be "admin" based on authorize return
                },
            };
        },
    },
};
