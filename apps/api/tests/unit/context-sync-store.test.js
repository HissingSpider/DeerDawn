/**
 * Unit tests for contextSyncStore.js
 * Exercises project, event, session, preferences, global, and graph operations
 * against the real local Postgres — no mocking of the store itself.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const store = require('../../src/store/contextSyncStore');
const { closeRedisConnections } = require('../../src/config/redis');
const { pool } = require('../../src/config/db');

const OWNER = `test-owner-${uuidv4()}`;

function makeProject(overrides = {}) {
  const id = `proj-${uuidv4()}`;
  const now = new Date().toISOString();
  return {
    project_id: id,
    owner_key: OWNER,
    project_name: `Test Project ${id}`,
    aliases: ['alias-a'],
    linked_paths: ['/workspace/test'],
    linked_conversations: [],
    context: { description: 'test project', goals: ['pass tests'] },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeSession(projectId = null) {
  const now = new Date().toISOString();
  return {
    session_id: `sess-${uuidv4()}`,
    owner_key: OWNER,
    tool: 'claude_web',
    surface_type: 'chat',
    project_id: projectId,
    conversation_ref: 'conv-1',
    cwd: '/workspace',
    host: 'localhost',
    tab_id: 'tab-1',
    status: 'active',
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
}

function makeNode(projectId) {
  const now = new Date().toISOString();
  return {
    node_id: `node-${uuidv4()}`,
    owner_key: OWNER,
    project_id: projectId,
    node_type: 'decision',
    canonical_key: `decision-${uuidv4()}`,
    title: 'Use PostgreSQL',
    summary: 'Chose Postgres for reliability',
    metadata: { source: 'test' },
    confidence: 0.9,
    source_session_id: '',
    source_tool: 'claude_web',
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
}

// Clean up after all tests
test.after(async () => {
  // Delete all test data for this owner
  await pool.query('DELETE FROM context_graph_evidence WHERE owner_key = $1', [OWNER]);
  await pool.query('DELETE FROM context_graph_edges WHERE owner_key = $1', [OWNER]);
  await pool.query('DELETE FROM context_graph_nodes WHERE owner_key = $1', [OWNER]);
  await pool.query('DELETE FROM context_graph_embeddings WHERE owner_key = $1', [OWNER]);
  await pool.query('DELETE FROM context_sessions WHERE owner_key = $1', [OWNER]);
  await pool.query(
    'DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)',
    [OWNER]
  );
  await pool.query('DELETE FROM context_projects WHERE owner_key = $1', [OWNER]);
  await pool.query('DELETE FROM injection_preferences WHERE owner_key = $1', [OWNER]);
  await pool.query('DELETE FROM context_globals WHERE owner_key = $1', [OWNER]);
  await closeRedisConnections();
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
test('saveProject + getProject roundtrip', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const fetched = await store.getProject(OWNER, proj.project_id);
  assert.ok(fetched, 'should return project');
  assert.equal(fetched.project_id, proj.project_id);
  assert.equal(fetched.project_name, proj.project_name);
  assert.deepEqual(fetched.aliases, proj.aliases);
  assert.deepEqual(fetched.linked_paths, proj.linked_paths);
  assert.deepEqual(fetched.context.goals, proj.context.goals);
});

test('saveProject updates existing project', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const updated = { ...proj, project_name: 'Updated Name', updated_at: new Date().toISOString() };
  await store.saveProject(updated);

  const fetched = await store.getProject(OWNER, proj.project_id);
  assert.equal(fetched.project_name, 'Updated Name');
});

test('listProjects returns all projects for owner', async () => {
  const p1 = makeProject();
  const p2 = makeProject();
  await store.saveProject(p1);
  await store.saveProject(p2);

  const all = await store.listProjects(OWNER, { system: true });
  const ids = all.map((p) => p.project_id);
  assert.ok(ids.includes(p1.project_id));
  assert.ok(ids.includes(p2.project_id));
});

test('saveProject persists parent_project_id on roundtrip', async () => {
  const parent = makeProject();
  const child = makeProject({ parent_project_id: parent.project_id });
  await store.saveProject(parent);
  await store.saveProject(child);

  const fetchedParent = await store.getProject(OWNER, parent.project_id);
  const fetchedChild = await store.getProject(OWNER, child.project_id);
  assert.equal(fetchedParent.parent_project_id, null, 'top-level project has null parent');
  assert.equal(fetchedChild.parent_project_id, parent.project_id, 'child points at parent');
});

test('getSubprojects returns children for a parent, owner-isolated', async () => {
  const parent = makeProject();
  const childA = makeProject({ parent_project_id: parent.project_id });
  const childB = makeProject({ parent_project_id: parent.project_id });
  const unrelated = makeProject();
  await store.saveProject(parent);
  await store.saveProject(childA);
  await store.saveProject(childB);
  await store.saveProject(unrelated);

  const children = await store.getSubprojects(OWNER, parent.project_id, { system: true });
  const ids = children.map((c) => c.project_id).sort();
  assert.deepEqual(ids, [childA.project_id, childB.project_id].sort());
  assert.equal((await store.getSubprojects(`other-owner-${uuidv4()}`, parent.project_id, { system: true })).length, 0);
});

test('saveProject can clear parent_project_id (promote to top-level)', async () => {
  const parent = makeProject();
  const child = makeProject({ parent_project_id: parent.project_id });
  await store.saveProject(parent);
  await store.saveProject(child);

  await store.saveProject({ ...child, parent_project_id: null, updated_at: new Date().toISOString() });
  const promoted = await store.getProject(OWNER, child.project_id);
  assert.equal(promoted.parent_project_id, null, 'null clears the link');
  assert.equal((await store.getSubprojects(OWNER, parent.project_id, { system: true })).length, 0);
});

test('getProject returns null for unknown project', async () => {
  const result = await store.getProject(OWNER, `proj-nonexistent-${uuidv4()}`);
  assert.equal(result, null);
});

test('getProject enforces owner isolation', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const result = await store.getProject('other-owner', proj.project_id);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
test('appendEvent stores event and getProject includes it', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const now = new Date().toISOString();
  await store.appendEvent({
    event_id: `evt-${uuidv4()}`,
    project_id: proj.project_id,
    source_type: 'extraction',
    source_id: 'session-1',
    event_kind: 'context_update',
    delta: { current_task: 'test events' },
    confidence: 0.85,
    created_at: now,
  });

  const fetched = await store.getProject(OWNER, proj.project_id);
  assert.equal(fetched.events.length, 1);
  assert.equal(fetched.events[0].event_kind, 'context_update');
  assert.equal(fetched.events[0].confidence, 0.85);
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
test('saveSession + getSession roundtrip', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const sess = makeSession(proj.project_id);
  await store.saveSession(sess);

  const fetched = await store.getSession(OWNER, sess.session_id);
  assert.ok(fetched);
  assert.equal(fetched.session_id, sess.session_id);
  assert.equal(fetched.tool, 'claude_web');
  assert.equal(fetched.project_id, proj.project_id);
});

test('saveSession upserts on conflict', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const sess = makeSession(proj.project_id);
  await store.saveSession(sess);

  const updated = { ...sess, status: 'closed', updated_at: new Date().toISOString(), last_seen_at: new Date().toISOString() };
  await store.saveSession(updated);

  const fetched = await store.getSession(OWNER, sess.session_id);
  assert.equal(fetched.status, 'closed');
});

test('listSessions returns sessions for owner', async () => {
  const s1 = makeSession();
  const s2 = makeSession();
  await store.saveSession(s1);
  await store.saveSession(s2);

  const sessions = await store.listSessions(OWNER);
  const ids = sessions.map((s) => s.session_id);
  assert.ok(ids.includes(s1.session_id));
  assert.ok(ids.includes(s2.session_id));
});

test('getSession returns null for unknown session', async () => {
  const result = await store.getSession(OWNER, `sess-nonexistent-${uuidv4()}`);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
test('savePreferences + getPreferences roundtrip', async () => {
  const prefs = { claude_web: { enabled: true }, cursor: { enabled: false } };
  await store.savePreferences(OWNER, prefs);

  const fetched = await store.getPreferences(OWNER);
  assert.deepEqual(fetched.claude_web, prefs.claude_web);
  assert.deepEqual(fetched.cursor, prefs.cursor);
});

test('savePreferences overwrites on conflict', async () => {
  await store.savePreferences(OWNER, { claude_web: { enabled: false } });
  await store.savePreferences(OWNER, { claude_web: { enabled: true } });

  const fetched = await store.getPreferences(OWNER);
  assert.equal(fetched.claude_web.enabled, true);
});

test('getPreferences returns null for unknown owner', async () => {
  const result = await store.getPreferences(`unknown-owner-${uuidv4()}`);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Global context
// ---------------------------------------------------------------------------
test('saveGlobal + getGlobal roundtrip', async () => {
  const global = { user_name: 'John', preferred_lang: 'TypeScript' };
  await store.saveGlobal(OWNER, 'user-store-test', global);

  const fetched = await store.getGlobal(OWNER, 'user-store-test');
  assert.equal(fetched.user_name, 'John');
  assert.equal(fetched.preferred_lang, 'TypeScript');
  // The profile is a person's: somebody else in the same workspace reads nothing,
  // and so does a caller that names no person.
  assert.equal(await store.getGlobal(OWNER, 'user-someone-else'), null);
  assert.equal(await store.getGlobal(OWNER), null);
});

test('getGlobal returns null for unknown owner', async () => {
  const result = await store.getGlobal(`unknown-owner-${uuidv4()}`, 'user-store-test');
  assert.equal(result, null);
});

test('saveGlobal refuses to write a profile that belongs to nobody', async () => {
  await assert.rejects(() => store.saveGlobal(OWNER, { user_name: 'x' }), /person/);
});

// ---------------------------------------------------------------------------
// Graph nodes
// ---------------------------------------------------------------------------
test('upsertGraphNode + getGraphNode roundtrip', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const node = makeNode(proj.project_id);
  const saved = await store.upsertGraphNode(node);
  assert.ok(saved.node_id);
  assert.equal(saved.title, 'Use PostgreSQL');

  const fetched = await store.getGraphNode(OWNER, saved.node_id);
  assert.ok(fetched);
  assert.equal(fetched.node_type, 'decision');
  assert.equal(fetched.confidence, 0.9);
});

test('upsertGraphNode updates on canonical_key conflict — keeps higher confidence', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const node = makeNode(proj.project_id);
  await store.upsertGraphNode(node);

  const updated = { ...node, node_id: `node-${uuidv4()}`, confidence: 0.5, title: 'Updated Title' };
  const result = await store.upsertGraphNode(updated);

  // confidence should stay at 0.9 (GREATEST), title updated. Decision titles are
  // content and now preserved verbatim (no sentence-casing) to avoid corrupting
  // embedded code/identifiers.
  assert.equal(result.confidence, 0.9);
  assert.equal(result.title, 'Updated Title');
});

test('listGraphNodesForProject returns nodes for project', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const n1 = makeNode(proj.project_id);
  const n2 = makeNode(proj.project_id);
  await store.upsertGraphNode(n1);
  await store.upsertGraphNode(n2);

  const nodes = await store.listGraphNodesForProject(OWNER, proj.project_id);
  const ids = nodes.map((n) => n.node_id);
  assert.ok(ids.includes(n1.node_id) || nodes.some((n) => n.canonical_key === n1.canonical_key));
  assert.ok(nodes.length >= 2);
});

// ---------------------------------------------------------------------------
// Graph edges
// ---------------------------------------------------------------------------
test('upsertGraphEdge + listGraphEdgesForProject roundtrip', async () => {
  const proj = makeProject();
  await store.saveProject(proj);

  const n1 = await store.upsertGraphNode(makeNode(proj.project_id));
  const n2 = await store.upsertGraphNode(makeNode(proj.project_id));

  const now = new Date().toISOString();
  const edge = {
    edge_id: `edge-${uuidv4()}`,
    owner_key: OWNER,
    project_id: proj.project_id,
    edge_type: 'depends_on',
    from_node_id: n1.node_id,
    to_node_id: n2.node_id,
    summary: 'node1 depends on node2',
    metadata: {},
    confidence: 0.8,
    source_session_id: '',
    source_tool: 'claude_web',
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
  await store.upsertGraphEdge(edge);

  const edges = await store.listGraphEdgesForProject(OWNER, proj.project_id);
  assert.ok(edges.some((e) => e.from_node_id === n1.node_id && e.to_node_id === n2.node_id));
});

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------
test('upsertGraphEmbedding + getGraphEmbeddings roundtrip', async () => {
  const targetId = `node-${uuidv4()}`;
  await store.upsertGraphEmbedding({
    owner_key: OWNER,
    target_kind: 'node',
    target_id: targetId,
    model: 'text-embedding-3-small',
    dimensions: 3,
    vector: [0.1, 0.2, 0.3],
  });

  const results = await store.getGraphEmbeddings(OWNER, 'node', [targetId], 'text-embedding-3-small');
  assert.equal(results.length, 1);
  assert.equal(results[0].dimensions, 3);
  assert.deepEqual(results[0].vector, [0.1, 0.2, 0.3]);
});

test('getGraphEmbeddings returns empty array for unknown ids', async () => {
  const results = await store.getGraphEmbeddings(OWNER, 'node', [`node-${uuidv4()}`]);
  assert.deepEqual(results, []);
});

// ---------------------------------------------------------------------------
// listRecentGraphFacts
// ---------------------------------------------------------------------------
test('listRecentGraphFacts returns nodes, edges, and evidence', async () => {
  const facts = await store.listRecentGraphFacts(OWNER, 50);
  assert.ok(Array.isArray(facts.nodes));
  assert.ok(Array.isArray(facts.edges));
  assert.ok(Array.isArray(facts.evidence));
});

// ---------------------------------------------------------------------------
// listCrossProjectEntities — the portfolio's one read
//
// A node keeps the FIRST project it was seen in (upsertGraphNode resolves the
// canonical_key conflict with COALESCE), so every later sighting in a different
// project exists ONLY as an evidence row. If this query ever stops reading
// evidence, the portfolio silently reports zero shared entities forever — the
// failure mode is an empty page, not an error.
// ---------------------------------------------------------------------------
test('listCrossProjectEntities finds a node whose second project is only in evidence', async () => {
  const home = makeProject();
  const other = makeProject();
  await store.saveProject(home);
  await store.saveProject(other);

  const shared = await store.upsertGraphNode(makeNode(home.project_id));
  const homeOnly = await store.upsertGraphNode(makeNode(home.project_id));

  const now = new Date().toISOString();
  await store.addGraphEvidence({
    evidence_id: `ev-${uuidv4()}`,
    owner_key: OWNER,
    project_id: other.project_id,
    session_id: 'sess-cross',
    node_id: shared.node_id,
    tool: 'claude_code',
    excerpt: 'seen again in the second project',
    confidence: 0.9,
    created_at: now,
  });
  // A second sighting in the node's OWN project must not make it look shared.
  await store.addGraphEvidence({
    evidence_id: `ev-${uuidv4()}`,
    owner_key: OWNER,
    project_id: home.project_id,
    session_id: 'sess-same',
    node_id: homeOnly.node_id,
    tool: 'claude_code',
    excerpt: 'seen twice in one project',
    confidence: 0.9,
    created_at: now,
  });

  const rows = await store.listCrossProjectEntities(OWNER, { limit: 50 });
  const found = rows.find((r) => r.node_id === shared.node_id);
  assert.ok(found, 'cross-project node was not reported as shared');
  assert.equal(found.project_count, 2);
  assert.deepEqual([...found.project_ids].sort(), [home.project_id, other.project_id].sort());
  assert.equal(found.shared_reason, 'cross_project');

  assert.ok(
    !rows.some((r) => r.node_id === homeOnly.node_id),
    'a node sighted twice in the same project was reported as cross-project'
  );
});
