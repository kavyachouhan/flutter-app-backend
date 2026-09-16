# syntax=docker/dockerfile:1.7
#
#   docker build --build-arg NODE_VERSION=<major> -t khata-api .
#
# NODE_VERSION has no default on purpose: the runtime version is a deployment
# decision and must match `engines.node`.
#
# Liveness/readiness probes are defined by the orchestrator against /healthz
# and /readyz rather than a Docker HEALTHCHECK, so their timings stay config.

ARG NODE_VERSION

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

# PID 1 must forward SIGTERM, otherwise graceful shutdown in server.ts never runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
