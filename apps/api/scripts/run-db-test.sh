#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/bootstrap-test-db.sh"

# The DB suites share one database and are not written to run side by side:
# two sweeps started at once (default + behavioral, or two sessions on one
# machine) produced phantom failures and an internally inconsistent summary
# ("820 tests / 819 pass / 0 fail") that were clean on an isolated re-run.
# Serialize every runner that targets the same DATABASE_URL instead of letting
# them corrupt each other. mkdir is atomic and exists everywhere (macOS has no
# flock). Set DEERDAWN_TEST_DB_NO_LOCK=1 to opt out, e.g. against a per-run DB.
if [[ "${DEERDAWN_TEST_DB_NO_LOCK:-}" != "1" ]]; then
  LOCK_KEY="$(printf '%s' "$DATABASE_URL" | cksum | cut -d' ' -f1)"
  LOCK_DIR="${TMPDIR:-/tmp}/deerdawn-test-db-${LOCK_KEY}.lock"
  LOCK_WAIT_SECONDS="${DEERDAWN_TEST_DB_LOCK_WAIT_SECONDS:-1800}"
  waited=0
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    # A runner killed without cleanup leaves the directory behind; reclaim it.
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      continue
    fi
    if (( waited == 0 )); then
      log "Another test run (pid ${holder:-unknown}) is using this database; waiting for it."
    fi
    if (( waited >= LOCK_WAIT_SECONDS )); then
      log "Gave up waiting ${LOCK_WAIT_SECONDS}s for the test database lock at $LOCK_DIR."
      exit 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "$$" > "$LOCK_DIR/pid"
  trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
  "$@"
  exit $?
fi

exec "$@"
