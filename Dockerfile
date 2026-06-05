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
ENV NODE_OPTIONS="--max-old-space-size=768"
COPY --from=deps /app/node_modules ./node_modules
COPY . .

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

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy public folder (create empty if not exists)
RUN mkdir -p ./public
COPY --from=builder /app/public* ./public/

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy Prisma schema and migrations for runtime DB operations
# NOTE: Do NOT copy prisma.config.ts — Prisma CLI auto-loads it and fails without node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Create data directories for SQLite and uploads
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
RUN mkdir -p /app/data/uploads && chown -R nextjs:nodejs /app/data/uploads
RUN mkdir -p /app/public/uploads && chown -R nextjs:nodejs /app/public/uploads

# Copy the entrypoint script
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

# Define a single named volume — /app/data contains both the SQLite DB and uploads/
# Do NOT declare sub-paths as separate VOLUMEs; they create anonymous volumes that
# won't persist across Easypanel deploys.
VOLUME ["/app/data"]


USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Point SQLite DB to the persistent volume
ENV DATABASE_URL="file:/app/data/prod.db"

# Replace standard CMD with our custom setup script
CMD ["./docker-entrypoint.sh"]
