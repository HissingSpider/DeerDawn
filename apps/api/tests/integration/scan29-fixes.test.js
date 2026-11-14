/**
 * SCAN 29. Round 28 filed manage_memory(upsert_entities) under the active
 * project; that default must only ever file a NEW entity. And a shown cut
 * never resolves an open sibling because the decision it was cut from is
 * already closed.
 *
 *   1. HIGH: an id-less upsert_entities of an entity that already exists as a
 *      WORKSPACE-level node (project_id NULL) re-homed it into the caller's
 *      active project — a member's personal one hid the team's node from the
 *      owner and every colleague. An existing node now keeps its own home, and
 *      the store never adopts a NULL-project row unless the write named that
 *      project for the entity itself. A NEW entity still lands in the active
 *      project (the round-28 privacy fix).
 *   3. MEDIUM: the same default turned an id-less status resolve of a decision
 *      filed under B, while A was active, into a brief-only no-op against A.
 *      The node's own project (B) is resolved, node and brief, as before.
 *   2. HIGH: a shown cut ("<opening>...") resolved the OPEN decision sharing
 *      the opening when the one it was cut from was already resolved. Every
 *      decision starting with the opening counts, open or resolved: exactly one
 *      open one resolves; one open beside a resolved one is refused, naming
 *      both. On /mcp, /mcp/claude and POST /projects/:id/decisions/resolve.
 *
 * (The local stdio parity copies are pinned in packages/mcp-server vitest.)
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan29-fixes.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
// NO LIVE MODEL. These pins are about how a resolve reads the decision log,
// and every update here goes through recordExplicitUpdate's extraction. With an
// OPENAI_API_KEY in the environment (a developer machine; CI has none) that is a
// live gpt-4o-mini call, and what it says varies run to run: it mirrors a
// decision into current_task (a same-worded open task, which round 28's guard
// rightly calls ambiguous), sets importance "high" (the brief then appends
// " ★ important" to the cut line), writes its own headline over the shown text,
// or judges a later update to resolve an earlier decision. The file ran green in
// CI and failed at random locally. Without a key the extraction is the
// deterministic fallback CI has always exercised.
const savedOpenAiKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));
test.after(() => {
  if (savedOpenAiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAiKey;
});

const db = require('../../src/config/db');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');

const q = (sql, params) => db.query(sql, params, 'org-system');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = () => uuidv4().slice(0, 6);

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

async function mintKey(person, orgId) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return key;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.ok(accepted.ok, accepted.reason);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function mcpCall(key, ws, name, args, path = '/mcp') {
  const r = await request(httpServer).post(path).set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`).set('x-deerdawn-workspace', ws)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { err: Boolean(body.result?.isError || body.error), text, raw: JSON.stringify(body) };
}

async function newProject(person, name, ws = person.orgId) {
  const created = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: `${name} ${tag()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

const nodeRows = async (ownerKey, marker) => (await q(
  `SELECT node_id, project_id, metadata->>'scope' AS scope, metadata->>'status' AS status FROM context_graph_nodes
   WHERE owner_key = $1 AND (title ILIKE $2 OR summary ILIKE $2)`,
  [ownerKey, `%${marker}%`],
)).rows;
const decisionsOf = async (ownerKey, projectId) => Object.fromEntries(((await store.getProject(ownerKey, projectId)).context.recent_decisions || [])
  .map((d) => [d.summary, Boolean(d.resolved)]));

// ─── 1. HIGH: an existing workspace node is not re-homed ────────────────────

async function teamWithPersonalProject(label) {
  const O = await makePerson(`${label}o`, { plan: 'developer_pro' });
  const M = await makePerson(`${label}m`);
  const M2 = await makePerson(`${label}n`);
  await join(O, M);
  await join(O, M2);
  const T = O.orgId;
  const keys = { O: await mintKey(O, T), M: await mintKey(M, T), M2: await mintKey(M2, T) };
  const Pm = await newProject(M, 'Mine', T);
  const shared = await as('patch', `/api/v1/teams/projects/${Pm}/sharing`, M, T).send({ visibility: 'personal' });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  return { O, M, M2, T, keys, Pm };
}

for (const path of ['/mcp', '/mcp/claude']) {
  test(`1 (${path}): a member's id-less re-upsert of a workspace entity from a personal project leaves it workspace-level`, async () => {
    const { O, T, keys, Pm } = await teamWithPersonalProject('s29h1');
    const mark = `Stagingcluster${tag()}`;
    const title = `The ${mark} lives in eu-west-2`;
    const first = await mcpCall(keys.O, T, 'manage_memory', {
      action: 'upsert_entities',
      entities: [{ entity_type: 'knowledge', title, summary: 'Every team deploys staging there.', scope: 'workspace' }],
    }, path);
    assert.equal(first.err, false, first.text);
    assert.deepEqual((await nodeRows(T, mark)).map((r) => [r.project_id, r.scope]), [[null, 'workspace']]);

    await mcpCall(keys.M, T, 'start_session', { project_id: Pm }, path);
    const again = await mcpCall(keys.M, T, 'manage_memory', {
      action: 'upsert_entities',
      entities: [{ entity_type: 'knowledge', title, summary: 'Every team deploys staging there; the NAT gateway is shared too.' }],
    }, path);
    assert.equal(again.err, false, again.text);
    assert.match(again.text, /Upserted 1 workspace entity/);

    // The row is still the team's: no project, workspace scope.
    assert.deepEqual((await nodeRows(T, mark)).map((r) => [r.project_id, r.scope]), [[null, 'workspace']]);
    // ...and everybody still reads it: the owner and the other member over MCP,
    // the owner over REST.
    for (const k of [keys.O, keys.M2]) {
      const seen = await mcpCall(k, T, 'recall', { action: 'entities', query: mark }, path);
      assert.match(seen.text, /eu-west-2/, seen.text);
    }
    const rest = await as('get', `/api/v1/context/workspace/entities?query=${mark}&format=json`, O, T);
    assert.equal(rest.status, 200);
    assert.equal((rest.body.entities || []).filter((e) => e.title.includes(mark)).length, 1, JSON.stringify(rest.body));
  });
}

test('1: a NEW entity with no project_id still lands in the active project (round 28 intact)', async () => {
  const { T, keys, Pm, O } = await teamWithPersonalProject('s29new');
  const mark = `Salarynote${tag()}`;
  await mcpCall(keys.M, T, 'start_session', { project_id: Pm });
  const saved = await mcpCall(keys.M, T, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'knowledge', title: `My ${mark} offer is 180k`, summary: 'Negotiating the counter-offer next week.' }],
  });
  assert.equal(saved.err, false, saved.text);
  assert.deepEqual((await nodeRows(T, mark)).map((r) => [r.project_id, r.scope]), [[Pm, 'project']]);
  const owner = await mcpCall(keys.O, T, 'recall', { action: 'entities', query: mark });
  assert.doesNotMatch(owner.text, /180k/, 'a personal project entity is not the owner\'s to read');
  const rest = await as('get', `/api/v1/context/workspace/entities?query=${mark}&format=json`, O, T);
  assert.equal((rest.body.entities || []).length, 0, JSON.stringify(rest.body));
});

test('1: the store never adopts a workspace-level row into a project it was not told to', async () => {
  const S = await makePerson('s29store', { plan: 'developer_pro' });
  const P = await newProject(S, 'Repo');
  const now = new Date().toISOString();
  const key = `service:s29-${tag()}`;
  const base = {
    owner_key: S.orgId, node_type: 'service', canonical_key: key, title: 'Shared queue service', summary: 'Every project enqueues through it.',
    confidence: 0.9, source_session_id: 'manual', source_tool: 'codex', created_at: now, updated_at: now, last_seen_at: now,
  };
  await store.upsertGraphNode({ ...base, node_id: `graph_node_${uuidv4()}`, project_id: null, metadata: { scope: 'workspace' } });
  // An extraction in P, or any write carrying a project it did not name for
  // this entity, lands on the same key: the row stays the workspace's.
  const extracted = await store.upsertGraphNode({ ...base, node_id: `graph_node_${uuidv4()}`, project_id: P, metadata: { scope: 'project' } });
  assert.equal(extracted.project_id, null);
  assert.equal(extracted.metadata.scope, 'workspace');
  // A write that names the project for this entity (adopt_project) still may.
  const named = await store.upsertGraphNode({ ...base, node_id: `graph_node_${uuidv4()}`, project_id: P, adopt_project: true, metadata: { scope: 'project' } });
  assert.equal(named.project_id, P);
  assert.equal(named.metadata.scope, 'project');
});

// ─── 3. MEDIUM: an id-less status resolve lands in the node's own project ────

test('3: id-less upsert_entities resolve of a decision filed under B, while A is active, resolves B', async () => {
  const S = await makePerson('s29m3', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const A = await newProject(S, 'A');
  const B = await newProject(S, 'B');
  const D = `Decided to adopt Temporal ${tag()} for the payout workflow orchestration.`;
  const recorded = await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: B, summary: D });
  assert.equal(recorded.err, false, recorded.text);
  await wait(700);
  await mcpCall(key, S.orgId, 'start_session', { project_id: A });
  const r = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'decision', title: D, metadata: { status: 'resolved' } }],
  });
  assert.equal(r.err, false, r.text);
  assert.match(r.text, /Upserted 1 workspace entity/, r.text);
  assert.equal((await decisionsOf(S.orgId, B))[D], true, 'B\'s brief is resolved');
  const nodes = (await q(
    'SELECT project_id, metadata->>\'status\' AS status FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'decision\'',
    [S.orgId],
  )).rows;
  assert.deepEqual(nodes.map((n) => [n.project_id, n.status]), [[B, 'resolved']]);
});

// ─── 2. HIGH: a shown cut and an already-resolved sibling ───────────────────

async function twoSiblings(label) {
  const S = await makePerson(label, { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const A = await newProject(S, 'A');
  const t = tag();
  const opening = `Route every outbound webhook ${t} through the shared`;
  const X = `Route every outbound webhook ${t} through the shared delivery queue in staging only.`;
  const Y = `Route every outbound webhook ${t} through the shared delivery queue in production too.`;
  for (const D of [X, Y]) {
    const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: A, summary: D });
    assert.equal(r.err, false, r.text);
    await wait(700);
  }
  assert.deepEqual(await decisionsOf(S.orgId, A), { [X]: false, [Y]: false });
  return { S, key, A, X, Y, cut: `${opening}...` };
}

const refusedNamingBoth = (text, X, Y) => {
  assert.doesNotMatch(text, /Marked resolved/, text);
  assert.match(text, /nothing was resolved/, text);
  assert.ok(text.includes(`"${X}" — already resolved`), text);
  assert.ok(text.includes(`"${Y}"`), text);
};

for (const path of ['/mcp', '/mcp/claude']) {
  test(`2 (${path}): the cut resolves nothing once the decision it was cut from is resolved, and names both`, async () => {
    const { S, key, A, X, Y, cut } = await twoSiblings('s29h2');
    const both = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: cut, project_id: A }, path);
    assert.match(both.text, /matches 2 open decisions/, both.text);
    const full = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: X, project_id: A }, path);
    assert.match(full.text, /Marked resolved/, full.text);

    const again = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: cut, project_id: A }, path);
    refusedNamingBoth(again.text, X, Y);
    // ...and with no project_id, the active project.
    await mcpCall(key, S.orgId, 'start_session', { project_id: A }, path);
    const active = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: cut }, path);
    refusedNamingBoth(active.text, X, Y);
    assert.deepEqual(await decisionsOf(S.orgId, A), { [X]: true, [Y]: false });

    // The full text of the open one still resolves it; then the cut is done.
    const y = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: Y, project_id: A }, path);
    assert.match(y.text, /Marked resolved/, y.text);
    const done = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: cut, project_id: A }, path);
    assert.match(done.text, /already resolved/, done.text);
    assert.doesNotMatch(done.text, /Marked resolved/, done.text);
  });
}

test('2 (REST): POST /projects/:id/decisions/resolve refuses the cut beside a resolved sibling', async () => {
  const { S, key, A, X, Y, cut } = await twoSiblings('s29h2r');
  const full = await as('post', `/api/v1/context/projects/${A}/decisions/resolve`, S, S.orgId).send({ title: X });
  assert.equal(full.body.outcome, 'resolved', JSON.stringify(full.body));
  const again = await as('post', `/api/v1/context/projects/${A}/decisions/resolve`, S, S.orgId).send({ title: cut, untyped: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, 'ambiguous', JSON.stringify(again.body));
  assert.deepEqual([...again.body.candidates].sort(), [X, Y].sort());
  refusedNamingBoth(again.body.message, X, Y);
  assert.deepEqual(await decisionsOf(S.orgId, A), { [X]: true, [Y]: false });
  // A lone open decision under the cut still resolves (round 28 intact).
  const P = await newProject(S, 'P');
  const Z = `Keep one ${tag()} retry budget per outbound webhook destination for every tenant.`;
  const rec = await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: Z });
  assert.equal(rec.err, false, rec.text);
  await wait(700);
  assert.equal((await decisionsOf(S.orgId, P))[Z], false);
  const lone = await as('post', `/api/v1/context/projects/${P}/decisions/resolve`, S, S.orgId).send({ title: `${Z.slice(0, 50).trim()}...` });
  assert.equal(lone.body.outcome, 'resolved', JSON.stringify(lone.body));
});

test('2 (entity path): a cut naming a resolved and an open workspace decision resolves neither', async () => {
  const S = await makePerson('s29h2e', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const C = await newProject(S, 'C');
  const t = tag();
  const X = `Pin every service ${t} to the regional cache cluster for staging traffic only.`;
  const Y = `Pin every service ${t} to the regional cache cluster for production traffic too.`;
  const up = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities',
    entities: [X, Y].map((text) => ({ entity_type: 'decision', title: text, summary: text, scope: 'workspace' })),
  });
  assert.equal(up.err, false, up.text);
  const full = await mcpCall(key, S.orgId, 'mark_resolved', { title: X, project_id: C });
  assert.match(full.text, /Marked resolved/, full.text);
  const again = await mcpCall(key, S.orgId, 'mark_resolved', { title: `Pin every service ${t} to the regional cache cluster...`, project_id: C });
  assert.doesNotMatch(again.text, /Marked resolved/, again.text);
  assert.match(again.text, /matches 2 entities/, again.text);
  assert.match(again.text, /staging traffic only\.?" \(decision\) — already resolved/, again.text);
  const statuses = (await q(
    'SELECT summary, metadata->>\'status\' AS status FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'decision\'',
    [S.orgId],
  )).rows;
  assert.notEqual(statuses.find((r) => r.summary.includes('production'))?.status, 'resolved', JSON.stringify(statuses));
});
