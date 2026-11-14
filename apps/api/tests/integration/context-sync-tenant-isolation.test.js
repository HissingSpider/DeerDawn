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

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${Date.now()}@test.com`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Context ${label}`, 'active'],
    orgId
  );

  const passHash = await hashPassword('password123');
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, passHash, 'admin', orgId],
    orgId
  );

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, `Context key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
    orgId
  );

  return {
    orgId,
    userId,
    apiKey: key,
  };
}

async function cleanupOrgFixture(fixture) {
  const { orgId } = fixture;
  await db.query('DELETE FROM decisions WHERE org_id = $1', [orgId], orgId).catch(() => {});
  await db.query('DELETE FROM policies WHERE org_id = $1', [orgId], orgId).catch(() => {});
  await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId).catch(() => {});
  await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
}

function authWithKey(req, apiKey) {
  return req.set('X-Api-Key', apiKey);
}

test('Context sync tenant isolation', async (t) => {
  await store.clearAll();

  const alpha = await createOrgFixture('alpha');
  const beta = await createOrgFixture('beta');

  let projectId;

  try {
    await t.test('org A can create a project and bind a session', async () => {
      const createRes = await authWithKey(
        request(httpServer).post('/api/v1/context/projects'),
        alpha.apiKey
      ).send({
        project_name: 'Alpha Workspace',
        description: 'Tenant A context',
        goals: ['Protect tenant isolation'],
      });

      assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));
      projectId = createRes.body.project.project_id;

      const sessionRes = await authWithKey(
        request(httpServer).patch('/api/v1/context/sessions/alpha-browser-1'),
        alpha.apiKey
      ).send({
        tool: 'claude_web',
        surface_type: 'browser',
        conversation_ref: 'https://claude.ai/chat/alpha',
        host: 'claude.ai',
        tab_id: 'tab-alpha',
        project_id: projectId,
        status: 'active',
      });

      assert.strictEqual(sessionRes.status, 200, JSON.stringify(sessionRes.body));
      assert.strictEqual(sessionRes.body.session.project_id, projectId);
    });

    await t.test('org B cannot list org A projects or sessions', async () => {
      const projectsRes = await authWithKey(
        request(httpServer).get('/api/v1/context/projects'),
        beta.apiKey
      );
      assert.strictEqual(projectsRes.status, 200, JSON.stringify(projectsRes.body));
      assert.ok(Array.isArray(projectsRes.body.projects));
      assert.strictEqual(projectsRes.body.projects.some((project) => project.project_id === projectId), false);

      const sessionsRes = await authWithKey(
        request(httpServer).get('/api/v1/context/sessions'),
        beta.apiKey
      );
      assert.strictEqual(sessionsRes.status, 200, JSON.stringify(sessionsRes.body));
      assert.ok(Array.isArray(sessionsRes.body.sessions));
      assert.strictEqual(sessionsRes.body.sessions.some((session) => session.project_id === projectId), false);
    });

    await t.test('org B cannot read injection payloads for org A projects', async () => {
      const res = await authWithKey(
        request(httpServer)
          .get(`/api/v1/context/projects/${projectId}/inject`)
          .query({ tool: 'chatgpt_web', verbosity: 'standard' }),
        beta.apiKey
      );

      assert.strictEqual(res.status, 204, JSON.stringify(res.body));
    });

    await t.test('org B cannot mutate org A session bindings by reusing the same session id', async () => {
      const res = await authWithKey(
        request(httpServer).patch('/api/v1/context/sessions/alpha-browser-1'),
        beta.apiKey
      ).send({
        tool: 'chatgpt_web',
        surface_type: 'browser',
        conversation_ref: 'https://chatgpt.com/beta',
        host: 'chatgpt.com',
        tab_id: 'tab-beta',
        status: 'active',
      });

      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.notStrictEqual(res.body.session.owner_key, alpha.orgId);
      assert.strictEqual(res.body.session.project_id, null);

      const alphaSessionsRes = await authWithKey(
        request(httpServer).get('/api/v1/context/sessions'),
        alpha.apiKey
      );
      const alphaSession = alphaSessionsRes.body.sessions.find((session) => session.session_id === 'alpha-browser-1');
      assert.ok(alphaSession, 'expected alpha session to remain present');
      assert.strictEqual(alphaSession.project_id, projectId);
      assert.strictEqual(alphaSession.host, 'claude.ai');
    });
  } finally {
    await cleanupOrgFixture(alpha);
    await cleanupOrgFixture(beta);
    await closeRedisConnections();
    await db.pool.end().catch(() => {});
  }
});
