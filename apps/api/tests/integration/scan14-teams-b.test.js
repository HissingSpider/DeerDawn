/**
 * SCAN 14 — TEAMS (B): WHAT A PERSON TAKES, LEAVES AND KEEPS AT THE TEAM'S EDGE.
 *
 * Every case drives the HTTP routes the dashboard and agents call.
 *
 *   1. A project's ROOT graph node is keyed by project NAME, so a personal
 *      `api` and the team's shared `api` are one row. The carry/erase kept it
 *      for the team because a team edge ends on it, and re-homed it onto the
 *      team project WITH the personal project's description/status — on
 *      removal, on erasure and on a move out. A node kept only for an edge's
 *      sake stays as identity; its words go with the project that wrote them.
 *   2. Removal left the person's unused invitation open, and redeeming it walked
 *      them back in; the domain door never spent the joiner's own invitation, so
 *      they held two seats and were refused at the door for their own seat.
 *   3. Exporting a lapsed team as an owner whose users.org_id is not the team
 *      (a co-owner, the creator of a POST /teams/workspaces team) exported their
 *      PERSONAL workspace.
 *   4. A viewer could move a project into (or out of) a team they only read.
 *   5. A legacy session with no user_id was claimable by any teammate.
 *   6. With seats cut below the outstanding invitations, every invitee was
 *      refused although a seat was free.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan14-teams-b.test.js
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
const { createTeamWorkspaceFixture } = require('../helpers/teamWorkspaceFixture');
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

async function setOrg(orgId, fields) {
  const keys = Object.keys(fields);
  await q(
    `UPDATE organizations SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE org_id = $1`,
    [orgId, ...keys.map((k) => fields[k])],
  );
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

const activeMembers = (ownerKey) => count(
  'SELECT COUNT(*)::int AS n FROM workspace_members WHERE owner_key = $1 AND removed_at IS NULL', [ownerKey],
);

// ── 1 ────────────────────────────────────────────────────────────────────────

const now = () => new Date().toISOString();
const PERSONAL_TEXT = 'M PERSONAL: interviewing at a competitor next week';

/**
 * The shape contextGraphService produces for two same-named projects in one
 * workspace: ONE root node `project:<name>`, first written by the personal
 * project (its summary is that project's status), with an edge from each
 * project to its own entity. Nothing records evidence on the root, so the team
 * keeps it only because the team's edge ends on it.
 */
async function sameNameRoot(ownerKey, personalId, teamId, name) {
  const node = (projectId, type, key, summary, metadata = {}) => store.upsertGraphNode({
    node_id: `graph_node_${uuidv4()}`, owner_key: ownerKey, project_id: projectId, node_type: type, canonical_key: key,
    title: key, summary, metadata, confidence: 0.9, source_tool: 'claude_code',
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });
  const edge = (projectId, from, to) => store.upsertGraphEdge({
    edge_id: `graph_edge_${uuidv4()}`, owner_key: ownerKey, project_id: projectId, edge_type: 'depends_on',
    from_node_id: from, to_node_id: to, summary: 'depends', metadata: {}, confidence: 0.7, source_tool: 'claude_code',
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });
  const evidence = (projectId, nodeId) => store.addGraphEvidence({
    evidence_id: `ev_${uuidv4()}`, owner_key: ownerKey, project_id: projectId, session_id: 's', node_id: nodeId,
    tool: 'claude_code', excerpt: 'seen', metadata: {}, confidence: 0.8, created_at: now(),
  });
  const root = await node(personalId, 'project', `project:${name}`, PERSONAL_TEXT,
    { project_id: personalId, tech_stack: ['postgres'], personal_note: PERSONAL_TEXT });
  const mine = await node(personalId, 'service', `service:postgres-${uuidv4().slice(0, 6)}`, 'Technology used by the personal api');
  const theirs = await node(teamId, 'service', `service:redis-${uuidv4().slice(0, 6)}`, 'Technology used by the team api');
  await edge(personalId, root.node_id, mine.node_id);
  await edge(teamId, root.node_id, theirs.node_id);
  await evidence(personalId, mine.node_id);
  await evidence(teamId, theirs.node_id);
  await q(
    `INSERT INTO context_graph_embeddings (owner_key, target_kind, target_id, model, dimensions, vector)
     VALUES ($1, 'node', $2, 'test', 1, '[1]'::jsonb)`,
    [ownerKey, root.node_id],
  );
  return root;
}

async function teamSideIsIdentityOnly(ownerKey, root, teamId, reader) {
  const row = (await q('SELECT * FROM context_graph_nodes WHERE node_id = $1', [root.node_id])).rows[0];
  assert.ok(row, 'the team keeps the node its edge ends on');
  assert.equal(row.owner_key, ownerKey);
  assert.equal(row.project_id, teamId, 're-homed onto the team project');
  assert.equal(row.summary, '', 'with none of the personal project\'s words');
  assert.deepEqual(row.metadata, {}, 'and none of its metadata');
  assert.equal(await count(
    'SELECT COUNT(*)::int AS n FROM context_graph_embeddings WHERE owner_key = $1 AND target_kind = \'node\' AND target_id = $2',
    [ownerKey, root.node_id],
  ), 0, 'nor a vector computed from them');
  const viaApi = await as('get', `/api/v1/context/graph/nodes/${root.node_id}`, reader, ownerKey);
  assert.ok(!JSON.stringify(viaApi.body).includes('M PERSONAL'), `a teammate cannot read it: ${viaApi.status}`);
  const graph = await as('get', `/api/v1/context/graph/projects/${teamId}`, reader, ownerKey);
  assert.equal(graph.status, 200);
  assert.ok(!JSON.stringify(graph.body).includes('M PERSONAL'), 'not through the team project graph either');
}

async function personKeepsTheirWords(destKey, root, personalId) {
  const copy = (await q(
    'SELECT * FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2 AND canonical_key = $3',
    [destKey, 'project', root.canonical_key],
  )).rows[0];
  assert.ok(copy, 'the person\'s workspace has the root');
  assert.equal(copy.project_id, personalId);
  assert.equal(copy.summary, PERSONAL_TEXT, 'the words travel with the project that wrote them');
}

test('1a: removing a member leaves the team a shared-name root as identity only; the person keeps its words', async () => {
  const owner = await makePerson('r-owner', { plan: 'developer_pro' });
  const viewer = await makePerson('r-viewer');
  const m = await makePerson('r-member');
  await join(owner.orgId, owner.userId, m);
  await join(owner.orgId, owner.userId, viewer, { role: 'viewer' });
  const name = `api-${uuidv4().slice(0, 6)}`;
  const personal = await createProject(m, owner.orgId, `${name} mine`);
  await setVisibility(m, owner.orgId, personal, 'personal');
  const team = await createProject(owner, owner.orgId, `${name} team`);
  const root = await sameNameRoot(owner.orgId, personal, team, name);

  const removal = await as('delete', `/api/v1/teams/members/${m.userId}`, owner, owner.orgId);
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  assert.equal(removal.body.personal_projects_moved, 1);

  await teamSideIsIdentityOnly(owner.orgId, root, team, viewer);
  await personKeepsTheirWords(m.orgId, root, personal);
});

test('1b: erasing a member leaves the team a shared-name root as identity only', async () => {
  const owner = await makePerson('er-owner', { plan: 'developer_pro' });
  const m = await makePerson('er-member');
  await join(owner.orgId, owner.userId, m);
  const name = `api-${uuidv4().slice(0, 6)}`;
  const personal = await createProject(m, owner.orgId, `${name} mine`);
  await setVisibility(m, owner.orgId, personal, 'personal');
  const team = await createProject(owner, owner.orgId, `${name} team`);
  const root = await sameNameRoot(owner.orgId, personal, team, name);

  // Closing the ACCOUNT (DELETE /orgs). Since scan 24, emptying a workspace
  // (DELETE /context/account) keeps the person and everything they hold in
  // other workspaces, personal projects included.
  const erase = await as('delete', '/api/v1/orgs', m).send({ password: 'password123' });
  assert.equal(erase.status, 200, `erase: ${erase.status} ${JSON.stringify(erase.body)}`);

  await teamSideIsIdentityOnly(owner.orgId, root, team, owner);
});

test('1c: moving a personal project out leaves the team a shared-name root as identity only; the destination keeps its words', async () => {
  const owner = await makePerson('mo-owner', { plan: 'developer_pro' });
  const m = await makePerson('mo-member');
  await join(owner.orgId, owner.userId, m);
  const name = `api-${uuidv4().slice(0, 6)}`;
  const personal = await createProject(m, owner.orgId, `${name} mine`);
  await setVisibility(m, owner.orgId, personal, 'personal');
  const team = await createProject(owner, owner.orgId, `${name} team`);
  const root = await sameNameRoot(owner.orgId, personal, team, name);

  const moved = await as('post', `/api/v1/teams/projects/${personal}/move`, m, owner.orgId).send({ workspace: m.orgId });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  await teamSideIsIdentityOnly(owner.orgId, root, team, owner);
  await personKeepsTheirWords(m.orgId, root, personal);
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test('2a: removal revokes the person\'s open invitation, so it cannot readmit them', async () => {
  const owner = await makePerson('ri-owner', { plan: 'developer_pro' });
  const x = await makePerson('ri-x');
  await join(owner.orgId, owner.userId, x);
  // A second, still-open invitation to the same person (an owner re-sending,
  // or one that outlived a join through another door).
  const stale = await workspace.createInvite(owner.orgId, x.email, { role: 'member', invitedBy: owner.userId });

  const removal = await as('delete', `/api/v1/teams/members/${x.userId}`, owner, owner.orgId);
  assert.equal(removal.status, 200, JSON.stringify(removal.body));

  const back = await as('post', '/api/v1/teams/invite/accept', x).send({ token: stale.token });
  assert.notEqual(back.status, 200, `the removed person walked back in: ${JSON.stringify(back.body)}`);
  assert.equal(back.body.error, 'revoked');
  assert.equal(await count(
    'SELECT COUNT(*)::int AS n FROM workspace_invites WHERE invite_id = $1 AND revoked_at IS NOT NULL', [stale.invite_id],
  ), 1, 'the open invitation was revoked with the removal');
  assert.equal(await count(
    'SELECT COUNT(*)::int AS n FROM workspace_members WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL',
    [owner.orgId, x.userId],
  ), 0, 'still removed');

  // An owner deciding again is still how the removal is reversed.
  const fresh = await workspace.createInvite(owner.orgId, x.email, { role: 'member', invitedBy: owner.userId });
  const readmit = await as('post', '/api/v1/teams/invite/accept', x).send({ token: fresh.token });
  assert.equal(readmit.status, 200, JSON.stringify(readmit.body));
});

test('2b: the domain door spends the joiner\'s own invitation — one seat, their reserved one, at the invited role', async () => {
  const domain = `dd-${uuidv4().slice(0, 6)}.example`;
  const owner = await makePerson('dd-owner', { plan: 'developer_pro', domain, seats: 2 });
  const added = await as('post', '/api/v1/teams/domains', owner, owner.orgId).send({ domain, role: 'viewer' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const x = await makePerson('dd-x', { domain });
  const inv = await as('post', '/api/v1/teams/invite', owner, owner.orgId).send({ email: x.email, role: 'member' });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));

  // Owner + x's reserved seat = both seats. The door must admit x on it.
  const door = await as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, x);
  assert.equal(door.status, 200, `refused their own reserved seat: ${JSON.stringify(door.body)}`);
  assert.equal(door.body.role, 'member', 'admitted at the role the owner invited them with');
  assert.equal(await activeMembers(owner.orgId), 2);
  assert.equal(await count(
    `SELECT COUNT(*)::int AS n FROM workspace_invites
      WHERE owner_key = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [owner.orgId, x.email.toLowerCase()],
  ), 0, 'the invitation is spent, not left holding a second seat');
  const roster = await as('get', '/api/v1/teams/members', owner, owner.orgId);
  assert.equal(roster.status, 200);
  assert.equal(roster.body.seats.pending, 0);

  // Somebody on the domain WITHOUT an invitation still respects the cap.
  const y = await makePerson('dd-y', { domain });
  const full = await as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, y);
  assert.equal(full.status, 402, JSON.stringify(full.body));
});

// ── 3 ────────────────────────────────────────────────────────────────────────

test('3: every owner of a lapsed team exports the team; a member exports their own workspace, announced', async () => {
  const founder = await makePerson('ex-founder', { plan: 'developer_pro' });
  const co = await makePerson('ex-co');
  const m = await makePerson('ex-member');
  await join(founder.orgId, founder.userId, co, { role: 'owner' });
  await join(founder.orgId, founder.userId, m);
  const teamName = `TEAM roadmap ${uuidv4().slice(0, 6)}`;
  await createProject(co, founder.orgId, teamName);
  const mine = `M own ${uuidv4().slice(0, 6)}`;
  await createProject(m, m.orgId, mine);
  await setOrg(founder.orgId, { subscription_status: 'past_due' });

  for (const ws of [founder.orgId, null]) {
    const exp = await as('get', '/api/v1/context/export', co, ws);
    assert.equal(exp.status, 200, JSON.stringify(exp.body));
    assert.equal(exp.headers['x-deerdawn-workspace-fallback'], undefined, 'an owner is not moved off her team');
    assert.ok(exp.text.includes(teamName), `a co-owner exports the TEAM (header ${ws ? 'set' : 'absent'})`);
  }

  const member = await as('get', '/api/v1/context/export', m, founder.orgId);
  assert.equal(member.status, 200);
  assert.equal(member.headers['x-deerdawn-workspace-fallback'], founder.orgId, 'the fallback is announced');
  assert.ok(member.text.includes(mine), 'a member exports the workspace being served');
  assert.ok(!member.text.includes(teamName), 'not the lapsed team');

  // A team born through POST /teams/workspaces is nobody's users.org_id.
  const creator = await makePerson('ex-creator', { plan: 'developer_pro' });
  const made = await createTeamWorkspaceFixture(creator, 'NewCo');
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const newco = made.body.workspace;
  await setOrg(newco, { plan: 'developer_pro', plan_tier: 'developer_pro', purchased_seats: 5 });
  const newcoProject = `NewCo plan ${uuidv4().slice(0, 6)}`;
  await createProject(creator, newco, newcoProject);
  await setOrg(newco, { subscription_status: 'past_due' });
  const exp = await as('get', '/api/v1/context/export', creator, newco);
  assert.equal(exp.status, 200, JSON.stringify(exp.body));
  assert.ok(exp.text.includes(newcoProject), 'its creator exports it');
});

// ── 4 ────────────────────────────────────────────────────────────────────────

test('4: a viewer can move a project neither into nor out of a team', async () => {
  const owner = await makePerson('vm-owner', { plan: 'developer_pro' });
  const v = await makePerson('vm-viewer');
  await join(owner.orgId, owner.userId, v, { role: 'viewer' });
  const junk = await createProject(v, v.orgId, `V junk ${uuidv4().slice(0, 6)}`);

  const moveIn = await as('post', `/api/v1/teams/projects/${junk}/move`, v, v.orgId).send({ workspace: owner.orgId });
  assert.equal(moveIn.status, 403, JSON.stringify(moveIn.body));
  assert.equal((await q('SELECT owner_key FROM context_projects WHERE project_id = $1', [junk])).rows[0].owner_key, v.orgId);

  // A project they wrote while a member, and were then demoted from.
  const w = await makePerson('vm-demoted');
  await join(owner.orgId, owner.userId, w);
  const theirs = await createProject(w, owner.orgId, `W work ${uuidv4().slice(0, 6)}`);
  await workspace.setMemberRole(owner.orgId, w.userId, 'viewer');
  const moveOut = await as('post', `/api/v1/teams/projects/${theirs}/move`, w, owner.orgId).send({ workspace: w.orgId });
  assert.equal(moveOut.status, 403, JSON.stringify(moveOut.body));
  assert.equal((await q('SELECT owner_key FROM context_projects WHERE project_id = $1', [theirs])).rows[0].owner_key, owner.orgId);

  // A member still moves their own project in.
  const mine = await createProject(w, w.orgId, `W own ${uuidv4().slice(0, 6)}`);
  await workspace.setMemberRole(owner.orgId, w.userId, 'member');
  const ok = await as('post', `/api/v1/teams/projects/${mine}/move`, w, w.orgId).send({ workspace: owner.orgId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// ── 5 ────────────────────────────────────────────────────────────────────────

async function legacySession(ownerKey, projectId) {
  const sid = `claude_code-${uuidv4()}`;
  await q(
    `INSERT INTO context_sessions (session_id, owner_key, user_id, tool, surface_type, project_id, cwd, host, status,
                                   routing_state, match_confidence, created_at, updated_at, last_seen_at)
     VALUES ($1, $2, NULL, 'claude_code', 'cli', $3, '/Users/alice/legacy', 'alices-mac', 'active', $4, 1, NOW(), NOW(), NOW())`,
    [sid, ownerKey, projectId, projectId ? 'matched' : 'global_only'],
  );
  return sid;
}

test('5: a legacy unattributed session is claimable by its project\'s author, not by any teammate', async () => {
  const owner = await makePerson('ls-owner', { plan: 'developer_pro' });
  const a = await makePerson('ls-alice');
  const b = await makePerson('ls-bob');
  const v = await makePerson('ls-viewer');
  await join(owner.orgId, owner.userId, a);
  await join(owner.orgId, owner.userId, b);
  await join(owner.orgId, owner.userId, v, { role: 'viewer' });
  const ap = await createProject(a, owner.orgId, `A personal ${uuidv4().slice(0, 6)}`);
  await setVisibility(a, owner.orgId, ap, 'personal');

  const sid = await legacySession(owner.orgId, ap);
  for (const other of [b, owner]) {
    const res = await as('patch', `/api/v1/context/sessions/${sid}`, other, owner.orgId).send({ status: 'active' });
    assert.equal(res.status, 404, `${other.label} claimed a colleague's legacy session: ${JSON.stringify(res.body)}`);
  }
  const row = (await q('SELECT user_id, cwd FROM context_sessions WHERE session_id = $1', [sid])).rows[0];
  assert.equal(row.user_id, null, 'nobody else stamped themselves onto it');

  const flush = await as('post', '/api/v1/context/extraction', a, owner.orgId).send({
    session_id: sid, tool: 'claude_code', chunks: [{ role: 'user', text: 'A on her legacy session' }],
    extraction: {
      match_decision: 'matched_existing', confidence: 0.95, delta: { current_task: 'A legacy task' },
      should_create_project: false, needs_user_confirmation: false,
    },
  });
  assert.equal(flush.status, 202, `its author uses it: ${flush.status} ${JSON.stringify(flush.body)}`);
  assert.equal((await q('SELECT user_id FROM context_sessions WHERE session_id = $1', [sid])).rows[0].user_id, a.userId);

  // Unbound, it names no author: anybody who can write the workspace claims it
  // (a viewer writes no session at all).
  const loose = await legacySession(owner.orgId, null);
  const byViewer = await as('patch', `/api/v1/context/sessions/${loose}`, v, owner.orgId).send({ status: 'active' });
  assert.notEqual(byViewer.status, 200, JSON.stringify(byViewer.body));
  const byMember = await as('patch', `/api/v1/context/sessions/${loose}`, b, owner.orgId).send({ status: 'active' });
  assert.equal(byMember.status, 200, JSON.stringify(byMember.body));
});

// ── 6 ────────────────────────────────────────────────────────────────────────

test('6: seats cut below the outstanding invitations still let an invitee take a free seat; sending still reserves', async () => {
  const owner = await makePerson('sc-owner', { plan: 'developer_pro', seats: 4 });
  const a = await makePerson('sc-a');
  const b = await makePerson('sc-b');
  const ia = await workspace.createInvite(owner.orgId, a.email, { role: 'member', invitedBy: owner.userId });
  const ib = await workspace.createInvite(owner.orgId, b.email, { role: 'member', invitedBy: owner.userId });
  await setOrg(owner.orgId, { purchased_seats: 2 });

  const ra = await as('post', '/api/v1/teams/invite/accept', a).send({ token: ia.token });
  assert.equal(ra.status, 200, `the free seat was refused: ${JSON.stringify(ra.body)}`);
  const rb = await as('post', '/api/v1/teams/invite/accept', b).send({ token: ib.token });
  assert.equal(rb.status, 409, 'the second invitee finds the team full');
  assert.equal(rb.body.error, 'workspace_not_accepting_members');
  assert.equal(await activeMembers(owner.orgId), 2, 'never over the seats');

  // Sending an invitation is where a seat is reserved: active + pending.
  const team = await makePerson('sc-team', { plan: 'developer_pro', seats: 3 });
  const one = await as('post', '/api/v1/teams/invite', team, team.orgId).send({ email: `p1-${uuidv4().slice(0, 6)}@x.test`, role: 'member' });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  const two = await as('post', '/api/v1/teams/invite', team, team.orgId).send({ email: `p2-${uuidv4().slice(0, 6)}@x.test`, role: 'member' });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  const three = await as('post', '/api/v1/teams/invite', team, team.orgId).send({ email: `p3-${uuidv4().slice(0, 6)}@x.test`, role: 'member' });
  assert.equal(three.status, 402, `sending past the reservations: ${JSON.stringify(three.body)}`);
});
