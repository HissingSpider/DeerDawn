/**
 * SCAN 12 — TEAMS (A): WHERE A PERSON LANDS WHEN A TEAM LAPSES OR LETS THEM GO.
 *
 * Every case drives the HTTP routes the dashboard and agents call.
 *
 *   1. A dashboard teammate (the browser sends x-deerdawn-workspace: <team>)
 *      got 403 subscription_inactive on every read when the team lapsed; only
 *      header-less requests fell back to their own workspace. An API key bound
 *      to the lapsed team must still fail loudly, and a removed member must
 *      still be refused.
 *   2. GET /teams/joinable and POST /teams/joinable/:key/accept were gated on
 *      the bound workspace, unlike invite/accept: a past_due personal org, or a
 *      lapsed/removed team in the header, blocked joining a healthy team by
 *      email domain.
 *   3. A re-homed person kept users.role 'read-only'/'member', so their own
 *      session was refused context:write/admin in their own new workspace.
 *   4. Re-homing stranded the founder's PERSONAL projects in the team, readable
 *      by nobody.
 *   5. Account erasure left a member's personal projects in a team behind.
 *   6. project_moved_out audit rows carried no visibility (contract with the
 *      /audit filter).
 *   7. POST /keys did not say which scopes the minted key was granted.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan12-teams-a.test.js
 */

process.env.NODE_ENV = 'test';
// The re-seal in (4) is only exercised when context is encrypted at rest.
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

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
const encryption = require('../../src/services/encryptionService');
const store = require('../../src/store/contextSyncStore');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function mintKey(userId, orgId, { scopes = ['context:read', 'context:write'] } = {}) {
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [keyId, prefix, hash, `seed ${keyId}`, userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), scopes],
  );
  return { key, keyId };
}

async function makeOrg(label, plan) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  return orgId;
}

async function makePerson(label, { plan = 'free', domain = 'e2e.test', role = 'admin' } = {}) {
  const orgId = await makeOrg(label, plan);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@${domain}`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), role, orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role, email });
  return { label, orgId, userId, email, jwt };
}

async function setBilling(orgId, { status } = {}) {
  await q('UPDATE organizations SET subscription_status = $2 WHERE org_id = $1', [orgId, status]);
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

function withKey(method, path, key, ws = null) {
  let r = request(httpServer)[method](path).set('x-api-key', key);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function createProject(person, ws, name, task = 'x') {
  const res = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name, current_task: task });
  assert.equal(res.status, 201, `project create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.project.project_id;
}

async function setVisibility(person, ws, projectId, visibility) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send({ visibility });
  assert.equal(res.status, 200, `sharing ${visibility}: ${res.status} ${JSON.stringify(res.body)}`);
}

const projectRow = async (projectId) => (await q(
  'SELECT owner_key, owner_user_id, visibility, context FROM context_projects WHERE project_id = $1', [projectId],
)).rows[0] || null;

const ids = (res) => (res.body.projects || []).map((p) => p.project_id);

// ── 1 ────────────────────────────────────────────────────────────────────────

test('1: a teammate whose browser names a lapsed team is served their own workspace, and told', async () => {
  const owner = await makePerson('l-owner', { plan: 'developer_pro' });
  const m = await makePerson('l-member');
  await join(owner.orgId, owner.userId, m);
  const mine = await createProject(m, m.orgId, `Mine ${uuidv4().slice(0, 6)}`);
  await setBilling(owner.orgId, { status: 'past_due' });

  const read = await as('get', '/api/v1/context/projects', m, owner.orgId);
  assert.equal(read.status, 200, `read with the lapsed team header: ${read.status} ${JSON.stringify(read.body)}`);
  assert.equal(read.headers['x-deerdawn-workspace-fallback'], owner.orgId, 'the fallback is announced');
  assert.ok(ids(read).includes(mine), 'served by the person\'s own workspace');

  // The switcher, with the same header the rest of the dashboard sends, now
  // agrees with where those requests are landing.
  const listing = await as('get', '/api/v1/teams/workspaces', m, owner.orgId);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.fallback?.from, owner.orgId);
  assert.equal(listing.body.fallback?.to, m.orgId);

  // A write still follows the existing fallback rule: refused, never silently
  // landed in the personal workspace.
  const write = await as('post', '/api/v1/context/projects', m, owner.orgId).send({ project_name: 'nope', current_task: 'x' });
  assert.equal(write.status, 409, `write with the lapsed team header: ${write.status} ${JSON.stringify(write.body)}`);
  assert.equal(write.body.error, 'workspace_inactive');
});

test('1: an API key bound to a lapsed team still fails loudly, with or without the header', async () => {
  const owner = await makePerson('k-owner', { plan: 'developer_pro' });
  const m = await makePerson('k-member');
  await join(owner.orgId, owner.userId, m);
  const { key } = await mintKey(m.userId, owner.orgId);
  await setBilling(owner.orgId, { status: 'past_due' });

  for (const ws of [null, owner.orgId]) {
    const res = await withKey('get', '/api/v1/context/projects', key, ws);
    assert.equal(res.status, 403, `key read (header=${ws}): ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'subscription_inactive');
    assert.equal(res.headers['x-deerdawn-workspace-fallback'], undefined);
  }
});

test('1: a removed member naming the lapsed team is still refused', async () => {
  const owner = await makePerson('r-owner', { plan: 'developer_pro' });
  const m = await makePerson('r-member');
  await join(owner.orgId, owner.userId, m);
  const removal = await as('delete', `/api/v1/teams/members/${m.userId}`, owner, owner.orgId);
  assert.equal(removal.status, 200);
  await setBilling(owner.orgId, { status: 'past_due' });

  const res = await as('get', '/api/v1/context/projects', m, owner.orgId);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'workspace_forbidden');
});

// ── 2 ────────────────────────────────────────────────────────────────────────

async function domainTeam(label) {
  const domain = `${label}-${uuidv4().slice(0, 6)}.example`;
  const owner = await makePerson(`${label}-owner`, { plan: 'developer_pro', domain });
  const added = await as('post', '/api/v1/teams/domains', owner, owner.orgId).send({ domain, role: 'member' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  return { owner, domain };
}

async function joinByDomain(person, target, ws = null) {
  const offers = await as('get', '/api/v1/teams/joinable', person, ws);
  assert.equal(offers.status, 200, `GET /joinable: ${offers.status} ${JSON.stringify(offers.body)}`);
  assert.ok(offers.body.joinable.some((o) => o.workspace === target), 'the healthy team is offered');
  const accepted = await as('post', `/api/v1/teams/joinable/${target}/accept`, person, ws).send({});
  assert.equal(accepted.status, 200, `domain accept: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  assert.equal(accepted.body.workspace, target);
}

test('2: a past_due personal org can list and accept a domain offer', async () => {
  const { owner, domain } = await domainTeam('dd-pd');
  const p = await makePerson('dd-pd-joiner', { plan: 'developer_basic', domain });
  await setBilling(p.orgId, { status: 'past_due' });
  await joinByDomain(p, owner.orgId);
});

test('2: a lapsed team in the header does not stop joining a healthy one by domain', async () => {
  const { owner, domain } = await domainTeam('dd-lh');
  const lapsedOwner = await makePerson('dd-lh-lapsed', { plan: 'developer_pro' });
  const p = await makePerson('dd-lh-joiner', { domain });
  await join(lapsedOwner.orgId, lapsedOwner.userId, p);
  await setBilling(lapsedOwner.orgId, { status: 'past_due' });
  await joinByDomain(p, owner.orgId, lapsedOwner.orgId);
});

test('2: a stale header for a team the person was removed from does not block a domain join', async () => {
  const { owner, domain } = await domainTeam('dd-rm');
  const other = await makePerson('dd-rm-other', { plan: 'developer_pro' });
  const p = await makePerson('dd-rm-joiner', { domain });
  await join(other.orgId, other.userId, p);
  const removal = await as('delete', `/api/v1/teams/members/${p.userId}`, other, other.orgId);
  assert.equal(removal.status, 200);
  await joinByDomain(p, owner.orgId, other.orgId);

  // The door that should stay shut still does: the team that removed them
  // cannot be re-entered by domain.
  const back = await as('post', `/api/v1/teams/joinable/${other.orgId}/accept`, p, other.orgId).send({});
  assert.ok([403].includes(back.status), `re-entry: ${back.status} ${JSON.stringify(back.body)}`);
});

// ── 3 + 4 ────────────────────────────────────────────────────────────────────

async function founderTeam(label, role) {
  const founder = await makePerson(`${label}-founder`, { plan: 'developer_pro', role });
  const coOwner = await makePerson(`${label}-co`);
  return { founder, coOwner, team: founder.orgId };
}

for (const legacyRole of ['read-only', 'member']) {
  test(`3: a re-homed founder with users.role '${legacyRole}' can act in their own new workspace`, async () => {
    const { founder, coOwner, team } = await founderTeam(`rh-${legacyRole}`, legacyRole);
    await join(team, founder.userId, coOwner, { role: 'owner' });

    const removal = await as('delete', `/api/v1/teams/members/${founder.userId}`, coOwner, team);
    assert.equal(removal.status, 200, JSON.stringify(removal.body));
    const home = removal.body.rehomed_to;
    assert.ok(home && home !== team);

    const key = await as('post', '/api/v1/keys', founder).send({ name: 'mine', environment: 'production' });
    assert.equal(key.status, 201, `mint key: ${key.status} ${JSON.stringify(key.body)}`);

    const project = await as('post', '/api/v1/context/projects', founder).send({ project_name: 'After', current_task: 'x' });
    assert.equal(project.status, 201, `create project: ${project.status} ${JSON.stringify(project.body)}`);

    const prefs = await as('patch', '/api/v1/context/preferences', founder).send({ max_tokens: 1200 });
    assert.ok(prefs.status < 400, `preferences: ${prefs.status} ${JSON.stringify(prefs.body)}`);

    // No confirmation: the handler answers 400 only after the scope gate
    // (context:admin) and its owner gates have let the request through.
    const erase = await as('delete', '/api/v1/context/account', founder).send({});
    assert.equal(erase.status, 400, `erase: ${erase.status} ${JSON.stringify(erase.body)}`);
    assert.equal(erase.body.error, 'confirmation_required');
  });
}

test('4: a removed founder\'s personal projects come with them, re-sealed; the team keeps its own', async () => {
  const { founder, coOwner, team } = await founderTeam('carry', 'admin');
  // Solo history: becomes 'personal' on the first 1->2 join (the org was a
  // personal org upgraded to Team).
  const solo = await createProject(founder, team, `Solo ${uuidv4().slice(0, 6)}`, 'solo task survives');
  await join(team, founder.userId, coOwner, { role: 'owner' });
  assert.equal((await projectRow(solo)).visibility, 'personal', 'fixture: backfill made solo history personal');
  assert.ok((await projectRow(solo)).context?._enc, 'fixture: context is encrypted at rest');
  await store.appendEvent({
    event_id: `evt-${uuidv4()}`, project_id: solo, source_type: 'mcp', source_id: 'scan12',
    event_kind: 'context_update', delta: { current_task: 'e' }, confidence: 1,
    contributing_user_id: founder.userId, created_at: new Date().toISOString(),
  });
  const node = `node-${uuidv4()}`;
  await q(`INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, source_tool)
           VALUES ($1, $2, $3, 'decision', $4, 'a decision', 'claude')`, [node, team, solo, `k-${node}`]);

  const shared = await createProject(founder, team, `Shared ${uuidv4().slice(0, 6)}`);
  await setVisibility(founder, team, shared, 'shared');
  const priv = await createProject(founder, team, `Private ${uuidv4().slice(0, 6)}`);
  await setVisibility(founder, team, priv, 'private');

  const removal = await as('delete', `/api/v1/teams/members/${founder.userId}`, coOwner, team);
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  const home = removal.body.rehomed_to;
  assert.ok(home);

  const row = await projectRow(solo);
  assert.equal(row.owner_key, home, 'the personal project moved to the new workspace');
  assert.equal(removal.body.personal_projects_moved, 1);
  assert.equal(row.owner_user_id, founder.userId);
  assert.ok(row.context?._enc, 'still encrypted at rest');
  const plain = await encryption.decryptContextObject(home, row.context);
  assert.equal(plain.current_task, 'solo task survives', 'decrypts under the new workspace\'s key');
  const nodeRow = (await q('SELECT owner_key FROM context_graph_nodes WHERE node_id = $1', [node])).rows[0];
  assert.equal(nodeRow.owner_key, home, 'its graph followed');

  const mine = await as('get', '/api/v1/context/projects', founder);
  assert.equal(mine.status, 200);
  const listed = (mine.body.projects || []).find((p) => p.project_id === solo);
  assert.ok(listed, 'readable by the founder in their new workspace');
  assert.ok(!listed._decrypt_error && !listed.context?._decrypt_error, 'and not a decrypt error');

  assert.equal((await projectRow(shared)).owner_key, team, 'shared stays with the team');
  assert.equal((await projectRow(priv)).owner_key, team, 'private stays with the team');
  const teamView = await as('get', '/api/v1/context/projects', coOwner, team);
  assert.ok(!ids(teamView).includes(solo), 'gone from the team');
  assert.ok(ids(teamView).includes(shared));
});

// ── 5 ────────────────────────────────────────────────────────────────────────

test('5: erasing an account takes the member\'s personal projects in a team with it; shared ones stay', async () => {
  const owner = await makePerson('er-owner', { plan: 'developer_pro' });
  const m = await makePerson('er-member');
  await join(owner.orgId, owner.userId, m);

  const personal = await createProject(m, owner.orgId, `Personal ${uuidv4().slice(0, 6)}`);
  await setVisibility(m, owner.orgId, personal, 'personal');
  const shared = await createProject(m, owner.orgId, `Shared ${uuidv4().slice(0, 6)}`);
  await setVisibility(m, owner.orgId, shared, 'shared');
  await store.appendEvent({
    event_id: `evt-${uuidv4()}`, project_id: personal, source_type: 'mcp', source_id: 'scan12',
    event_kind: 'context_update', delta: { current_task: 'e' }, confidence: 1,
    contributing_user_id: m.userId, created_at: new Date().toISOString(),
  });
  const nodeA = `node-${uuidv4()}`;
  const nodeB = `node-${uuidv4()}`;
  for (const n of [nodeA, nodeB]) {
    await q(`INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, source_tool)
             VALUES ($1, $2, $3, 'decision', $4, 'a decision', 'claude')`, [n, owner.orgId, personal, `k-${n}`]);
  }
  await q(`INSERT INTO context_graph_edges (edge_id, owner_key, project_id, from_node_id, to_node_id, edge_type, source_tool)
           VALUES ($1, $2, $3, $4, $5, 'relates_to', 'claude')`, [`edge-${uuidv4()}`, owner.orgId, personal, nodeA, nodeB]);

  // Closing the ACCOUNT (DELETE /orgs). Since scan 24, emptying a workspace
  // (DELETE /context/account) keeps the person and everything they hold in
  // other workspaces, personal projects included.
  const erase = await as('delete', '/api/v1/orgs', m).send({ password: 'password123' });
  assert.equal(erase.status, 200, `erase: ${erase.status} ${JSON.stringify(erase.body)}`);

  assert.equal(await projectRow(personal), null, 'the personal project is gone');
  const count = async (sql, params) => (await q(sql, params)).rows[0].n;
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM context_events WHERE project_id = $1', [personal]), 0);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM context_graph_nodes WHERE node_id = ANY($1)', [[nodeA, nodeB]]), 0);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM context_graph_edges WHERE project_id = $1', [personal]), 0);
  assert.equal((await projectRow(shared))?.owner_key, owner.orgId, 'the shared project stays with the team');
});

// ── 6 ────────────────────────────────────────────────────────────────────────

test('6: project_moved_out records the visibility the project had where it left', async () => {
  const owner = await makePerson('mv-owner', { plan: 'developer_pro' });
  const m = await makePerson('mv-member');
  await join(owner.orgId, owner.userId, m);
  const pid = await createProject(m, owner.orgId, `Leaving ${uuidv4().slice(0, 6)}`);
  await setVisibility(m, owner.orgId, pid, 'personal');

  const moved = await as('post', `/api/v1/teams/projects/${pid}/move`, m, owner.orgId).send({ workspace: m.orgId });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const audit = (await q(
    'SELECT metadata FROM context_audit_logs WHERE owner_key = $1 AND action = \'project_moved_out\' ORDER BY created_at DESC LIMIT 1',
    [owner.orgId],
  )).rows[0];
  assert.ok(audit, 'the move-out is audited');
  assert.equal(audit.metadata.visibility, 'personal');
  assert.equal(audit.metadata.project_id, pid);
  assert.ok(audit.metadata.project_name?.startsWith('Leaving'));
});

// ── 7 ────────────────────────────────────────────────────────────────────────

test('7: POST /keys says which scopes the key was granted', async () => {
  const owner = await makePerson('sc-owner', { plan: 'developer_pro' });
  const viewer = await makePerson('sc-viewer');
  await join(owner.orgId, owner.userId, viewer, { role: 'viewer' });

  const v = await as('post', '/api/v1/keys', viewer, owner.orgId).send({ name: 'agent', environment: 'production' });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.deepEqual(v.body.key.scopes, ['context:read']);

  const o = await as('post', '/api/v1/keys', owner, owner.orgId).send({ name: 'agent', environment: 'production' });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const stored = (await q('SELECT scopes FROM api_keys WHERE key_id = $1', [o.body.key.id])).rows[0].scopes;
  assert.deepEqual([...o.body.key.scopes].sort(), [...stored].sort(), 'the response reports what was stored');
});
