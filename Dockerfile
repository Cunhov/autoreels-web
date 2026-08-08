# syntax=docker/dockerfile:1.7

# Base image
FROM node:20-alpine AS base

ENV NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --prefer-offline --progress=false

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
ENV NODE_OPTIONS="--max-old-space-size=1024"
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Ensure scripts/ exists even when .dockerignore excludes its legacy files
# (db-migrate.sh from the DB workstream lives here and is needed in the runner)
RUN mkdir -p /app/scripts

# Make DATABASE_URL available during build (needed by prisma.config.ts for prisma generate)
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

# Generate Prisma client
RUN npx prisma generate

RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# ffmpeg for server-side video trimming and thumbnail (frame) extraction
RUN apk add --no-cache ffmpeg

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy public folder (committed as public/.gitkeep — do NOT use a glob here,
# BuildKit fails the build when the wildcard matches nothing)
COPY --from=builder --chown=nextjs:nodejs /app/public ./public/

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# ── Prisma CLI for runtime migrations ──────────────────────────────────────────
# The Next.js standalone output only traces what the app imports at runtime.
# `prisma` (the CLI) is a devDependency, so it is NOT included — but
# docker-entrypoint.sh needs it to run `prisma migrate deploy` against the
# persistent volume. Copy the CLI and its full transitive dependency closure.
# NOTE: these packages are copied from the BUILDER stage (Linux), so the
# platform-specific schema engine inside @prisma/engines matches the runner.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
# Transitive deps of the Prisma CLI (resolved empirically with prisma@7.4.2)
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/mysql2 ./node_modules/mysql2
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/postgres ./node_modules/postgres
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/iconv-lite ./node_modules/iconv-lite
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/graphmatch ./node_modules/graphmatch
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/grammex ./node_modules/grammex
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/graceful-fs ./node_modules/graceful-fs
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/retry ./node_modules/retry
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/fast-check ./node_modules/fast-check
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/pure-rand ./node_modules/pure-rand
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/exsolve ./node_modules/exsolve
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/jiti ./node_modules/jiti
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/rc9 ./node_modules/rc9
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/destr ./node_modules/destr
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/defu ./node_modules/defu
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/pkg-types ./node_modules/pkg-types
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/confbox ./node_modules/confbox
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/dotenv ./node_modules/dotenv
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/perfect-debounce ./node_modules/perfect-debounce
# Second empirical pass (prisma@7.4.2): @prisma/dev pulls these at runtime
# (db push / migrate deploy / config loading). Discovered by running the CLI
# in a sandbox with only these packages until all MODULE_NOT_FOUND were gone.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/valibot ./node_modules/valibot
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/pathe ./node_modules/pathe
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/zeptomatch ./node_modules/zeptomatch
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/get-port-please ./node_modules/get-port-please
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/remeda ./node_modules/remeda
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/std-env ./node_modules/std-env
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/proper-lockfile ./node_modules/proper-lockfile
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/effect ./node_modules/effect
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/c12 ./node_modules/c12
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/deepmerge-ts ./node_modules/deepmerge-ts

# Copy Prisma schema and config for runtime DB operations.
# prisma.config.ts is REQUIRED by `prisma migrate deploy` in Prisma 7 (the CLI
# reads datasource.url from it — DATABASE_URL is provided via env at runtime).
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

# Copy the DB migration helper (baseline for legacy DBs + migrate deploy).
# Created by the monolith DB workstream; entrypoint falls back to a plain
# `prisma migrate deploy` if this file is absent.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

# Create data directories for SQLite and uploads (single persistent volume)
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
RUN mkdir -p /app/data/uploads && chown -R nextjs:nodejs /app/data/uploads

# Copy the entrypoint script
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

# Define a single named volume — /app/data contains both the SQLite DB and uploads/
# Do NOT declare sub-paths as separate VOLUMEs; they create anonymous volumes that
# won't persist across Easypanel deploys.
VOLUME ["/app/data"]

# Healthcheck: verify the HTTP server responds (API route checks the DB too)
HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=90s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Point SQLite DB to the persistent volume
ENV DATABASE_URL="file:/app/data/prod.db"

# Replace standard CMD with our custom setup script
CMD ["./docker-entrypoint.sh"]
