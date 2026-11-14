# syntax = docker/dockerfile:1

# Production image for the DeerDawn API. Used by BOTH the hosted deploy
# (fly.toml -> this file) and self-hosting (docker-compose.yml at the repo root,
# and the ghcr.io/<owner>/deerdawn-api image built by publish-images.yml).
#
# Build context is the REPO ROOT (npm workspaces: the API requires
# packages/shared-context by relative path, and the lockfile lives at the root):
#   docker build -f apps/api/Dockerfile -t deerdawn-api .

ARG NODE_VERSION=20.19.2
FROM node:${NODE_VERSION}-slim AS base

ARG COMMIT_SHA
LABEL fly_launch_runtime="Node.js"
LABEL commit_sha="${COMMIT_SHA}"
LABEL org.opencontainers.image.title="deerdawn-api"
LABEL org.opencontainers.image.description="DeerDawn API: AI session memory (context sync, MCP endpoint, OAuth)"
LABEL org.opencontainers.image.source="https://github.com/HissingSpider/DeerDawn"

WORKDIR /workspace


# Throw-away build stage: installs production dependencies only.
FROM base AS build

# Toolchain for any native module that has no prebuilt binary for this arch
# (matters for the arm64 image).
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3 && \
    rm -rf /var/lib/apt/lists/*

# Only the manifests of the workspaces the API needs, so this layer is cached
# until a dependency actually changes. `npm install --omit=dev` rather than
# `npm ci`: the root lockfile names every workspace (dashboard, marketing, e2e)
# and those directories are deliberately absent from this context.
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-context/package.json ./packages/shared-context/
COPY packages/tool-adapters/package.json ./packages/tool-adapters/
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy API source and shared packages
COPY apps/api/ ./apps/api/
COPY packages/shared-context/ ./packages/shared-context/
COPY packages/tool-adapters/ ./packages/tool-adapters/


# Final stage for app image
FROM base

# Run in production mode (activates boot-time secret validation + prod-safe behaviors).
ENV NODE_ENV=production

# INFRA-02: copy the built application owned by the built-in non-root `node` user (uid 1000)
# so the Express + MCP process never runs as root.
COPY --from=build --chown=node:node /workspace /workspace

WORKDIR /workspace/apps/api

# Make startup script executable (as root, before dropping privileges)
RUN chmod +x scripts/start.sh

# Drop to the non-root user for the running container.
USER node

EXPOSE 8080

# /healthz is the cheap in-memory bootstrap check (no DB query).
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD [ "./scripts/start.sh" ]
