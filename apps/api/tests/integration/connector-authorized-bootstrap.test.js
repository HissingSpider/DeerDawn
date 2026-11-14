/**
 * A CONNECTOR THAT HAS AUTHORIZED BUT NOT YET CALLED.
 *
 * 2026-09-27: two signups through ChatGPT approved the connector and opened the
 * dashboard seconds later. ChatGPT exchanges its code at approve and first calls
 * `initialize` when a chat uses the connector, so neither had a source='mcp'
 * event yet, mcp_registered read false, and the empty workspace told them to
 * "Connect a tool" over a sample brief whose invented "verified" lines read as
 * data already loaded into their account.
 *
 * The bootstrap now publishes the grant as connector_authorized. It is display
 * only: mcp_registered stays the strict signal, because a handshake is not a
 * tool call.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/connector-authorized-bootstrap.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, plan, plan, 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${label} key`, userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    orgId,
  );
  return { label, orgId, userId, email, apiKey: key };
}

// The row /api/v1/oauth/token writes when a connector exchanges its code
// (mintAccessToken in routes/oauth.js).
async function grantConnector(person, orgId, { clientName = 'ChatGPT', status = 'active', expiresInMs = 86400000 } = {}) {
  const { prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes,
                           status, oauth_resource, oauth_client_id, oauth_client_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [`key-${uuidv4()}`, prefix, hash, 'DeerDawn MCP (OAuth)', person.userId, orgId, 'production',
      new Date(Date.now() + expiresInMs).toISOString(), ['context:read', 'context:write'],
      status, 'https://api.deerdawn.test/mcp', `mcpcx-${uuidv4()}`, clientName],
    'org-system',
  );
}

async function cleanup(people) {
  for (const person of people) {
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
}

async function syncHealth(person, workspaceKey) {
  let req = request(httpServer).get('/api/v1/dashboard/bootstrap').set('X-Api-Key', person.apiKey);
  if (workspaceKey) req = req.set('x-deerdawn-workspace', workspaceKey);
  const res = await req;
  assert.equal(res.status, 200, res.text);
  const health = res.body.sync_health || res.body.data?.sync_health;
  assert.ok(health, `no sync_health in the bootstrap payload: ${Object.keys(res.body)}`);
  return health;
}

test('a fresh ChatGPT signup that has not called yet reads as an authorized connector, not a connection', async () => {
  const p = await makePerson('fresh');
  try {
    const before = await syncHealth(p);
    assert.equal(before.connector_authorized, false, 'nothing authorized yet');
    assert.equal(before.connector_client_name, null);

    await grantConnector(p, p.orgId);
    const after = await syncHealth(p);
    assert.equal(after.connector_authorized, true, 'THE BUG: a live connector grant read as nothing connected');
    assert.equal(after.connector_client_name, 'ChatGPT');
    assert.equal(after.mcp_registered, false, 'a grant is a handshake, not a tool call: it must not count as a connection');
  } finally {
    await cleanup([p]);
  }
});

test('a revoked or expired grant is not an authorized connector', async () => {
  const p = await makePerson('stale');
  try {
    await grantConnector(p, p.orgId, { status: 'revoked' });
    await grantConnector(p, p.orgId, { expiresInMs: -60000 });
    const health = await syncHealth(p);
    assert.equal(health.connector_authorized, false);
    assert.equal(health.connector_client_name, null);
  } finally {
    await cleanup([p]);
  }
});

test('on a team, a colleague\'s connector is not yours', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  const team = sarah.orgId;
  try {
    await workspace.addMember(team, sarah.userId, { role: 'owner' });
    const invite = await workspace.createInvite(team, marcus.email, { role: 'member', invitedBy: sarah.userId });
    const accepted = await workspace.acceptInvite(invite.token, { id: marcus.userId, email: marcus.email });
    assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);

    await grantConnector(sarah, team);
    assert.equal((await syncHealth(sarah)).connector_authorized, true, 'the founder\'s own grant counts for her');
    const his = await syncHealth(marcus, team);
    assert.equal(his.connector_authorized, false, 'an invitee must not be told their tool is connected on the strength of hers');
  } finally {
    await cleanup([sarah, marcus]);
  }
});
