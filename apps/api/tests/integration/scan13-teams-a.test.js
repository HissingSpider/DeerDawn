/**
 * SCAN 13 — TEAMS (A): WHAT LEAVES A TEAM WITH A PERSON, AND WHAT MUST NOT.
 *
 * Every case drives the HTTP routes the dashboard and agents call.
 *
 *   1. A graph node is one row per entity per workspace and keeps the FIRST
 *      project that saw it. Carrying a project's graph "by project_id" (the
 *      removal re-home, POST /teams/projects/:id/move) took an entity the team's
 *      SHARED work was built on out of the team, and erasure deleted it (the
 *      cascade taking the team's evidence with it). The team must keep its node
 *      and evidence; the destination gets a copy carrying only the moving
 *      project's evidence.
 *   2. Removing an ORDINARY member stranded their personal projects in the team,
 *      readable by nobody. They travel to the member's own workspace.
 *   3. Domain join counted seats outside addMember's lock: concurrent joiners
 *      overfilled the team. Mixed with an invitation accept, the same.
 *   4. A carried personal project's audit rows and project-scoped skills stayed
 *      in the team; erasure left the audit rows of the personal projects it
 *      deleted.
 *   5. Routes exempt from plan enforcement ignored the lapsed-team fallback:
 *      export exported the team, account deletion 403'd, a non-owner member got
 *      the team's upgrade offer from GET /teams/members.
 *   6. GET /teams/joinable offered a lapsed team whose accept then refused.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan13-teams-a.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

const q = (sql, params) => db.query(sql, params, 'org-system');
const count = async (sql, params) => Number((await q(sql, params)).rows[0].n);

async function makeOrg(label, plan, seats) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : (seats || 5)],
  );
  return orgId;
}

async function makePerson(label, { plan = 'free', domain = 'e2e.test', seats } = {}) {
  const orgId = await makeOrg(label, plan, seats);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@${domain}`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

async function setBilling(orgId, status) {
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

async function createProject(person, ws, name) {
  const res = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name, current_task: 'x' });
  assert.equal(res.status, 201, `project create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.project.project_id;
}

async function setVisibility(person, ws, projectId, visibility) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send({ visibility });
  assert.equal(res.status, 200, `sharing ${visibility}: ${res.status} ${JSON.stringify(res.body)}`);
}

const now = () => new Date().toISOString();
async function node(ownerKey, projectId, key, summary) {
  return store.upsertGraphNode({
    node_id: `node_${uuidv4()}`, owner_key: ownerKey, project_id: projectId, node_type: 'service', canonical_key: key,
    title: key, summary, metadata: {}, confidence: 0.8, source_tool: 'claude_code',
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });
}
async function evidence(ownerKey, projectId, nodeId, excerpt) {
  const row = await store.addGraphEvidence({
    evidence_id: `ev_${uuidv4()}`, owner_key: ownerKey, project_id: projectId, session_id: 's', node_id: nodeId,
    tool: 'claude_code', excerpt, metadata: {}, confidence: 0.8, created_at: now(),
  });
  return row.evidence_id;
}
async function embed(ownerKey, kind, targetId) {
  await q(
    `INSERT INTO context_graph_embeddings (owner_key, target_kind, target_id, model, dimensions, vector)
     VALUES ($1, $2, $3, 'test', 1, '[1]'::jsonb)`,
    [ownerKey, kind, targetId],
  );
}
const nodeRow = async (nodeId) => (await q('SELECT * FROM context_graph_nodes WHERE node_id = $1', [nodeId])).rows[0] || null;
const evidenceRow = async (id) => (await q('SELECT * FROM context_graph_evidence WHERE evidence_id = $1', [id])).rows[0] || null;

// ── 1 ────────────────────────────────────────────────────────────────────────

test('1a: removing a founder keeps the team\'s shared entity; their new workspace gets a copy with only their evidence', async () => {
  const founder = await makePerson('g-founder', { plan: 'developer_pro' });
  const personal = await createProject(founder, null, `personal ${uuidv4().slice(0, 6)}`);
  const shared = await node(founder.orgId, personal, `billing-${uuidv4().slice(0, 6)}`, 'short');
  const solo = await node(founder.orgId, personal, `diary-${uuidv4().slice(0, 6)}`, 'only mine');
  await embed(founder.orgId, 'node', solo.node_id);
  const co = await makePerson('g-co');
  await join(founder.orgId, founder.userId, co, { role: 'owner' });
  const teamProject = await createProject(co, founder.orgId, `team ${uuidv4().slice(0, 6)}`);

  // The team builds on the same entity in its SHARED project.
  const again = await node(founder.orgId, teamProject, shared.canonical_key,
    'Team runbook: rotates Stripe keys from vault path secret/prod/stripe every Monday');
  assert.equal(again.node_id, shared.node_id, 'one entity, one node');
  // Since scan 36 (V3) a write from another project never replaces a node's
  // text, so the team's summary is planted directly: this is the shape rows
  // written before that change are in, and what the removal must keep.
  await q('UPDATE context_graph_nodes SET summary = $2 WHERE node_id = $1',
    [shared.node_id, 'Team runbook: rotates Stripe keys from vault path secret/prod/stripe every Monday']);
  const teamEv = await evidence(founder.orgId, teamProject, shared.node_id, 'team decision about billing');
  const mineEv = await evidence(founder.orgId, personal, shared.node_id, 'my own note about billing');
  await embed(founder.orgId, 'evidence', mineEv);

  const removal = await as('delete', `/api/v1/teams/members/${founder.userId}`, co, founder.orgId);
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  const home = removal.body.rehomed_to;
  assert.ok(home, 're-homed');
  assert.equal(removal.body.personal_projects_moved, 1);

  const kept = await nodeRow(shared.node_id);
  assert.equal(kept.owner_key, founder.orgId, 'the team keeps the node its shared project is built on');
  assert.match(kept.summary, /Team runbook/, 'with its own summary');
  assert.equal(kept.project_id, teamProject, 're-homed onto a project it is still seen in');
  assert.equal((await evidenceRow(teamEv)).owner_key, founder.orgId, 'the team keeps its evidence');
  assert.equal((await evidenceRow(teamEv)).node_id, shared.node_id);

  const copy = (await q(
    'SELECT * FROM context_graph_nodes WHERE owner_key = $1 AND canonical_key = $2', [home, shared.canonical_key],
  )).rows[0];
  assert.ok(copy, 'the new workspace has its own copy');
  assert.notEqual(copy.node_id, shared.node_id);
  assert.equal(copy.summary, '', 'the copy carries none of the team\'s writing');
  assert.equal(copy.project_id, personal);
  const moved = await evidenceRow(mineEv);
  assert.equal(moved.owner_key, home, 'the personal evidence moved');
  assert.equal(moved.node_id, copy.node_id, 're-pointed at the copy');
  assert.equal(await count(
    'SELECT COUNT(*)::int AS n FROM context_graph_evidence WHERE owner_key = $1 AND node_id = $2', [home, copy.node_id],
  ), 1, 'the copy carries ONLY the moved project\'s evidence');
  assert.equal(await count(
    'SELECT COUNT(*)::int AS n FROM context_graph_embeddings WHERE owner_key = $1 AND target_kind = \'evidence\' AND target_id = $2',
    [home, mineEv],
  ), 1, 'the evidence vector followed it');

  // The entity only the personal project used moved whole, id and vector.
  assert.equal((await nodeRow(solo.node_id)).owner_key, home);
  assert.equal(await count(
    'SELECT COUNT(*)::int AS n FROM context_graph_embeddings WHERE owner_key = $1 AND target_kind = \'node\' AND target_id = $2',
    [home, solo.node_id],
  ), 1);

  // The team still sees it through the API.
  const graph = await as('get', `/api/v1/context/graph/projects/${teamProject}`, co, founder.orgId);
  assert.equal(graph.status, 200);
  assert.ok((graph.body.graph?.nodes || []).some((n) => n.node_id === shared.node_id), 'visible in the team project graph');
});

test('1b: moving a project does not take the workspace\'s shared entity with it', async () => {
  const owner = await makePerson('mv-owner', { plan: 'developer_pro' });
  const other = await makePerson('mv-other', { plan: 'developer_pro' });
  await join(other.orgId, other.userId, owner, { role: 'member' });
  const moving = await createProject(owner, owner.orgId, `moving ${uuidv4().slice(0, 6)}`);
  const staying = await createProject(owner, owner.orgId, `staying ${uuidv4().slice(0, 6)}`);
  const n = await node(owner.orgId, moving, `auth-${uuidv4().slice(0, 6)}`, 'first seen in the moving project, long summary text');
  const stayEv = await evidence(owner.orgId, staying, n.node_id, 'the staying project uses it');
  const moveEv = await evidence(owner.orgId, moving, n.node_id, 'the moving project uses it');

  const res = await as('post', `/api/v1/teams/projects/${moving}/move`, owner, owner.orgId).send({ workspace: other.orgId });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.equal((await nodeRow(n.node_id)).owner_key, owner.orgId, 'the source keeps the entity it still uses');
  assert.equal((await evidenceRow(stayEv)).node_id, n.node_id);
  const moved = await evidenceRow(moveEv);
  assert.equal(moved.owner_key, other.orgId);
  const copy = (await q('SELECT node_id, owner_key FROM context_graph_nodes WHERE node_id = $1', [moved.node_id])).rows[0];
  assert.equal(copy.owner_key, other.orgId, 'the moved evidence hangs off a node in its own workspace');
});

test('1c: erasing a member\'s personal project in a team leaves the team\'s shared entity and evidence', async () => {
  const owner = await makePerson('e-owner', { plan: 'developer_pro' });
  const m = await makePerson('e-member');
  await join(owner.orgId, owner.userId, m);
  const personal = await createProject(m, owner.orgId, `personal ${uuidv4().slice(0, 6)}`);
  await setVisibility(m, owner.orgId, personal, 'personal');
  const teamProject = await createProject(owner, owner.orgId, `team ${uuidv4().slice(0, 6)}`);
  const n = await node(owner.orgId, personal, `queue-${uuidv4().slice(0, 6)}`, 'x');
  const teamEv = await evidence(owner.orgId, teamProject, n.node_id, 'team relies on the queue');
  const mineEv = await evidence(owner.orgId, personal, n.node_id, 'my personal note');
  await q(
    `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata)
     VALUES ($1, $2, $3, 'context_read', 'user', $4, 'dashboard', '{}')`,
    [`audit_${uuidv4()}`, owner.orgId, personal, m.userId],
  );

  // Closing the ACCOUNT (DELETE /orgs). Since scan 24, emptying a workspace
  // (DELETE /context/account) keeps the person and everything they hold in
  // other workspaces, personal projects included.
  const erase = await as('delete', '/api/v1/orgs', m).send({ password: 'password123' });
  assert.equal(erase.status, 200, `erase: ${erase.status} ${JSON.stringify(erase.body)}`);

  assert.ok(await nodeRow(n.node_id), 'the team\'s entity survives the erasure');
  assert.ok(await evidenceRow(teamEv), 'and so does the team\'s evidence');
  assert.equal(await evidenceRow(mineEv), null, 'the erased person\'s evidence is gone');
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM context_projects WHERE project_id = $1', [personal]), 0);
  // (4) its audit rows with it
  assert.equal(await count(
    'SELECT COUNT(*)::int AS n FROM context_audit_logs WHERE owner_key = $1 AND project_id = $2', [owner.orgId, personal],
  ), 0, 'audit rows of an erased personal project are erased');
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test('2: removing an ordinary member carries their personal projects to their own workspace; private and shared stay', async () => {
  const owner = await makePerson('o-owner', { plan: 'developer_pro' });
  const m = await makePerson('o-member');
  await join(owner.orgId, owner.userId, m);
  const personal = await createProject(m, owner.orgId, `M personal ${uuidv4().slice(0, 6)}`);
  await setVisibility(m, owner.orgId, personal, 'personal');
  const priv = await createProject(m, owner.orgId, `M private ${uuidv4().slice(0, 6)}`);
  await setVisibility(m, owner.orgId, priv, 'private');
  const shared = await createProject(m, owner.orgId, `M shared ${uuidv4().slice(0, 6)}`);

  const removal = await as('delete', `/api/v1/teams/members/${m.userId}`, owner, owner.orgId);
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  assert.equal(removal.body.rehomed_to, null, 'an ordinary member is not re-homed');
  assert.equal(removal.body.personal_projects_moved, 1);
  assert.equal(removal.body.personal_projects_moved_to, m.orgId);

  const rows = new Map((await q(
    'SELECT project_id, owner_key FROM context_projects WHERE project_id = ANY($1)', [[personal, priv, shared]],
  )).rows.map((r) => [r.project_id, r.owner_key]));
  assert.equal(rows.get(personal), m.orgId, 'the personal project travelled with its author');
  assert.equal(rows.get(priv), owner.orgId, 'private stays with the team');
  assert.equal(rows.get(shared), owner.orgId, 'shared stays with the team');

  const inject = await as('get', `/api/v1/context/projects/${personal}/inject?format=json`, m);
  assert.equal(inject.status, 200, `the author can read it: ${inject.status} ${JSON.stringify(inject.body)}`);
});

// ── 3 ────────────────────────────────────────────────────────────────────────

const activeMembers = (ownerKey) => count(
  'SELECT COUNT(*)::int AS n FROM workspace_members WHERE owner_key = $1 AND removed_at IS NULL', [ownerKey],
);

test('3a: concurrent domain joiners never exceed the seats', async () => {
  const domain = `dj-${uuidv4().slice(0, 6)}.example`;
  const owner = await makePerson('dj-owner', { plan: 'developer_pro', domain, seats: 3 });
  const added = await as('post', '/api/v1/teams/domains', owner, owner.orgId).send({ domain, role: 'member' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const j1 = await makePerson('dj1', { domain });
  assert.equal((await as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, j1)).status, 200);

  const joiners = await Promise.all([1, 2, 3, 4].map((i) => makePerson(`djr${i}`, { domain })));
  const results = await Promise.all(joiners.map((j) => as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, j)));
  const statuses = results.map((r) => r.status).sort();
  assert.ok(await activeMembers(owner.orgId) <= 3, `over the cap: ${await activeMembers(owner.orgId)} active, ${statuses}`);
  assert.deepEqual(statuses, [200, 402, 402, 402]);
  assert.equal(results.find((r) => r.status === 402).body.error, 'limit_exceeded');
});

test('3b: an invitation accepted alongside domain joins does not overfill the team either', async () => {
  const domain = `dm-${uuidv4().slice(0, 6)}.example`;
  const owner = await makePerson('dm-owner', { plan: 'developer_pro', domain, seats: 3 });
  await as('post', '/api/v1/teams/domains', owner, owner.orgId).send({ domain, role: 'member' });
  const invited = await makePerson('dm-inv', { domain: 'elsewhere.test' });
  const invite = await workspace.createInvite(owner.orgId, invited.email, { role: 'member', invitedBy: owner.userId });
  const joiners = await Promise.all([1, 2].map((i) => makePerson(`dmj${i}`, { domain })));

  await Promise.all([
    as('post', '/api/v1/teams/invite/accept', invited).send({ token: invite.token }),
    ...joiners.map((j) => as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, j)),
  ]);
  assert.ok(await activeMembers(owner.orgId) <= 3, `over the cap: ${await activeMembers(owner.orgId)} active`);
});

// ── 4 ────────────────────────────────────────────────────────────────────────

test('4: a carried personal project takes its audit rows and project-scoped skills with it', async () => {
  const owner = await makePerson('a-owner', { plan: 'developer_pro' });
  const m = await makePerson('a-member');
  await join(owner.orgId, owner.userId, m);
  const personal = await createProject(m, owner.orgId, `audited ${uuidv4().slice(0, 6)}`);
  await setVisibility(m, owner.orgId, personal, 'personal');
  const auditId = `audit_${uuidv4()}`;
  await q(
    `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata)
     VALUES ($1, $2, $3, 'context_read', 'user', $4, 'dashboard', '{}')`,
    [auditId, owner.orgId, personal, m.userId],
  );
  const skillId = `skill_${uuidv4()}`;
  await q(
    `INSERT INTO workspace_skills (skill_id, owner_key, project_id, slug, name, markdown_content)
     VALUES ($1, $2, $3, $4, 'Mine', '# mine')`,
    [skillId, owner.orgId, personal, `mine-${uuidv4().slice(0, 6)}`],
  );

  const removal = await as('delete', `/api/v1/teams/members/${m.userId}`, owner, owner.orgId);
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  assert.equal((await q('SELECT owner_key FROM context_audit_logs WHERE audit_id = $1', [auditId])).rows[0].owner_key, m.orgId);
  assert.equal((await q('SELECT owner_key FROM workspace_skills WHERE skill_id = $1', [skillId])).rows[0].owner_key, m.orgId);
});

// ── 5 ────────────────────────────────────────────────────────────────────────

test('5: exempt routes follow the lapsed-team fallback like every other read', async () => {
  const owner = await makePerson('x-owner', { plan: 'developer_pro' });
  const co = await makePerson('x-co');
  const m = await makePerson('x-member');
  await join(owner.orgId, owner.userId, co, { role: 'owner' });
  await join(owner.orgId, owner.userId, m);
  const mine = `M own ${uuidv4().slice(0, 6)}`;
  await createProject(m, m.orgId, mine);
  const teams = `TEAM ${uuidv4().slice(0, 6)}`;
  await createProject(owner, owner.orgId, teams);
  await setBilling(owner.orgId, 'past_due');

  const exp = await as('get', '/api/v1/context/export', m, owner.orgId);
  assert.equal(exp.status, 200);
  assert.equal(exp.headers['x-deerdawn-workspace-fallback'], owner.orgId, 'the fallback is announced');
  assert.ok(exp.text.includes(mine), 'exports the workspace being served');
  assert.ok(!exp.text.includes(teams), 'not the lapsed team');

  const erase = await as('delete', '/api/v1/context/account', m, owner.orgId).send({});
  assert.equal(erase.status, 400, `reaches its own workspace's handler: ${erase.status} ${JSON.stringify(erase.body)}`);
  assert.equal(erase.body.error, 'confirmation_required');

  const members = await as('get', '/api/v1/teams/members', m, owner.orgId);
  assert.equal(members.headers['x-deerdawn-workspace-fallback'], owner.orgId, 'a non-owner member follows the fallback');

  // An owner of the lapsed team keeps its roster: that exemption is hers.
  const roster = await as('get', '/api/v1/teams/members', co, owner.orgId);
  assert.equal(roster.status, 200, JSON.stringify(roster.body));
  assert.equal(roster.headers['x-deerdawn-workspace-fallback'], undefined);
  assert.ok(roster.body.members.some((row) => row.id === m.userId));
});

// ── 6 ────────────────────────────────────────────────────────────────────────

test('6: a lapsed team is not offered through the domain door', async () => {
  const domain = `lj-${uuidv4().slice(0, 6)}.example`;
  const owner = await makePerson('lj-owner', { plan: 'developer_pro', domain });
  await as('post', '/api/v1/teams/domains', owner, owner.orgId).send({ domain, role: 'member' });
  const j = await makePerson('lj', { domain });
  const before = await as('get', '/api/v1/teams/joinable', j);
  assert.ok(before.body.joinable.some((o) => o.workspace === owner.orgId), 'offered while healthy');
  await setBilling(owner.orgId, 'past_due');
  const after = await as('get', '/api/v1/teams/joinable', j);
  assert.equal(after.status, 200);
  assert.ok(!after.body.joinable.some((o) => o.workspace === owner.orgId), 'not offered once lapsed');
});
