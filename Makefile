.PHONY: up down test load chaos logs test-db test-db-check test-api-layers selfhost-init selfhost-up selfhost-down selfhost-logs selfhost-build

# Targets that need files only the private repository has (the public export
# does not ship e2e/journey or the hosted-production verifiers). In a public
# checkout they stop with this message instead of a missing-file error.
# Usage: $(call require_private,<path>)
define require_private
@if [ ! -e "$(1)" ]; then \
	echo "make $@: $(1) is not in this checkout. This target is for the maintainers' private repository (hosted DeerDawn) and does not apply to a self-hosted or public checkout." >&2; \
	exit 1; \
fi
endef

# ── Self-hosting (root docker-compose.yml; see docs/self-hosting.md) ─────────
# `make up`/`make down` below are the contributor sandbox (infra/docker-compose.yml).
selfhost-init:
	./scripts/selfhost/init.sh

selfhost-up:
	docker compose up -d

selfhost-build:
	docker compose build

# Keeps the data volumes (no -v): this is somebody's memory, not a sandbox.
selfhost-down:
	docker compose down

selfhost-logs:
	docker compose logs -f

up:
	docker compose -f infra/docker-compose.yml up --build -d
	@echo "Waiting for services to be healthy..."
	sleep 10
	@echo "Sandbox running."

down:
	docker compose -f infra/docker-compose.yml down -v

logs:
	docker compose -f infra/docker-compose.yml logs -f

seed:
	@echo "Seeding database..."
	docker compose -f infra/docker-compose.yml exec api npm run seed

migrate:
	@echo "Running migrations..."
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate.js
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate-security.js
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate-versioning.js
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate-personal.js
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate-context-sync.js
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate-stripe.js
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate-context-source-credentials.js
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate-email-prefs.js
	docker compose -f infra/docker-compose.yml exec api node scripts/verify-credential-migration.js

migrate-security:
	@echo "Enabling database security..."
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate-security.js

migrate-context-indexes:
	@echo "Adding context sync indexes..."
	docker compose -f infra/docker-compose.yml exec api node scripts/migrate-context-indexes.js

journey:
	$(call require_private,e2e/journey)
	@echo "Running full new-user journey (Phases 0-4)..."
	JOURNEY_REAL_AGENT=1 npm run journey -w @deerdawn/journey

journey-ci:
	$(call require_private,e2e/journey)
	@echo "Running journey (Phases 0-3, no real-agent smoke)..."
	npm run journey:ci -w @deerdawn/journey

# ── Local UI verification ────────────────────────────────────────────────────
# Every authed dashboard page renders blank without a session, which made UI
# changes on those pages unverifiable in automation. dev-session mints a session
# from the local API's credential endpoints (no browser, no prompt) and writes it
# as a Playwright storageState; verify-ui then opens the page at real desktop AND
# phone viewports and screenshots it.
#
# Requires: make up (API on :8080) and the dashboard dev server on :3001.
dev-session:
	$(call require_private,e2e/journey)
	@echo "Minting a local dev session..."
	node e2e/journey/scripts/mint-local-session.mjs

verify-ui: dev-session
	@echo "Verifying authed UI at desktop + mobile viewports..."
	npx playwright test -c e2e/journey/playwright.config.ts --project=local-desktop --project=local-mobile
	@echo "Screenshots: e2e/journey/artifacts/local-screens/"

verify-ui-mobile: dev-session
	@echo "Verifying authed UI at phone viewport only..."
	npx playwright test -c e2e/journey/playwright.config.ts --project=local-mobile
	@echo "Screenshots: e2e/journey/artifacts/local-screens/"

verify:
	@bash apps/api/scripts/verify-system.sh http://localhost:8080

verify-prod:
	$(call require_private,apps/api/scripts/verify-production-readonly.sh)
	@bash apps/api/scripts/verify-production-readonly.sh https://api.deerdawn.com
	@bash apps/api/scripts/quick-verify.sh
	@if [ -n "$$DATABASE_URL" ]; then \
		node apps/api/scripts/verify-credential-migration.js; \
	else \
		echo "Skipping credential migration verifier (DATABASE_URL not set in this shell)."; \
	fi

test-db:
	@bash apps/api/scripts/bootstrap-test-db.sh

test-db-check:
	@DEERDAWN_TEST_DB_BOOTSTRAP_MODE=check-only bash apps/api/scripts/bootstrap-test-db.sh

test-api-layers:
	cd apps/api && bash tests/run-all-layers.sh all

test:
	@echo "Running tests..."
	cd apps/api && npm test
	@echo "Unit tests passed."
	# Integration/E2E are handled by consumer-sim in compose, but we can run a manual verify here if needed
	bash apps/api/scripts/smoke-e2e.sh http://localhost:8080 http://localhost:3001

release-gate:
	@echo "Running release gate checks..."
	cd apps/api && npm test
	npm test -w @deerdawn/mcp-server
	npm run typecheck -w @deerdawn/mcp-server
	@echo "Release gate checks passed."

token-benchmark:
	@if [ -z "$$BENCHMARK_INPUT" ]; then \
		echo "Usage: BENCHMARK_INPUT=<path.json> make token-benchmark"; \
		exit 1; \
	fi
	node apps/api/scripts/benchmark-token-efficiency.js "$$BENCHMARK_INPUT" "$${TOKEN_SAVINGS_THRESHOLD:-5}"

load:
	@echo "Running load test (simple)..."
	export DATABASE_URL=postgres://deerdawn:password@localhost:5432/deerdawn_dev && node apps/api/scripts/test-latency.js http://localhost:8080 dev-key

speed-test:
	@echo "Running full speed test..."
	node apps/api/scripts/speed-test.js http://localhost:8080

chaos:
	@echo "Chaos: stopping Postgres..."
	docker compose -f infra/docker-compose.yml stop postgres
	sleep 5
	@echo "Sending request (expecting failure or cached/fail-safe)..."
	curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8080/api/v1/decisions:evaluate \
		-H "Content-Type: application/json" \
		-H "X-Api-Key: dev-key" \
		-d '{"action_type":"context.sync","trace_id":"chaos-1","payload":{"amount":1}}' || echo "Connection Failed"
	@echo "Healing: starting Postgres..."
	docker compose -f infra/docker-compose.yml start postgres
	sleep 10
	@echo "Recovery check..."
	curl -f http://localhost:8080/healthz
