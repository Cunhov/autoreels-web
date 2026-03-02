import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";


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
            async authorize(credentials) {
                if (!credentials?.email || !credentials?.password) {
                    return null;
                }

                const adminEmail = process.env.ADMIN_EMAIL;
                const adminPassword = process.env.ADMIN_PASSWORD;

                if (!adminEmail || !adminPassword) {
                    console.error("ADMIN_EMAIL or ADMIN_PASSWORD is not set in environment variables.");
                    return null;
                }

                if (credentials.email === adminEmail && credentials.password === adminPassword) {
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
