const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const { closeRedisConnections } = require('../../src/config/redis');
const store = require('../../src/store/contextSyncStore');

async function createSharedOrgFixture() {
  const orgId = `org-${uuidv4()}`;
  const users = [];

  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, 'Shared Team Workspace', 'developer_pro', 'developer_pro', 'active'],
    orgId
  );

  for (const label of ['alpha', 'beta']) {
    const userId = `user-${uuidv4()}`;
    const email = `${label}-${Date.now()}@test.com`;
    const { key, prefix, hash } = generateApiKey();
    const keyId = `key-${uuidv4()}`;
    const passwordHash = await hashPassword('password123');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();

    await db.query(
      'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
      [userId, email, passwordHash, 'admin', orgId],
      orgId
    );
    await db.query(
      'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [keyId, prefix, hash, `Shared key ${label}`, userId, orgId, 'production', expiresAt, ['context:read', 'context:write']],
      orgId
    );

    users.push({ label, userId, apiKey: key });
  }

  return { orgId, users };
}

async function cleanupSharedOrgFixture({ orgId }) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
    await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [orgId], 'org-system').catch(() => {});
  }
  await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM injection_preferences WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId).catch(() => {});
  await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
}

function auth(req, apiKey) {
  return req.set('X-Api-Key', apiKey);
}

test('Context sync shared org behavior for team plans', async () => {
  await store.clearAll();
  const fixture = await createSharedOrgFixture();
  const [alpha, beta] = fixture.users;

  try {
    const createRes = await auth(request(httpServer).post('/api/v1/context/projects'), alpha.apiKey).send({
      project_name: 'Team Shared Context',
      description: 'Verify that two users in the same org share one context layer.',
      current_status: 'Alpha created the project.',
    });

    assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));
    const projectId = createRes.body.project.project_id;

    // Journey r4, the owner's decision: a project an AI tool (any key) creates
    // in a workspace with more than one person starts personal. Only alpha
    // reads it until alpha shares it, as the create's placement note says.
    assert.strictEqual(createRes.body.project.visibility, 'personal', 'a key-created project in a team starts personal');
    const beforeShare = await auth(request(httpServer).get('/api/v1/context/projects'), beta.apiKey);
    assert.strictEqual(beforeShare.status, 200, JSON.stringify(beforeShare.body));
    assert.ok(!beforeShare.body.projects.some((project) => project.project_id === projectId), 'beta must not see alpha\'s personal project');

    const shareRes = await auth(request(httpServer).patch(`/api/v1/teams/projects/${projectId}/sharing`), alpha.apiKey).send({ visibility: 'shared' });
    assert.strictEqual(shareRes.status, 200, JSON.stringify(shareRes.body));

    const listRes = await auth(request(httpServer).get('/api/v1/context/projects'), beta.apiKey);
    assert.strictEqual(listRes.status, 200, JSON.stringify(listRes.body));
    assert.ok(listRes.body.projects.some((project) => project.project_id === projectId), 'expected beta to see alpha project');

    const extractionRes = await auth(request(httpServer).post('/api/v1/context/extraction'), beta.apiKey).send({
      session_id: `shared-${uuidv4()}`,
      tool: 'codex',
      session_context: {
        cwd: '/Users/shared/workspace',
        status: 'active',
      },
      chunks: [{ role: 'assistant', text: 'Beta updated the shared context with the latest task state.' }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.97,
        project_candidate: {
          project_id: projectId,
          project_name: 'Team Shared Context',
          reason: 'same org shared workspace',
        },
        delta: {
          current_task: 'Beta is extending shared context verification.',
          current_status: 'Shared context was updated from a second user.',
        },
        should_create_project: false,
        needs_user_confirmation: false,
      },
    });
    assert.ok(extractionRes.status === 200 || extractionRes.status === 202, JSON.stringify(extractionRes.body));

    const injectRes = await auth(
      request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`).query({ tool: 'cursor', verbosity: 'detailed' }),
      alpha.apiKey
    );
    assert.strictEqual(injectRes.status, 200, JSON.stringify(injectRes.body));
    const body = injectRes.body.payload?.body || '';
    assert.match(body, /Beta is extending shared context verification\./);
    assert.match(body, /Shared context was updated from a second user\./);
  } finally {
    await cleanupSharedOrgFixture(fixture);
    await closeRedisConnections();
    await db.pool.end().catch(() => {});
  }
});
