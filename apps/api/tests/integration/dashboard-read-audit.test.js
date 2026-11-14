/**
 * A dashboard read is a read.
 *
 * context_audit_logs is what GET /teams/projects/:id/access is built on — the
 * "who has opened this project" roster a workspace owner sees. The audit line
 * lived at the BOTTOM of GET /projects/:id/inject, after two earlier returns:
 * `?format=json` (the call the dashboard brief and board make) and
 * `?sections=`. So every project read made from the browser left no trace at
 * all, and the roster was answering "who has opened this" with MCP traffic
 * only — a confidently wrong answer, which is worse than no feature.
 */
process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../../src/app');

const httpServer = app.listen(0);

const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('../helpers/runtimeAvailability');
const { ensureRuntimeSchema } = require('../helpers/runtimeSchema');

const systemKey = process.env.DEERDAWN_API_KEY || 'dev-key';
const auth = (req) => req.set('X-Api-Key', systemKey);

// logContextAudit is fire-and-forget by design — an audit write must never
// delay or fail a read — so the row can land a tick after the response. Poll
// for it rather than asserting on a race the product deliberately created.
const readsFor = async (projectId, expected = 1, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  for (;;) {
    const result = await db.query(
      `SELECT action, metadata FROM context_audit_logs
        WHERE project_id = $1 AND action = 'context_read'`,
      [projectId],
      'org-system'
    );
    rows = result.rows;
    if (rows.length >= expected || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test('dashboard project reads reach the access log', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'dashboard read audit')) return;
  if (!await ensureDatabaseAvailable(t, db, 'dashboard read audit')) return;
  await ensureRuntimeSchema();
  await store.clearAll();

  const created = await auth(request(httpServer).post('/api/v1/context/projects')).send({
    project_name: 'AuditedProj',
    description: 'A project somebody opens in the browser.',
    current_task: 'Make a read visible to the workspace owner',
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const projectId = created.body.project.project_id;

  await db.query('DELETE FROM context_audit_logs WHERE project_id = $1', [projectId], 'org-system');

  await t.test('?format=json — the brief and the board', async () => {
    const res = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject?format=json`));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const rows = await readsFor(projectId);
    assert.strictEqual(rows.length, 1, 'the dashboard read must be recorded exactly once');
    assert.strictEqual(rows[0].metadata.format, 'json');
  });

  await t.test('?sections= — the targeted read', async () => {
    await db.query('DELETE FROM context_audit_logs WHERE project_id = $1', [projectId], 'org-system');
    const res = await auth(request(httpServer)
      .get(`/api/v1/context/projects/${projectId}/inject?sections=task`));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const rows = await readsFor(projectId);
    // Matched on the marker rather than on position: the previous subtest's
    // fire-and-forget insert can still be in flight when this one starts.
    assert.ok(
      rows.some((row) => Array.isArray(row.metadata.sections) && row.metadata.sections.includes('task')),
      `no sections read recorded: ${JSON.stringify(rows)}`
    );
  });

  await t.test('the text render still records one, and only one', async () => {
    await db.query('DELETE FROM context_audit_logs WHERE project_id = $1', [projectId], 'org-system');
    const res = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`));
    assert.ok([200, 204].includes(res.status), `unexpected ${res.status}`);
    const rows = await readsFor(projectId, res.status === 200 ? 1 : 0, res.status === 200 ? 3000 : 500);
    assert.strictEqual(rows.length, res.status === 200 ? 1 : 0);
  });
});

test.after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await closeRedisConnections();
});
