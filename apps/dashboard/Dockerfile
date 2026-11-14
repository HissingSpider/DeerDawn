# syntax = docker/dockerfile:1

# Production image for the DeerDawn dashboard (Next.js, standalone output).
#
# Build context is the REPO ROOT (npm workspaces, root lockfile):
#   docker build -f apps/dashboard/Dockerfile -t deerdawn-dashboard .
#
# ── How this image learns its URL at RUNTIME ──────────────────────────────────
# Next.js inlines every NEXT_PUBLIC_* value into the bundles at BUILD time, so a
# prebuilt image cannot read them from the environment. This image is therefore
# built with fixed placeholder URLs, and docker-entrypoint.sh rewrites them to
# $DEERDAWN_PUBLIC_URL once, when the container starts. The dashboard and the
# API share that one origin (Caddy routes /api/v1, /mcp, /.well-known, ... to
# the API), which is also what the dashboard's CSP (`connect-src 'self'`) needs.
# Server-side fetches the dashboard makes to that public origin are sent
# straight to $DEERDAWN_INTERNAL_API_URL by internal-fetch.cjs, because the
# public URL (e.g. http://localhost:3000) may not resolve from inside the
# container. See docs/self-hosting.md.

ARG NODE_VERSION=20.19.2

FROM node:${NODE_VERSION}-slim AS base
WORKDIR /workspace


# ── deps: the full dependency tree the build needs ────────────────────────────
FROM base AS deps
COPY package.json package-lock.json .npmrc ./
COPY apps/dashboard/package.json ./apps/dashboard/
# `npm install` scoped to the dashboard workspace rather than `npm ci`: the
# root lockfile names every workspace and the others are absent from this stage.
RUN npm install --workspace=dashboard --include-workspace-root=false --no-audit --no-fund \
  && npm cache clean --force


# ── build ─────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY package.json package-lock.json ./
COPY apps/dashboard/ ./apps/dashboard/

# This image is the SELF-HOSTED dashboard. next.config.ts inlines SELF_HOSTED and
# TELEMETRY_ENABLED into the bundles (DD_SELF_HOSTED / DD_TELEMETRY_ENABLED) at
# build time; lib/telemetryGate.ts decides from them, before anything loads,
# that no analytics may load, and lib/connectTarget.ts points the setup copy at
# this install. Hosted (Vercel) builds never use this Dockerfile. Override only
# to build something other than a self-hosted image.
ARG SELF_HOSTED=true
ARG TELEMETRY_ENABLED=false
ENV SELF_HOSTED=${SELF_HOSTED} \
    TELEMETRY_ENABLED=${TELEMETRY_ENABLED}

# Placeholders the entrypoint swaps for the real origin. They must be absolute
# URLs (the client normalises anything else) and must never occur naturally.
ENV NEXT_PUBLIC_API_URL=https://deerdawn-public-url.placeholder.invalid \
    NEXT_PUBLIC_APP_URL=https://deerdawn-public-url.placeholder.invalid \
    NEXT_PUBLIC_SITE_URL=https://deerdawn-public-url.placeholder.invalid \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
# Deliberately UNSET at build time, so the self-hosted bundle carries no
# third-party ids: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (unset = the local
# email/password sign-in), NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_SENTRY_DSN,
# NEXT_PUBLIC_GA4_ID, NEXT_PUBLIC_REDDIT_PIXEL_ID, SENTRY_AUTH_TOKEN.
WORKDIR /workspace/apps/dashboard
# webpack, not the Turbopack default: a Turbopack build served by `next start`
# (standalone) puts its chunk-loader bootstrap in an INLINE <script>, which the
# dashboard's CSP (script-src without 'unsafe-inline') blocks, so the pages
# never hydrate. Vercel's Turbopack output has no such inline script. The
# webpack build emits only external scripts plus the JSON __NEXT_DATA__.
RUN npx next build --webpack


# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS runtime
LABEL org.opencontainers.image.title="deerdawn-dashboard"
LABEL org.opencontainers.image.description="DeerDawn dashboard: web UI for self-hosted DeerDawn"
LABEL org.opencontainers.image.source="https://github.com/HissingSpider/DeerDawn"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DEERDAWN_INTERNAL_API_URL=http://api:8080

WORKDIR /app

# Standalone output mirrors the monorepo layout: server.js lives at
# apps/dashboard/server.js. Static assets and public/ are not traced, so they
# are copied next to it. Owned by the non-root `node` user so the entrypoint
# can rewrite the placeholders in place.
COPY --from=build --chown=node:node /workspace/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build --chown=node:node /workspace/apps/dashboard/public ./apps/dashboard/public
COPY --chown=node:node infra/selfhost/dashboard/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chown=node:node infra/selfhost/dashboard/internal-fetch.cjs /app/internal-fetch.cjs
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/login',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--require", "/app/internal-fetch.cjs", "apps/dashboard/server.js"]
