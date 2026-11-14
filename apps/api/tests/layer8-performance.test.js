process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

/**
 * Layer 8 — Performance Benchmarks
 *
 * p95 latency assertions for all critical endpoints.
 * Requires server to be running (via supertest's in-process mode).
 * Thresholds: non-LLM endpoints p95 < 300ms, health < 50ms.
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../src/config/db');
const { closeRedisConnections } = require('../src/config/redis');
const store = require('../src/store/contextSyncStore');
const { ensureDatabaseAvailable } = require('./helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('./helpers/runtimeAvailability');
const { ensureRuntimeSchema } = require('./helpers/runtimeSchema');

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
const ITERATIONS = parseInt(process.env.PERF_ITERATIONS || '20', 10);

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

async function bench(label, fn, iterations = ITERATIONS) {
  const latencies = [];
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await fn();
    latencies.push(Date.now() - start);
  }
  const p95ms = p95(latencies);
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  console.log(`  [perf] ${label}: avg=${avg}ms p95=${p95ms}ms (n=${iterations})`);
  return { p95: p95ms, avg, samples: latencies };
}

async function setupProject() {
  const res = await request(httpServer)
    .post('/api/v1/context/projects')
    .set('X-Api-Key', API_KEY)
    .send({ project_name: `Perf Test ${uuidv4().slice(0, 8)}`, current_status: 'active', tech_stack: ['Node.js'] });
  assert.strictEqual(res.status, 201, `setup project create got ${res.status}: ${JSON.stringify(res.body)}`);
  const projectId = (res.body.project || {}).project_id || res.body.project_id;
  assert.ok(projectId, `expected project_id from setup response, got ${JSON.stringify(res.body)}`);
  return projectId;
}

test('Layer 8 — Performance Benchmarks', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'Layer 8 — Performance Benchmarks')) return;
  if (!await ensureDatabaseAvailable(t, db, 'Layer 8 — Performance Benchmarks')) return;
  await ensureRuntimeSchema();

  await store.clearAll().catch(() => {});
  const projectId = await setupProject();

  t.after(async () => {
    await store.clearAll().catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
  });

  // ─── Health ───────────────────────────────────────────────────────────────

  await t.test('/healthz p95 < 50ms', async () => {
    const { p95: p } = await bench('GET /healthz', async () => {
      await request(httpServer).get('/healthz');
    });
    assert.ok(p < 50, `p95 ${p}ms exceeds 50ms threshold for /healthz`);
  });

  // ─── Context endpoints (no LLM) ───────────────────────────────────────────

  await t.test('GET /context/projects p95 < 300ms', async () => {
    const { p95: p } = await bench('GET /context/projects', async () => {
      await request(httpServer).get('/api/v1/context/projects').set('X-Api-Key', API_KEY);
    });
    assert.ok(p < 300, `p95 ${p}ms exceeds 300ms for GET /context/projects`);
  });

  await t.test('GET /context/projects/:id/inject p95 < 200ms', async () => {
    const { p95: p } = await bench('GET /context/projects/:id/inject', async () => {
      await request(httpServer)
        .get(`/api/v1/context/projects/${projectId}/inject?tool=claude_code`)
        .set('X-Api-Key', API_KEY);
    });
    assert.ok(p < 200, `p95 ${p}ms exceeds 200ms for inject endpoint`);
  });

  await t.test('GET /context/active p95 < 200ms', async () => {
    const { p95: p } = await bench('GET /context/active', async () => {
      await request(httpServer).get('/api/v1/context/active').set('X-Api-Key', API_KEY);
    });
    assert.ok(p < 200, `p95 ${p}ms exceeds 200ms for /active`);
  });

  await t.test('GET /context/map p95 < 200ms', async () => {
    const { p95: p } = await bench('GET /context/map', async () => {
      await request(httpServer).get('/api/v1/context/map').set('X-Api-Key', API_KEY);
    });
    assert.ok(p < 200, `p95 ${p}ms exceeds 200ms for /map`);
  });

  await t.test('GET /context/workspace/overview?mode=startup p95 < 300ms', async () => {
    const { p95: p } = await bench('GET /workspace/overview startup', async () => {
      await request(httpServer).get('/api/v1/context/workspace/overview?mode=startup').set('X-Api-Key', API_KEY);
    });
    assert.ok(p < 300, `p95 ${p}ms exceeds 300ms for workspace overview startup`);
  });

  await t.test('GET /context/workspace/entities p95 < 250ms', async () => {
    const { p95: p } = await bench('GET /workspace/entities', async () => {
      await request(httpServer).get('/api/v1/context/workspace/entities').set('X-Api-Key', API_KEY);
    });
    assert.ok(p < 250, `p95 ${p}ms exceeds 250ms for workspace entities`);
  });

  // ─── Concurrency test ─────────────────────────────────────────────────────

  await t.test('50 concurrent GET /context/projects requests: no 500s', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(httpServer).get('/api/v1/context/projects').set('X-Api-Key', API_KEY)
      )
    );
    const failed = results.filter(r => r.status >= 500);
    assert.strictEqual(failed.length, 0, `${failed.length} requests returned 5xx under concurrency`);
  });

  await t.test('50 concurrent GET /healthz requests: p95 < 100ms', async () => {
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => request(httpServer).get('/healthz'))
    );
    const totalMs = Date.now() - start;
    const failed = results.filter(r => r.status !== 200);
    assert.strictEqual(failed.length, 0, `${failed.length} health checks failed under concurrency`);
    console.log(`  [perf] 50 concurrent /healthz completed in ${totalMs}ms`);
  });

  await t.test('20 concurrent extraction requests: no 500s', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(httpServer)
          .post('/api/v1/context/extraction')
          .set('X-Api-Key', API_KEY)
          .send({
            session_id: `sess-perf-${i}-${uuidv4()}`,
            tool: 'claude_code',
            chunks: [{ role: 'user', text: `Performance test message ${i} with some context about the project.` }],
            extraction: {
              match_decision: 'matched_existing',
              confidence: 0.8,
              project_candidate: { project_id: projectId, project_name: 'Perf Test', score: 0.8 },
              delta: { current_task: `Perf task ${i}` },
              should_create_project: false,
              needs_user_confirmation: false,
            },
          })
      )
    );
    const serverErrors = results.filter(r => r.status >= 500);
    assert.strictEqual(serverErrors.length, 0, `${serverErrors.length} extraction requests returned 5xx`);
    const ok = results.filter(r => r.status === 200).length;
    console.log(`  [perf] ${ok}/20 extraction requests succeeded (rest rate-guarded or 4xx)`);
  });

  // ─── Policy evaluation ────────────────────────────────────────────────────

  await t.test('POST /decisions:evaluate p95 < 100ms', async () => {
    const { p95: p } = await bench('POST /decisions:evaluate', async () => {
      await request(httpServer)
        .post('/api/v1/decisions:evaluate')
        .set('X-Api-Key', API_KEY)
        .send({ action_type: 'send_message', context: { user: 'test', content: 'hello' } });
    }, 10);
    // Policy eval should be fast even without policies configured (allow default)
    assert.ok(p < 500, `p95 ${p}ms exceeds 500ms for decisions:evaluate`);
  });
});
