# syntax=docker/dockerfile:1
# Multi-stage build: small runtime image, production deps only, non-root user.
# Build from the repo root:  docker build -f docker/Dockerfile -t mcp-server .

# --- Stage 1: install all dependencies (dev included, for the compiler) -----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: compile TypeScript ---------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# --- Stage 3: production dependencies only -----------------------------------
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 4: runtime ----------------------------------------------------------
FROM node:24-alpine AS runtime
# tini: proper PID-1 signal handling so graceful shutdown works under Docker/K8s.
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docs ./docs

# Run as the unprivileged built-in `node` user.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${HTTP_PORT}/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
