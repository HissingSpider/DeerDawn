/**
 * A DASHBOARD TAB NAMES THE WORKSPACE IT SHOWS, PERSONAL INCLUDED.
 *
 * Journey scan round 3, T3-1. A tab showing Marcus's personal workspace used to
 * express "personal" by sending NO x-deerdawn-workspace header, and a
 * header-less session request is answered in the person's stored active
 * workspace. Accepting an invitation sets that to the team, and so does a
 * switch in another tab or on another device: the page still said FREE and
 * listed his own projects, and the project he created there landed in the
 * team, shared with every member.
 *
 * The dashboard now names personal explicitly, with the person's own org id.
 * That is only safe if the API already does two things, and this file pins
 * both against the real app and a real database:
 *
 *   1. For the person, their own org id binds the request to their own
 *      workspace, OVER their stored active workspace: the explicit header wins,
 *      what the page shows (bootstrap) and where it writes agree, and a key
 *      minted there belongs there.
 *   2. For anybody else, naming that org id is refused with workspace_forbidden
 *      and nothing is written. A teammate on the same team is "anybody else":
 *      sharing a team does not admit you to a colleague's personal workspace.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r3-tab-workspace.test.js
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
const { hashPassword, generateApiKey, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

async function mintKey(userId, orgId, name) {
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, name, userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    'org-system',
  );
  return key;
}

async function makePerson(label, { plan = 'free', purchasedSeats = null } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', purchasedSeats],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin' });
  const apiKey = await mintKey(userId, orgId, `${label} personal key`);
  return { label, orgId, userId, email, jwt, apiKey };
}

async function cleanup(people) {
  for (const person of people) {
    await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_ownership_backfills WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1 OR user_id = $2', [person.orgId, person.userId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM audit_logs WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1 OR owner_id = $2', [person.orgId, person.userId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await invalidateOrgCache(person.orgId).catch(() => {});
  }
}

const asUser = (req, person, ws) => {
  const r = req.set('Authorization', `Bearer ${person.jwt}`);
  return ws ? r.set('x-deerdawn-workspace', ws) : r;
};

async function join(owner, joiner) {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role: 'member', invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function projectRow(name) {
  return db.query(
    'SELECT owner_key, visibility FROM context_projects WHERE project_name = $1',
    [name],
    'org-system',
  ).then((r) => r.rows);
}

async function listedNames(person, ws) {
  const res = await asUser(request(httpServer).get('/api/v1/context/projects'), person, ws);
  assert.equal(res.status, 200, res.text);
  return (res.body.projects || []).map((p) => p.project_name);
}

test('naming your own workspace binds the request there, over the team your stored choice points at', async () => {
  const olivia = await makePerson('olivia', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  try {
    await join(olivia, marcus);
    // Accepting activates the team, which is what used to capture the
    // header-less "personal" tab.
    assert.equal(await workspace.getActiveWorkspace({ id: marcus.userId }), olivia.orgId,
      'the fixture depends on accept auto-activating the team');

    // What the page SHOWS: the bootstrap bound to his own workspace.
    const boot = await asUser(request(httpServer).get('/api/v1/dashboard/bootstrap'), marcus, marcus.orgId);
    assert.equal(boot.status, 200, boot.text);
    assert.equal(boot.body.org.id, marcus.orgId, 'the page loaded for personal is shown personal');

    // Where it WRITES.
    const name = `TwoTab ${uuidv4().slice(0, 6)}`;
    const created = await asUser(request(httpServer).post('/api/v1/context/projects'), marcus, marcus.orgId)
      .send({ project_name: name });
    assert.equal(created.status, 201, created.text);
    const rows = await projectRow(name);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner_key, marcus.orgId, `landed in ${rows[0].owner_key}, not the workspace the page named`);
    assert.notEqual(rows[0].visibility, 'shared');

    // Read back as each member.
    assert.ok((await listedNames(marcus, marcus.orgId)).includes(name), 'Marcus reads it in his own workspace');
    assert.ok(!(await listedNames(marcus, olivia.orgId)).includes(name), 'it is not in the team');
    assert.ok(!(await listedNames(olivia)).includes(name), 'Olivia never sees it');

    // A key minted from that page belongs to the workspace it shows.
    const minted = await asUser(request(httpServer).post('/api/v1/keys'), marcus, marcus.orgId)
      .send({ name: `setup key ${uuidv4().slice(0, 5)}`, environment: 'production' });
    assert.equal(minted.status, 201, minted.text);
    const keyId = minted.body.key?.id || minted.body.key?.key_id || minted.body.id || minted.body.key_id;
    const keyRow = await db.query('SELECT org_id FROM api_keys WHERE key_id = $1', [keyId], 'org-system');
    assert.equal(keyRow.rows[0]?.org_id, marcus.orgId, 'the key was minted into the workspace the page named');

    // And the header-less request the page no longer makes still follows the
    // stored choice, which keeps its meaning for tools and new pages.
    const toolName = `Header-less ${uuidv4().slice(0, 6)}`;
    const headerless = await asUser(request(httpServer).post('/api/v1/context/projects'), marcus)
      .send({ project_name: toolName });
    assert.equal(headerless.status, 201, headerless.text);
    assert.equal((await projectRow(toolName))[0]?.owner_key, olivia.orgId);
  } finally {
    await cleanup([olivia, marcus]);
  }
});

test('nobody can name somebody else\'s personal workspace, not even a teammate', async () => {
  const olivia = await makePerson('olivia', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  const vera = await makePerson('vera');
  try {
    await join(olivia, marcus);
    await join(olivia, vera);
    const mine = `Marcus private ${uuidv4().slice(0, 6)}`;
    const own = await asUser(request(httpServer).post('/api/v1/context/projects'), marcus, marcus.orgId)
      .send({ project_name: mine });
    assert.equal(own.status, 201, own.text);

    for (const intruder of [vera, olivia]) {
      const read = await asUser(request(httpServer).get('/api/v1/context/projects'), intruder, marcus.orgId);
      assert.equal(read.status, 403, `${intruder.label} read Marcus's personal workspace: ${read.status} ${read.text}`);
      assert.equal(read.body.error, 'workspace_forbidden');

      const planted = `Planted by ${intruder.label} ${uuidv4().slice(0, 6)}`;
      const write = await asUser(request(httpServer).post('/api/v1/context/projects'), intruder, marcus.orgId)
        .send({ project_name: planted });
      assert.equal(write.status, 403, `${intruder.label} wrote into Marcus's personal workspace: ${write.status}`);
      assert.equal(write.body.error, 'workspace_forbidden');
      assert.deepEqual(await projectRow(planted), [], 'nothing was written anywhere');

      const boot = await asUser(request(httpServer).get('/api/v1/dashboard/bootstrap'), intruder, marcus.orgId);
      assert.equal(boot.status, 403, `${intruder.label} loaded Marcus's workspace in the dashboard: ${boot.status}`);

      // A key is the same credential by another route.
      const byKey = await request(httpServer).get('/api/v1/context/projects')
        .set('X-Api-Key', intruder.apiKey).set('x-deerdawn-workspace', marcus.orgId);
      assert.equal(byKey.status, 403, `${intruder.label}'s key read Marcus's personal workspace: ${byKey.status}`);
    }

    // And the workspace itself is untouched and still his.
    assert.deepEqual(await listedNames(marcus, marcus.orgId), [mine]);
  } finally {
    await cleanup([olivia, marcus, vera]);
  }
});
