# syntax=docker/dockerfile:1.7
#
# Multi-stage build. The runtime image carries production dependencies and
# compiled JS only — no TypeScript, no tests, no build toolchain — and runs as
# an unprivileged user.

# --- Stage 1: install every dependency, including dev ----------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# --- Stage 2: type-check and compile ---------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `build` runs tsc, so a type error fails the image build rather than
# reaching production.
RUN npm run build

# --- Stage 3: production dependencies only ---------------------------------
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# --- Stage 4: runtime ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# dumb-init reaps zombies and forwards SIGTERM, which is what makes the
# graceful shutdown in server.ts actually fire under an orchestrator.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    APP_ENV=production \
    PORT=3000 \
    # Keep heap under a typical 512MB container limit.
    NODE_OPTIONS=--max-old-space-size=384

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./
# Migrations are plain .sql and are not compiled by tsc, so copy them across.
COPY --from=build --chown=node:node /app/src/db/migrations ./dist/db/migrations

USER node
EXPOSE 3000

# Container-level liveness. /healthz never touches the database, so a slow
# query cannot get the container killed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
