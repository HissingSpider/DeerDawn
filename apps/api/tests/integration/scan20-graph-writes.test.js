/**
 * SCAN 20 — GRAPH WRITE PATHS.
 *
 * Round 19 filtered every graph READ by the share's sections. The WRITE paths
 * kept answering with raw rows, so the same withheld content reached a teammate
 * in the reply to their own write:
 *
 *   1. POST /extraction (and its explicit-update branch) returned the graph
 *      recordGraphArtifacts built from the WHOLE stored context — withheld
 *      decisions, tech stack and description included — to a member allowed to
 *      edit one visible section.
 *   2. PATCH /graph/nodes/:rootId and POST /workspace/entities (and the MCP
 *      upsert_entities) on a shared project's root answered with the stored row
 *      (withheld description, metadata.tech_stack) and let the member overwrite
 *      the root they only see blanked. An exact-key upsert onto a hidden node in
 *      the SAME project the caller named merged into it and echoed it.
 *   3. Selection tracking wrote the reader's redacted copy of the root back with
 *      upsertGraphNode, which takes the incoming summary whenever the stored one
 *      is under 40 characters: the first teammate to load the brief blanked a
 *      short root summary for everybody.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan20-graph-writes.test.js
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

async function mintKey(person, orgId, scopes = ['context:read', 'context:write']) {
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
  return body;
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

function extraction(projectId, projectName, delta) {
  return {
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: projectId,
    chunks: [{ role: 'user', text: 'status update' }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.9,
      project_candidate: { project_id: projectId, project_name: projectName, score: 0.9 },
      delta,
      should_create_project: false,
      needs_user_confirmation: false,
    },
  };
}

// The stored root, straight from the table: what everybody reads next.
async function storedRoot(ownerKey, projectId) {
  const rows = (await q(
    'SELECT node_id, summary, metadata FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2 AND canonical_key = $3',
    [ownerKey, 'project', graph.projectRootKey(projectId)],
  )).rows;
  assert.equal(rows.length, 1, 'one root per project');
  return rows[0];
}

const leaked = (payload, markers) => markers.filter((m) => JSON.stringify(payload).toLowerCase().includes(m.toLowerCase()));

// A team, a shared project whose share grants status + task (editable) and
// withholds decisions; description and tech_stack are never granted. The owner
// has written a decision, a stack entry and a description into it.
async function sharedLedger() {
  const tag = uuidv4().slice(0, 6);
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  await join(O, M);
  const T = O.orgId;
  const name = `Ledger ${tag}`;
  const P = await createProject(O, T, name);
  await share(O, T, P, [
    { section_key: 'current_status', can_view: true, can_edit: true },
    { section_key: 'current_task', can_view: true, can_edit: true },
    { section_key: 'recent_decisions', can_view: false },
  ]);
  const HID = { dec: `HIDDENDEC${tag}`, stack: `HIDDENSTACK${tag}`, desc: `HIDDENDESC${tag}` };
  const patched = await as('patch', `/api/v1/context/projects/${P}/context`, O, T)
    .send({ current_status: `VISIBLESTATUS${tag}`, tech_stack: [`${HID.stack}db`], description: `${HID.desc} acquisition target` });
  assert.equal(patched.status, 200, `owner patch: ${patched.status} ${JSON.stringify(patched.body)}`);
  // The owner's own extraction records the decision AND builds the graph.
  const own = await as('post', '/api/v1/context/extraction', O, T)
    .send(extraction(P, name, { recent_decisions: [{ summary: `Decided: ${HID.dec} we will lay off the payments team in Q4`, decided_at: new Date().toISOString() }] }));
  assert.equal(own.status, 202, `owner extraction: ${own.status} ${JSON.stringify(own.body).slice(0, 300)}`);
  // The author reads their own graph whole in the reply: the filter is the
  // identity for them.
  assert.deepEqual(leaked(own.body.graph, Object.values(HID)).sort(), Object.values(HID).sort(),
    'the author gets every node the write built');
  return { O, M, T, P, name, tag, HID };
}

// ── 1 ────────────────────────────────────────────────────────────────────────

test('1: POST /extraction answers a teammate with the graph they may read, not the whole project', async () => {
  const { M, T, P, name, HID } = await sharedLedger();
  const hidden = Object.values(HID);
  const key = await mintKey(M, T);

  const viaJwt = await as('post', '/api/v1/context/extraction', M, T)
    .send(extraction(P, name, { current_status: `mia status ${uuidv4().slice(0, 4)}` }));
  assert.equal(viaJwt.status, 202, JSON.stringify(viaJwt.body).slice(0, 300));
  assert.deepEqual(leaked(viaJwt.body, hidden), [], 'the member\'s extraction reply carries nothing the share withholds');
  // Still a graph: the root travels (blanked), so the reply is filtered, not dropped.
  assert.ok((viaJwt.body.graph?.nodes || []).some((n) => n.node_type === 'project'), 'the root is still in the reply');

  const viaKey = await request(httpServer).post('/api/v1/context/extraction')
    .set('X-Api-Key', key).set('x-deerdawn-workspace', T)
    .send(extraction(P, name, { current_task: `mia task ${uuidv4().slice(0, 4)}` }));
  assert.equal(viaKey.status, 202, JSON.stringify(viaKey.body).slice(0, 300));
  assert.deepEqual(leaked(viaKey.body, hidden), [], 'the same over an API key');
});

test('1b: the explicit-update branch of POST /extraction filters its graph too', async () => {
  const tag = uuidv4().slice(0, 6);
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  await join(O, M);
  const T = O.orgId;
  const P = await createProject(O, T, `Atlas ${tag}`);
  // Decisions are shared AND editable, so the member's explicit update lands;
  // description and tech_stack are not granted.
  await share(O, T, P, [
    { section_key: 'current_status', can_view: true, can_edit: true },
    { section_key: 'recent_decisions', can_view: true, can_edit: true },
  ]);
  const HID = [`HIDDENSTACK${tag}`, `HIDDENDESC${tag}`];
  const patched = await as('patch', `/api/v1/context/projects/${P}/context`, O, T)
    .send({ tech_stack: [`${HID[0]}db`], description: `${HID[1]} acquisition target` });
  assert.equal(patched.status, 200);

  // The explicit branch runs the model extraction over the summary; with no
  // model key that is an empty delta and nothing reaches the graph. Stand in a
  // model answer that changes the brief, so the graph is actually rebuilt.
  const extractionService = require('../../src/services/extractionService');
  const runExtraction = extractionService.runExtraction;
  extractionService.runExtraction = async () => ({
    match_decision: 'matched_existing',
    confidence: 0.9,
    delta: { current_status: `VISSTATUS${tag} retries capped` },
    should_create_project: false,
    needs_user_confirmation: false,
    no_material_change: false,
  });
  let res;
  try {
    res = await as('post', '/api/v1/context/extraction', M, T).send({
      session_id: `sess-${uuidv4()}`,
      tool: 'claude_code',
      project_id: P,
      explicit: true,
      chunks: [{ role: 'user', text: `Decided: VISDEC${tag} retries are capped at three` }],
    });
  } finally {
    extractionService.runExtraction = runExtraction;
  }
  assert.equal(res.status, 202, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.stored, true, 'the explicit update itself landed');
  assert.ok((res.body.graph?.nodes || []).length, 'the explicit update rebuilt the graph');
  assert.deepEqual(leaked(res.body.graph, HID), [], 'the explicit branch\'s graph carries nothing the share withholds');
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test('2: a teammate cannot rewrite a root they see blanked, and no write reply hands it back', async () => {
  const { O, M, T, P, HID } = await sharedLedger();
  const hidden = [HID.stack, HID.desc];
  const key = await mintKey(M, T);
  const before = await storedRoot(T, P);
  assert.ok(before.summary.includes(HID.desc), 'the stored root carries the description');

  // Reading it: redacted (round 19).
  const read = await as('get', `/api/v1/context/graph/nodes/${before.node_id}`, M, T);
  assert.equal(read.status, 200);
  assert.deepEqual(leaked(read.body, hidden), []);

  // PATCH: refused, 403 (the node is visible, so there is no existence to protect).
  for (const body of [{ summary: 'member rewrote the root' }, { pinned: true }, { metadata: { note: 'x' } }]) {
    const res = await as('patch', `/api/v1/context/graph/nodes/${before.node_id}`, M, T).send(body);
    assert.equal(res.status, 403, `PATCH ${JSON.stringify(body)}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    assert.equal(res.body.error, 'share_write_forbidden');
    assert.deepEqual(leaked(res.body, hidden), [], 'the refusal carries nothing withheld');
  }

  // REST upsert of the root by its key: refused, nothing echoed.
  const rest = await as('post', '/api/v1/context/workspace/entities', M, T).send({
    project_id: P,
    entities: [{ entity_type: 'project', canonical_key: `project:${P}`, title: 'Ledger', summary: 'member upsert over the root' }],
  });
  assert.equal(rest.status, 403, `${rest.status} ${JSON.stringify(rest.body).slice(0, 200)}`);
  assert.deepEqual(leaked(rest.body, hidden), []);

  // MCP upsert_entities, by key and by name: an error, nothing echoed.
  for (const entity of [
    { entity_type: 'project', canonical_key: `project:${P}`, title: 'Ledger', summary: 'mcp upsert over the root' },
    { entity_type: 'project', title: (await store.getProject(T, P)).project_name, summary: 'mcp upsert by name' },
  ]) {
    const body = await mcp(key, 'manage_memory', { action: 'upsert_entities', project_id: P, entities: [entity] });
    assert.ok(body.result?.isError || body.error, `upsert_entities over the root must be refused: ${JSON.stringify(body).slice(0, 300)}`);
    assert.deepEqual(leaked(body, hidden), []);
  }

  const after = await storedRoot(T, P);
  assert.equal(after.summary, before.summary, 'the root summary is untouched');
  assert.deepEqual(after.metadata.tech_stack, before.metadata.tech_stack, 'the root stack is untouched');

  // The author still edits their own root, and reads it whole in the reply.
  const own = await as('patch', `/api/v1/context/graph/nodes/${before.node_id}`, O, T).send({ pinned: true });
  assert.equal(own.status, 200, JSON.stringify(own.body).slice(0, 200));
  assert.ok(JSON.stringify(own.body.node).includes(HID.desc), 'the author\'s reply is the full row');
});

test('2b: an exact-key upsert onto a node the share hides in the SAME project is refused, not merged', async () => {
  const { M, T, P, HID } = await sharedLedger();
  const decision = (await q(
    'SELECT node_id, canonical_key, title, summary FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2 AND title ILIKE $3',
    [T, 'decision', `%${HID.dec}%`],
  )).rows[0];
  assert.ok(decision, 'the owner\'s decision is a graph node');

  const res = await as('post', '/api/v1/context/workspace/entities', M, T).send({
    project_id: P,
    entities: [{ entity_type: 'decision', project_id: P, scope: 'project', canonical_key: decision.canonical_key, title: 'Member decision on the same key', summary: 'member merge attempt' }],
  });
  // Scan 31: a key a hidden node holds is no longer the refusal: the member's
  // entity would be their own node under a scoped key (never the hidden one),
  // and it is refused for what it is — a new decision in a project whose share
  // withholds decisions from them, the same answer any new decision gets there.
  assert.equal(res.status, 403, `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  assert.deepEqual(res.body.blocked_fields, ['recent_decisions']);
  assert.deepEqual(leaked(res.body, [HID.dec]), []);
  const scoped = (await q('SELECT count(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1 AND starts_with(canonical_key, $2)', [T, `${decision.canonical_key}::`])).rows[0].n;
  assert.equal(scoped, 0, 'nothing was stored beside it either');
  const after = (await q('SELECT title, summary FROM context_graph_nodes WHERE node_id = $1', [decision.node_id])).rows[0];
  assert.equal(after.title, decision.title, 'the hidden node was not retitled');
  assert.equal(after.summary, decision.summary, 'the hidden node was not merged into');
});

test('2c: a teammate\'s own upsert still lands and its reply carries only what they may read', async () => {
  const { M, T, P, HID } = await sharedLedger();
  const res = await as('post', '/api/v1/context/workspace/entities', M, T).send({
    project_id: P,
    entities: [{ entity_type: 'knowledge', title: 'Webhook retry policy for ledger payouts', summary: 'Retries are capped at three with jitter' }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.entities.length, 1, 'the write is counted');
  assert.deepEqual(leaked(res.body, Object.values(HID)), []);
});

// ── 3 ────────────────────────────────────────────────────────────────────────

for (const [label, description] of [
  ['short', 'SHORTROOT desc'],
  ['long', 'LONGROOT the description of the acquisition, well past forty characters'],
]) {
  test(`3 (${label} root summary): a teammate loading the brief does not rewrite the stored root`, async () => {
    const tag = uuidv4().slice(0, 6);
    const O = await makePerson('owner', { plan: 'developer_pro' });
    const M = await makePerson('member');
    await join(O, M);
    const T = O.orgId;
    const name = `Rootp ${tag}`;
    const P = await createProject(O, T, name);
    await share(O, T, P, [
      { section_key: 'current_status', can_view: true },
      { section_key: 'current_task', can_view: true },
    ]);
    const patched = await as('patch', `/api/v1/context/projects/${P}/context`, O, T)
      .send({ description, current_status: 'ROOTSTATUS', tech_stack: ['postgres'] });
    assert.equal(patched.status, 200);
    const own = await as('post', '/api/v1/context/extraction', O, T)
      .send(extraction(P, name, { recent_decisions: [{ summary: 'Decided: the api uses postgres', decided_at: new Date().toISOString() }] }));
    assert.equal(own.status, 202);
    const before = await storedRoot(T, P);
    assert.equal(before.summary, description, 'the root summary is the description');

    // The member's brief loads: every path that records a selection.
    const inject = await as('get', `/api/v1/context/projects/${P}/inject?tool=claude_code`, M, T);
    assert.equal(inject.status, 200);
    const entities = await as('get', '/api/v1/context/workspace/entities?limit=50', M, T);
    assert.equal(entities.status, 200);
    assert.ok(!JSON.stringify(entities.body).includes(description.split(' ')[0]), 'the member reads the root blanked');

    // Selection is recorded after the response; wait for it to land.
    let after = before;
    for (let i = 0; i < 40; i += 1) {
      after = await storedRoot(T, P);
      if (after.metadata?.last_selected_at && after.metadata.last_selected_at !== before.metadata?.last_selected_at) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(after.metadata?.last_selected_at, 'the selection was recorded on the root');
    assert.ok(Number(after.metadata.retrieval_hits || 0) > Number(before.metadata?.retrieval_hits || 0), 'retrieval_hits counted');
    assert.equal(after.summary, description, 'the stored root summary is unchanged for everybody');
    assert.deepEqual(after.metadata.tech_stack, before.metadata.tech_stack, 'the stored stack is unchanged');
  });
}
