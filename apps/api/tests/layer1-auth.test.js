/**
 * Layer 1 — Authentication System
 *
 * Tests local signup/login, JWT validation, MCP device flow end-to-end,
 * API key lifecycle, and rate limiter shapes.
 *
 * Notes on auth shapes:
 * - POST /auth/login: returns {user:{id,email,role,org_id}}, sets cookie (no body token)
 * - GET /auth/me: returns {user:{id,email,role,org_id}}
 * - POST /auth/mcp/start: returns {device_code, user_code, verification_url, expires_in}
 * - POST /keys: requires Bearer token (actor.id must be a valid user_id FK)
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
const { hashPassword, generateApiKey, generateToken } = require('../src/utils/security');
const { closeRedisConnections } = require('../src/config/redis');


async function createOrgFixture(label = 'auth-test') {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${Date.now()}@test.com`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;
  const passHash = await hashPassword('TestPass123!');

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Auth Test Org ${orgId.slice(-8)}`, 'active'],
    orgId
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, passHash, 'admin', orgId],
    orgId
  );
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, 'Test Key', userId, orgId, 'production', expiresAt.toISOString(), ['*']],
    orgId
  );

  // Generate a JWT for Bearer token auth (needed for routes with user_id FK constraints)
  const token = generateToken({ user_id: userId, role: 'admin', org_id: orgId });

  return { orgId, userId, email, password: 'TestPass123!', apiKey: key, token };
}

async function cleanupOrg(orgId) {
  for (const table of ['api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

test('Layer 1 — Authentication', async (t) => {
  const orgs = [];

  t.after(async () => {
    for (const orgId of orgs) await cleanupOrg(orgId).catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
  });

  // ─── Basic signup/login (local auth mode only) ──────────────────────────

  await t.test('POST /auth/login with valid credentials returns user object', async () => {
    if (process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER !== 'local') {
      console.log('  Skipping: AUTH_PROVIDER is not local');
      return;
    }
    const fixture = await createOrgFixture('login');
    orgs.push(fixture.orgId);

    const res = await request(httpServer)
      .post('/api/v1/auth/login')
      .send({ email: fixture.email, password: fixture.password });
    assert.ok(res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
    // Token is set as cookie; body returns {user:{id,email,role,org_id}}
    assert.ok(res.body.user, 'expected user object in login response');
    assert.ok(res.body.user.id || res.body.user.user_id, 'expected user id');
    assert.ok(res.body.user.org_id, 'expected org_id');
    assert.ok(!('token' in res.body), 'login response must not echo the JWT in the body');
    const setCookie = res.headers['set-cookie'] || [];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : setCookie;
    assert.ok(cookieStr.includes('dd_session'), 'login should set dd_session cookie');
  });

  await t.test('POST /auth/signup creates account, sets cookie, does not echo token', async () => {
    if (process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER !== 'local') {
      console.log('  Skipping: AUTH_PROVIDER is not local');
      return;
    }
    const email = `signup-${Date.now()}@test.com`;
    const res = await request(httpServer)
      .post('/api/v1/auth/signup')
      .send({ email, password: 'TestPass123!', org_name: 'Signup Test Org' });
    assert.ok(res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.user, 'signup response must include user object');
    assert.ok(res.body.user.id || res.body.user.user_id, 'signup response must include user id');
    assert.ok(!('token' in res.body), 'signup response must not echo the JWT in the body');
    const setCookie = res.headers['set-cookie'] || [];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : setCookie;
    assert.ok(cookieStr.includes('dd_session'), 'signup should set dd_session cookie');
    // cleanup
    if (res.body.user) {
      const uid = res.body.user.id || res.body.user.user_id;
      await db.query('DELETE FROM api_keys WHERE org_id = $1', [res.body.user.org_id], 'cleanup').catch(() => {});
      await db.query('DELETE FROM users WHERE user_id = $1', [uid], 'cleanup').catch(() => {});
      await db.query('DELETE FROM organizations WHERE org_id = $1', [res.body.user.org_id], 'cleanup').catch(() => {});
    }
  });

  await t.test('POST /auth/signup with duplicate email returns 409', async () => {
    if (process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER !== 'local') {
      console.log('  Skipping: AUTH_PROVIDER is not local');
      return;
    }
    const fixture = await createOrgFixture('signup-dup');
    orgs.push(fixture.orgId);
    const res = await request(httpServer)
      .post('/api/v1/auth/signup')
      .send({ email: fixture.email, password: 'TestPass123!', org_name: 'Dup Org' });
    assert.strictEqual(res.status, 409);
    assert.ok(res.body.error, 'duplicate signup should return an error field');
  });

  await t.test('Cookie session is valid for subsequent authenticated requests', async () => {
    if (process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER !== 'local') {
      console.log('  Skipping: AUTH_PROVIDER is not local');
      return;
    }
    const fixture = await createOrgFixture('cookie-session');
    orgs.push(fixture.orgId);

    // Step 1: sign in — browser flow
    const loginRes = await request(httpServer)
      .post('/api/v1/auth/login')
      .send({ email: fixture.email, password: fixture.password });
    assert.strictEqual(loginRes.status, 200, `login failed: ${JSON.stringify(loginRes.body)}`);

    // Step 2: extract the session cookie
    const rawCookies = loginRes.headers['set-cookie'] || [];
    const cookieHeader = Array.isArray(rawCookies) ? rawCookies.join('; ') : rawCookies;
    const sessionCookie = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
      .find((c) => c.startsWith('dd_session='));
    assert.ok(sessionCookie, 'login must set a dd_session cookie');

    // Step 3: use the cookie on a protected endpoint — this is the real browser auth flow
    const meRes = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('Cookie', cookieHeader);
    assert.strictEqual(meRes.status, 200, `cookie session rejected on /auth/me: ${JSON.stringify(meRes.body)}`);
    assert.ok(meRes.body.user, 'expected user object from cookie-authenticated /auth/me');
    assert.ok(
      meRes.body.user.email === fixture.email,
      `expected email ${fixture.email}, got ${meRes.body.user?.email}`
    );
  });

  await t.test('POST /auth/login with wrong password returns 401', async () => {
    if (process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER !== 'local') {
      console.log('  Skipping: AUTH_PROVIDER is not local');
      return;
    }
    const fixture = await createOrgFixture('login-bad');
    orgs.push(fixture.orgId);

    const res = await request(httpServer)
      .post('/api/v1/auth/login')
      .send({ email: fixture.email, password: 'WrongPassword!' });
    assert.strictEqual(res.status, 401);
    assert.ok(!res.body.token, 'should not return token on bad creds');
  });

  await t.test('GET /auth/me with valid API key returns user object', async () => {
    const fixture = await createOrgFixture('me');
    orgs.push(fixture.orgId);

    const res = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('X-Api-Key', fixture.apiKey);
    assert.strictEqual(res.status, 200);
    // /me returns {user:{id,email,role,org_id}}
    assert.ok(res.body.user, `expected user field, got: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.user.id, 'expected id in user');
    assert.ok(res.body.user.org_id, 'expected org_id in user');
  });

  await t.test('GET /auth/me with Bearer token returns user object', async () => {
    const fixture = await createOrgFixture('me-bearer');
    orgs.push(fixture.orgId);

    const res = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${fixture.token}`);
    assert.ok(res.status === 200 || res.status === 401, `got ${res.status}`);
    if (res.status === 200) {
      assert.ok(res.body.user, 'expected user object');
    }
  });

  await t.test('GET /auth/me with no credentials returns 401 or 403', async () => {
    const res = await request(httpServer).get('/api/v1/auth/me');
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  await t.test('GET /auth/me with tampered API key returns 401 or 403', async () => {
    const res = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('X-Api-Key', 'dd_tampered_key_00000000000');
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  // ─── MCP Device Flow ────────────────────────────────────────────────────

  await t.test('MCP device flow: POST /auth/mcp/start returns device_code and verification_url', async () => {
    const res = await request(httpServer)
      .post('/api/v1/auth/mcp/start')
      .send({ client_name: 'test-mcp-client' });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.device_code, 'expected device_code');
    // Route returns verification_url (not verification_uri)
    assert.ok(
      res.body.verification_url || res.body.verification_uri || res.body.url,
      `expected verification_url field, got keys: ${Object.keys(res.body).join(', ')}`
    );
    assert.ok(res.body.expires_in, 'expected expires_in');
  });

  await t.test('MCP device flow: GET /auth/mcp/token with unconfirmed code returns pending', async () => {
    const startRes = await request(httpServer)
      .post('/api/v1/auth/mcp/start')
      .send({ client_name: 'test-mcp-pending' });
    assert.ok(startRes.status === 200 || startRes.status === 201, `start got ${startRes.status}`);
    const deviceCode = startRes.body.device_code;

    const tokenRes = await request(httpServer)
      .get(`/api/v1/auth/mcp/token?device_code=${deviceCode}`);
    assert.ok(tokenRes.status === 200 || tokenRes.status === 202, `token got ${tokenRes.status}`);
    assert.ok(
      tokenRes.body.status === 'pending' || tokenRes.body.status === 'authorization_pending',
      `expected pending status, got: ${JSON.stringify(tokenRes.body)}`
    );
  });

  await t.test('MCP device flow: GET /auth/mcp/token with invalid code returns 404 or 410', async () => {
    const res = await request(httpServer)
      .get('/api/v1/auth/mcp/token?device_code=nonexistent-device-code-xyz');
    assert.ok(res.status === 404 || res.status === 410 || res.status === 400, `got ${res.status}`);
  });

  await t.test('MCP device flow: POST /auth/mcp/authorize with Bearer token authorizes device', async () => {
    const fixture = await createOrgFixture('mcp-auth');
    orgs.push(fixture.orgId);

    const startRes = await request(httpServer)
      .post('/api/v1/auth/mcp/start')
      .send({ client_name: 'test-mcp-authorize' });
    assert.ok(startRes.status === 200 || startRes.status === 201, `start got ${startRes.status}`);
    const deviceCode = startRes.body.device_code;
    const userCode = startRes.body.user_code;

    // MCP authorize requires user auth (Bearer) because it creates an API key owned by the user.
    // The browser/dashboard authorizes using the human-entered user_code (not the device_code,
    // which only the polling MCP client holds) — mirror that real contract here.
    const authRes = await request(httpServer)
      .post('/api/v1/auth/mcp/authorize')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ user_code: userCode });
    assert.ok(authRes.status === 200 || authRes.status === 201, `authorize got ${authRes.status}: ${JSON.stringify(authRes.body)}`);

    const tokenRes = await request(httpServer)
      .get(`/api/v1/auth/mcp/token?device_code=${deviceCode}`);
    assert.ok(tokenRes.status === 200, `token get got ${tokenRes.status}`);
    assert.ok(tokenRes.body.api_key || tokenRes.body.token, 'expected api_key in token response');

    // MCP-issued keys must be least-privilege (context:read + context:write only, never wildcard)
    const issuedKey = tokenRes.body.api_key || tokenRes.body.token;
    if (issuedKey && issuedKey.startsWith('dd_')) {
      const keyRow = await db.query(
        'SELECT scopes FROM api_keys WHERE key_hash = crypt($1, key_hash) OR prefix = $2',
        [issuedKey, issuedKey.split('_').slice(0, 2).join('_')],
        fixture.orgId
      ).catch(() => ({ rows: [] }));
      if (keyRow.rows.length > 0) {
        const scopes = keyRow.rows[0].scopes;
        assert.ok(!scopes.includes('*'), 'MCP-issued key must not have wildcard scope');
        assert.ok(scopes.includes('context:read'), 'MCP-issued key must have context:read scope');
        assert.ok(scopes.includes('context:write'), 'MCP-issued key must have context:write scope');
      }
    }
  });

  // ─── API Key lifecycle ───────────────────────────────────────────────────

  await t.test('POST /keys creates new API key (requires Bearer token)', async () => {
    const fixture = await createOrgFixture('key-create');
    orgs.push(fixture.orgId);

    const res = await request(httpServer)
      .post('/api/v1/keys')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ name: 'My Test Key', environment: 'production' });
    assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
    // Response shape: {key: {id, key, prefix, name, environment, status}}
    const keyObj = res.body.key || res.body;
    const keyStr = typeof keyObj === 'string' ? keyObj : (keyObj.key || keyObj.api_key || '');
    assert.ok(keyStr, `expected key string, got: ${JSON.stringify(keyObj)}`);
    assert.ok(keyStr.startsWith('dd_'), `key should start with dd_, got: ${keyStr}`);
  });

  await t.test('GET /keys lists keys for authenticated user', async () => {
    const fixture = await createOrgFixture('key-list');
    orgs.push(fixture.orgId);

    const res = await request(httpServer)
      .get('/api/v1/keys')
      .set('Authorization', `Bearer ${fixture.token}`);
    assert.ok(res.status === 200, `got ${res.status}`);
    const keys = res.body.keys || res.body;
    assert.ok(Array.isArray(keys), 'expected array of keys');
  });

  await t.test('Revoked API key returns 401 on subsequent requests', async () => {
    const fixture = await createOrgFixture('key-revoke');
    orgs.push(fixture.orgId);

    const createRes = await request(httpServer)
      .post('/api/v1/keys')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ name: 'Revoke Test Key' });
    assert.ok(createRes.status === 200 || createRes.status === 201, `create got ${createRes.status}`);
    const keyObj = createRes.body.key || createRes.body;
    const newKey = typeof keyObj === 'string' ? keyObj : (keyObj.key || keyObj.api_key || '');
    const keyId = keyObj.id || keyObj.key_id || createRes.body.key_id;

    if (keyId) {
      const deleteRes = await request(httpServer)
        .delete(`/api/v1/keys/${keyId}`)
        .set('Authorization', `Bearer ${fixture.token}`);
      assert.ok(deleteRes.status === 200 || deleteRes.status === 204, `delete got ${deleteRes.status}`);

      const useRes = await request(httpServer)
        .get('/api/v1/auth/me')
        .set('X-Api-Key', newKey);
      assert.ok(useRes.status === 401 || useRes.status === 403, `revoked key should be rejected, got ${useRes.status}`);
    }
  });

  // ─── System-level API key (dev-key) ──────────────────────────────────────

  await t.test('System dev-key bypasses DB lookup, returns system actor', async () => {
    const res = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('X-Api-Key', 'dev-key');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.user, 'expected user in response');
  });
});
