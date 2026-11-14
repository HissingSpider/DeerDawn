# syntax = docker/dockerfile:1

# Pinned patch version (matches repo .nvmrc) — was a floating `node:20-alpine`
# tag before, so a base-image update could silently change behavior on rebuild.
ARG NODE_VERSION=20.20.2
FROM node:${NODE_VERSION}-alpine

WORKDIR /app

# npm ci (not install) for reproducible, lockfile-pinned installs.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

RUN npm run build

# Drop to the non-root `node` user the base image ships with, matching the
# pattern in apps/api/Dockerfile (which never runs its app as root).
RUN chown -R node:node /app
USER node

# Not an HTTP server — it's a load/verification client hitting the API — so
# health is "the node process is still running" rather than a port probe.
# Uses busybox `ps` (ships with the alpine base) instead of `pgrep`/procps, to
# avoid an extra apk install.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ps aux | grep -q "[n]ode dist/index.js" || exit 1

CMD ["npm", "start"]
