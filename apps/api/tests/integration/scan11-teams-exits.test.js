/**
 * SCAN 11 — TEAMS: EXITS THAT WERE LOCKED, AND DOORS THAT WERE OPEN.
 *
 * Every case here drives the HTTP routes the dashboard and agents call.
 *
 *   1. POST /teams/invite/accept was gated on the BOUND workspace: a lapsed
 *      team in x-deerdawn-workspace (or a past_due personal org) blocked
 *      joining a healthy team, and a removed member's stale header got
 *      workspace_forbidden on the re-invite that would readmit them.
 *   2. DELETE /context/account — "the exit of last resort" — was 403 for a
 *      past_due or locked account.
 *   3. A founder removed from the Team they upgraded their own signup org into
 *      was barred from their own default workspace with nowhere else to go.
 *   4. A removed member walked back in through domain join.
 *   5. Domain join did not point header-less sessions at the team.
 *   6. Removal revoked keys in the DB but not in the api-key cache.
 *   7. Team audit rows attributed to a key id, or to nobody.
 *   8. The 1->2 backfill flipped projects moved into a NEW team to 'personal'.
 *   9. A viewer could mint no API key at all.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan11-teams-exits.test.js
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
const { createTeamWorkspaceFixture } = require('../helpers/teamWorkspaceFixture');
const { hashPassword, generateApiKey, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

async function mintKey(userId, orgId, { name = 'seed key', scopes = ['context:read', 'context:write'] } = {}) {
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [keyId, prefix, hash, name, userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), scopes],
    'org-system',
  );
  return { key, keyId };
}

async function makeOrg(label, plan) {
  const orgId = `org-${uuidv4()}`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
    orgId,
  );
  return orgId;
}

async function makePerson(label, { plan = 'free', domain = 'e2e.test' } = {}) {
  const orgId = await makeOrg(label, plan);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@${domain}`;
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

async function setBilling(orgId, { plan, status, locked } = {}) {
  if (plan) await db.query('UPDATE organizations SET plan = $2, plan_tier = $2 WHERE org_id = $1', [orgId, plan], 'org-system');
  if (status) await db.query('UPDATE organizations SET subscription_status = $2 WHERE org_id = $1', [orgId, status], 'org-system');
  if (locked) await db.query('UPDATE organizations SET is_locked = TRUE WHERE org_id = $1', [orgId], 'org-system');
  await invalidateOrgCache(orgId).catch(() => {});
}

async function join(ownerKey, inviterId, joiner, { role = 'member' } = {}) {
  const invite = await workspace.createInvite(ownerKey, joiner.email, { role, invitedBy: inviterId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function createProject(person, ws, name) {
  const res = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name, current_task: 'x' });
  assert.equal(res.status, 201, `project create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.project.project_id;
}

const visibilityOf = async (projectId) => (await db.query(
  'SELECT visibility FROM context_projects WHERE project_id = $1', [projectId], 'org-system',
)).rows[0]?.visibility;

// ── 1 ────────────────────────────────────────────────────────────────────────

test('1: a lapsed team in the header does not stop somebody joining a healthy team', async () => {
  const tOwner = await makePerson('t-owner', { plan: 'developer_pro' });
  const bOwner = await makePerson('b-owner', { plan: 'developer_pro' });
  const m = await makePerson('m');
  await join(tOwner.orgId, tOwner.userId, m);
  await setBilling(tOwner.orgId, { status: 'past_due' });

  const invite = await workspace.createInvite(bOwner.orgId, m.email, { role: 'member', invitedBy: bOwner.userId });
  const res = await as('post', '/api/v1/teams/invite/accept', m, tOwner.orgId).send({ token: invite.token });
  assert.equal(res.status, 200, `accept with lapsed header: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.workspace, bOwner.orgId);
});

test('1: a past_due personal org can still accept an invitation', async () => {
  const bOwner = await makePerson('b2-owner', { plan: 'developer_pro' });
  const m = await makePerson('m2', { plan: 'developer_basic' });
  await setBilling(m.orgId, { status: 'past_due' });

  const invite = await workspace.createInvite(bOwner.orgId, m.email, { role: 'member', invitedBy: bOwner.userId });
  const res = await as('post', '/api/v1/teams/invite/accept', m).send({ token: invite.token });
  assert.equal(res.status, 200, `accept from past_due personal: ${res.status} ${JSON.stringify(res.body)}`);
});

test('1+4: a removed member holding the old team header can accept the re-invite that readmits them', async () => {
  const tOwner = await makePerson('t3-owner', { plan: 'developer_pro' });
  const m = await makePerson('m3');
  await join(tOwner.orgId, tOwner.userId, m);
  const removal = await as('delete', `/api/v1/teams/members/${m.userId}`, tOwner, tOwner.orgId);
  assert.equal(removal.status, 200);

  const invite = await workspace.createInvite(tOwner.orgId, m.email, { role: 'member', invitedBy: tOwner.userId });
  const res = await as('post', '/api/v1/teams/invite/accept', m, tOwner.orgId).send({ token: invite.token });
  assert.equal(res.status, 200, `re-invite with stale header: ${res.status} ${JSON.stringify(res.body)}`);
  const back = await as('get', '/api/v1/context/projects', m, tOwner.orgId);
  assert.equal(back.status, 200, 'an explicit invitation readmits a removed person');
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test('2: a past_due or locked account reaches its own erasure route', async () => {
  const lapsed = await makePerson('lapsed', { plan: 'developer_basic' });
  await setBilling(lapsed.orgId, { status: 'past_due' });
  const locked = await makePerson('locked');
  await setBilling(locked.orgId, { locked: true });

  for (const p of [lapsed, locked]) {
    // No confirmation: the handler refuses with 400 and deletes nothing. What
    // matters is that the HANDLER answered, not the billing gate.
    const res = await as('delete', '/api/v1/context/account', p).send({});
    assert.equal(res.status, 400, `${p.label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'confirmation_required');
  }
});

// ── 3 ────────────────────────────────────────────────────────────────────────

test('3: a founder removed from the Team they upgraded into lands in a working personal workspace', async () => {
  const founder = await makePerson('founder', { plan: 'developer_pro' });
  const team = founder.orgId;
  const coOwner = await makePerson('co-owner');
  await join(team, founder.userId, coOwner, { role: 'owner' });
  const teamProject = await createProject(founder, team, `Team roadmap ${uuidv4().slice(0, 6)}`);
  await as('patch', `/api/v1/teams/projects/${teamProject}/sharing`, founder, team).send({ visibility: 'shared' });

  const removal = await as('delete', `/api/v1/teams/members/${founder.userId}`, coOwner, team);
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  const home = removal.body.rehomed_to;
  assert.ok(home && home !== team, 'the founder is given a new personal workspace');

  const listing = await as('get', '/api/v1/teams/workspaces', founder);
  assert.equal(listing.status, 200);
  assert.ok(!listing.body.workspaces.some((w) => w.workspace === team), 'the barred team is not listed as theirs');
  const personal = listing.body.workspaces.find((w) => w.personal);
  assert.equal(personal?.workspace, home);
  assert.equal(personal?.role, 'owner');

  const key = await as('post', '/api/v1/keys', founder).send({ name: 'after hand-off', environment: 'production' });
  assert.equal(key.status, 201, `mint key: ${key.status} ${JSON.stringify(key.body)}`);
  const minted = await db.query('SELECT org_id FROM api_keys WHERE key_id = $1', [key.body.key.id], 'org-system');
  assert.equal(minted.rows[0].org_id, home);

  // Erasure of their own account is reachable: without a confirmation the
  // handler answers 400 AFTER its owner and no-other-members gates have passed,
  // and deletes nothing. (Barred, this was 403 workspace_forbidden.)
  const erase = await as('delete', '/api/v1/context/account', founder).send({});
  assert.equal(erase.status, 400, `erase: ${erase.status} ${JSON.stringify(erase.body)}`);
  assert.equal(erase.body.error, 'confirmation_required');
  const usage = await as('get', '/api/v1/orgs/usage', founder);
  assert.equal(usage.status, 200, `own account settings reachable: ${usage.status} ${JSON.stringify(usage.body)}`);

  // The team's data stays with the team.
  const teamView = await as('get', '/api/v1/context/projects', coOwner, team);
  assert.equal(teamView.status, 200);
  assert.ok((teamView.body.projects || []).some((p) => p.project_id === teamProject), 'the shared project survives in the team');
});

test('3: GET /teams/workspaces never offers a barred own org as personal/owner', async () => {
  // The legacy shape: a person whose users.org_id IS the team, removed at the
  // service layer (no re-home), is still barred — and must not be told it is theirs.
  const owner = await makePerson('legacy-owner', { plan: 'developer_pro' });
  const userId = `user-${uuidv4()}`;
  const email = `legacy-${uuidv4().slice(0, 8)}@e2e.test`;
  await db.query('INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', owner.orgId], owner.orgId);
  await workspace.addMember(owner.orgId, userId, { role: 'member' });
  await workspace.removeMember(owner.orgId, userId);
  const legacy = { userId, jwt: generateToken({ user_id: userId, org_id: owner.orgId, role: 'admin', email }) };

  const listing = await as('get', '/api/v1/teams/workspaces', legacy);
  assert.equal(listing.status, 200);
  const offered = listing.body.workspaces.find((w) => w.workspace === owner.orgId);
  assert.equal(offered, undefined, `barred org must not be listed: ${JSON.stringify(listing.body.workspaces)}`);
});

// ── 4, 5 ────────────────────────────────────────────────────────────────────

async function domainTeam(label) {
  const domain = `${label}-${uuidv4().slice(0, 6)}.example`;
  const owner = await makePerson(`${label}-owner`, { plan: 'developer_pro', domain });
  const added = await as('post', '/api/v1/teams/domains', owner, owner.orgId).send({ domain, role: 'member' });
  assert.equal(added.status, 201);
  return { domain, owner };
}

test('5: a domain joiner lands in the team like an invitee does', async () => {
  const { domain, owner } = await domainTeam('land');
  const carol = await makePerson('carol', { domain });
  const joined = await as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, carol).send({});
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const active = await workspace.getActiveWorkspace({ type: 'user', id: carol.userId, org_id: carol.orgId });
  assert.equal(active, owner.orgId, 'a domain joiner\'s header-less sessions land in the team');
});

test('4: a removed member cannot re-enter by domain; an invitation readmits them', async () => {
  const { domain, owner } = await domainTeam('door');
  const bob = await makePerson('bob', { domain });
  const joined = await as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, bob).send({});
  assert.equal(joined.status, 200, JSON.stringify(joined.body));

  const removal = await as('delete', `/api/v1/teams/members/${bob.userId}`, owner, owner.orgId);
  assert.equal(removal.status, 200);

  const offers = await as('get', '/api/v1/teams/joinable', bob);
  assert.equal(offers.status, 200);
  assert.ok(!offers.body.joinable.some((o) => o.workspace === owner.orgId), 'not offered back');
  const rejoin = await as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, bob).send({});
  assert.equal(rejoin.status, 403, `domain door refuses a removed member: ${JSON.stringify(rejoin.body)}`);
  assert.equal(rejoin.body.error, 'removed_from_workspace');
  const stillOut = await as('get', '/api/v1/context/projects', bob, owner.orgId);
  assert.equal(stillOut.status, 403);

  // The owner inviting them again is the way back in.
  const invite = await workspace.createInvite(owner.orgId, bob.email, { role: 'member', invitedBy: owner.userId });
  const readmit = await as('post', '/api/v1/teams/invite/accept', bob).send({ token: invite.token });
  assert.equal(readmit.status, 200);
});

// ── 6 ────────────────────────────────────────────────────────────────────────

test('6: a key revoked by member removal stops working even after a re-invite', async () => {
  const owner = await makePerson('k-owner', { plan: 'developer_pro' });
  const m = await makePerson('k-member');
  await join(owner.orgId, owner.userId, m);
  const { key } = await mintKey(m.userId, owner.orgId, { name: 'team key' });

  const warm = await request(httpServer).get('/api/v1/context/projects').set('Authorization', `Bearer ${key}`);
  assert.equal(warm.status, 200, 'the key works (and is now cached)');

  const removal = await as('delete', `/api/v1/teams/members/${m.userId}`, owner, owner.orgId);
  assert.equal(removal.status, 200);
  assert.equal(removal.body.keys_revoked, 1);
  await join(owner.orgId, owner.userId, m);

  const after = await request(httpServer).get('/api/v1/context/projects').set('Authorization', `Bearer ${key}`);
  assert.equal(after.status, 401, `a revoked key must not serve the team again: ${after.status}`);
});

// ── 7 ────────────────────────────────────────────────────────────────────────

test('7: team audit rows name the PERSON, including on sharing changes', async () => {
  const owner = await makePerson('a-owner', { plan: 'developer_pro' });
  const m = await makePerson('a-member');
  const { key, keyId } = await mintKey(m.userId, m.orgId, { name: 'personal key' });

  const invite = await workspace.createInvite(owner.orgId, m.email, { role: 'member', invitedBy: owner.userId });
  const accepted = await request(httpServer).post('/api/v1/teams/invite/accept')
    .set('Authorization', `Bearer ${key}`).send({ token: invite.token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const acceptRow = await db.query(
    'SELECT actor_user_id FROM context_audit_logs WHERE owner_key = $1 AND action = \'invite_accepted\'',
    [owner.orgId], 'org-system',
  );
  assert.equal(acceptRow.rows[0]?.actor_user_id, m.userId, `not the key id ${keyId}`);

  const pid = await createProject(owner, owner.orgId, `Audit ${uuidv4().slice(0, 6)}`);
  const shared = await as('patch', `/api/v1/teams/projects/${pid}/sharing`, owner, owner.orgId).send({ visibility: 'private' });
  assert.equal(shared.status, 200);
  const shareRow = await db.query(
    'SELECT actor_user_id FROM context_audit_logs WHERE owner_key = $1 AND project_id = $2 AND action = \'sharing_policy_updated\'',
    [owner.orgId, pid], 'org-system',
  );
  assert.equal(shareRow.rows[0]?.actor_user_id, owner.userId);
});

// ── 8 ────────────────────────────────────────────────────────────────────────

test('8: a project moved into a NEW team stays private when the first colleague joins', async () => {
  const founder = await makePerson('w-founder');
  const created = await createTeamWorkspaceFixture(founder, 'Acme team');
  assert.equal(created.status, 201);
  const team = created.body.workspace;
  const pid = await createProject(founder, null, `Moved in ${uuidv4().slice(0, 6)}`);
  const moved = await as('post', `/api/v1/teams/projects/${pid}/move`, founder).send({ workspace: team });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(await visibilityOf(pid), 'private');

  await setBilling(team, { plan: 'developer_pro' });
  await db.query('UPDATE organizations SET purchased_seats = 5 WHERE org_id = $1', [team], 'org-system');
  const colleague = await makePerson('w-colleague');
  const invite = await workspace.createInvite(team, colleague.email, { role: 'member', invitedBy: founder.userId });
  const accepted = await as('post', '/api/v1/teams/invite/accept', colleague).send({ token: invite.token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  assert.equal(await visibilityOf(pid), 'private', 'what the wizard promised: visible to you and to owners');
});

test('8: solo history in a personal org upgraded to Team still becomes personal on the first invite', async () => {
  const founder = await makePerson('u-founder', { plan: 'developer_pro' });
  const pid = await createProject(founder, null, `Solo ${uuidv4().slice(0, 6)}`);
  await db.query('UPDATE context_projects SET visibility = \'private\' WHERE project_id = $1', [pid], 'org-system');

  const colleague = await makePerson('u-colleague');
  const invite = await workspace.createInvite(founder.orgId, colleague.email, { role: 'member', invitedBy: founder.userId });
  const accepted = await as('post', '/api/v1/teams/invite/accept', colleague).send({ token: invite.token });
  assert.equal(accepted.status, 200);

  assert.equal(await visibilityOf(pid), 'personal', 'inviting a colleague never publishes solo history');
});

// ── 9 ────────────────────────────────────────────────────────────────────────

test('9: a viewer mints a read-only key; asking for write is refused', async () => {
  const owner = await makePerson('v-owner', { plan: 'developer_pro' });
  const viewer = await makePerson('viewer');
  await join(owner.orgId, owner.userId, viewer, { role: 'viewer' });

  const minted = await as('post', '/api/v1/keys', viewer, owner.orgId).send({ name: 'agent', environment: 'production' });
  assert.equal(minted.status, 201, `viewer mint: ${minted.status} ${JSON.stringify(minted.body)}`);
  const row = await db.query('SELECT org_id, scopes FROM api_keys WHERE key_id = $1', [minted.body.key.id], 'org-system');
  assert.equal(row.rows[0].org_id, owner.orgId);
  assert.deepEqual(row.rows[0].scopes, ['context:read']);

  const escalate = await as('post', '/api/v1/keys', viewer, owner.orgId)
    .send({ name: 'agent-w', environment: 'production', scopes: ['context:read', 'context:write'] });
  assert.equal(escalate.status, 403);
});
