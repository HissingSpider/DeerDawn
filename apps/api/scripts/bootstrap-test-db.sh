#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$API_ROOT/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.yml"

log() {
  echo "[test-db] $*"
}

export NODE_ENV="${NODE_ENV:-test}"
export JWT_SECRET="${JWT_SECRET:-test-secret}"
export DATABASE_URL="${DATABASE_URL:-postgres://deerdawn:password@localhost:5432/deerdawn_dev}"
export DEERDAWN_API_KEY="${DEERDAWN_API_KEY:-dev-key}"
export DB_CIRCUIT_BREAKER_TIMEOUT="${DB_CIRCUIT_BREAKER_TIMEOUT:-10000}"
export DISABLE_REDIS="${DISABLE_REDIS:-true}"
export DB_DEV_HOSTNAMES="${DB_DEV_HOSTNAMES:-postgres}"

WAIT_SECONDS="${DEERDAWN_TEST_DB_WAIT_SECONDS:-30}"
BOOTSTRAP_MODE="${DEERDAWN_TEST_DB_BOOTSTRAP_MODE:-auto}"

check_db() {
  node "$SCRIPT_DIR/check-test-db.js" --quiet
}

if ! check_db; then
  if [[ "$BOOTSTRAP_MODE" == "check-only" ]]; then
    log "Database unavailable and bootstrap disabled by DEERDAWN_TEST_DB_BOOTSTRAP_MODE=check-only."
    exit 1
  fi

  if ! command -v docker >/dev/null 2>&1; then
    log "Database unavailable and docker is not installed."
    exit 1
  fi

  if ! docker ps >/dev/null 2>&1; then
    log "Database unavailable and Docker is not accessible. Start Docker Desktop or ensure this shell can reach the Docker daemon."
    exit 1
  fi

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    log "Database unavailable and compose file was not found at $COMPOSE_FILE."
    exit 1
  fi

  log "Starting local postgres via Docker Compose..."
  if ! docker compose -f "$REPO_ROOT/infra/docker-compose.yml" up -d postgres; then
    log "Failed to start postgres via Docker Compose."
    exit 1
  fi

  deadline=$((SECONDS + WAIT_SECONDS))
  until check_db; do
    if (( SECONDS >= deadline )); then
      log "Database did not become ready within ${WAIT_SECONDS}s."
      exit 1
    fi
    sleep 1
  done
fi

log "Running test database migrations..."
(
  cd "$API_ROOT"
  npm run migrate
  node scripts/migrate-referrals-grant.js || log "Warning: referrals grant skipped (may already be applied or requires superuser)"
  node scripts/migrate-context-sync.js || log "Warning: context-sync migration skipped"
  node scripts/migrate-context-indexes.js || log "Warning: context-sync index migration skipped"
  # users.weekly_digest_unsubscribed. autoMigrate.js also adds it, but only when
  # something boots the app — so a suite that talks to the db directly (the email
  # audience tests) got the column by luck of file ordering. Every email sender
  # filters on it, and their audience queries SWALLOW errors and return [], so the
  # failure mode is a green suite that selected nobody. Make it deterministic.
  node scripts/migrate-email-prefs.js || log "Warning: email prefs migration skipped"
)

# Fix table ownership for context_project_* tables — they may have been created by the OS
# user (e.g. during a local migrate run) rather than the deerdawn role, causing CREATE INDEX
# to fail with "must be owner of table" during ensureSchema(). Connecting without a user
# specification uses peer/ident auth as the current OS user, who is the owner.
DB_HOST=$(node -e "const u = new URL('${DATABASE_URL}'); process.stdout.write(u.hostname)")
DB_PORT=$(node -e "const u = new URL('${DATABASE_URL}'); process.stdout.write(u.port || '5432')")
DB_NAME=$(node -e "const u = new URL('${DATABASE_URL}'); process.stdout.write(u.pathname.slice(1))")
psql "postgres://${DB_HOST}:${DB_PORT}/${DB_NAME}" -c "
  ALTER TABLE IF EXISTS context_project_shares OWNER TO deerdawn;
  ALTER TABLE IF EXISTS context_project_share_sections OWNER TO deerdawn;
  ALTER TABLE IF EXISTS context_project_members OWNER TO deerdawn;
" 2>/dev/null && log "Table ownership fixed." || log "Warning: could not reassign table ownership (tables may not exist or peer auth unavailable — safe to ignore if DB is clean)"

log "Test database ready."
