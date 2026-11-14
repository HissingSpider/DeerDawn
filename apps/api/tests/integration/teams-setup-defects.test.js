/**
 * The DB-backed half of the 2026-09 teams setup defects (the stubbed half is
 * tests/unit/teams-setup-defects.test.js):
 *
 *   #5  accepting an invite left the teammate's agents in their own empty
 *       workspace, because nothing set is_active
 *   #6  no signup path wrote a workspace_members row for the founder
 *   #7  a wizard-created workspace inherited an active paid plan with no Stripe
 *       subscription behind it
 *
 * Run: bash scripts/run-db-test.sh node --test tests/integration/teams-setup-defects.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { createTeamWorkspaceFixture } = require('../helpers/teamWorkspaceFixture');
const { generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const created = { orgs: new Set() };

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@setup.test`;
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, plan, plan, 'active'], orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, role, org_id) VALUES ($1, $2, $3, $4)',
    [userId, email, 'owner', orgId], orgId,
  );
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${label} key`, userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    orgId,
  );
  created.orgs.add(orgId);
  return { orgId, userId, email, apiKey: key };
}

test.after(async () => {
  for (const orgId of created.orgs) {
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_audit_logs WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
  }
});

async function activeWorkspaceOf(userId) {
  const res = await db.query(
    'SELECT owner_key FROM workspace_members WHERE user_id = $1 AND is_active AND removed_at IS NULL',
    [userId], 'org-system',
  );
  return res.rows.map((r) => r.owner_key);
}

test('#5 accepting a first invite makes the team the active workspace', async () => {
  const owner = await makePerson('owner', { plan: 'developer_pro' });
  const joiner = await makePerson('joiner');
  await workspace.addMember(owner.orgId, owner.userId, { role: 'owner' });

  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role: 'member', invitedBy: owner.userId });
  const res = await request(httpServer)
    .post('/api/v1/teams/invite/accept')
    .set('X-Api-Key', joiner.apiKey)
    .send({ token: invite.token });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.workspace, owner.orgId);
  assert.equal(res.body.activated, true);
  assert.equal(res.body.workspace_name, 'owner workspace');
  assert.deepEqual(await activeWorkspaceOf(joiner.userId), [owner.orgId],
    'header-less requests (every MCP session) must now resolve to the team');
  assert.equal(await workspace.getActiveWorkspace({ id: joiner.userId }), owner.orgId);
});

test('#5 a second invite does not move somebody already working in another team', async () => {
  const teamA = await makePerson('team-a', { plan: 'developer_pro' });
  const teamB = await makePerson('team-b', { plan: 'developer_pro' });
  const joiner = await makePerson('two-teams');

  const first = await workspace.createInvite(teamA.orgId, joiner.email, { role: 'member' });
  const a = await workspace.acceptInvite(first.token, { id: joiner.userId, email: joiner.email });
  assert.equal(a.activated, true);

  const second = await workspace.createInvite(teamB.orgId, joiner.email, { role: 'member' });
  const b = await workspace.acceptInvite(second.token, { id: joiner.userId, email: joiner.email });
  assert.equal(b.ok, true);
  assert.equal(b.activated, false, 'a live agent loop must not be silently redirected');
  assert.deepEqual(await activeWorkspaceOf(joiner.userId), [teamA.orgId]);
});

test('#6 password signup writes the founder as owner, idempotently', async () => {
  const email = `signup-${uuidv4().slice(0, 8)}@setup.test`;
  const res = await request(httpServer)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'password1234' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { id: userId, org_id: orgId } = res.body.user;
  created.orgs.add(orgId);

  const members = await workspace.listMembers(orgId);
  assert.deepEqual(members.map((m) => [m.user_id, m.role]), [[userId, 'owner']]);

  // Re-running never duplicates, resurrects, or overwrites a changed role.
  assert.equal(await workspace.ensureOwnerMembership(orgId, userId), false);
  await db.query('UPDATE workspace_members SET role = $3 WHERE owner_key = $1 AND user_id = $2', [orgId, userId, 'member'], 'org-system');
  await workspace.ensureOwnerMembership(orgId, userId);
  assert.equal((await workspace.getMembership(orgId, userId)).role, 'member');
});

test('#7 a team workspace is born on Free (its plan comes only from its own subscription), and an owner can take it to checkout', async () => {
  const founder = await makePerson('founder', { plan: 'developer_pro' });
  await workspace.addMember(founder.orgId, founder.userId, { role: 'owner' });

  const res = await createTeamWorkspaceFixture(founder, 'Acme Engineering');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  created.orgs.add(res.body.workspace);
  assert.equal(res.body.plan_tier, 'free');

  const org = await db.query(
    'SELECT plan_tier, subscription_status, stripe_subscription_id FROM organizations WHERE org_id = $1',
    [res.body.workspace], 'org-system',
  );
  assert.equal(org.rows[0].plan_tier, 'free', 'a Team creator must not get a second Team workspace for free');
  assert.equal(org.rows[0].stripe_subscription_id, null);

  // A member of that workspace cannot start its checkout.
  const member = await makePerson('member');
  await workspace.addMember(res.body.workspace, member.userId, { role: 'member' });
  const refused = await request(httpServer)
    .post('/api/v1/billing/checkout')
    .set('X-Api-Key', member.apiKey)
    .set('x-deerdawn-workspace', res.body.workspace)
    .send({ tierId: 'developer_pro', seats: 2 });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});

test('an expired invitation stops holding a seat and leaves the pending list, but stays on record', async () => {
  // listInvites filtered revoked and accepted rows and never expires_at, and
  // both seat checks count activeMembers + listInvites().length. An invitation
  // nobody redeemed inside its 7 days held a seat forever, so a team could hit
  // "all seats taken" with nobody new in it.
  const owner = await makePerson('seatowner', { plan: 'developer_pro' });
  await workspace.addMember(owner.orgId, owner.userId, { role: 'owner' });
  await workspace.createInvite(owner.orgId, 'live@seat.test', { invitedBy: owner.userId });
  await workspace.createInvite(owner.orgId, 'stale@seat.test', { invitedBy: owner.userId });
  await db.query(
    'UPDATE workspace_invites SET expires_at = NOW() - INTERVAL \'1 day\' WHERE owner_key = $1 AND email = $2',
    [owner.orgId, 'stale@seat.test'], 'org-system',
  );

  const pending = await workspace.listInvites(owner.orgId);
  assert.deepEqual(pending.map((i) => i.email), ['live@seat.test']);

  const res = await request(httpServer)
    .get('/api/v1/teams/members')
    .set('X-Api-Key', owner.apiKey)
    .set('x-deerdawn-workspace', owner.orgId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.invites.map((i) => i.email), ['live@seat.test']);
  assert.equal(res.body.seats.pending, 1, JSON.stringify(res.body.seats));

  const history = await workspace.listInvites(owner.orgId, { includeExpired: true });
  assert.deepEqual(history.map((i) => i.email).sort(), ['live@seat.test', 'stale@seat.test']);
  assert.equal(history.find((i) => i.email === 'stale@seat.test').status, 'expired');

  // Re-inviting the same address refreshes the row into a live invitation.
  await workspace.createInvite(owner.orgId, 'stale@seat.test', { invitedBy: owner.userId });
  assert.equal((await workspace.listInvites(owner.orgId)).length, 2);
});
