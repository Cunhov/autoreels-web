import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

function createPrismaClient() {
    // DATABASE_URL format: "file:/path/to/db" or "file:./relative/path.db"
    const dbUrl = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
    // Strip the "file:" prefix to get the raw filesystem path
    const dbPath = dbUrl.replace(/^file:/, "");
    const db = new Database(dbPath);
    const adapter = new PrismaBetterSqlite3(db);
    return new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
