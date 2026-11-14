/**
 * SCAN 17 — MEDIUMS (A): THE API HALF.
 *
 *   1. POST /graph/nodes upserts on (owner, type, key-from-title), and owner_key
 *      is the WORKSPACE. A member filing a node whose title matched a node on a
 *      colleague's PERSONAL project landed on the colleague's row: the 201
 *      returned its summary, id and project, and the metadata merged into it.
 *      Only the project the caller NAMED was ever judged.
 *   4. Project roots are keyed `project:<id>` since round 16, so
 *      upsert_entities {title: "Atlas", entity_type: "project"} minted a second
 *      "Atlas" node beside the root, and a relation to `project:atlas` was
 *      dropped — the hosted reply counted only the ones that landed.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan17-mediums.test.js
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
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const graph = require('../../src/services/contextGraphService');

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

async function createProject(person, ws, name, visibility = null) {
  const res = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name });
  assert.equal(res.status, 201, `project create: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.project.project_id;
  if (visibility) {
    const vis = await as('patch', `/api/v1/teams/projects/${id}/sharing`, person, ws).send({ visibility });
    assert.equal(vis.status, 200, `sharing ${visibility}: ${vis.status} ${JSON.stringify(vis.body)}`);
  }
  return id;
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
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { isError: Boolean(body.result?.isError || body.error), text };
}

async function seedRoot(ownerKey, projectId, name) {
  const now = new Date().toISOString();
  return store.upsertGraphNode({
    node_id: `graph_node_${uuidv4()}`,
    owner_key: ownerKey,
    project_id: projectId,
    node_type: 'project',
    canonical_key: graph.projectRootKey(projectId),
    title: name,
    summary: '',
    metadata: { project_id: projectId, tech_stack: [] },
    confidence: 1,
    source_session_id: 'seed',
    source_tool: 'test',
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });
}

async function nodeRow(nodeId) {
  return (await q('SELECT project_id, title, summary, metadata FROM context_graph_nodes WHERE node_id = $1', [nodeId])).rows[0];
}

// ── 1 ────────────────────────────────────────────────────────────────────────

test('1: POST /graph/nodes never lands on — or returns — a colleague\'s hidden node of the same title', async () => {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('mia');
  const J = await makePerson('jay');
  await join(O, M);
  await join(O, J);
  const T = O.orgId;
  const marker = `MK${uuidv4().slice(0, 8)}`;
  const personal = await createProject(M, T, `Mia side ${uuidv4().slice(0, 6)}`, 'personal');
  const jShared = await createProject(J, T, `Jay shared ${uuidv4().slice(0, 6)}`);

  const mine = await as('post', '/api/v1/context/graph/nodes', M, T)
    .send({ project_id: personal, node_type: 'service', title: 'ledger-svc', summary: `${marker} my private notes about this service` });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const mNodeId = mine.body.node.node_id;
  const before = await nodeRow(mNodeId);

  // Filed under a project J may write, and workspace-scoped: both collide on the key.
  for (const body of [
    { project_id: jShared, node_type: 'service', title: 'ledger-svc', summary: 'x' },
    { node_type: 'service', title: 'ledger-svc', summary: 'y' },
  ]) {
    const res = await as('post', '/api/v1/context/graph/nodes', J, T).send({ ...body, metadata: { planted: true } });
    assert.equal(res.status, 404, `refused like upsert_entities' exact-key refusal: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: 'node_not_found' });
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(marker), 'nothing of the hidden row is returned');
    assert.ok(!text.includes(mNodeId) && !text.includes(personal), 'neither its id nor its project');
  }

  const after = await nodeRow(mNodeId);
  assert.deepEqual(after, before, 'the colleague\'s row is untouched: no merged metadata, no replaced summary');
  assert.equal(after.metadata.planted, undefined);
});

test('1: a collision with a node the caller CAN see still upserts as before', async () => {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('mia');
  await join(O, M);
  const T = O.orgId;
  const shared = await createProject(O, T, `Team core ${uuidv4().slice(0, 6)}`);
  // A `service` node is the tech_stack section (scan 19), which the default
  // share does not carry — so the share has to grant it for M to SEE the node.
  const sections = ['current_task', 'current_status', 'recent_decisions', 'todo_items', 'tech_stack']
    .map((section_key) => ({ section_key, can_view: true, can_edit: true }));
  const opened = await as('patch', `/api/v1/teams/projects/${shared}/sharing`, O, T).send({ visibility: 'shared', sections });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));

  const first = await as('post', '/api/v1/context/graph/nodes', O, T)
    .send({ project_id: shared, node_type: 'service', title: 'billing-engine', summary: 'short' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await as('post', '/api/v1/context/graph/nodes', M, T)
    .send({ project_id: shared, node_type: 'service', title: 'billing-engine', summary: 'Invoices and dunning for every customer on the team plan', metadata: { owner_team: 'payments' } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.node.node_id, first.body.node.node_id, 'the same row, as the upsert always did');
  assert.equal(again.body.node.metadata.owner_team, 'payments');

  // A solo account re-filing its own node is the ordinary case.
  const S = await makePerson('solo', { plan: 'developer_pro' });
  const p = await createProject(S, null, `Solo ${uuidv4().slice(0, 6)}`);
  const a = await as('post', '/api/v1/context/graph/nodes', S).send({ project_id: p, node_type: 'service', title: 'queue-worker' });
  const b = await as('post', '/api/v1/context/graph/nodes', S).send({ node_type: 'service', title: 'queue-worker' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.node.node_id, a.body.node.node_id);
});

// ── 4 ────────────────────────────────────────────────────────────────────────

test('4: a `project` entity and a `project:<name>` relation resolve to the project\'s root, and misses are named', async () => {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const key = await mintKey(O, O.orgId, ['context:read', 'context:write']);
  const pid = await createProject(O, null, 'Atlas');
  const root = await seedRoot(O.orgId, pid, 'Atlas');

  const res = await mcp(key, 'manage_memory', {
    action: 'upsert_entities',
    project_id: pid,
    entities: [
      { title: 'Atlas', entity_type: 'project', summary: 'Atlas is the payments platform for payouts' },
      { title: 'Ledger', entity_type: 'service', summary: 'Double-entry ledger service that books every payout and refund' },
    ],
    relations: [
      { from_canonical_key: 'service:ledger', to_canonical_key: 'project:atlas', relation_type: 'part_of' },
      { from_canonical_key: 'service:ledger', to_canonical_key: 'project:nowhere', relation_type: 'depends_on' },
    ],
  });
  assert.equal(res.isError, false, res.text);

  const projectNodes = (await q(
    'SELECT node_id, canonical_key FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'project\'',
    [O.orgId],
  )).rows;
  assert.deepEqual(projectNodes.map((n) => n.canonical_key), [graph.projectRootKey(pid)], 'no second "Atlas" node beside the root');

  const edges = (await q(
    'SELECT from_node_id, to_node_id, edge_type FROM context_graph_edges WHERE owner_key = $1 AND edge_type = $2',
    [O.orgId, 'part_of'],
  )).rows;
  assert.equal(edges.length, 1, 'the relation to project:atlas was recorded');
  assert.equal(edges[0].to_node_id, root.node_id, 'on the root');

  assert.match(res.text, /Recorded 1 relation\./);
  assert.match(res.text, /Did not record 1 relation: service:ledger depends_on project:nowhere \(project:nowhere: no such entity you can see\)/);

  // Named by id works too, even through a canonical_key (normalizeKey folds `_`).
  const byId = await mcp(key, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ title: 'Atlas platform', entity_type: 'project', canonical_key: `project:${pid}`, summary: 'Atlas owns payouts, refunds and the ledger' }],
  });
  assert.equal(byId.isError, false, byId.text);
  const after = (await q('SELECT count(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'project\'', [O.orgId])).rows[0].n;
  assert.equal(after, 1);
  assert.equal((await nodeRow(root.node_id)).title, 'Atlas', 'the root keeps the project\'s name as its title');
});

test('4: the REST route reports unresolved relations too, and an ambiguous project name is refused with the way out', async () => {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('mia');
  await join(O, M);
  const T = O.orgId;
  const shared = await createProject(O, T, 'Orion');
  // M sees both the team's Orion and her own personal one. Creation refuses a
  // duplicate name, but a project moved in from a personal workspace (or one
  // predating the team) arrives with whatever name it had — set it directly.
  const mine = await createProject(M, T, `Orion ${uuidv4().slice(0, 6)}`, 'personal');
  await q('UPDATE context_projects SET project_name = $1 WHERE project_id = $2', ['Orion', mine]);
  // Workspace-scoped: since scan 21 a member may not file a NEW service under
  // Orion, whose default share withholds tech_stack (she could never read it
  // back). This test is about relation reporting, not where the node lives.
  const rest = await as('post', '/api/v1/context/workspace/entities', M, T).send({
    entities: [{ title: 'Relay', entity_type: 'service', summary: 'Message relay between the payment rails and the ledger' }],
    relations: [{ from_canonical_key: 'service:relay', to_canonical_key: 'project:ghost', relation_type: 'part_of' }],
  });
  assert.equal(rest.status, 200, JSON.stringify(rest.body));
  assert.equal(rest.body.relations.length, 0);
  assert.deepEqual(rest.body.unresolved_relations[0].unresolved, [{ key: 'project:ghost', reason: 'not_found' }]);

  await seedRoot(T, shared, 'Orion');
  const amb = await as('post', '/api/v1/context/workspace/entities', M, T).send({
    entities: [{ title: 'Orion', entity_type: 'project', summary: 'Orion runs the settlement batch every night' }],
  });
  assert.equal(amb.status, 400, JSON.stringify(amb.body));
  assert.equal(amb.body.error, 'workspace_entity_project_ambiguous');
  assert.match(amb.body.message, /project:<project_id>/);
  const orionNodes = (await q(
    'SELECT canonical_key FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'project\'',
    [T],
  )).rows;
  assert.deepEqual(orionNodes.map((n) => n.canonical_key), [graph.projectRootKey(shared)], 'nothing minted on a guess');

  // And a relation to the ambiguous name says so rather than picking one.
  // Workspace-scoped for the reason given above.
  const rel = await as('post', '/api/v1/context/workspace/entities', M, T).send({
    entities: [{ title: 'Relay two', entity_type: 'service', summary: 'Second message relay between the payment rails and the ledger' }],
    relations: [{ from_canonical_key: 'service:relay-two', to_canonical_key: 'project:orion', relation_type: 'part_of' }],
  });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  assert.deepEqual(rel.body.unresolved_relations[0].unresolved, [{ key: 'project:orion', reason: 'ambiguous_project_name' }]);
});
