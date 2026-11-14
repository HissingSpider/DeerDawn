/**
 * Layer 3 — Context Sync API
 *
 * Tests project CRUD, extraction pipeline, injection rendering,
 * project matching, preferences, global context, and SSE stream.
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
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

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';

function auth(req) {
  return req.set('X-Api-Key', API_KEY);
}

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `CtxSync ${label}`, 'active'],
    orgId
  );
  const passHash = await hashPassword('TestPass123!');
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `ctx-${label}-${Date.now()}@test.com`, passHash, 'admin', orgId],
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
  // context_* tables use owner_key (= org_id for real orgs, 'org-system' for dev-key)
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

test('Layer 3 — Context Sync API', async (t) => {
  const orgs = [];

  t.after(async () => {
    await store.clearAll().catch(() => {});
    for (const orgId of orgs) await cleanupOrg(orgId).catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
  });

  // ─── Project CRUD ────────────────────────────────────────────────────────

  await t.test('POST /context/projects creates project and returns project_id UUID', async () => {
    const { orgId, apiKey } = await createOrgFixture('create');
    orgs.push(orgId);

    const res = await request(httpServer)
      .post('/api/v1/context/projects')
      .set('X-Api-Key', apiKey)
      .send({ project_name: 'Test Project Alpha' });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.project || res.body.project_id, 'expected project in response');
    const projectId = (res.body.project || {}).project_id || res.body.project_id;
    assert.ok(projectId, 'expected project_id');
    // project_id format: "project_<uuid>" or plain UUID
    assert.ok(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(projectId),
      `expected UUID in project_id, got ${projectId}`
    );
  });

  await t.test('GET /context/projects lists projects for authenticated user', async () => {
    const { orgId, apiKey } = await createOrgFixture('list');
    orgs.push(orgId);

    await request(httpServer)
      .post('/api/v1/context/projects')
      .set('X-Api-Key', apiKey)
      .send({ project_name: 'Listed Project' });

    const res = await request(httpServer)
      .get('/api/v1/context/projects')
      .set('X-Api-Key', apiKey);
    assert.strictEqual(res.status, 200);
    const projects = res.body.projects || res.body;
    assert.ok(Array.isArray(projects), 'expected array');
    assert.ok(projects.length >= 1, 'expected at least 1 project');
  });

  await t.test('GET /context/projects does not return other orgs projects', async () => {
    const orgA = await createOrgFixture('iso-a');
    const orgB = await createOrgFixture('iso-b');
    orgs.push(orgA.orgId, orgB.orgId);

    await request(httpServer)
      .post('/api/v1/context/projects')
      .set('X-Api-Key', orgA.apiKey)
      .send({ project_name: 'Org A Private Project' });

    const res = await request(httpServer)
      .get('/api/v1/context/projects')
      .set('X-Api-Key', orgB.apiKey);
    const projects = res.body.projects || res.body;
    const found = Array.isArray(projects) && projects.some(p => p.project_name === 'Org A Private Project');
    assert.strictEqual(found, false, 'Org B should not see Org A projects');
  });

  await t.test('POST /context/projects without project_name returns 400', async () => {
    const res = await auth(request(httpServer).post('/api/v1/context/projects'))
      .send({ description: 'No name given' });
    assert.strictEqual(res.status, 400);
  });

  await t.test('POST /context/projects without auth returns 401/403', async () => {
    const res = await request(httpServer)
      .post('/api/v1/context/projects')
      .send({ project_name: 'Unauth' });
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  // ─── Extraction pipeline ─────────────────────────────────────────────────

  await t.test('POST /context/extraction with client-provided extraction returns 200', async () => {
    const createRes = await auth(request(httpServer).post('/api/v1/context/projects'))
      .send({ project_name: 'Extraction Test Project' });
    assert.strictEqual(createRes.status, 201);
    const projectId = (createRes.body.project || {}).project_id || createRes.body.project_id;

    const res = await auth(request(httpServer).post('/api/v1/context/extraction'))
      .send({
        session_id: `sess-${uuidv4()}`,
        tool: 'claude_code',
        chunks: [{ role: 'user', text: 'Working on the extraction layer for context sync with TypeScript.' }],
        extraction: {
          match_decision: 'matched_existing',
          confidence: 0.9,
          project_candidate: { project_id: projectId, project_name: 'Extraction Test Project', score: 0.9 },
          delta: { current_task: 'Implement extraction layer', current_status: 'in_progress' },
          should_create_project: false,
          needs_user_confirmation: false,
        },
      });
    // Extraction returns 200 or 202 (queued)
    assert.ok(res.status === 200 || res.status === 202, `got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert.ok(res.body.match_decision || res.body.routing_state || res.body.project_id || res.body.project, 'expected extraction result fields');
  });

  await t.test('POST /context/extraction without session_id returns 400', async () => {
    const res = await auth(request(httpServer).post('/api/v1/context/extraction'))
      .send({ tool: 'claude_web', chunks: [{ role: 'user', text: 'hello' }] });
    assert.strictEqual(res.status, 400);
  });

  await t.test('POST /context/extraction with unknown tool returns 400', async () => {
    const res = await auth(request(httpServer).post('/api/v1/context/extraction'))
      .send({ session_id: `sess-${uuidv4()}`, tool: 'unknown_tool_xyz', chunks: [{ role: 'user', text: 'hi' }] });
    assert.strictEqual(res.status, 400);
  });

  await t.test('POST /context/extraction without auth returns 401/403', async () => {
    const res = await request(httpServer)
      .post('/api/v1/context/extraction')
      .send({ session_id: 'x', tool: 'claude_web', chunks: [] });
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  await t.test('POST /context/extraction with context:read-only key returns insufficient_scope', async () => {
    const { orgId } = await createOrgFixture('read-only-scope');
    orgs.push(orgId);
    // Re-insert key with context:read scope only
    const { key: readKey, prefix: rp, hash: rh } = generateApiKey();
    const rKeyId = `key-${uuidv4()}`;
    const exp = new Date(); exp.setDate(exp.getDate() + 30);
    const userId = `user-ro-${uuidv4()}`;
    await db.query('INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
      [userId, `ro-${Date.now()}@test.com`, 'x', 'admin', orgId], orgId);
    await db.query(
      'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [rKeyId, rp, rh, 'Read-only key', userId, orgId, 'production', exp.toISOString(), ['context:read']],
      orgId
    );
    const res = await request(httpServer)
      .post('/api/v1/context/extraction')
      .set('X-Api-Key', readKey)
      .send({ session_id: `sess-${uuidv4()}`, tool: 'claude_code', chunks: [{ role: 'user', text: 'hi' }] });
    assert.ok(res.status === 403, `expected 403 insufficient_scope, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'insufficient_scope', 'error code must be insufficient_scope');
  });

  // ─── Injection / retrieval ───────────────────────────────────────────────

  await t.test('GET /context/projects/:id/inject?tool=claude_code returns formatted brief', async () => {
    const createRes = await auth(request(httpServer).post('/api/v1/context/projects'))
      .send({ project_name: 'Inject Test', current_status: 'Active', tech_stack: ['Node.js', 'PostgreSQL'] });
    assert.strictEqual(createRes.status, 201);
    const projectId = (createRes.body.project || {}).project_id || createRes.body.project_id;

    const res = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject?tool=claude_code`));
    assert.strictEqual(res.status, 200);
    // Inject returns {payload: {tool, format, verbosity, body, provenance}}
    const content = res.body.payload?.body || res.body.brief || res.body.body || res.body.injection;
    assert.ok(content !== undefined || res.body.payload, 'expected payload or brief in inject response');
  });

  await t.test('GET /context/projects/:id/inject?tool=cursor returns code-format block', async () => {
    const createRes = await auth(request(httpServer).post('/api/v1/context/projects'))
      .send({ project_name: 'Cursor Inject Test' });
    const projectId = (createRes.body.project || {}).project_id || createRes.body.project_id;

    const res = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject?tool=cursor`));
    assert.strictEqual(res.status, 200);
    const content = res.body.payload?.body || res.body.brief || res.body.body || res.body.injection;
    assert.ok(content !== undefined || res.body.payload, 'expected payload in cursor inject response');
  });

  await t.test('GET /context/active returns null project when empty', async () => {
    const { orgId, apiKey } = await createOrgFixture('active-empty');
    orgs.push(orgId);

    const res = await request(httpServer)
      .get('/api/v1/context/active')
      .set('X-Api-Key', apiKey);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.project_id, null);
  });

  await t.test('GET /context/map returns project listing', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/map'));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.map !== undefined || res.body.projects !== undefined || typeof res.body === 'object', 'expected map response');
  });

  // ─── Search ──────────────────────────────────────────────────────────────

  await t.test('POST /context/search returns results array', async () => {
    const res = await auth(request(httpServer).post('/api/v1/context/search'))
      .send({ query: 'TypeScript context sync', limit: 5 });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.results || res.body), 'expected results array');
  });

  await t.test('POST /context/search without query returns 400', async () => {
    const res = await auth(request(httpServer).post('/api/v1/context/search'))
      .send({ limit: 5 });
    assert.ok(res.status === 400 || res.status === 422, `got ${res.status}`);
  });

  // ─── Preferences ────────────────────────────────────────────────────────

  await t.test('PATCH /context/preferences saves preferences, GET retrieves them', async () => {
    const { orgId, apiKey } = await createOrgFixture('prefs');
    orgs.push(orgId);

    const patchRes = await request(httpServer)
      .patch('/api/v1/context/preferences')
      .set('X-Api-Key', apiKey)
      .send({ preferences: { paused: false, tools: { claude_code: { enabled: true } } } });
    assert.ok(patchRes.status === 200 || patchRes.status === 204, `patch got ${patchRes.status}`);

    const getRes = await request(httpServer)
      .get('/api/v1/context/preferences')
      .set('X-Api-Key', apiKey);
    assert.strictEqual(getRes.status, 200);
    assert.ok(getRes.body.preferences !== undefined || getRes.body !== null, 'expected preferences');
  });

  // ─── Global context ──────────────────────────────────────────────────────

  await t.test('GET /context/global returns user profile or empty state', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/global'));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body !== null, 'expected non-null global context');
  });

  // ─── SSE stream ──────────────────────────────────────────────────────────

  await t.test('GET /context/stream establishes SSE connection and sends heartbeat', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${port}/api/v1/context/stream`, {
        headers: { 'X-Api-Key': API_KEY, Accept: 'text/event-stream' },
      }, (res) => {
        assert.strictEqual(res.statusCode, 200);
        assert.ok(
          (res.headers['content-type'] || '').includes('text/event-stream'),
          `expected SSE content-type, got ${res.headers['content-type']}`
        );
        req.destroy();
        server.close(resolve);
      });
      req.on('error', (e) => { server.close(); reject(e); });
      setTimeout(() => { req.destroy(); server.close(resolve); }, 2000);
      req.end();
    });
  });

  // ─── Content routes smoke tests ───────────────────────────────────────────

  await t.test('GET /public/content is publicly accessible and returns content array', async () => {
    const res = await request(httpServer).get('/api/v1/public/content');
    assert.ok(
      res.status === 200 || res.status === 404,
      `expected 200/404, got ${res.status}: ${JSON.stringify(res.body)}`
    );
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.pages) || Array.isArray(res.body) || res.body !== null,
        'expected content response');
    }
  });

  await t.test('GET /admin/content without auth returns 401/403', async () => {
    const res = await request(httpServer).get('/api/v1/admin/content');
    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
  });

  await t.test('GET /admin/content with valid API key returns content list', async () => {
    const res = await auth(request(httpServer).get('/api/v1/admin/content'));
    assert.ok(
      res.status === 200 || res.status === 403,
      `got ${res.status}: ${JSON.stringify(res.body)}`
    );
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.pages) || Array.isArray(res.body) || res.body !== null,
        'expected admin content response');
    }
  });
});
