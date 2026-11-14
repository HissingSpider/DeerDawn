/**
 * /api/v1/context/graph/* was the hole the visibility column was supposed to close.
 *
 * PR #479 made graph NODES inherit the visibility of the projects they were seen
 * in, but only on the paths that surface them in a brief, a recall result or the
 * portfolio. The graph ENDPOINTS were untouched, and every one of them resolved
 * nothing but `owner_key` — which in a shared workspace is the SAME VALUE for
 * every member. So a viewer could read a colleague's `personal` project graph by
 * id: its nodes, its edges, and its evidence, which carries verbatim transcript
 * excerpts. Hiding the brief while serving the transcript it was extracted from
 * hides nothing.
 *
 * And the write routes (POST/PATCH/DELETE /graph/nodes) were gated on
 * requireContextWrite — a SCOPE check. context:write is derived from users.role
 * and every Clerk session in the workspace holds it, so it separated nobody from
 * anybody: a VIEWER could rewrite or permanently delete another person's memory.
 *
 * Refusals are not_found for anything invisible, never 403: naming the refusal
 * confirms the project exists and that somebody is working on it, which is most
 * of what `personal` protects. 403 (share_write_forbidden) is for something the
 * caller can already SEE and may not change — there is no existence left to hide.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/graph-endpoint-visibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const ALICE = `user-graphep-alice-${RUN}`;
const BOB = `user-graphep-bob-${RUN}`;
const VERA = `user-graphep-vera-${RUN}`;

// Alice owns the workspace, Bob is a member, Vera is a viewer. All three carry
// context:write / context:admin scopes, because that is exactly the point: the
// scope is derived from the org role and tells you nothing about the workspace.
const SCOPES = ['context:read', 'context:write', 'context:admin'];
const alice = () => ({ type: 'user', id: ALICE, org_id: ORG, workspace_key: ORG, role: 'admin', scopes: SCOPES });
const bob = () => ({ type: 'user', id: BOB, org_id: ORG, workspace_key: ORG, role: 'admin', scopes: SCOPES });
const vera = () => ({ type: 'user', id: VERA, org_id: ORG, workspace_key: ORG, role: 'admin', scopes: SCOPES });

const now = () => new Date().toISOString();

// Mount the router with the actor injected, so these exercise the ROUTES
// (status codes, the export renderer, the vault-health SQL) and not only the
// service functions underneath them.
let currentActor = alice;
// requireAuth is applied with router.use() inside the router itself, so it is
// replaced on the middleware module BEFORE the router is required.
const auth = require('../../src/middleware/auth');
auth.requireAuth = (req, _res, next) => { req.actor = currentActor(); next(); };
const app = express();
app.use(express.json());
app.use('/api/v1/context', require('../../src/routes/context/context-sync'));
app.use((err, _req, res, _next) => res.status(err?.status || 500).json({ error: err?.message || 'internal_error' }));
const httpServer = app.listen(0);
const as = (who, fn) => { currentActor = who; return fn(request(httpServer)); };

let personalProject;   // Alice's, visibility 'personal' — hers alone
let privateProject;    // Alice's, visibility 'private' — hers + the workspace OWNER
let sharedProject;     // Alice's, shared with the workspace
let secretNode;        // lives only in the personal project
let crossNode;         // personal project, but also SEEN in the shared one
let sharedNode;        // shared project
let neighbourNode;     // shared project, on the far end of a visible edge
let workspaceNode;     // no project at all
let aliceSession;

async function seedNode({ title, projectId, evidenceProjectIds = [], scope = 'project', excerpt }) {
  const node = await store.upsertGraphNode({
    node_id: `graph_node_${crypto.randomUUID()}`,
    owner_key: ORG,
    project_id: projectId,
    node_type: 'knowledge',
    canonical_key: `knowledge:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    summary: `${title} summary long enough to survive the graph node summary rules`,
    metadata: { entity_type: 'knowledge', scope, importance: 'high', status: 'active' },
    confidence: 0.9,
    source_session_id: '',
    source_tool: 'claude_code',
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });
  for (const pid of [...(projectId ? [projectId] : []), ...evidenceProjectIds]) {
    await store.addGraphEvidence({
      evidence_id: `graph_ev_${crypto.randomUUID()}`,
      owner_key: ORG,
      project_id: pid,
      session_id: `sess-${RUN}`,
      node_id: node.node_id,
      tool: 'claude_code',
      excerpt: pid === projectId && excerpt ? excerpt : `${title} seen here`,
      metadata: {},
      confidence: 0.9,
      created_at: now(),
    });
  }
  return node;
}

async function seedEdge(fromNodeId, toNodeId, summary) {
  return store.upsertGraphEdge({
    edge_id: `graph_edge_${crypto.randomUUID()}`,
    owner_key: ORG,
    project_id: null,
    edge_type: 'supports',
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    summary,
    metadata: {},
    confidence: 0.9,
    source_session_id: '',
    source_tool: 'claude_code',
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });
}

async function setVisibility(projectId, visibility) {
  const row = await store.getProject(ORG, projectId);
  await store.saveProject({ ...row, visibility }, null);
}

test.before(async () => {
  await workspace.addMember(ORG, ALICE, { role: 'owner' });
  await workspace.addMember(ORG, BOB, { role: 'member' });
  await workspace.addMember(ORG, VERA, { role: 'viewer' });

  personalProject = await service.createProject(alice(), { project_name: `GraphEpPersonal ${RUN}` });
  privateProject = await service.createProject(alice(), { project_name: `GraphEpPrivate ${RUN}` });
  sharedProject = await service.createProject(alice(), { project_name: `GraphEpShared ${RUN}` });
  await setVisibility(personalProject.project_id, 'personal');
  await setVisibility(privateProject.project_id, 'private');
  await setVisibility(sharedProject.project_id, 'shared');

  secretNode = await seedNode({
    title: `Acquisition target ${RUN}`,
    projectId: personalProject.project_id,
    excerpt: `TRANSCRIPT ${RUN}: we are buying Northwind in Q1, do not tell the team`,
  });
  crossNode = await seedNode({
    title: `Queue choice seen in both ${RUN}`,
    projectId: personalProject.project_id,
    evidenceProjectIds: [sharedProject.project_id],
  });
  sharedNode = await seedNode({ title: `Team convention ${RUN}`, projectId: sharedProject.project_id });
  neighbourNode = await seedNode({ title: `Neighbour convention ${RUN}`, projectId: sharedProject.project_id });
  workspaceNode = await seedNode({ title: `Workspace wide rule ${RUN}`, projectId: null, scope: 'workspace' });

  // sharedNode sits between a node the workspace may read and one it may not.
  // Its own graph must carry the first edge and not the second.
  await seedEdge(sharedNode.node_id, neighbourNode.node_id, `Team convention supports Neighbour convention ${RUN}`);
  await seedEdge(sharedNode.node_id, secretNode.node_id, `Team convention supports Acquisition target ${RUN}`);

  aliceSession = `sess_graphep_${crypto.randomUUID()}`;
  await store.saveSession({
    session_id: aliceSession,
    owner_key: ORG,
    user_id: ALICE,
    tool: 'claude_code',
    surface_type: 'cli',
    project_id: personalProject.project_id,
    conversation_ref: '',
    cwd: `/Users/alice/secret-${RUN}`,
    host: `alice-laptop-${RUN}`,
    tab_id: '',
    status: 'active',
    routing_state: 'matched',
    match_confidence: 1,
    created_at: now(), updated_at: now(), last_seen_at: now(),
  });
});

test.after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  for (const table of [
    'context_graph_evidence', 'context_graph_edges', 'context_graph_nodes',
    'context_sessions', 'context_projects', 'workspace_members',
  ]) {
    try { await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [ORG], 'org-system'); } catch (_) { /* best effort */ }
  }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

// ─── Reads ───────────────────────────────────────────────────────────────────

test('a teammate cannot pull a personal project graph by id', async () => {
  const ok = await as(alice, (r) => r.get(`/api/v1/context/graph/projects/${personalProject.project_id}`));
  assert.strictEqual(ok.status, 200, 'precondition: its author reads her own graph');
  assert.ok(JSON.stringify(ok.body).includes('Acquisition target'), 'precondition: the node is there to leak');

  for (const [name, who] of [['member', bob], ['viewer', vera]]) {
    const res = await as(who, (r) => r.get(`/api/v1/context/graph/projects/${personalProject.project_id}`));
    assert.strictEqual(res.status, 404, `${name} must not read a personal project graph`);
    assert.strictEqual(res.body.error, 'project_not_found', `${name} is told not_found, never forbidden`);
  }
});

test('a workspace OWNER reads a private project graph and a member does not', async () => {
  // 'private' is org-owned but unshared: the owner may read it (continuity when
  // somebody leaves), a member may not. Same line canViewProjectForActor draws.
  const owner = await as(alice, (r) => r.get(`/api/v1/context/graph/projects/${privateProject.project_id}`));
  assert.strictEqual(owner.status, 200);
  const member = await as(bob, (r) => r.get(`/api/v1/context/graph/projects/${privateProject.project_id}`));
  assert.strictEqual(member.status, 404, 'a member cannot read org-private work');
});

test('a node is reachable by id only when a project it was seen in is visible', async () => {
  const hidden = await as(bob, (r) => r.get(`/api/v1/context/graph/nodes/${secretNode.node_id}`));
  assert.strictEqual(hidden.status, 404, 'a node from a personal project only');
  assert.strictEqual(hidden.body.error, 'node_not_found');

  const cross = await as(bob, (r) => r.get(`/api/v1/context/graph/nodes/${crossNode.node_id}`));
  assert.strictEqual(cross.status, 200, 'a sighting in a shared project makes the node legitimately visible');

  // ...and even then, the EVIDENCE from the hidden project does not ride along.
  // The excerpt is the transcript; filtering the node and shipping its excerpts
  // would be the same leak wearing a different key.
  const projectIds = (cross.body.graph.evidence || []).map((e) => e.project_id);
  assert.ok(!projectIds.includes(personalProject.project_id), 'no evidence rows from the hidden project');

  const workspaceWide = await as(vera, (r) => r.get(`/api/v1/context/graph/nodes/${workspaceNode.node_id}`));
  assert.strictEqual(workspaceWide.status, 200, 'a node belonging to no project stays visible');
});

// REGRESSION (#480): the node graph came back with no edges AT ALL for every
// member of a shared workspace.
//
// getNodeGraph builds a graph whose `nodes` array is the ONE node asked for, and
// the visibility filter kept an edge only when BOTH of its endpoints survived
// that node list. One node in, so every edge — including the ones to nodes the
// caller reads every day — failed the test. The relationships are most of what a
// node graph is; a filter that removes all of them is not a narrower answer, it
// is a broken endpoint.
//
// The neighbours have to be fetched and judged on their own visibility, which is
// also the only way to keep the leak closed: an edge to a hidden node must stay
// out, and its title must not ride out on the edge summary either.
test('a node graph keeps the edges to nodes the caller may see', async () => {
  const hers = await as(alice, (r) => r.get(`/api/v1/context/graph/nodes/${sharedNode.node_id}`));
  assert.strictEqual(hers.status, 200);
  assert.strictEqual((hers.body.graph.edges || []).length, 2, 'precondition: the author sees both edges');

  const theirs = await as(bob, (r) => r.get(`/api/v1/context/graph/nodes/${sharedNode.node_id}`));
  assert.strictEqual(theirs.status, 200, 'a shared project\'s node is readable');
  const edges = theirs.body.graph.edges || [];
  assert.strictEqual(edges.length, 1, `a member keeps the edge to a node they may read, got ${edges.length}`);
  assert.strictEqual(edges[0].to_node_id, neighbourNode.node_id, 'and it is the visible neighbour');

  // The leak stays closed, by id and by title: the edge summary names the node.
  const body = JSON.stringify(theirs.body);
  assert.ok(!body.includes(secretNode.node_id), 'no edge to a node from a personal project');
  assert.ok(!body.includes('Acquisition target'), 'and no hidden title carried out on an edge summary');
});

test('POST /graph/query is the same read behind a different verb', async () => {
  const byProject = await as(vera, (r) => r.post('/api/v1/context/graph/query').send({ project_id: personalProject.project_id }));
  assert.strictEqual(byProject.status, 404, 'project_id branch is gated');
  const byNode = await as(vera, (r) => r.post('/api/v1/context/graph/query').send({ node_id: secretNode.node_id }));
  assert.strictEqual(byNode.status, 404, 'node_id branch is gated');
  const bySession = await as(vera, (r) => r.post('/api/v1/context/graph/query').send({ session_id: aliceSession }));
  assert.strictEqual(bySession.status, 404, 'session_id branch is gated');
});

test('a session graph does not open somebody else\'s project, or name their machine', async () => {
  const hers = await as(alice, (r) => r.get(`/api/v1/context/graph/sessions/${aliceSession}`));
  assert.strictEqual(hers.status, 200, 'precondition: Alice reads her own session graph');

  const theirs = await as(bob, (r) => r.get(`/api/v1/context/graph/sessions/${aliceSession}`));
  assert.strictEqual(theirs.status, 404, 'a peer\'s session on a personal project is not readable');

  // getProjectPresence deliberately withholds a peer's cwd and host — on a shared
  // workspace the peer is a colleague on their own machine. The session graph read
  // both to build its ranking terms; nothing may carry them out.
  const body = JSON.stringify(theirs.body);
  assert.ok(!body.includes('alice-laptop'), 'no peer host');
  assert.ok(!body.includes('/Users/alice/secret'), 'no peer cwd');
});

test('the per-node markdown export carries no hidden node and no hidden excerpt', async () => {
  const mine = await as(alice, (r) => r.get('/api/v1/context/graph/export'));
  assert.strictEqual(mine.status, 200);
  assert.ok(JSON.stringify(mine.body).includes('Acquisition target'), 'precondition: the author exports her own');

  const theirs = await as(vera, (r) => r.get('/api/v1/context/graph/export'));
  assert.strictEqual(theirs.status, 200, 'a viewer still gets their own vault');
  const dump = JSON.stringify(theirs.body);
  assert.ok(!dump.includes('Acquisition target'), 'no hidden node in a teammate\'s export');
  assert.ok(!dump.includes(`TRANSCRIPT ${RUN}`), 'no hidden transcript excerpt either');
  assert.ok(dump.includes('Team convention'), 'the shared project still exports');
});

test('vault-health counts only what the caller may read', async () => {
  const mine = await as(alice, (r) => r.get('/api/v1/context/graph/vault-health'));
  const theirs = await as(vera, (r) => r.get('/api/v1/context/graph/vault-health'));
  assert.strictEqual(mine.status, 200);
  assert.strictEqual(theirs.status, 200);
  assert.ok(theirs.body.health.total < mine.body.health.total, 'a viewer does not count a colleague\'s private vault');
});

test('vault-health counts a node visible through a sighting, not only its home project', async () => {
  // crossNode's HOME project is personal, but it was also seen in the shared
  // one, and every other surface — the node read, the export, the brief — shows
  // it to a teammate on exactly that basis. A gauge that judges by home project
  // alone contradicts them, and it under-reports by more the more a workspace
  // shares. This is the only node in the fixture that separates the two rules.
  const mine = await as(alice, (r) => r.get('/api/v1/context/graph/vault-health'));
  const theirs = await as(vera, (r) => r.get('/api/v1/context/graph/vault-health'));

  // Counts follow the fixture, which gained neighbourNode when the edge
  // regression was fixed (a node's own graph needs a far end to show an edge to).
  assert.strictEqual(mine.body.health.total, 5, 'the author counts every seeded node');
  assert.strictEqual(
    theirs.body.health.total, 4,
    'a viewer counts both shared nodes, the workspace-scoped one AND the cross-seen one — everything but the secret'
  );
});

// ─── Writes ──────────────────────────────────────────────────────────────────

test('a viewer cannot edit or delete another person\'s memory node', async () => {
  const patch = await as(vera, (r) => r.patch(`/api/v1/context/graph/nodes/${sharedNode.node_id}`).send({ title: `Vandalised ${RUN}` }));
  assert.strictEqual(patch.status, 403, 'a viewer writes nothing, whatever scope the credential carries');
  assert.strictEqual(patch.body.error, 'share_write_forbidden');

  const del = await as(vera, (r) => r.delete(`/api/v1/context/graph/nodes/${sharedNode.node_id}`));
  assert.strictEqual(del.status, 403, 'and deleting is permanent');

  const stillThere = await store.getGraphNode(ORG, sharedNode.node_id);
  assert.ok(stillThere, 'the node survived');
  assert.ok(!stillThere.title.includes('Vandalised'), 'and was not renamed');
});

test('an invisible node is not_found on write, not forbidden', async () => {
  // A 403 here would confirm the id exists and that a colleague is working on it.
  for (const [verb, call] of [
    ['patch', (r) => r.patch(`/api/v1/context/graph/nodes/${secretNode.node_id}`).send({ title: 'x' })],
    ['delete', (r) => r.delete(`/api/v1/context/graph/nodes/${secretNode.node_id}`)],
  ]) {
    const res = await as(bob, call);
    assert.strictEqual(res.status, 404, `${verb} on an invisible node`);
    assert.strictEqual(res.body.error, 'node_not_found');
  }
  assert.ok(await store.getGraphNode(ORG, secretNode.node_id), 'the node survived');
});

test('a member may curate a shared project\'s node, and its author may curate her own', async () => {
  const byMember = await as(bob, (r) => r.patch(`/api/v1/context/graph/nodes/${sharedNode.node_id}`).send({ importance: 'critical' }));
  assert.strictEqual(byMember.status, 200, 'shared means shared — a member can still curate');

  const byAuthor = await as(alice, (r) => r.patch(`/api/v1/context/graph/nodes/${secretNode.node_id}`).send({ importance: 'critical' }));
  assert.strictEqual(byAuthor.status, 200, 'the author was never the problem');
});

test('creating a node under a project you cannot open is refused', async () => {
  const hidden = await as(bob, (r) => r.post('/api/v1/context/graph/nodes')
    .send({ project_id: personalProject.project_id, node_type: 'knowledge', title: `Planted ${RUN}` }));
  assert.strictEqual(hidden.status, 404, 'you cannot file a node into a project you cannot see');

  const byViewer = await as(vera, (r) => r.post('/api/v1/context/graph/nodes')
    .send({ node_type: 'knowledge', title: `Viewer note ${RUN}` }));
  assert.strictEqual(byViewer.status, 403, 'a viewer cannot create workspace-scoped memory either');

  const allowed = await as(bob, (r) => r.post('/api/v1/context/graph/nodes')
    .send({ project_id: sharedProject.project_id, node_type: 'knowledge', title: `Member note ${RUN}` }));
  assert.strictEqual(allowed.status, 201, 'a member still writes into a shared project');
});
