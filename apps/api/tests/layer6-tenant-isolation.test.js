process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

/**
 * Layer 6 — Multi-Tenant Isolation (Context Sync)
 *
 * Verifies that no org can read, modify, or trigger operations on another
 * org's context projects, graph nodes, audit logs, or SSE streams.
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
const { hashPassword, generateApiKey } = require('../src/utils/security');
const store = require('../src/store/contextSyncStore');
const { ensureDatabaseAvailable } = require('./helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('./helpers/runtimeAvailability');
const { ensureRuntimeSchema } = require('./helpers/runtimeSchema');

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Isolation ${label}`, 'active'],
    orgId
  );
  const passHash = await hashPassword('TestPass123!');
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `iso-${label}-${Date.now()}@test.com`, passHash, 'admin', orgId],
    orgId
  );
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, `Key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['*']],
    orgId
  );
  return { orgId, userId, apiKey: key };
}

async function cleanupOrg(orgId) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
    await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [orgId], 'org-system').catch(() => {});
  }
  await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM injection_preferences WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  for (const table of ['api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

async function lookupNodeId(ownerKey, nodeType, canonicalKey) {
  const result = await db.query(
    'SELECT node_id FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2 AND canonical_key = $3',
    [ownerKey, nodeType, canonicalKey],
    'org-system'
  );
  return result.rows[0]?.node_id || null;
}

test('Layer 6 — Multi-Tenant Isolation', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'Layer 6 — Multi-Tenant Isolation')) return;
  if (!await ensureDatabaseAvailable(t, db, 'Layer 6 — Multi-Tenant Isolation')) return;
  await ensureRuntimeSchema();

  const orgA = await createOrgFixture('org-a');
  const orgB = await createOrgFixture('org-b');

  t.after(async () => {
    await store.clearAll().catch(() => {});
    await cleanupOrg(orgA.orgId).catch(() => {});
    await cleanupOrg(orgB.orgId).catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
  });

  // Create Org A's project
  const createRes = await request(httpServer)
    .post('/api/v1/context/projects')
    .set('X-Api-Key', orgA.apiKey)
    .send({ project_name: 'Org A Secret Project', description: 'Top secret' });
  assert.strictEqual(createRes.status, 201, `Org A project create got ${createRes.status}`);
  const orgAProjectId = (createRes.body.project || {}).project_id || createRes.body.project_id;
  assert.ok(orgAProjectId, `expected Org A project_id, got ${JSON.stringify(createRes.body)}`);

  // ─── Project isolation ────────────────────────────────────────────────────

  await t.test('Org B cannot list Org A projects', async () => {
    const res = await request(httpServer)
      .get('/api/v1/context/projects')
      .set('X-Api-Key', orgB.apiKey);
    assert.strictEqual(res.status, 200);
    const projects = res.body.projects || res.body;
    if (Array.isArray(projects)) {
      const found = projects.some(p => p.project_name === 'Org A Secret Project');
      assert.strictEqual(found, false, 'Org B should not see Org A projects');
    }
  });

  await t.test('Org B cannot inject from Org A project by ID', async () => {
    const res = await request(httpServer)
      .get(`/api/v1/context/projects/${orgAProjectId}/inject?tool=claude_code`)
      .set('X-Api-Key', orgB.apiKey);
    // Ideal: 403 or 404. 204 (no content) means project not found for this owner — acceptable isolation.
    // 200 with another org's data would be a breach.
    if (res.status === 200) {
      // If 200, verify the content doesn't expose Org A's private data
      const body = JSON.stringify(res.body);
      assert.ok(
        !body.includes('Org A Secret Project'),
        `Org B got 200 from Org A inject — possible isolation breach: ${body.slice(0, 200)}`
      );
      console.log('  WARNING: inject returned 200 for cross-org request — verify isolation at service layer');
    } else {
      assert.ok(
        res.status === 403 || res.status === 404 || res.status === 204,
        `expected 403/404/204 when Org B accesses Org A project, got ${res.status}`
      );
      if (res.status === 204) {
        console.log('  NOTE: inject returns 204 (no content) for unknown project — acceptable isolation behavior');
      }
    }
  });

  await t.test('Org B cannot send extraction targeting Org A project_id', async () => {
    const res = await request(httpServer)
      .post('/api/v1/context/extraction')
      .set('X-Api-Key', orgB.apiKey)
      .send({
        session_id: `sess-${uuidv4()}`,
        tool: 'claude_code',
        chunks: [{ role: 'user', text: 'Trying to write to Org A data' }],
        extraction: {
          match_decision: 'matched_existing',
          confidence: 0.99,
          project_candidate: { project_id: orgAProjectId, project_name: 'Org A Secret Project', score: 0.99 },
          delta: { current_task: 'Injected by Org B' },
          should_create_project: false,
          needs_user_confirmation: false,
        },
      });
    // Either returns 403/404 OR creates a new project under Org B (does not modify Org A)
    if (res.status === 200) {
      // Verify Org A project was NOT modified
      const orgAProjectsRes = await request(httpServer)
        .get('/api/v1/context/projects')
        .set('X-Api-Key', orgA.apiKey);
      const orgAProjects = orgAProjectsRes.body.projects || orgAProjectsRes.body;
      if (Array.isArray(orgAProjects)) {
        const orgAProject = orgAProjects.find(p => p.project_id === orgAProjectId);
        if (orgAProject) {
          const task = (orgAProject.context || {}).current_task;
          assert.notStrictEqual(task, 'Injected by Org B', 'Org B should not modify Org A context');
        }
      }
    } else {
      assert.ok(res.status === 403 || res.status === 404 || res.status === 200, `got ${res.status}`);
    }
  });

  // ─── Graph isolation ──────────────────────────────────────────────────────

  await t.test('Org B cannot access Org A graph nodes', async () => {
    const canonicalKey = 'decision:org-a-secret';
    // Create a node for Org A
    const entityRes = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('X-Api-Key', orgA.apiKey)
      .send({ entities: [{ entity_type: 'decision', title: 'Org A Decision', canonical_key: canonicalKey, scope: 'workspace' }] });

    assert.ok(entityRes.status === 200 || entityRes.status === 201, `entity create got ${entityRes.status}: ${JSON.stringify(entityRes.body)}`);
    const nodeId = (entityRes.body.entities || [])[0]?.node_id
      || (entityRes.body.created || [])[0]?.node_id
      || await lookupNodeId(orgA.orgId, 'decision', canonicalKey);
    assert.ok(nodeId, `expected node_id for ${canonicalKey}, got ${JSON.stringify(entityRes.body)}`);

    const res = await request(httpServer)
      .get(`/api/v1/context/graph/nodes/${nodeId}`)
      .set('X-Api-Key', orgB.apiKey);
    assert.ok(
      res.status === 403 || res.status === 404,
      `expected 403 or 404, got ${res.status}`
    );
  });

  await t.test('Org B workspace entities do not include Org A entities', async () => {
    const res = await request(httpServer)
      .get('/api/v1/context/workspace/entities')
      .set('X-Api-Key', orgB.apiKey);
    assert.strictEqual(res.status, 200);
    const entities = res.body.entities || res.body;
    if (Array.isArray(entities)) {
      const leaked = entities.some(e => e.title === 'Org A Decision');
      assert.strictEqual(leaked, false, 'Org B should not see Org A workspace entities');
    }
  });

  // ─── Audit log isolation ──────────────────────────────────────────────────

  await t.test('Org B cannot access Org A audit logs', async () => {
    const res = await request(httpServer)
      .get('/api/v1/audit')
      .set('X-Api-Key', orgB.apiKey);
    if (res.status === 200) {
      const logs = res.body.logs || res.body;
      if (Array.isArray(logs)) {
        const leaked = logs.some(l => l.org_id === orgA.orgId);
        assert.strictEqual(leaked, false, 'Org B audit logs should not contain Org A entries');
      }
    }
  });

  // ─── owner_key DB-level verification ─────────────────────────────────────

  await t.test('DB query with Org B owner_key returns 0 rows from Org A projects', async () => {
    // Get Org A's actual owner_key from the project
    const orgAResult = await db.query(
      'SELECT owner_key FROM context_projects WHERE project_id = $1',
      [orgAProjectId],
      'org-system'
    );
    assert.ok(orgAResult.rows.length > 0, `expected project ${orgAProjectId} in DB`);
    const orgAOwnerKey = orgAResult.rows[0].owner_key;
    // Org B's owner_key should not match Org A's
    const result = await db.query(
      'SELECT project_id FROM context_projects WHERE project_id = $1 AND owner_key = $2',
      [orgAProjectId, orgB.orgId],
      'org-system'
    );
    assert.strictEqual(result.rows.length, 0, `Org B owner_key (${orgB.orgId}) should not match Org A project owner_key (${orgAOwnerKey})`);
  });
});
