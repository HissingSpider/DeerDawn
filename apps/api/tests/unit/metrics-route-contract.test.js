/**
 * Contract: the retention metrics endpoint is mounted and auth-gated.
 *
 * Platform revenue/retention is admin-only, so an unauthenticated request must be
 * rejected (not 404 — which would mean the route isn't wired — and not 200).
 *
 * Run via scripts/run-db-test.sh node tests/unit/metrics-route-contract.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const { closeRedisConnections } = require('../../src/config/redis');

test('GET /api/v1/metrics/retention requires authentication', async () => {
  const res = await request(httpServer).get('/api/v1/metrics/retention');
  assert.notEqual(res.status, 404, 'route must be mounted');
  assert.equal(res.status, 401, 'unauthenticated callers are rejected');
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
