/**
 * SCAN 31. A graph node with no project is WORKSPACE-level: every member of the
 * workspace reads it. Rounds 27-30 let "no project given" default to that in
 * too many cases, so private content leaked the moment a team existed or
 * formed. The rules now (service.upsertWorkspaceEntities):
 *
 *   R1. A NEW entity with no project of its own is filed under the WORKING
 *       project whenever the caller may edit its section there (the author
 *       always; a teammate when the share grants edit). Workspace-level only
 *       when a member writes their own knowledge in a teammate's share that
 *       withholds the section (scan 30's p72 stays fixed), or when there is no
 *       working project. A scope:"project" ask is refused, never widened.
 *       p2 (author's narrowed share), p3/p78 (solo, then invite), p7 (solo
 *       top-level project_id), p80 (solo resolve), p81 (solo Trail), p82.
 *   R2. A dispatcher-supplied project never adopts an existing node — the
 *       scope:"project" ask included (p6).
 *   R3. An existing node saved from another project records a sighting there,
 *       so the portfolio still counts it cross-project (scan 30's p66).
 *   R4. No fuzzy dedup: a similar node is not the row written, so it neither
 *       gates the write nor lends it metadata (p1, p1b, p5/p77, p76).
 *   R5. The first invite keeps pre-team workspace-level nodes private to the
 *       founder (scan 32: by a private_to mark, no longer by attaching them to
 *       a project).
 *   R6. A Trail import files its graph under the import's target, and the
 *       export carries node descriptions (p9).
 *   R7. A key held by a node the caller cannot see no longer blocks them: their
 *       entity is written under a scoped key of its own (p83).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan31-fixes.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
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

async function share(person, ws, projectId, body) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send(body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

const rowsLike = async (ownerKey, marker) => (await q(
  `SELECT node_type, title, summary, canonical_key, project_id, metadata->>'scope' AS scope, metadata->>'status' AS status
     FROM context_graph_nodes
    WHERE owner_key = $1 AND (title ILIKE $2 OR summary ILIKE $2) AND node_type <> 'project'
    ORDER BY created_at`,
  [ownerKey, `%${marker}%`],
)).rows;

const upsert = (key, ws, args) => mcpCall(key, ws, 'manage_memory', { action: 'upsert_entities', ...args });

// An owner and two members, keys for all three.
async function team(label) {
  const O = await makePerson(`${label}o`, { plan: 'developer_pro' });
  const M = await makePerson(`${label}m`);
  const M2 = await makePerson(`${label}n`);
  await join(O, M);
  await join(O, M2);
  const T = O.orgId;
  const keys = { O: await mintKey(O, T), M: await mintKey(M, T), M2: await mintKey(M2, T) };
  return { O, M, M2, T, keys };
}

const VIEW_ONLY = ['current_task', 'current_status', 'recent_decisions', 'todo_items', 'tech_stack', 'open_questions']
  .map((section) => ({ section_key: section, can_view: true, can_edit: false }));

// ── R4. A similar node is not the row written ──────────────────────────────

test('R4 (p1): a decision similar to a workspace decision is not a door into a view-only share', async () => {
  const t = await team('s31p1');
  const P = await newProject(t.O, 'ViewOnly', t.T);
  await share(t.O, t.T, P, { visibility: 'shared', sections: VIEW_ONLY, members: [] });
  const mk = `ledger${tag()}`;
  const seed = await upsert(t.keys.O, t.T, { entities: [{ entity_type: 'decision', scope: 'workspace', title: `Decided to move the ${mk} store to DynamoDB this quarter` }] });
  assert.equal(seed.err, false, seed.text);
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: P });
  for (const entity of [
    { entity_type: 'decision', project_id: P, title: `Decided to move the ${mk} store to DynamoDB this quarter and drop Postgres` },
    { entity_type: 'decision', scope: 'project', title: `Decided to move the ${mk} store to DynamoDB this quarter, owner signed off` },
  ]) {
    const r = await upsert(t.keys.M, t.T, { entities: [entity] });
    assert.equal(r.err, true, r.text);
    assert.match(r.text, /share_write_forbidden.*recent_decisions/, r.text);
  }
  assert.deepEqual((await rowsLike(t.T, mk)).filter((row) => row.project_id === P), []);
  const brief = await mcpCall(t.keys.O, t.T, 'start_session', { project_id: P });
  assert.doesNotMatch(brief.text, new RegExp(`${mk} store to DynamoDB this quarter (and|,)`), brief.text);
});

test('R4 (p1b/p76c): the caller\'s own similar node neither opens a view-only share nor blocks their own save', async () => {
  const t = await team('s31p1b');
  const P = await newProject(t.O, 'ViewOnly', t.T);
  await share(t.O, t.T, P, { visibility: 'shared', sections: VIEW_ONLY, members: [] });
  const Mine = await newProject(t.M, 'Mine', t.T);
  await share(t.M, t.T, Mine, { visibility: 'personal' });
  const mk = `Ledger${tag()}`;
  const own = await upsert(t.keys.M, t.T, { entities: [{ entity_type: 'service', project_id: Mine, title: `${mk} cache`, summary: 'Redis cache in front of the ledger.' }] });
  assert.equal(own.err, false, own.text);
  const into = await upsert(t.keys.M, t.T, { entities: [{ entity_type: 'service', project_id: P, title: `${mk} cache cluster`, summary: 'MongoDB Atlas replaces Postgres for the ledger.' }] });
  assert.equal(into.err, true, into.text);
  assert.match(into.text, /share_write_forbidden.*tech_stack/, into.text);
  // p76c: a decision in the OWNER's view-only share must not stop the member
  // saving a similar decision of their own in their own project.
  const D = `Decided to rate limit the ${mk} public API at 100 requests per minute per key.`;
  const ownerDecision = await upsert(t.keys.O, t.T, { entities: [{ entity_type: 'decision', project_id: P, title: D }] });
  assert.equal(ownerDecision.err, false, ownerDecision.text);
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: Mine });
  const mine = await upsert(t.keys.M, t.T, { entities: [{ entity_type: 'decision', title: `${D.slice(0, -1)} and per IP.` }] });
  assert.equal(mine.err, false, mine.text);
  assert.deepEqual((await rowsLike(t.T, 'per minute per key and per IP')).map((row) => row.project_id), [Mine]);
  assert.deepEqual((await rowsLike(t.T, `${mk} cache cluster`)), []);
});

test('R4 (p5/p77): a new decision similar to a resolved one is not born resolved', async () => {
  const S = await makePerson('s31p5', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const P = await newProject(S, 'Solo');
  await mcpCall(key, S.orgId, 'start_session', { project_id: P });
  const mk = `Redis${tag()}`;
  const d1 = await upsert(key, S.orgId, { entities: [{ entity_type: 'decision', title: `Use ${mk} for session storage in the api`, metadata: { status: 'resolved' } }] });
  assert.equal(d1.err, false, d1.text);
  const d2 = await upsert(key, S.orgId, { entities: [{ entity_type: 'decision', title: `Use ${mk} for session storage in the api and the worker` }] });
  assert.equal(d2.err, false, d2.text);
  const rows = await rowsLike(S.orgId, mk);
  assert.deepEqual(rows.map((row) => row.status), ['resolved', null], JSON.stringify(rows));
  const seen = await mcpCall(key, S.orgId, 'recall', { action: 'entities', query: `${mk} worker` });
  assert.match(seen.text, /and the worker/, seen.text);
});

// ── R1. New entities are filed where the caller may edit them ───────────────

test('R1 (p2/p82): an author\'s id-less and top-level saves in their own narrowed share stay in that project', async () => {
  const t = await team('s31p2');
  const mk = `payments${tag()}`;
  for (const [who, key] of [['O', t.keys.O], ['M', t.keys.M]]) {
    const author = t[who];
    const P = await newProject(author, `Narrow ${who}`, t.T);
    await share(author, t.T, P, { visibility: 'shared', sections: [{ section_key: 'current_task', can_view: true, can_edit: true }], members: [] });
    await mcpCall(key, t.T, 'start_session', { project_id: P });
    const idless = await upsert(key, t.T, { entities: [
      { entity_type: 'decision', title: `Decided to lay off the ${mk} ${who} team in Q4` },
      { entity_type: 'service', title: `${mk} ${who} ledger svc`, summary: 'Ledger service being sunset after the layoffs.' },
    ] });
    assert.equal(idless.err, false, idless.text);
    const top = await upsert(key, t.T, { project_id: P, entities: [{ entity_type: 'decision', title: `Decided to sell the ${mk} ${who} unit` }] });
    assert.equal(top.err, false, top.text);
    const rows = await rowsLike(t.T, `${mk} ${who}`);
    assert.equal(rows.length, 3);
    for (const row of rows) assert.deepEqual([row.project_id, row.scope], [P, 'project'], row.title);
  }
  const seen = await mcpCall(t.keys.M2, t.T, 'recall', { action: 'entities', query: mk });
  assert.match(seen.text, /No workspace entities found/, seen.text);
  const rest = await as('get', `/api/v1/context/workspace/entities?query=${mk}&format=json`, t.M2, t.T);
  assert.deepEqual((rest.body.entities || []).map((e) => e.title), []);
});

test('R1+R5 (p3/p78): inviting a colleague publishes none of the founder\'s solo-era entities; the founder keeps them', async () => {
  const O = await makePerson('s31p3', { plan: 'developer_pro' });
  const okey = await mintKey(O, O.orgId);
  const P = await newProject(O, 'Job search');
  const Q = await newProject(O, 'Side notes');
  const mk = `Bob${tag()}`;
  await mcpCall(okey, O.orgId, 'start_session', { project_id: P });
  // R1: id-less, filed under the working project.
  const idless = await upsert(okey, O.orgId, { entities: [
    { entity_type: 'decision', title: `Decided to fire contractor ${mk} for missed deadlines` },
    { entity_type: 'person', title: `Dr. ${mk} Nair`, summary: `My therapist ${mk}; Tuesday sessions about burnout.` },
  ] });
  assert.equal(idless.err, false, idless.text);
  // R5: nodes that were workspace-level before the team formed — an explicit
  // scope:"workspace", and one with a sighting in Q.
  const ws = await upsert(okey, O.orgId, { entities: [
    { entity_type: 'knowledge', scope: 'workspace', title: `Runway ${mk} is 4 months at current burn`, summary: 'Keep quiet about it.' },
    { entity_type: 'tool', scope: 'workspace', title: `${mk} recruiter portal`, summary: 'Where the offer letter lives.' },
  ] });
  assert.equal(ws.err, false, ws.text);
  const portal = (await rowsLike(O.orgId, `${mk} recruiter`))[0];
  await store.addGraphEvidence({
    evidence_id: `ev_${uuidv4()}`, owner_key: O.orgId, project_id: Q, session_id: 'manual', node_id: (await q('SELECT node_id FROM context_graph_nodes WHERE owner_key=$1 AND canonical_key=$2', [O.orgId, portal.canonical_key])).rows[0].node_id,
    tool: 'test', excerpt: 'seen in Q', metadata: {}, confidence: 0.9, created_at: new Date().toISOString(),
  });
  assert.equal((await rowsLike(O.orgId, `Runway ${mk}`))[0].project_id, null);
  // Q is the founder's most recently updated project.
  await q('UPDATE context_projects SET updated_at = NOW() + interval \'1 day\' WHERE project_id = $1', [Q]);

  const M = await makePerson('s31p3m');
  await join(O, M);
  const mkey = await mintKey(M, O.orgId);
  const rows = await rowsLike(O.orgId, mk);
  assert.equal(rows.length, 4);
  // Scan 32 (L4): the workspace-level ones are MARKED private to the founder
  // and keep no project (round 31 moved them into one, which deleting that
  // project then destroyed). The id-less ones were filed under P (R1).
  const marks = (await q('SELECT title, project_id, metadata->>\'private_to\' AS private_to FROM context_graph_nodes WHERE owner_key=$1 AND title ILIKE $2 AND node_type <> \'project\'', [O.orgId, `%${mk}%`])).rows;
  for (const row of marks.filter((r) => /recruiter|Runway/i.test(r.title))) {
    assert.equal(row.project_id, null, `${row.title} stays workspace-level`);
    assert.equal(row.private_to, O.userId, `${row.title} is private to the founder`);
  }
  for (const row of rows.filter((r) => !/recruiter|Runway/i.test(r.title))) assert.equal(row.project_id, P, row.title);

  const theirs = await mcpCall(mkey, O.orgId, 'recall', { action: 'entities', query: mk });
  assert.match(theirs.text, /No workspace entities found/, theirs.text);
  const search = await mcpCall(mkey, O.orgId, 'recall', { action: 'search', query: `${mk} therapist runway` });
  assert.doesNotMatch(search.text, new RegExp(mk), search.text);
  const brief = await mcpCall(mkey, O.orgId, 'start_session', {});
  assert.doesNotMatch(brief.text, new RegExp(mk), brief.text);
  const rest = await as('get', `/api/v1/context/workspace/entities?query=${mk}&format=json`, M, O.orgId);
  assert.deepEqual((rest.body.entities || []).map((e) => e.title), []);

  const mine = await mcpCall(okey, O.orgId, 'recall', { action: 'entities', query: mk });
  for (const text of ['fire contractor', 'Nair', 'Runway', 'Recruiter Portal']) assert.match(mine.text, new RegExp(text, 'i'), mine.text);
});

test('R1 (p7): a solo user\'s top-level project_id reaches that project\'s brief and a project-scoped recall', async () => {
  const S = await makePerson('s31p7', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const P = await newProject(S, 'SoloP');
  const Q = await newProject(S, 'SoloQ');
  const mk = `Kafka${tag()}`;
  const r = await upsert(key, S.orgId, { project_id: P, entities: [
    { entity_type: 'decision', title: `Decided to use ${mk} for events` },
    { entity_type: 'service', title: `${mk} cluster`, summary: 'Event backbone for the P service mesh.' },
  ] });
  assert.equal(r.err, false, r.text);
  const scoped = await mcpCall(key, S.orgId, 'recall', { action: 'entities', project_id: P, scope: 'project' });
  assert.match(scoped.text, new RegExp(`Decided to use ${mk}`), scoped.text);
  assert.match(scoped.text, new RegExp(`${mk} Cluster`, 'i'), scoped.text);
  const briefP = await mcpCall(key, S.orgId, 'start_session', { project_id: P });
  assert.match(briefP.text, new RegExp(`Knowledge web:[^\\n]*${mk}`), briefP.text);
  const briefQ = await mcpCall(key, S.orgId, 'start_session', { project_id: Q });
  assert.doesNotMatch(briefQ.text, new RegExp(mk), briefQ.text);
});

for (const how of ['upsert', 'resolve']) {
  test(`R1 (p80, ${how}): a solo user's saved decision is resolved as an entity too`, async () => {
    const S = await makePerson(`s31p80${how[0]}`);
    const key = await mintKey(S, S.orgId);
    const P = await newProject(S, 'Api');
    await mcpCall(key, S.orgId, 'start_session', { project_id: P });
    const D = `Decided to put every public endpoint behind the ${tag()} gateway rate limiter.`;
    assert.equal((await upsert(key, S.orgId, { entities: [{ entity_type: 'decision', title: D, summary: D }] })).err, false);
    assert.equal((await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', summary: D })).err, false);
    await wait(1200);
    const r = how === 'upsert'
      ? await upsert(key, S.orgId, { entities: [{ entity_type: 'decision', title: D, metadata: { status: 'resolved' } }] })
      : await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: D });
    assert.equal(r.err, false, r.text);
    await wait(300);
    const nodes = (await q('SELECT project_id, metadata->>\'status\' AS status FROM context_graph_nodes WHERE owner_key=$1 AND node_type=\'decision\' AND title=$2', [S.orgId, D])).rows;
    assert.deepEqual(nodes.map((n) => [n.project_id, n.status]), [[P, 'resolved']]);
    const seen = await mcpCall(key, S.orgId, 'recall', { action: 'entities', query: 'gateway rate limiter' });
    assert.doesNotMatch(seen.text, /gateway rate limiter/, seen.text);
  });
}

test('R1 (p81): a solo project\'s graph and Trail carry the entities saved while working in it', async () => {
  const S = await makePerson('s31p81', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const A = await newProject(S, 'Payments');
  await mcpCall(key, S.orgId, 'start_session', { project_id: A });
  const mk = tag();
  const r = await upsert(key, S.orgId, { entities: [
    { entity_type: 'service', title: `Stripe Connect ${mk}`, summary: 'Pays out sellers; webhooks at /hooks/connect.' },
    { entity_type: 'database', title: `Payout ledger ${mk}`, summary: 'Postgres table payouts_ledger holds every transfer.' },
  ] });
  assert.equal(r.err, false, r.text);
  const graph = await as('get', `/api/v1/context/graph/projects/${A}`, S, S.orgId);
  assert.equal(graph.status, 200);
  const titles = (graph.body.nodes || graph.body.graph?.nodes || []).map((n) => n.title);
  assert.ok(titles.some((title) => /Stripe Connect/i.test(title)), JSON.stringify(titles));
  const trail = await as('get', `/api/v1/context/projects/${A}/trail`, S, S.orgId);
  const nodes = (trail.body.trail || trail.body).content.graph.nodes;
  const ledger = nodes.find((n) => /Payout Ledger/i.test(n.title));
  assert.ok(ledger, JSON.stringify(nodes.map((n) => n.title)));
  // R6: the node's description travels (it was dropped as `summary`).
  assert.equal(ledger.body, 'Postgres table payouts_ledger holds every transfer.');
});

// ── R2. A dispatcher-supplied project never adopts ──────────────────────────

test('R2 (p6): scope:"project" with no project_id never takes the team\'s node into a personal project', async () => {
  const t = await team('s31p6');
  const mk = tag();
  const seed = await upsert(t.keys.O, t.T, { entities: [
    { entity_type: 'service', scope: 'workspace', title: `Stripe billing ${mk}`, summary: 'The team billing platform for all products.' },
    { entity_type: 'decision', scope: 'workspace', title: `All teams deploy ${mk} through the shared pipeline` },
  ] });
  assert.equal(seed.err, false, seed.text);
  const Mine = await newProject(t.M, 'Mine', t.T);
  await share(t.M, t.T, Mine, { visibility: 'personal' });
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: Mine });
  const r = await upsert(t.keys.M, t.T, { entities: [
    { entity_type: 'service', scope: 'project', title: `Stripe billing ${mk}`, summary: 'The team billing platform for all products.' },
    { entity_type: 'decision', scope: 'project', title: `All teams deploy ${mk} through the shared pipeline`, metadata: { importance: 'high' } },
  ] });
  assert.equal(r.err, false, r.text);
  const rows = await rowsLike(t.T, mk);
  assert.deepEqual(rows.map((row) => row.project_id), [null, null], JSON.stringify(rows));
  for (const who of ['O', 'M2']) {
    const seen = await mcpCall(t.keys[who], t.T, 'recall', { action: 'entities', query: `Stripe billing ${mk}` });
    assert.match(seen.text, /Stripe Billing/i, `${who}: ${seen.text}`);
  }
  // A NEW entity asked for with scope:"project" is filed there.
  const fresh = await upsert(t.keys.M, t.T, { entities: [{ entity_type: 'service', scope: 'project', title: `Side cache ${mk}`, summary: 'Caches the side project renders.' }] });
  assert.equal(fresh.err, false, fresh.text);
  assert.deepEqual((await rowsLike(t.T, `Side cache ${mk}`)).map((row) => row.project_id), [Mine]);
});

// ── R3. Cross-project by sighting ──────────────────────────────────────────

test('R3: a solo user saving the same service from A then B keeps one node in A that the portfolio counts in both', async () => {
  const S = await makePerson('s31r3', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const A = await newProject(S, 'Web');
  const B = await newProject(S, 'Mobile');
  const mk = tag();
  for (const project of [A, B]) {
    await mcpCall(key, S.orgId, 'start_session', { project_id: project });
    const r = await upsert(key, S.orgId, { entities: [{ entity_type: 'service', title: `Auth0 login ${mk}`, summary: 'Auth0 provides login for every app we ship.' }] });
    assert.equal(r.err, false, r.text);
  }
  assert.deepEqual((await rowsLike(S.orgId, mk)).map((row) => row.project_id), [A]);
  const portfolio = await mcpCall(key, S.orgId, 'recall', { action: 'portfolio' });
  assert.match(portfolio.text, new RegExp(`Auth0 Login ${mk} \\(service\\): (Web|Mobile) [a-f0-9]+, (Web|Mobile) [a-f0-9]+`, 'i'), portfolio.text);
  // Saving it again from B records no second sighting.
  await upsert(key, S.orgId, { entities: [{ entity_type: 'service', title: `Auth0 login ${mk}` }] });
  const sightings = (await q('SELECT count(*)::int AS n FROM context_graph_evidence WHERE owner_key=$1 AND project_id=$2', [S.orgId, B])).rows[0].n;
  assert.equal(sightings, 1);

  // In a team a sighting widens nobody's view: a member's personal node saved
  // again from a team project they own is not recorded there, so a colleague
  // still cannot read it.
  const t = await team('s31r3t');
  const Side = await newProject(t.M, 'Side', t.T);
  await share(t.M, t.T, Side, { visibility: 'personal' });
  const Team = await newProject(t.M, 'Team', t.T);
  const mark = `Sidecache${tag()}`;
  for (const project of [Side, Team]) {
    await mcpCall(t.keys.M, t.T, 'start_session', { project_id: project });
    const r = await upsert(t.keys.M, t.T, { entities: [{ entity_type: 'knowledge', title: `${mark} redis notes`, summary: 'My side project cache, password in 1Password.' }] });
    assert.equal(r.err, false, r.text);
  }
  assert.deepEqual((await rowsLike(t.T, mark)).map((row) => row.project_id), [Side]);
  const colleague = await mcpCall(t.keys.M2, t.T, 'recall', { action: 'entities', query: mark });
  assert.match(colleague.text, /No workspace entities found/, colleague.text);
});

// ── R6. Trail import ───────────────────────────────────────────────────────

test('R6 (p9): a Trail imported into a member\'s personal project files its graph there, with its descriptions', async () => {
  const t = await team('s31p9');
  const Src = await newProject(t.M, 'Src', t.T);
  await share(t.M, t.T, Src, { visibility: 'personal' });
  const Dst = await newProject(t.M, 'Dst', t.T);
  await share(t.M, t.T, Dst, { visibility: 'personal' });
  const mk = `Globex${tag()}`;
  const seed = await upsert(t.keys.M, t.T, { project_id: Src, entities: [
    { entity_type: 'knowledge', title: `Acquisition talks with ${mk}`, summary: 'Confidential: they are buying us in Q1, do not share.' },
    { entity_type: 'decision', title: `Decided to accept the ${mk} offer` },
  ] });
  assert.equal(seed.err, false, seed.text);
  const exported = await as('get', `/api/v1/context/projects/${Src}/trail`, t.M, t.T)
    .buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); });
  assert.equal(exported.status, 200);
  await q('DELETE FROM context_graph_nodes WHERE owner_key=$1 AND title ILIKE $2', [t.T, `%${mk}%`]);
  const imported = await as('post', '/api/v1/context/trail/import', t.M, t.T).send({ trail: exported.body, project_id: Dst });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  let rows = [];
  for (let i = 0; i < 20 && rows.length < 2; i += 1) {
    await wait(250);
    rows = await rowsLike(t.T, mk);
  }
  assert.deepEqual(rows.map((row) => row.project_id), [Dst, Dst], JSON.stringify(rows));
  assert.equal(rows.find((row) => row.node_type === 'knowledge').summary, 'Confidential: they are buying us in Q1, do not share.');
  const seen = await mcpCall(t.keys.M2, t.T, 'recall', { action: 'entities', query: mk });
  assert.match(seen.text, /No workspace entities found/, seen.text);
});

// ── R7. A hidden node's key does not block anybody else ─────────────────────

test('R7 (p83): a member\'s personal "Stripe" no longer blocks the owner from saving the team\'s', async () => {
  const t = await team('s31p83');
  const Side = await newProject(t.M, 'Side', t.T);
  await share(t.M, t.T, Side, { visibility: 'personal' });
  const mk = tag();
  const name = `Stripe${mk}`;
  const personal = await upsert(t.keys.M, t.T, { project_id: Side, entities: [{ entity_type: 'service', title: name, summary: 'Payments for my side project.' }] });
  assert.equal(personal.err, false, personal.text);
  const P = await newProject(t.O, 'Team', t.T);
  await mcpCall(t.keys.O, t.T, 'start_session', { project_id: P });
  const first = await upsert(t.keys.O, t.T, {
    entities: [
      { entity_type: 'service', title: name, summary: 'Team billing provider for every product.' },
      { entity_type: 'person', title: `Dana ${mk}`, summary: 'Dana owns billing and the Stripe account.' },
    ],
    relations: [{ from_canonical_key: `person:dana-${mk}`, to_canonical_key: `service:${name.toLowerCase()}`, relation_type: 'owns' }],
  });
  assert.equal(first.err, false, first.text);
  assert.match(first.text, /Upserted 2 workspace entities\..*Recorded 1 relation\./, first.text);
  // Later saves for P land on the owner's node: id-less and a named project.
  // scope:"workspace" is a different home, so (scan 32, landGraphWrite) it is
  // the owner's workspace-level node, `::in.workspace` — never a colleague's.
  for (const entity of [
    { entity_type: 'service', title: name, summary: 'Team billing provider for every product.' },
    { entity_type: 'service', title: name, project_id: P, metadata: { importance: 'high' } },
    { entity_type: 'service', title: name, scope: 'workspace', summary: 'Billing provider every team project uses.' },
  ]) {
    const r = await upsert(t.keys.O, t.T, { entities: [entity] });
    assert.equal(r.err, false, r.text);
    assert.doesNotMatch(r.text, /Skipped|not_found/, r.text);
  }
  const rows = (await q('SELECT canonical_key, project_id, summary FROM context_graph_nodes WHERE owner_key=$1 AND node_type=\'service\' AND title ILIKE $2 ORDER BY created_at', [t.T, `%${mk}%`])).rows;
  assert.deepEqual(rows.map((row) => row.project_id), [Side, P, null], JSON.stringify(rows));
  assert.equal(rows[0].summary, 'Payments for my side project.', 'the member\'s node is untouched');
  assert.notEqual(rows[1].canonical_key, rows[0].canonical_key);
  assert.equal(rows[2].canonical_key, `${rows[0].canonical_key}::in.workspace`);
  const ownerSees = await mcpCall(t.keys.O, t.T, 'recall', { action: 'entities', query: name });
  assert.match(ownerSees.text, /Team billing provider/, ownerSees.text);
  assert.doesNotMatch(ownerSees.text, /side project/, ownerSees.text);
  const memberSees = await mcpCall(t.keys.M, t.T, 'recall', { action: 'entities', query: name });
  assert.match(memberSees.text, /side project/, memberSees.text);
  // The member's own later save still lands on their own node.
  const again = await upsert(t.keys.M, t.T, { project_id: Side, entities: [{ entity_type: 'service', title: name, metadata: { importance: 'high' } }] });
  assert.equal(again.err, false, again.text);
  assert.equal((await q('SELECT count(*)::int AS n FROM context_graph_nodes WHERE owner_key=$1 AND node_type=\'service\' AND title ILIKE $2', [t.T, `%${mk}%`])).rows[0].n, 3);
  // Once the plain key is free again (the member deleted theirs), the owner's
  // save still lands on the owner's node, not a new one beside it.
  await q('DELETE FROM context_graph_nodes WHERE owner_key=$1 AND project_id=$2 AND node_type=\'service\'', [t.T, Side]);
  const later = await upsert(t.keys.O, t.T, { entities: [{ entity_type: 'service', title: name, metadata: { importance: 'critical' } }] });
  assert.equal(later.err, false, later.text);
  const left = (await q('SELECT project_id, metadata->>\'importance\' AS importance FROM context_graph_nodes WHERE owner_key=$1 AND node_type=\'service\' AND title ILIKE $2 AND project_id IS NOT NULL', [t.T, `%${mk}%`])).rows;
  assert.deepEqual(left.map((row) => [row.project_id, row.importance]), [[P, 'critical']]);
});
