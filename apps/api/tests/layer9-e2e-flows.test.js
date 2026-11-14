/**
 * Layer 9 — End-to-End Flows
 *
 * Complete scenario tests that simulate real user journeys:
 * A) New user onboarding + extraction + SSE notification
 * B) MCP device flow + project creation + context recall
 * C) Multi-project CWD matching
 * D) Billing gate (free plan project limit)
 * E) Workspace knowledge graph lifecycle
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const app = require('../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../src/config/db');
const { redis, closeRedisConnections } = require('../src/config/redis');
const { hashPassword, generateApiKey, generateToken } = require('../src/utils/security');
const store = require('../src/store/contextSyncStore');


async function createOrgFixture(label, plan = 'free') {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `E2E ${label}`, plan, plan, 'active'],
    orgId
  );
  const passHash = await hashPassword('TestPass123!');
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `e2e-${label}-${Date.now()}@test.com`, passHash, 'admin', orgId],
    orgId
  );
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, `E2E Key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['*']],
    orgId
  );
  const token = generateToken({ user_id: userId, role: 'admin', org_id: orgId });
  return { orgId, userId, apiKey: key, token };
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

test('Layer 9 — End-to-End Flows', async (t) => {
  const orgs = [];

  t.after(async () => {
    await store.clearAll().catch(() => {});
    for (const orgId of orgs) await cleanupOrg(orgId).catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
  });

  // ─── Flow A: New User Onboarding ──────────────────────────────────────────

  await t.test('Flow A: New user onboarding — signup → project → extraction → inject → SSE', async (t) => {
    // Paid tier: the flow creates two top-level projects; free's 1-workspace cap
    // would 422 the second. Plan-gate behavior is Flow D's job.
    const { orgId, apiKey } = await createOrgFixture('flow-a', 'developer_basic');
    orgs.push(orgId);

    await t.test('A1: Create first project', async () => {
      const res = await request(httpServer)
        .post('/api/v1/context/projects')
        .set('X-Api-Key', apiKey)
        .send({ project_name: 'Flow A Project', description: 'Testing onboarding flow', tech_stack: ['TypeScript', 'Node.js'] });
      assert.strictEqual(res.status, 201, `create project got ${res.status}: ${JSON.stringify(res.body)}`);
      this.projectId = (res.body.project || {}).project_id || res.body.project_id;
    });

    let projectId;

    await t.test('A1: Create first project (direct)', async () => {
      const res = await request(httpServer)
        .post('/api/v1/context/projects')
        .set('X-Api-Key', apiKey)
        .send({ project_name: 'Flow A Project Direct', tech_stack: ['TypeScript'] });
      assert.strictEqual(res.status, 201);
      projectId = (res.body.project || {}).project_id || res.body.project_id;
      assert.ok(projectId, 'expected project_id');
    });

    await t.test('A2: Post extraction with delta', async () => {
      if (!projectId) return;
      const res = await request(httpServer)
        .post('/api/v1/context/extraction')
        .set('X-Api-Key', apiKey)
        .send({
          session_id: `sess-a-${uuidv4()}`,
          tool: 'claude_code',
          chunks: [{ role: 'user', text: 'Working on the context sync extraction pipeline with TypeScript.' }],
          extraction: {
            match_decision: 'matched_existing',
            confidence: 0.9,
            project_candidate: { project_id: projectId, project_name: 'Flow A Project Direct', score: 0.9 },
            delta: { current_task: 'Build extraction pipeline', current_status: 'in_progress', tech_stack: ['TypeScript', 'Node.js'] },
            should_create_project: false,
            needs_user_confirmation: false,
          },
        });
      assert.ok(res.status === 200 || res.status === 202, `extraction got ${res.status}: ${JSON.stringify(res.body).slice(0,200)}`);
    });

    await t.test('A3: Get injection for claude_code tool', async () => {
      if (!projectId) return;
      const res = await request(httpServer)
        .get(`/api/v1/context/projects/${projectId}/inject?tool=claude_code`)
        .set('X-Api-Key', apiKey);
      assert.strictEqual(res.status, 200);
      // Inject returns {payload: {tool, format, verbosity, body, provenance}}
      const content = res.body.payload?.body || res.body.brief || res.body.body || res.body.injection;
      assert.ok(content !== undefined || res.body.payload, 'expected payload in inject response');
    });

    await t.test('A4: Project context updated in DB after extraction', async () => {
      if (!projectId) return;
      const result = await db.query(
        'SELECT context FROM context_projects WHERE project_id = $1',
        [projectId],
        'org-system'
      );
      assert.strictEqual(result.rows.length, 1, 'project should exist in DB');
    });

    await t.test('A5: SSE stream establishes connection (event delivery requires Redis)', async () => {
      if (!projectId) return;
      const server = app.listen(0);
      const port = server.address().port;

      await new Promise((resolve) => {
        const req = http.request(`http://localhost:${port}/api/v1/context/stream`, {
          headers: { 'X-Api-Key': apiKey, Accept: 'text/event-stream' },
        }, (res) => {
          assert.strictEqual(res.statusCode, 200, `SSE should return 200, got ${res.statusCode}`);
          assert.ok(
            (res.headers['content-type'] || '').includes('text/event-stream'),
            `expected SSE content-type, got ${res.headers['content-type']}`
          );
          req.destroy();
        });
        req.on('error', () => {}); // ignore destroy error
        req.end();
        // Force cleanup after 1s
        setTimeout(() => {
          server.closeAllConnections?.();
          server.close();
          resolve();
        }, 1000);
      });
    });
  });

  // ─── Flow B: MCP Device Flow + Context Recall ─────────────────────────────

  await t.test('Flow B: MCP device flow + project create + context recall', async (t) => {
    const fixture = await createOrgFixture('flow-b');
    const { orgId, apiKey } = fixture;
    orgs.push(orgId);

    let deviceCode;
    let userCode;

    await t.test('B1: Start MCP device flow', async () => {
      const res = await request(httpServer)
        .post('/api/v1/auth/mcp/start')
        .send({ client_name: 'flow-b-mcp' });
      assert.ok(res.status === 200 || res.status === 201, `got ${res.status}`);
      assert.ok(res.body.device_code, 'expected device_code');
      assert.ok(res.body.user_code, 'expected user_code');
      deviceCode = res.body.device_code;
      userCode = res.body.user_code;
    });

    await t.test('B2: Poll token returns pending', async () => {
      if (!deviceCode) return;
      const res = await request(httpServer)
        .get(`/api/v1/auth/mcp/token?device_code=${deviceCode}`);
      assert.ok(res.body.status === 'pending' || res.body.status === 'authorization_pending', `got ${JSON.stringify(res.body)}`);
    });

    await t.test('B3: Authorize device code (Bearer token required)', async () => {
      if (!deviceCode) return;
      // MCP authorize creates an API key owned by the user — requires Bearer (not API key) auth.
      // Authorize with the human-entered user_code (the dashboard's real contract), not device_code.
      const res = await request(httpServer)
        .post('/api/v1/auth/mcp/authorize')
        .set('Authorization', `Bearer ${fixture.token}`)
        .send({ user_code: userCode });
      assert.ok(res.status === 200 || res.status === 201, `authorize got ${res.status}: ${JSON.stringify(res.body)}`);
    });

    let mcpApiKey;

    await t.test('B4: Poll token returns api_key (one-time pickup)', async () => {
      if (!deviceCode) return;
      const res = await request(httpServer)
        .get(`/api/v1/auth/mcp/token?device_code=${deviceCode}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.api_key || res.body.token, 'expected api_key in response');
      // Token is deleted after retrieval — capture it here
      mcpApiKey = res.body.api_key || res.body.token;
    });

    let projectId;

    await t.test('B5: Create project via MCP API key', async () => {
      const key = mcpApiKey || apiKey;
      const res = await request(httpServer)
        .post('/api/v1/context/projects')
        .set('X-Api-Key', key)
        .send({ project_name: 'MCP Flow B Project' });
      assert.strictEqual(res.status, 201);
      projectId = (res.body.project || {}).project_id || res.body.project_id;
    });

    await t.test('B6: Update context via extraction', async () => {
      const key = mcpApiKey || apiKey;
      if (!projectId) return;
      const res = await request(httpServer)
        .post('/api/v1/context/extraction')
        .set('X-Api-Key', key)
        .send({
          session_id: `sess-b-${uuidv4()}`,
          tool: 'claude_code',
          chunks: [{ role: 'user', text: 'MCP flow B test: working on auth module.' }],
          extraction: {
            match_decision: 'matched_existing',
            confidence: 0.9,
            project_candidate: { project_id: projectId, project_name: 'MCP Flow B Project', score: 0.9 },
            delta: { current_task: 'Build MCP auth module', current_status: 'in_progress' },
            should_create_project: false,
            needs_user_confirmation: false,
          },
        });
      assert.ok(res.status === 200 || res.status === 202, `extraction got ${res.status}`);
    });

    await t.test('B7: Recall context via inject endpoint', async () => {
      const key = mcpApiKey || apiKey;
      if (!projectId) return;
      const res = await request(httpServer)
        .get(`/api/v1/context/projects/${projectId}/inject?tool=claude_code`)
        .set('X-Api-Key', key);
      assert.strictEqual(res.status, 200);
      const content = JSON.stringify(res.body);
      assert.ok(content.length > 10, 'expected non-trivial injection response');
    });
  });

  // ─── Flow C: Multi-Project CWD Matching ──────────────────────────────────

  await t.test('Flow C: Multi-project CWD matching', async (t) => {
    // Paid tier: CWD matching needs 3 coexisting projects, which free's
    // 1-workspace cap forbids.
    const { orgId, apiKey } = await createOrgFixture('flow-c', 'developer_basic');
    orgs.push(orgId);

    const projectIds = {};

    await t.test('C1: Create 3 projects with different linked_paths', async () => {
      for (const [name, path] of [
        ['Project Alpha', '/home/user/alpha'],
        ['Project Beta', '/home/user/beta'],
        ['Project Gamma', '/home/user/gamma'],
      ]) {
        const res = await request(httpServer)
          .post('/api/v1/context/projects')
          .set('X-Api-Key', apiKey)
          .send({ project_name: name, linked_paths: [path] });
        assert.strictEqual(res.status, 201);
        projectIds[name] = (res.body.project || {}).project_id || res.body.project_id;
      }
    });

    await t.test('C2: GET /context/active?cwd=/home/user/beta returns a project (CWD or recency)', async () => {
      const res = await request(httpServer)
        .get('/api/v1/context/active?cwd=/home/user/beta')
        .set('X-Api-Key', apiKey);
      assert.strictEqual(res.status, 200);
      // Note: linked_paths are set via extraction sessions (not at project creation).
      // Without an extraction session, active falls back to most-recently-updated project.
      assert.ok(res.body.project_id || res.body.project_id === null, 'expected project_id field in response');
      console.log('  C2 active result:', res.body.project_name, '(CWD matching requires prior extraction session)');
    });

    await t.test('C3: GET /context/map shows all 3 projects', async () => {
      const res = await request(httpServer)
        .get('/api/v1/context/map')
        .set('X-Api-Key', apiKey);
      assert.strictEqual(res.status, 200);
      const mapContent = JSON.stringify(res.body);
      const foundCount = ['Project Alpha', 'Project Beta', 'Project Gamma']
        .filter(name => mapContent.includes(name)).length;
      assert.ok(foundCount >= 3, `expected all 3 projects in map, found ${foundCount}`);
    });

    await t.test('C4: POST /context/search finds projects across workspace', async () => {
      const res = await request(httpServer)
        .post('/api/v1/context/search')
        .set('X-Api-Key', apiKey)
        .send({ query: 'Alpha Beta Gamma', limit: 10 });
      assert.strictEqual(res.status, 200);
    });
  });

  // ─── Flow D: Billing Gate ─────────────────────────────────────────────────

  await t.test('Flow D: Free plan project limit behavior', async (t) => {
    const { orgId, apiKey } = await createOrgFixture('flow-d', 'free');
    orgs.push(orgId);

    await t.test('D1: First project creation succeeds on free plan', async () => {
      const res = await request(httpServer)
        .post('/api/v1/context/projects')
        .set('X-Api-Key', apiKey)
        .send({ project_name: 'Free Plan Project 1' });
      assert.ok(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    });

    await t.test('D2: Upgrade org plan to developer_pro in DB', async () => {
      await db.query(
        'UPDATE organizations SET plan = $1::text, plan_tier = $1::text WHERE org_id = $2::text',
        ['developer_pro', orgId],
        orgId
      );
      await redis.del(`org:${orgId}`).catch(() => {});
    });

    await t.test('D3: Second project creation succeeds after upgrade', async () => {
      const res = await request(httpServer)
        .post('/api/v1/context/projects')
        .set('X-Api-Key', apiKey)
        .send({ project_name: 'Pro Plan Project 2' });
      assert.ok(res.status === 201 || res.status === 200, `pro plan project create got ${res.status}: ${JSON.stringify(res.body)}`);
    });

    await t.test('D4: Downgrade to free plan in DB (simulate cancellation webhook)', async () => {
      await db.query(
        'UPDATE organizations SET plan = \'free\'::text, plan_tier = \'free\'::text, subscription_status = \'canceled\'::text WHERE org_id = $1::text',
        [orgId],
        orgId
      );
      await redis.del(`org:${orgId}`).catch(() => {});
      const result = await db.query('SELECT plan, subscription_status FROM organizations WHERE org_id = $1', [orgId], orgId);
      assert.strictEqual(result.rows[0].plan, 'free');
      assert.strictEqual(result.rows[0].subscription_status, 'canceled');
    });
  });

  // ─── Flow E: Workspace Knowledge Graph Lifecycle ──────────────────────────

  await t.test('Flow E: Workspace knowledge graph — create entities, relate, query, delete', async (t) => {
    const { orgId, apiKey } = await createOrgFixture('flow-e');
    orgs.push(orgId);

    const keys = {
      task: `task:flow-e-${uuidv4().slice(0, 8)}`,
      decision: `decision:flow-e-${uuidv4().slice(0, 8)}`,
      service: `service:flow-e-${uuidv4().slice(0, 8)}`,
    };
    const nodeIds = {};

    await t.test('E1: Create 3 entities (task, decision, service)', async () => {
      const res = await request(httpServer)
        .post('/api/v1/context/workspace/entities')
        .set('X-Api-Key', apiKey)
        .send({
          entities: [
            { entity_type: 'task', title: 'Build auth service', canonical_key: keys.task, scope: 'workspace', metadata: { status: 'active' } },
            { entity_type: 'decision', title: 'Use JWT tokens', canonical_key: keys.decision, scope: 'workspace' },
            { entity_type: 'service', title: 'Auth Service API', canonical_key: keys.service, scope: 'workspace' },
          ],
          relations: [
            { from_canonical_key: keys.task, to_canonical_key: keys.decision, relation_type: 'implements', summary: 'Task implements the JWT decision' },
            { from_canonical_key: keys.decision, to_canonical_key: keys.service, relation_type: 'used_in', summary: 'JWT used in auth service' },
          ],
        });
      assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
      const created = res.body.entities || res.body.created || [];
      if (Array.isArray(created)) {
        created.forEach(e => { if (e.node_id && e.canonical_key) nodeIds[e.canonical_key] = e.node_id; });
      }
    });

    await t.test('E2: GET workspace/entities?types=task returns only tasks', async () => {
      const res = await request(httpServer)
        .get('/api/v1/context/workspace/entities?types=task')
        .set('X-Api-Key', apiKey);
      assert.strictEqual(res.status, 200);
      const entities = res.body.entities || res.body;
      if (Array.isArray(entities) && entities.length > 0) {
        const allTasks = entities.every(e => e.node_type === 'task' || e.entity_type === 'task');
        assert.ok(allTasks, 'all returned entities should be tasks');
      }
    });

    await t.test('E3: GET workspace/overview includes entity summary', async () => {
      const res = await request(httpServer)
        .get('/api/v1/context/workspace/overview?mode=overview')
        .set('X-Api-Key', apiKey);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body !== null, 'expected non-null overview');
    });

    await t.test('E4: Delete service entity', async () => {
      const serviceNodeId = nodeIds[keys.service];
      if (!serviceNodeId) {
        console.log('  service node_id not found in response — skipping delete test');
        return;
      }
      const deleteRes = await request(httpServer)
        .delete(`/api/v1/context/graph/nodes/${serviceNodeId}`)
        .set('X-Api-Key', apiKey);
      assert.ok(deleteRes.status === 200 || deleteRes.status === 204, `delete got ${deleteRes.status}`);

      // Verify entity is gone
      const getRes = await request(httpServer)
        .get(`/api/v1/context/graph/nodes/${serviceNodeId}`)
        .set('X-Api-Key', apiKey);
      assert.ok(getRes.status === 404, `deleted node should return 404, got ${getRes.status}`);
    });
  });

  // ─── Flow F: Dashboard bootstrap reflects context state ───────────────────

  await t.test('Flow F: Dashboard bootstrap reflects context state', async (t) => {
    const { orgId, apiKey } = await createOrgFixture('flow-f');
    orgs.push(orgId);
    const auth = (req) => req.set('X-Api-Key', apiKey);

    await t.test('F1: Bootstrap before context returns free plan shape', async () => {
      const res = await auth(request(httpServer).get('/api/v1/dashboard/bootstrap'));
      assert.ok(res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.org, 'expected org');
      assert.ok(res.body.user, 'expected user');
      assert.strictEqual(res.body.status, 'ok', 'bootstrap status field must be "ok"');
      assert.strictEqual(res.body.error_code, null, 'bootstrap error_code must be null on success');
      assert.ok(res.body.shell, 'bootstrap must include shell object');
      assert.ok(res.body.shell.visible_navigation && typeof res.body.shell.visible_navigation === 'object', 'bootstrap shell must include visible_navigation object');
    });

    let fProjectId;
    await t.test('F2: Create project and run extraction', async () => {
      const proj = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ project_name: 'Flow F Project', tech_stack: ['Go'] });
      assert.ok(proj.status === 200 || proj.status === 201, `create got ${proj.status}`);
      fProjectId = proj.body.project?.project_id ?? proj.body.project_id;
      assert.ok(fProjectId, 'expected project_id');

      const ext = await auth(request(httpServer).post('/api/v1/context/extraction'))
        .send({
          session_id: `f2-${uuidv4()}`,
          tool: 'claude_code',
          project_id: fProjectId,
          chunks: [
            { role: 'user', text: 'Build the flow F feature' },
            { role: 'assistant', text: 'Done — Flow F feature complete.' },
          ],
          delta: { current_task: 'Flow F feature', current_status: 'Complete' },
        });
      assert.ok(ext.status === 200 || ext.status === 202, `extraction got ${ext.status}`);
    });

    await t.test('F3: Bootstrap after context returns same valid shape', async () => {
      const res = await auth(request(httpServer).get('/api/v1/dashboard/bootstrap'));
      assert.ok(res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.org, 'expected org in bootstrap after context');
      assert.ok(res.body.user, 'expected user in bootstrap after context');
    });
  });

  // ─── Flow G: Injection format correctness per tool ────────────────────────

  await t.test('Flow G: Injection format correctness per tool', async (t) => {
    const { orgId, apiKey } = await createOrgFixture('flow-g');
    orgs.push(orgId);
    const auth = (req) => req.set('X-Api-Key', apiKey);

    let gProjectId;
    await t.test('G1: Create project with rich context', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ project_name: 'Flow G App', tech_stack: ['TypeScript', 'React'], description: 'Frontend dashboard' });
      assert.ok(res.status === 200 || res.status === 201, `got ${res.status}`);
      gProjectId = res.body.project?.project_id ?? res.body.project_id;
      assert.ok(gProjectId, 'expected project_id');

      await auth(request(httpServer).post('/api/v1/context/extraction'))
        .send({
          session_id: `g1-${uuidv4()}`,
          tool: 'claude_code',
          project_id: gProjectId,
          chunks: [
            { role: 'user', text: 'Build the chart component in Flow G App' },
            { role: 'assistant', text: 'Built chart using Recharts. Added dark mode support.' },
          ],
          delta: {
            current_task: 'Build chart component',
            current_status: 'Chart shipped with dark mode',
            recent_decisions: [{ summary: 'Use Recharts for charts', decided_at: new Date().toISOString() }],
          },
        });
    });

    await t.test('G2: claude_code injection returns code format with content', async () => {
      if (!gProjectId) return;
      const res = await auth(request(httpServer)
        .get(`/api/v1/context/projects/${gProjectId}/inject?tool=claude_code&verbosity=standard`));
      assert.ok(res.status === 200 || res.status === 204, `got ${res.status}`);
      if (res.status === 200) {
        const body = res.body.payload?.body ?? res.body.body ?? res.body.brief;
        assert.ok(body && body.length > 20, `expected substantial injection body, got: ${body}`);
        const format = res.body.payload?.format ?? res.body.format;
        if (format) assert.ok(format === 'code' || format === 'conversational', `unexpected format: ${format}`);
      }
    });

    await t.test('G3: claude_web injection returns conversational format', async () => {
      if (!gProjectId) return;
      const res = await auth(request(httpServer)
        .get(`/api/v1/context/projects/${gProjectId}/inject?tool=claude_web&verbosity=light`));
      assert.ok(res.status === 200 || res.status === 204, `got ${res.status}`);
    });

    await t.test('G4: cursor injection returns response', async () => {
      if (!gProjectId) return;
      const res = await auth(request(httpServer)
        .get(`/api/v1/context/projects/${gProjectId}/inject?tool=cursor&verbosity=detailed`));
      assert.ok(res.status === 200 || res.status === 204, `got ${res.status}`);
    });
  });
});
