/**
 * SCAN 19 — TEAMS (A).
 *
 *   1. The knowledge graph ignored the per-section share policy. An owner who
 *      withheld recent_decisions from a shared project saw the brief say "Not
 *      shared with you: decisions", and the line under it — the Knowledge web —
 *      print the withheld decision to every teammate. The same nodes reached them
 *      through /graph/*, both exports, the Trail, workspace/entities and recall.
 *   2. The sole owner of a team with other members could delete their account
 *      (DELETE /api/v1/orgs, or DELETE /context/account) and leave the team with
 *      no owner over a live subscription nobody could reach the portal to cancel.
 *   3. Two co-owners demoting or removing each other at the same moment both
 *      passed the last-owner check, which ran outside the membership lock, and
 *      left the workspace with zero owners.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan19-teams-a.test.js
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
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const graph = require('../../src/services/contextGraphService');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makeOrg(label, plan) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  return orgId;
}

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = await makeOrg(label, plan);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

async function mintKey(person, orgId, scopes) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), scopes],
  );
  return key;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
async function mcp(key, name, args) {
  const res = await request(httpServer).post('/mcp').set(MCP_HEADERS).set('Authorization', `Bearer ${key}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return JSON.stringify(body);
}

async function createProject(person, ws, name) {
  const res = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name });
  assert.equal(res.status, 201, `project create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.project.project_id;
}

async function share(person, ws, projectId, sections) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send({ visibility: 'shared', sections });
  assert.equal(res.status, 200, `sharing: ${res.status} ${JSON.stringify(res.body)}`);
}

// What deriveEntities / recordGraphArtifacts writes on an extraction: a root, a
// node per decision / stack item / task, edges from the root, and evidence whose
// excerpt is the raw transcript chunk.
async function writeGraph(ownerKey, projectId, { task, stack = [], decision, chunk }) {
  const project = await store.getProject(ownerKey, projectId);
  project.context.current_task = task;
  project.context.tech_stack = stack;
  project.context.recent_decisions = decision ? [{ summary: decision, decided_at: new Date().toISOString() }] : [];
  await graph.recordGraphArtifacts({
    ownerKey,
    project,
    session: { session_id: `s-${uuidv4()}`, tool: 'claude_code' },
    input: { chunks: [{ role: 'user', text: chunk || decision || task }] },
  });
}

async function seedNode(ownerKey, projectId, nodeType, title) {
  const now = new Date().toISOString();
  const node = await store.upsertGraphNode({
    node_id: `graph_node_${uuidv4()}`, owner_key: ownerKey, project_id: projectId, node_type: nodeType,
    canonical_key: `${nodeType}:${uuidv4()}`, title, summary: title,
    metadata: { entity_type: nodeType, scope: 'project' }, confidence: 0.9, source_tool: 'claude_code',
    created_at: now, updated_at: now, last_seen_at: now,
  });
  await store.addGraphEvidence({
    evidence_id: `ev_${uuidv4()}`, owner_key: ownerKey, project_id: projectId, session_id: 's', node_id: node.node_id,
    edge_id: null, tool: 'claude_code', excerpt: title, metadata: {}, confidence: 0.8, created_at: now,
  });
  return node;
}

const has = (text, marker) => String(text).toLowerCase().includes(String(marker).toLowerCase());

// ── 1 ────────────────────────────────────────────────────────────────────────

test('1: a section the share withholds is withheld from the knowledge graph on every surface', async () => {
  const tag = uuidv4().slice(0, 6);
  const HIDDEN_DEC = `HIDDENDEC${tag}`;
  const HIDDEN_STACK = `hiddenstack${tag}`;
  const HIDDEN_Q = `HIDDENQ${tag}`;
  const VIS_TASK = `VISTASK${tag}`;
  const VIS_DEC = `VISDEC${tag}`;

  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  const V = await makePerson('viewer');
  await join(O, M);
  await join(O, V, 'viewer');
  const T = O.orgId;

  // P1: decisions withheld explicitly; the task travels. tech_stack is not granted.
  const P1 = await createProject(O, T, `Ledger ${tag}`);
  await share(O, T, P1, [
    { section_key: 'current_status', can_view: true },
    { section_key: 'current_task', can_view: true },
    { section_key: 'recent_decisions', can_view: false },
  ]);
  await writeGraph(T, P1, {
    task: `${VIS_TASK} ship the ledger export`,
    stack: [HIDDEN_STACK],
    decision: `Decided: ${HIDDEN_DEC} we will lay off the payments team in Q4`,
  });
  // P2: decisions travel, questions are withheld.
  const P2 = await createProject(O, T, `Atlas ${tag}`);
  await share(O, T, P2, [
    { section_key: 'recent_decisions', can_view: true },
    { section_key: 'open_questions', can_view: false },
  ]);
  await writeGraph(T, P2, { task: 'atlas task', decision: `Decided: ${VIS_DEC} keep the atlas API`, chunk: 'atlas chat' });
  await seedNode(T, P2, 'question', `${HIDDEN_Q} do we sell the atlas unit?`);

  const hidden = [HIDDEN_DEC, HIDDEN_STACK, HIDDEN_Q];
  for (const reader of [M, V]) {
    const key = await mintKey(reader, T, reader === V ? ['context:read'] : ['context:read', 'context:write']);
    const seen = {};
    const get = async (path) => { const r = await as('get', path, reader, T); seen[path] = `${r.status} ${JSON.stringify(r.body)}${r.text || ''}`; };
    await get(`/api/v1/context/graph/projects/${P1}`);
    await get(`/api/v1/context/graph/projects/${P2}`);
    await get('/api/v1/context/graph/export');
    await get(`/api/v1/context/projects/${P1}/trail`);
    await get(`/api/v1/context/projects/${P2}/trail`);
    await get('/api/v1/context/export?format=json');
    await get('/api/v1/context/export?format=markdown');
    await get('/api/v1/context/workspace/entities?limit=50');
    const post = async (path, body) => { const r = await as('post', path, reader, T).send(body); seen[`POST ${path}`] = JSON.stringify(r.body); };
    await post('/api/v1/context/graph/query', { project_id: P1 });
    seen['mcp:recall context P1'] = await mcp(key, 'recall', { action: 'context', project_id: P1 });
    seen['mcp:recall entities'] = await mcp(key, 'recall', { action: 'entities' });
    seen['mcp:recall entities P2'] = await mcp(key, 'recall', { action: 'entities', project_id: P2 });
    seen['mcp:recall search'] = await mcp(key, 'recall', { action: 'search', query: 'lay off payments team' });
    if (reader === M) {
      seen['mcp:start_session P1'] = await mcp(key, 'start_session', { project_id: P1 });
      seen['mcp:export_trail P1'] = await mcp(key, 'manage_memory', { action: 'export_trail', project_id: P1 });
    }
    // Case-insensitive: graph titles are re-cased on write ("Hiddenstack…").
    for (const [surface, text] of Object.entries(seen)) {
      for (const marker of hidden) {
        assert.ok(!has(text, marker), `${reader.label} must not read ${marker} on ${surface}`);
      }
    }
    // Not vacuous: the reads answered with this project.
    if (reader === M) {
      assert.ok(seen['mcp:start_session P1'].includes(`Ledger ${tag}`), 'start_session briefed P1');
      assert.ok(!seen['mcp:export_trail P1'].includes('"isError":true'), `export_trail answered: ${seen['mcp:export_trail P1'].slice(0, 300)}`);
    }
    assert.ok(seen[`/api/v1/context/projects/${P1}/trail`].startsWith('200'), 'the Trail export answered');
    assert.ok(seen[`/api/v1/context/projects/${P1}/trail`].toLowerCase().includes(VIS_TASK.toLowerCase()), 'and its graph still carries the shared task');
    // What the share grants still travels.
    assert.ok(has(seen[`/api/v1/context/graph/projects/${P1}`], VIS_TASK), `${reader.label}: P1's shared task stays in its graph`);
    assert.ok(has(seen[`/api/v1/context/graph/projects/${P2}`], VIS_DEC), `${reader.label}: P2's shared decision stays in its graph`);
    assert.ok(has(seen['/api/v1/context/graph/export'], VIS_DEC), `${reader.label}: and in the export`);
  }

  // The author reads everything they wrote.
  const own = JSON.stringify((await as('get', `/api/v1/context/graph/projects/${P1}`, O, T)).body);
  assert.ok(has(own, HIDDEN_DEC) && has(own, HIDDEN_STACK), 'the author is unaffected');
  const ownQ = JSON.stringify((await as('get', `/api/v1/context/graph/projects/${P2}`, O, T)).body);
  assert.ok(has(ownQ, HIDDEN_Q), 'the author reads their own question');
});

test('1b: a project shared with its defaults hides the non-default sections, and a solo account is untouched', async () => {
  const tag = uuidv4().slice(0, 6);
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  await join(O, M);
  const T = O.orgId;
  const P = await createProject(O, T, `Defaults ${tag}`);
  await as('patch', `/api/v1/teams/projects/${P}/sharing`, O, T).send({ visibility: 'shared' });
  await writeGraph(T, P, { task: `DEFTASK${tag}`, stack: [`defstack${tag}`], decision: `Decided: DEFDEC${tag}` });
  const seen = JSON.stringify((await as('get', `/api/v1/context/graph/projects/${P}`, M, T)).body);
  assert.ok(has(seen, `DEFDEC${tag}`) && has(seen, `DEFTASK${tag}`), 'default sections (decisions, task) travel');
  assert.ok(!has(seen, `defstack${tag}`), 'tech_stack is not a default section, so its nodes and edges stay home');

  const S = await makePerson('solo', { plan: 'developer_pro' });
  const SP = await createProject(S, null, `Solo ${tag}`);
  await writeGraph(S.orgId, SP, { task: 'solo task', stack: [`solostack${tag}`], decision: `Decided: SOLODEC${tag}` });
  const solo = JSON.stringify((await as('get', `/api/v1/context/graph/projects/${SP}`, S)).body);
  assert.ok(has(solo, `SOLODEC${tag}`) && has(solo, `solostack${tag}`), 'a solo account reads its whole graph');
});

// ── 2 ────────────────────────────────────────────────────────────────────────

async function createdTeam(founder, name) {
  const res = await createTeamWorkspaceFixture(founder, name);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const T = res.body.workspace;
  await q(
    `UPDATE organizations SET plan = 'developer_pro', plan_tier = 'developer_pro', purchased_seats = 5,
            stripe_subscription_id = $2 WHERE org_id = $1`,
    [T, `sub_${uuidv4().replace(/-/g, '')}`],
  );
  await invalidateOrgCache(T);
  return T;
}

const activeOwners = async (T) => Number((await q(
  'SELECT COUNT(*)::int AS n FROM workspace_members WHERE owner_key = $1 AND removed_at IS NULL AND role IN (\'owner\', \'admin\')',
  [T],
)).rows[0].n);

test('2: the sole owner of a team with members cannot delete their account through either route', async () => {
  const P = await makePerson('founder');
  const T = await createdTeam(P, `Created team ${uuidv4().slice(0, 6)}`);
  const M = await makePerson('mate');
  await join({ orgId: T, userId: P.userId }, M);

  const orgs = await as('delete', '/api/v1/orgs', P).send({ password: 'password123' });
  assert.equal(orgs.status, 409, JSON.stringify(orgs.body));
  assert.equal(orgs.body.error, 'sole_owner');
  assert.deepEqual(orgs.body.workspaces.map((w) => w.id), [T], 'names the workspace it would orphan');
  assert.ok(orgs.body.workspaces[0].name.startsWith('Created team'));

  const account = await as('delete', '/api/v1/context/account', P, P.orgId).send({ confirmation: 'DELETE MY DEERDAWN ACCOUNT' });
  assert.equal(account.status, 409, JSON.stringify(account.body));
  assert.equal(account.body.error, 'sole_owner');
  assert.equal(await activeOwners(T), 1, 'the team still has its owner');
  assert.equal((await q('SELECT 1 FROM users WHERE user_id = $1', [P.userId])).rows.length, 1, 'and the account still exists');

  // With a co-owner, the gate does not fire (the confirmation check is next).
  await as('patch', `/api/v1/teams/members/${M.userId}`, P, T).send({ role: 'owner' });
  const past = await as('delete', '/api/v1/context/account', P, P.orgId).send({ confirmation: 'nope' });
  assert.equal(past.status, 400, JSON.stringify(past.body));
  assert.equal(past.body.error, 'confirmation_required');
});

test('2b: a co-owner who removed the founder cannot then delete their account and orphan the team', async () => {
  const O = await makePerson('founder', { plan: 'developer_pro' });
  const M = await makePerson('coowner');
  await join(O, M);
  const T = O.orgId;
  assert.equal((await as('patch', `/api/v1/teams/members/${M.userId}`, O, T).send({ role: 'owner' })).status, 200);
  assert.equal((await as('delete', `/api/v1/teams/members/${O.userId}`, M, T)).status, 200);
  const V = await makePerson('viewer');
  await join({ orgId: T, userId: M.userId }, V, 'viewer');

  const del = await as('delete', '/api/v1/orgs', M).send({ password: 'password123' });
  assert.equal(del.status, 409, JSON.stringify(del.body));
  assert.equal(del.body.error, 'sole_owner');
  assert.equal(await activeOwners(T), 1);
});

test('2c: a solo account, and an owner whose team has nobody else in it, still delete', async () => {
  const S = await makePerson('solo');
  const res = await as('delete', '/api/v1/context/account', S, S.orgId).send({ confirmation: 'DELETE MY DEERDAWN ACCOUNT' });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const P = await makePerson('alone');
  await createdTeam(P, `Empty team ${uuidv4().slice(0, 6)}`);
  const orgs = await as('delete', '/api/v1/orgs', P).send({ password: 'password123' });
  assert.notEqual(orgs.body.error, 'sole_owner', JSON.stringify(orgs.body));
});

// ── 3 ────────────────────────────────────────────────────────────────────────

async function coOwners(label) {
  const O = await makePerson(`${label}o`, { plan: 'developer_pro' });
  const M = await makePerson(`${label}m`);
  await join(O, M);
  const pr = await as('patch', `/api/v1/teams/members/${M.userId}`, O, O.orgId).send({ role: 'owner' });
  assert.equal(pr.status, 200);
  return { O, M, T: O.orgId };
}

test('3: two owners demoting each other at once leave one owner, every time', async () => {
  for (let i = 0; i < 4; i += 1) {
    const { O, M, T } = await coOwners(`d${i}`);
    const [a, b] = await Promise.all([
      as('patch', `/api/v1/teams/members/${M.userId}`, O, T).send({ role: 'member' }),
      as('patch', `/api/v1/teams/members/${O.userId}`, M, T).send({ role: 'member' }),
    ]);
    assert.equal(await activeOwners(T), 1, `run ${i}: ${a.status}/${b.status}`);
    // One lands; the other is refused — 409 last_owner, or 403 when the
    // demotion already landed before the second caller's role was read.
    const statuses = [a.status, b.status].sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1, `run ${i}: exactly one demotion lands (${statuses})`);
    assert.ok(statuses.includes(409) || statuses.includes(403), `run ${i}: the other is refused (${statuses})`);
  }
});

test('3b: two owners removing each other at once leave one owner, every time', async () => {
  for (let i = 0; i < 4; i += 1) {
    const { O, M, T } = await coOwners(`r${i}`);
    const [a, b] = await Promise.all([
      as('delete', `/api/v1/teams/members/${M.userId}`, O, T),
      as('delete', `/api/v1/teams/members/${O.userId}`, M, T),
    ]);
    assert.equal(await activeOwners(T), 1, `run ${i}: ${a.status} ${a.body.error || ''} / ${b.status} ${b.body.error || ''}`);
    const active = Number((await q('SELECT COUNT(*)::int AS n FROM workspace_members WHERE owner_key = $1 AND removed_at IS NULL', [T])).rows[0].n);
    assert.equal(active, 1, `run ${i}: exactly one person remains`);
  }
});

test('3c: the service refuses to demote the last owner even when called directly', async () => {
  const O = await makePerson('lone', { plan: 'developer_pro' });
  await assert.rejects(() => workspace.setMemberRole(O.orgId, O.userId, 'member'), (err) => err.code === 'last_owner');
  assert.equal(await activeOwners(O.orgId), 1);
});
