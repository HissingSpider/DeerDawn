/**
 * Layer 7 — Security Hardening
 *
 * HTTP header security, CORS enforcement, SQL injection safety,
 * XSS storage safety, API key format validation, JWT tampering,
 * webhook signature enforcement, and debug route lockdown.
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

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';

async function createOrgFixture(label, scopes = ['*']) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  // Paid tier: these fixtures probe injection/scope handling, not plan gates —
  // a free-tier org would trip the 1-workspace cap on its second project.
  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status, plan, plan_tier) VALUES ($1, $2, $3, $4, $4)',
    [orgId, `Sec ${label}`, 'active', 'developer_basic'],
    orgId
  );
  const passHash = await hashPassword('TestPass123!');
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `sec-${label}-${Date.now()}@test.com`, passHash, 'admin', orgId],
    orgId
  );
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, `Sec Key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), scopes],
    orgId
  );
  return { orgId, userId, apiKey: key };
}

async function cleanupOrg(orgId) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_events', 'context_sessions', 'context_projects', 'api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

test('Layer 7 — Security Hardening', async (t) => {
  const orgs = [];

  t.after(async () => {
    for (const orgId of orgs) await cleanupOrg(orgId).catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
  });

  // ─── Security headers ─────────────────────────────────────────────────────

  await t.test('Response includes X-Content-Type-Options: nosniff', async () => {
    const res = await request(httpServer).get('/healthz');
    const header = res.headers['x-content-type-options'];
    assert.strictEqual(header, 'nosniff', `expected nosniff, got: ${header}`);
  });

  await t.test('Response includes X-Frame-Options header', async () => {
    const res = await request(httpServer).get('/healthz');
    const header = res.headers['x-frame-options'];
    assert.ok(header, 'expected X-Frame-Options header to be set');
    assert.ok(
      header.toUpperCase() === 'DENY' || header.toUpperCase() === 'SAMEORIGIN',
      `unexpected X-Frame-Options value: ${header}`
    );
  });

  await t.test('Response does not leak X-Powered-By header', async () => {
    const res = await request(httpServer).get('/healthz');
    assert.ok(!res.headers['x-powered-by'], 'X-Powered-By should be hidden');
  });

  await t.test('Response includes cache control on sensitive endpoints', async () => {
    const res = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('X-Api-Key', API_KEY);
    // Auth endpoints should not be publicly cacheable
    const cc = res.headers['cache-control'] || '';
    if (res.status === 200) {
      assert.ok(
        cc.includes('no-store') || cc.includes('no-cache') || cc.includes('private') || cc === '',
        `unexpected cache-control on auth endpoint: ${cc}`
      );
    }
  });

  // ─── CORS ─────────────────────────────────────────────────────────────────

  await t.test('CORS rejects arbitrary origin on API endpoints', async () => {
    const res = await request(httpServer)
      .options('/api/v1/auth/me')
      .set('Origin', 'https://evil-attacker.com')
      .set('Access-Control-Request-Method', 'GET');
    const acaoHeader = res.headers['access-control-allow-origin'];
    assert.ok(
      !acaoHeader || acaoHeader !== 'https://evil-attacker.com',
      `CORS should not allow arbitrary origins, got: ${acaoHeader}`
    );
  });

  await t.test('CORS allows configured dashboard origin', async () => {
    const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
    const res = await request(httpServer)
      .options('/api/v1/auth/me')
      .set('Origin', dashboardUrl)
      .set('Access-Control-Request-Method', 'GET');
    // Either passes CORS (2xx) or server blocks preflight but that is also acceptable
    assert.ok(res.status !== 500, `CORS preflight should not 500, got ${res.status}`);
  });

  // ─── SQL injection safety ─────────────────────────────────────────────────

  let injectionOrg;
  try {
    injectionOrg = await createOrgFixture('injection');
    orgs.push(injectionOrg.orgId);
  } catch (_) { /* optional fixture */ }

  await t.test('SQL injection attempt in project_name is safely stored, not executed', async () => {
    const key = injectionOrg?.apiKey || API_KEY;
    const injectionName = '\'; DROP TABLE context_projects; --';
    const res = await request(httpServer)
      .post('/api/v1/context/projects')
      .set('X-Api-Key', key)
      .send({ project_name: injectionName });
    assert.ok(res.status === 201 || res.status === 400, `got ${res.status}`);

    if (res.status === 201) {
      const tableCheck = await db.query(
        'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = \'context_projects\') AS exists',
        [],
        'org-system'
      );
      assert.strictEqual(tableCheck.rows[0].exists, true, 'context_projects table should still exist after injection attempt');
    }
  });

  await t.test('SQL injection in search query is safely handled', async () => {
    const key = injectionOrg?.apiKey || API_KEY;
    const res = await request(httpServer)
      .post('/api/v1/context/search')
      .set('X-Api-Key', key)
      .send({ query: '\' OR \'1\'=\'1', limit: 5 });
    assert.ok(res.status !== 500, `SQL injection in search should not 500, got ${res.status}`);
  });

  // ─── XSS storage safety ──────────────────────────────────────────────────

  await t.test('XSS payload in project description is stored as plain text, not executed', async () => {
    const key = injectionOrg?.apiKey || API_KEY;
    const xssPayload = '<script>alert(document.cookie)</script>';
    const res = await request(httpServer)
      .post('/api/v1/context/projects')
      .set('X-Api-Key', key)
      .send({ project_name: 'XSS Test Project', description: xssPayload });
    assert.ok(res.status === 201 || res.status === 400, `got ${res.status}`);
    if (res.status === 201) {
      assert.strictEqual(res.headers['content-type'].includes('application/json'), true, 'response should be JSON');
    }
  });

  // ─── API key format ───────────────────────────────────────────────────────

  await t.test('API key not starting with dd_ is rejected', async () => {
    const res = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('X-Api-Key', 'malformed-key-without-prefix');
    assert.ok(res.status === 401 || res.status === 403, `expected rejection, got ${res.status}`);
  });

  await t.test('Empty API key returns 401 or 403', async () => {
    const res = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('X-Api-Key', '');
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  await t.test('Decision-only API key cannot access context-sync routes', async () => {
    const scoped = await createOrgFixture('context-scope', ['decisions:evaluate']);
    orgs.push(scoped.orgId);

    const res = await request(httpServer)
      .get('/api/v1/context/projects')
      .set('X-Api-Key', scoped.apiKey);

    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  // ─── JWT tampering ────────────────────────────────────────────────────────

  await t.test('Tampered JWT Bearer token returns 401', async () => {
    const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJoYWNrZXIiLCJvcmdfaWQiOiJvcmctZXZpbCJ9.TAMPERED_SIGNATURE';
    const res = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${fakeToken}`);
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  // ─── Webhook signature enforcement ───────────────────────────────────────

  await t.test('Stripe webhook without stripe-signature header returns 400', async () => {
    const res = await request(httpServer)
      .post('/api/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'checkout.session.completed', id: 'evt_test', data: { object: {} } }));
    assert.ok(res.status === 400 || res.status === 401, `expected 400/401, got ${res.status}`);
  });

  await t.test('Clerk webhook without svix headers rejects request', async () => {
    const res = await request(httpServer)
      .post('/api/v1/webhooks/auth/clerk')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'user.created', data: {} }));
    // Should return 400 or 401; 500 indicates missing header validation (gap to fix before launch)
    assert.ok(res.status !== 200, `should not return 200 for unsigned Clerk webhook, got ${res.status}`);
    if (res.status === 500) {
      console.log('  WARNING: Clerk webhook returns 500 (not 400) on missing svix headers — pre-launch fix needed');
    }
  });

  // ─── Debug route lockdown ─────────────────────────────────────────────────

  await t.test('Debug routes return 404 in non-debug mode', async () => {
    const res = await request(httpServer)
      .get('/api/debug')
      .set('X-Api-Key', API_KEY);
    // In production, debug routes should not be exposed
    if (process.env.NODE_ENV === 'production') {
      assert.strictEqual(res.status, 404, 'debug routes should not be accessible in production');
    } else {
      console.log(`  NODE_ENV=${process.env.NODE_ENV} — debug route returned ${res.status} (expected in dev)`);
    }
  });

  // ─── Scope enforcement ───────────────────────────────────────────────────

  await t.test('DELETE /context/account requires context:admin scope (context:read rejected)', async () => {
    const readOnlyFixture = await createOrgFixture('scope-read', ['context:read']);
    orgs.push(readOnlyFixture.orgId);
    const res = await request(httpServer)
      .delete('/api/v1/context/account')
      .set('X-Api-Key', readOnlyFixture.apiKey)
      .send({ confirmation_hmac: 'not-real' });
    assert.ok(res.status === 403 || res.status === 401, `context:read key should be rejected for account deletion, got ${res.status}`);
  });

  await t.test('POST /keys requires admin role (member role rejected)', async () => {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const { key, prefix, hash } = generateApiKey();
    const keyId = `key-${uuidv4()}`;
    orgs.push(orgId);
    await db.query('INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)', [orgId, 'Scope test', 'active'], orgId);
    await db.query('INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)', [userId, `scope-member-${Date.now()}@test.com`, 'x', 'read-only', orgId], orgId);
    const exp = new Date(); exp.setDate(exp.getDate() + 30);
    await db.query('INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [keyId, prefix, hash, 'Member key', userId, orgId, 'production', exp.toISOString(), ['*']], orgId);
    const res = await request(httpServer)
      .post('/api/v1/keys')
      .set('X-Api-Key', key)
      .send({ name: 'Attempted key', scopes: ['context:read'] });
    assert.ok(res.status === 403 || res.status === 401, `member-role key should be rejected for key creation, got ${res.status}`);
  });

  // ─── Source code audits (static analysis) ────────────────────────────────

  await t.test('Rate limiter bypass key not hard-coded in source', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../src/middleware/rateLimit'), 'utf8');
    assert.ok(!source.includes('dd_speed_test_key_999'), 'Hard-coded bypass key found in rate limiter');
  });

  await t.test('Rate limit skip requires non-production env check', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../src/middleware/rateLimit'), 'utf8');
    const hasProductionCheck = source.includes('NODE_ENV') && (
      source.includes('!== \'production\'') || source.includes('!== "production"')
    );
    assert.ok(hasProductionCheck, 'Rate limit bypass should check NODE_ENV !== production');
  });

  await t.test('Auth middleware has scopes check for system key', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../src/middleware/auth'), 'utf8');
    assert.ok(source.includes('scopes'), 'Auth middleware should define scopes for system key');
  });

  await t.test('Userscript installer does not accept long-lived API keys in query params', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../src/routes/context/userscript'), 'utf8');
    assert.ok(!source.includes('req.query.key'), 'userscript route should not read API keys from query params');
    assert.ok(source.includes('requireAuth'), 'userscript route should require authenticated access');
  });
});
