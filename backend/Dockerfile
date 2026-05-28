# ---------- base ----------
# Debian-based image: Prisma ships a `debian-openssl-3.0.x` query engine,
# and Debian has ffmpeg + OpenSSL 3 in apt. Alpine's musl variant needs
# libssl.so.1.1 which isn't in recent base images — Render fails to boot
# with: "Prisma cannot find libssl.so.1.1".
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm prisma generate

# ---------- builder ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate
RUN pnpm build

# ---------- runner ----------
# Single runner — the HTTP server embeds the Postgres-backed TaskWorker in
# the same process by default (EMBED_WORKER=true). Opt-out with
# EMBED_WORKER=false and run a second container with HTTP disabled to
# scale workers horizontally — they coordinate via FOR UPDATE SKIP LOCKED.
FROM node:20-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./
EXPOSE 4000
# migrate deploy + seed are both idempotent:
#   - `migrate deploy` applies any pending migrations, no-op if up to date.
#   - `pnpm seed` uses upsert everywhere, won't duplicate demo data.
# Set SEED_ON_BOOT=false in the Render dashboard once the demo is seeded,
# to skip the seed step on subsequent restarts (saves ~3s).
CMD ["sh", "-c", "pnpm prisma migrate deploy && { [ \"${SEED_ON_BOOT:-true}\" = \"true\" ] && pnpm seed; } ; node dist/server.js"]
