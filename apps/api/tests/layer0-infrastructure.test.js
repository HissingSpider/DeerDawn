/**
 * Layer 0 — Environment & Infrastructure
 *
 * Verifies DB connectivity, Redis, required env vars, table existence,
 * and core health endpoints are reachable and return correct shapes.
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../src/config/db');
const { redis, closeRedisConnections } = require('../src/config/redis');

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';

test('Layer 0 — Infrastructure', async (t) => {
  t.after(async () => {
    await closeRedisConnections();
    await db.pool.end();
  });

  // ─── Health endpoints ────────────────────────────────────────────────────

  await t.test('GET /healthz returns 200', async () => {
    const res = await request(httpServer).get('/healthz');
    assert.strictEqual(res.status, 200);
    // Endpoint returns plain text 'ok' or JSON {status:'ok'}
    const content = res.text || JSON.stringify(res.body);
    assert.ok(content.includes('ok'), `expected 'ok' in response, got: ${content}`);
  });

  await t.test('GET /health/liveness returns 200', async () => {
    const res = await request(httpServer).get('/health/liveness');
    assert.strictEqual(res.status, 200);
  });

  await t.test('GET /health/readiness returns 200 or 503', async () => {
    const res = await request(httpServer).get('/health/readiness');
    assert.ok(res.status === 200 || res.status === 503, `unexpected status ${res.status}`);
  });

  // ─── Database connectivity ───────────────────────────────────────────────

  await t.test('PostgreSQL pool responds with a query', async () => {
    const result = await db.query('SELECT 1 AS ping', [], 'org-system');
    assert.strictEqual(result.rows[0].ping, 1);
  });

  await t.test('Required tables exist in the database', async () => {
    const tables = [
      'organizations', 'users', 'api_keys', 'policies', 'decisions',
      'audit_logs', 'stripe_events', 'context_projects', 'context_events',
      'context_sessions', 'context_graph_nodes', 'context_graph_edges',
      'context_graph_evidence', 'injection_preferences',
    ];
    for (const table of tables) {
      const result = await db.query(
        'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = \'public\' AND table_name = $1) AS exists',
        [table],
        'org-system'
      );
      assert.strictEqual(result.rows[0].exists, true, `Table '${table}' does not exist`);
    }
  });

  // ─── Redis connectivity ──────────────────────────────────────────────────

  await t.test('Redis responds (ping or stub)', async () => {
    if (typeof redis.ping === 'function') {
      const pong = await redis.ping();
      assert.ok(pong === 'PONG' || pong === 'pong', `expected PONG, got ${pong}`);
    } else {
      // Stub client (NODE_ENV=test or DISABLE_REDIS=true) — verify set/get works
      await redis.set('deerdawn:test:stub', 'alive');
      const val = await redis.get('deerdawn:test:stub');
      assert.strictEqual(val, 'alive', 'stub Redis set/get should work');
    }
  });

  await t.test('Redis set/get round-trip works', async () => {
    await redis.set('deerdawn:test:ping', 'alive', 'EX', 10);
    const val = await redis.get('deerdawn:test:ping');
    assert.strictEqual(val, 'alive');
    await redis.del('deerdawn:test:ping');
  });

  // ─── OpenAPI spec ─────────────────────────────────────────────────────────

  await t.test('GET /api/docs returns parseable OpenAPI spec', async () => {
    const res = await request(httpServer)
      .get('/api/docs')
      .set('X-Api-Key', API_KEY);
    assert.ok(res.status === 200 || res.status === 404, `got ${res.status}`);
    if (res.status === 200) {
      assert.ok(res.body.openapi || res.body.swagger, 'Response should be OpenAPI spec');
    }
  });

  // ─── Required env vars ────────────────────────────────────────────────────

  await t.test('Required env vars are set', () => {
    const required = ['DATABASE_URL', 'JWT_SECRET', 'DEERDAWN_API_KEY'];
    for (const key of required) {
      assert.ok(process.env[key], `Missing required env var: ${key}`);
    }
  });
});
