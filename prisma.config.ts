import { defineConfig } from "prisma/config";

// In Docker production, DATABASE_URL is set via ENV in Dockerfile/entrypoint.
// In local dev, it can be set in .env manually or via `dotenv` before running prisma CLI.
// We intentionally do NOT import dotenv here so this file works in production containers.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"] ?? "file:./prisma/dev.db",
  },
});
