#!/bin/sh
# Dashboard container entrypoint (self-hosting).
#
# The image is built with a placeholder origin in every NEXT_PUBLIC_*_URL (Next
# inlines those at build time). Here, once per container, the placeholder is
# replaced with $DEERDAWN_PUBLIC_URL in the built server and client bundles.
# A container is recreated whenever its environment changes, so a new
# DEERDAWN_PUBLIC_URL always starts again from the pristine image.
set -eu

PLACEHOLDER='https://deerdawn-public-url.placeholder.invalid'
APP_DIR=/app/apps/dashboard
MARKER="$APP_DIR/.deerdawn-public-url"

PUBLIC_URL="${DEERDAWN_PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ]; then
  echo "[dashboard] DEERDAWN_PUBLIC_URL is not set (e.g. http://localhost:3000 or https://deerdawn.example.com)." >&2
  exit 1
fi
# Strip a trailing slash, then insist on scheme://host[:port] and nothing else:
# it is substituted into JavaScript string literals, so no path, quotes or spaces.
PUBLIC_URL="${PUBLIC_URL%/}"
if ! printf '%s' "$PUBLIC_URL" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$'; then
  echo "[dashboard] DEERDAWN_PUBLIC_URL must look like http(s)://host[:port] with no path; got: $PUBLIC_URL" >&2
  exit 1
fi

if [ -f "$MARKER" ]; then
  APPLIED="$(cat "$MARKER")"
  if [ "$APPLIED" != "$PUBLIC_URL" ]; then
    echo "[dashboard] This container was configured for $APPLIED; recreate it to change the URL (docker compose up -d --force-recreate dashboard)." >&2
    exit 1
  fi
else
  echo "[dashboard] Configuring bundles for $PUBLIC_URL"
  grep -rlF "$PLACEHOLDER" "$APP_DIR/.next" 2>/dev/null | while IFS= read -r file; do
    sed -i "s|$PLACEHOLDER|$PUBLIC_URL|g" "$file"
  done
  printf '%s' "$PUBLIC_URL" > "$MARKER"
fi

export DEERDAWN_PUBLIC_URL="$PUBLIC_URL"
exec "$@"
