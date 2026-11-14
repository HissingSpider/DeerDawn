#!/usr/bin/env bash
# DeerDawn Pre-Launch Test Suite — All Automated Layers
# Usage: bash tests/run-all-layers.sh [layer0|layer1|...|all]
#
# Prerequisites:
#   bash scripts/bootstrap-test-db.sh
#   export DATABASE_URL=postgres://deerdawn:password@localhost:5432/deerdawn_dev
#   export DEERDAWN_API_KEY=dev-key

set -euo pipefail

LAYER="${1:-all}"
PASS=0
FAIL=0
SKIPPED=0

log() { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { log "✓ $1"; ((++PASS)); }
fail() { log "✗ $1"; ((++FAIL)); }

export NODE_ENV="${NODE_ENV:-test}"
export JWT_SECRET="${JWT_SECRET:-test-secret}"
export DATABASE_URL="${DATABASE_URL:-postgres://deerdawn:password@localhost:5432/deerdawn_dev}"
export DEERDAWN_API_KEY="${DEERDAWN_API_KEY:-dev-key}"
export DB_CIRCUIT_BREAKER_TIMEOUT="${DB_CIRCUIT_BREAKER_TIMEOUT:-10000}"
export DISABLE_REDIS="${DISABLE_REDIS:-true}"

run_test() {
  local label="$1"
  local file="$2"
  log "Running: $label"
  if node --test --test-timeout=60000 "$file" 2>&1; then
    pass "$label"
  else
    fail "$label"
  fi
}

run_layer() {
  local layer="$1"
  case "$layer" in
    layer0)
      run_test "Layer 0 — Infrastructure" tests/layer0-infrastructure.test.js
      ;;
    layer1)
      run_test "Layer 1 — Authentication" tests/layer1-auth.test.js
      ;;
    layer2)
      run_test "Layer 2 — Billing" tests/layer2-billing.test.js
      ;;
    layer3)
      run_test "Layer 3 — Context Sync API" tests/layer3-context-sync.test.js
      ;;
    layer4)
      run_test "Layer 4 — Workspace Knowledge" tests/layer4-workspace.test.js
      ;;
    layer6)
      run_test "Layer 6 — Tenant Isolation" tests/layer6-tenant-isolation.test.js
      ;;
    layer7)
      run_test "Layer 7 — Security Hardening" tests/layer7-security.test.js
      ;;
    layer8)
      log "Running: Layer 8 — Performance (may take ~60s)"
      if node --test --test-timeout=120000 tests/layer8-performance.test.js 2>&1; then
        pass "Layer 8 — Performance"
      else
        fail "Layer 8 — Performance"
      fi
      ;;
    layer9)
      run_test "Layer 9 — E2E Flows" tests/layer9-e2e-flows.test.js
      ;;
    existing)
      log "Running existing test suite..."
      npm test
      ;;
    all)
      run_layer layer0
      run_layer layer1
      run_layer layer2
      run_layer layer3
      run_layer layer4
      run_layer layer6
      run_layer layer7
      run_layer layer9
      run_layer existing
      log ""
      log "Skipping Layer 5 (MCP) — run separately from packages/mcp-server: npm test"
      log "Skipping Layer 8 (perf) — run manually with: node tests/layer8-performance.test.js"
      log "Skipping Layers 10-12 (manual) — see markdown checklists in tests/"
      ((SKIPPED+=3))
      ;;
    *)
      echo "Unknown layer: $layer"
      echo "Usage: $0 [layer0|layer1|layer2|layer3|layer4|layer6|layer7|layer8|layer9|existing|all]"
      exit 1
      ;;
  esac
}

log "═══════════════════════════════════════════════════"
log "  DeerDawn Pre-Launch Test Suite"
log "  Layer: $LAYER"
log "  DB: ${DATABASE_URL}"
log "═══════════════════════════════════════════════════"

bash scripts/bootstrap-test-db.sh

run_layer "$LAYER"

log ""
log "═══════════════════════════════════════════════════"
log "  Results: $PASS passed, $FAIL failed, $SKIPPED skipped"
log "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
