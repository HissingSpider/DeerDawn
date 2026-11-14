/**
 * ROUND-12 SCAN: THE REFRESH GRANT OUTLIVED REMOVAL FROM THE WORKSPACE.
 *
 * A refresh record carries the org_id captured at consent. For a person whose
 * users.org_id WAS the team — a founder who handed ownership to a colleague, or
 * anyone the legacy invite path created inside the team — that org is the
 * team. After removal (and re-homing), the refresh grant kept succeeding and
 * kept minting access tokens into the team they are barred from: every
 * connector call answered workspace_forbidden, while the client, whose refresh
 * still worked, never asked the person to reconnect.
 *
 * Driven end to end through the real routes: register -> authorize -> approve
 * (as the person, by session) -> token -> refresh. The OAuth flow's Redis keys
 * are held in an in-memory Map (see below).
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/scan12-oauth-refresh-after-removal.test.js
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
const { generateToken, hashPassword } = require('../../src/utils/security');

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
  const email = `${label}-${uuidv4().slice(0, 8)}@scan12.test`;
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
async function connect(person) {
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

  const approve = await request(httpServer).post('/api/v1/oauth/approve')
    .set('Authorization', `Bearer ${person.jwt}`)
    .send({ req: reqId });
  assert.equal(approve.status, 200, `approve: ${approve.text}`);
  const code = new URL(approve.body.redirect).searchParams.get('code');

  const token = await request(httpServer).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK,
  });
  assert.equal(token.status, 200, token.text);
  return { clientId, refresh: token.body.refresh_token };
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

test('a founder removed and re-homed out of the team is told to reconnect, and the token is retired', async () => {
  const { founder } = await teamWithFounder();
  const conn = await connect(founder);

  const before = await refresh(conn);
  assert.equal(before.status, 200, `a member refreshes normally: ${before.text}`);
  conn.refresh = before.body.refresh_token;

  const removal = await workspace.removeMemberAndRehome(founder.orgId, founder.userId);
  assert.equal(removal.removed, true);
  assert.ok(removal.personalWorkspace, 'the founder is re-homed');

  const after = await refresh(conn);
  assert.equal(after.status, 400, `THE BUG: a removed founder's refresh minted into the team again: ${after.text}`);
  assert.equal(after.body.error, 'invalid_grant');
  assert.equal(after.body.access_token, undefined);

  const minted = await db.query(
    'SELECT count(*)::int AS n FROM api_keys WHERE owner_id = $1 AND org_id = $2 AND status = \'active\' AND oauth_resource IS NOT NULL',
    [founder.userId, founder.orgId],
    'org-system',
  );
  assert.equal(minted.rows[0].n, 0, 'no live OAuth token remains in the team the founder left');

  const again = await refresh(conn);
  assert.equal(again.status, 400, 'the refused refresh token was retired, not left to retry');
  assert.equal(again.body.error, 'invalid_grant');
});

test('a person removed without re-homing is refused too', async () => {
  // The legacy invite path creates a person directly inside the team, so their
  // users.org_id IS the team and removal leaves them there with removed_at set.
  const { founder: owner } = await teamWithFounder();
  const legacy = await makePerson('legacy', { orgId: owner.orgId });
  await workspace.addMember(owner.orgId, legacy.userId, { role: 'member', invitedBy: owner.userId });
  const conn = await connect(legacy);

  assert.equal(await workspace.removeMember(owner.orgId, legacy.userId), true);
  const after = await refresh(conn);
  assert.equal(after.status, 400, after.text);
  assert.equal(after.body.error, 'invalid_grant');
});

test('a solo account keeps refreshing its own workspace', async () => {
  const solo = await makePerson('solo');
  await workspace.ensureOwnerMembership(solo.orgId, solo.userId);
  const conn = await connect(solo);
  for (let i = 0; i < 3; i += 1) {
    const res = await refresh(conn);
    assert.equal(res.status, 200, `refresh ${i + 1}: ${res.text}`);
    conn.refresh = res.body.refresh_token;
  }
});

test('a solo account whose membership row predates the backfill still refreshes', async () => {
  const legacySolo = await makePerson('pre-backfill');
  const conn = await connect(legacySolo);
  const res = await refresh(conn);
  assert.equal(res.status, 200, res.text);
});

test('a teammate removed from a team they joined keeps their own connection', async () => {
  // An invited teammate's grant carries their PERSONAL org, so leaving the team
  // is no reason to break it.
  const { founder } = await teamWithFounder();
  const mate = await makePerson('mate');
  await workspace.ensureOwnerMembership(mate.orgId, mate.userId);
  await workspace.addMember(founder.orgId, mate.userId, { role: 'member', invitedBy: founder.userId });
  const conn = await connect(mate);

  await workspace.removeMemberAndRehome(founder.orgId, mate.userId);
  const res = await refresh(conn);
  assert.equal(res.status, 200, res.text);
});
