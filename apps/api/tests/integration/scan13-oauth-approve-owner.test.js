/**
 * ROUND-13 SCAN: /approve STORED THE CREDENTIAL, NOT THE PERSON, AS THE OWNER.
 *
 * A consent approved by somebody authenticated with an API key stored
 * owner_id = actor.id — the KEY id. The minted OAuth access key was then owned
 * by a key, and #530's refresh-after-removal check, which can only look up a
 * person, deliberately let such a grant through: a founder who approved with a
 * key and was later removed from the team kept refreshing into it.
 *
 * Driven through register -> authorize -> approve (by API key) -> token ->
 * refresh. The OAuth flow keys live in a Map, as in the scan12 file, so this
 * pin does not depend on the Redis-stub TTL fix that ships beside it.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/scan13-oauth-approve-owner.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.API_BASE_URL = process.env.API_BASE_URL || 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../../src/app');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { generateToken, hashPassword, generateApiKey, hashApiKey } = require('../../src/utils/security');

// The test environment's Redis stub expires a key with setTimeout, and a
// refresh TTL (days) overflows setTimeout's 24.8-day ceiling, which Node turns
// into ~1ms: the refresh token would vanish before it could be presented. The
// OAuth flow keys live here instead, TTL-free, exactly as the unit suites do.
const { redis } = require('../../src/config/redis');
const flowStore = new Map();
redis.set = async (key, value) => { flowStore.set(key, value); return 'OK'; };
redis.get = async (key) => (flowStore.has(key) ? flowStore.get(key) : null);
redis.del = async (...keys) => keys.flat().reduce((n, key) => n + (flowStore.delete(key) ? 1 : 0), 0);

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CONSENT = 'https://app.deerdawn.test/oauth/consent?req=';
const created = { orgs: [], users: [] };

test.after(async () => {
  await db.query('DELETE FROM api_keys WHERE owner_id = ANY($1) OR org_id = ANY($2)', [created.users, created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE user_id = ANY($1) OR owner_key = ANY($2)', [created.users, created.orgs], 'org-system').catch(() => {});
  const homes = await db.query('SELECT org_id FROM users WHERE user_id = ANY($1)', [created.users], 'org-system').catch(() => ({ rows: [] }));
  await db.query('DELETE FROM users WHERE user_id = ANY($1)', [created.users], 'org-system').catch(() => {});
  const orgs = [...created.orgs, ...homes.rows.map((r) => r.org_id)];
  await db.query('DELETE FROM organizations WHERE org_id = ANY($1)', [orgs], 'org-system').catch(() => {});
});

async function makePerson(label, { orgId = null, plan = 'free' } = {}) {
  const org = orgId || `org-${uuidv4()}`;
  if (!orgId) {
    await db.query(
      'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
      [org, `${label} workspace`, plan, plan, 'active'],
      org,
    );
    created.orgs.push(org);
  }
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@scan13.test`;
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', org],
    org,
  );
  created.users.push(userId);
  const jwt = generateToken({ user_id: userId, org_id: org, role: 'admin' });
  return { label, userId, orgId: org, email, jwt };
}

// Consent as `person` by dashboard session, then exchange the code.
async function connect(person, { apiKey = null } = {}) {
  const reg = await request(httpServer).post('/api/v1/oauth/register').send({
    client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none',
  });
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.body.client_id;

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = await request(httpServer).get('/api/v1/oauth/authorize').query({
    response_type: 'code', client_id: clientId, redirect_uri: CALLBACK,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'context:read context:write',
  });
  assert.equal(authorize.status, 302, authorize.text);
  const reqId = authorize.headers.location.slice(CONSENT.length);

  let approveReq = request(httpServer).post('/api/v1/oauth/approve');
  approveReq = apiKey ? approveReq.set('x-api-key', apiKey) : approveReq.set('Authorization', `Bearer ${person.jwt}`);
  const approve = await approveReq.send({ req: reqId });
  assert.equal(approve.status, 200, `approve: ${approve.text}`);
  const code = new URL(approve.body.redirect).searchParams.get('code');

  const token = await request(httpServer).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK,
  });
  assert.equal(token.status, 200, token.text);
  return { clientId, refresh: token.body.refresh_token, access: token.body.access_token };
}

function refresh(conn, token = conn.refresh) {
  return request(httpServer).post('/api/v1/oauth/token').type('form')
    .send({ grant_type: 'refresh_token', refresh_token: token, client_id: conn.clientId });
}

async function teamWithFounder() {
  const founder = await makePerson('founder', { plan: 'developer_pro' });
  await workspace.ensureOwnerMembership(founder.orgId, founder.userId);
  const co = await makePerson('co-owner');
  await workspace.ensureOwnerMembership(co.orgId, co.userId);
  await workspace.addMember(founder.orgId, co.userId, { role: 'owner', invitedBy: founder.userId });
  return { founder, co };
}


async function personalKey(person) {
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [keyId, prefix, hash, `scan13 ${person.label}`, person.userId, person.orgId, 'production', expiresAt, ['context:read', 'context:write', 'context:admin']],
    'org-system',
  );
  return { key, keyId };
}

async function ownerOfAccessToken(accessToken) {
  const row = await db.query('SELECT owner_id FROM api_keys WHERE key_hash = $1', [hashApiKey(accessToken)], 'org-system');
  return row.rows[0]?.owner_id;
}

test('a consent approved with an API key is owned by the person, not the key', async () => {
  const solo = await makePerson('key-approver');
  await workspace.ensureOwnerMembership(solo.orgId, solo.userId);
  const { key, keyId } = await personalKey(solo);
  const conn = await connect(solo, { apiKey: key });

  const owner = await ownerOfAccessToken(conn.access);
  assert.notEqual(owner, keyId, 'THE BUG: the minted access key is owned by the approving KEY');
  assert.equal(owner, solo.userId);

  // Refresh mints from the stored record, so the person carries through rotation.
  const res = await refresh(conn);
  assert.equal(res.status, 200, res.text);
  assert.equal(await ownerOfAccessToken(res.body.access_token), solo.userId);
});

test('a founder who approved with an API key and was removed is told to reconnect', async () => {
  const { founder } = await teamWithFounder();
  const { key } = await personalKey(founder);
  const conn = await connect(founder, { apiKey: key });

  const before = await refresh(conn);
  assert.equal(before.status, 200, `a member refreshes normally: ${before.text}`);
  conn.refresh = before.body.refresh_token;

  const removal = await workspace.removeMemberAndRehome(founder.orgId, founder.userId);
  assert.equal(removal.removed, true);

  const after = await refresh(conn);
  assert.equal(after.status, 400, `THE BUG: a key-approved grant outlived its owner's removal: ${after.text}`);
  assert.equal(after.body.error, 'invalid_grant');
});

test('a session-approved consent is unchanged: still the person', async () => {
  const solo = await makePerson('session-approver');
  await workspace.ensureOwnerMembership(solo.orgId, solo.userId);
  const conn = await connect(solo);
  assert.equal(await ownerOfAccessToken(conn.access), solo.userId);
});
