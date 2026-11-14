/**
 * SCAN 32 (a). Graph nodes are unique per (owner_key, node_type, canonical_key)
 * across a whole team workspace, while READ visibility is per project and
 * evidence. Every write path that landed on an existing row by its plain key
 * could cross a privacy boundary: it added evidence in the writer's project (the
 * row became readable there), merged the writer's text into a colleague's
 * private row, or refused because the row was somebody else's. Round 31 fixed
 * that for manage_memory's hidden-holder case only. The rules now:
 *
 *   L1. ONE landing rule (service.landGraphWrite) for every graph write: the
 *       extraction rebuild (recordGraphArtifacts — the session-end flush and
 *       resolve_question), upsert_entities, auto-promotion, structured events
 *       and Trail import. A write for home H lands on the plain-key row only
 *       when that row is H's, or is workspace-level and the writer may edit it;
 *       otherwise on the writer's own node for H, `<key>::in.<H|workspace>`.
 *       p1, p84 (the rebuild), p87a/b (readable but not writable), p89 (a
 *       colleague's scoped node is not the caller's own).
 *   L2. A sighting is a usage record for the portfolio, never a read grant (p5).
 *   L3. Relations and resolve pick the caller's landed node (p10, p86).
 *   L4. The first invite marks pre-team no-project nodes private to the founder
 *       (metadata.private_to) instead of moving them into a project: deleting a
 *       project cannot take them (p9), a founder with no project is covered
 *       (p91), and the founder publishing one is a re-save (p6, p85).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan32-a-fixes.test.js
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

async function mcpCall(key, ws, name, args) {
  const r = await request(httpServer).post('/mcp').set({ Accept: 'application/json, text/event-stream' })
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

const upsert = (key, ws, args) => mcpCall(key, ws, 'manage_memory', { action: 'upsert_entities', ...args });

const nodesLike = async (ownerKey, marker) => (await q(
  `SELECT node_id, node_type, title, summary, canonical_key, project_id, metadata
     FROM context_graph_nodes
    WHERE owner_key = $1 AND (title ILIKE $2 OR summary ILIKE $2) AND node_type <> 'project'
    ORDER BY created_at`,
  [ownerKey, `%${marker}%`],
)).rows;

// Evidence rows hanging off the nodes homed in `homeProject`, recorded in `inProject`.
const evidenceCrossing = async (ownerKey, homeProject, inProject) => (await q(
  `SELECT n.canonical_key FROM context_graph_evidence e JOIN context_graph_nodes n ON n.node_id = e.node_id
    WHERE e.owner_key = $1 AND n.project_id = $2 AND e.project_id = $3`,
  [ownerKey, homeProject, inProject],
)).rows;

// The non-explicit POST /extraction every end-of-session flush makes
// (packages/mcp-server src/flush-session.ts): the delta is applied and the
// project's graph is rebuilt from its whole stored context.
function flush(person, ws, projectId, delta) {
  return as('post', '/api/v1/context/extraction', person, ws).send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: projectId,
    chunk: { role: 'user', text: 'status update' },
    extraction: { match_decision: 'matched_existing', confidence: 0.9, should_create_project: false, needs_user_confirmation: false, delta },
  });
}

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

const VIEW_ONLY_STACK_AND_DECISIONS = [
  { section_key: 'recent_decisions', can_view: true, can_edit: false },
  { section_key: 'tech_stack', can_view: true, can_edit: false },
];

// ── L1. The rebuild ────────────────────────────────────────────────────────

test('L1 (a/p1): a team project\'s rebuild never lands on, or exposes, a member\'s personal node', async () => {
  const t = await team('s32p1');
  const mk = tag();
  const Side = await newProject(t.M, 'Side', t.T);
  await share(t.M, t.T, Side, { visibility: 'personal' });
  const name = `Stripe${mk}`;
  const decision = `Use Adyen${mk} for billing`;
  const personal = await upsert(t.keys.M, t.T, { project_id: Side, entities: [
    { entity_type: 'service', title: name, summary: `SECRETSUMMARY${mk}: moonlighting payments for a competitor, do not tell anyone` },
    { entity_type: 'decision', title: decision, summary: `SECRETDEC${mk}: because I am leaving the company in March` },
  ] });
  assert.equal(personal.err, false, personal.text);
  const P = await newProject(t.O, 'Team', t.T);
  await share(t.O, t.T, P, { visibility: 'shared' });
  const ex = await flush(t.O, t.T, P, { tech_stack: [name], recent_decisions: [{ summary: decision, decided_at: new Date().toISOString() }] });
  assert.equal(ex.status, 202, JSON.stringify(ex.body).slice(0, 300));
  await wait(300);

  assert.deepEqual(await evidenceCrossing(t.T, Side, P), [], 'no evidence in the team project on the member\'s nodes');
  const rows = await nodesLike(t.T, mk);
  const mine = rows.filter((row) => row.project_id === Side);
  assert.equal(mine.length, 2);
  assert.match(mine.find((row) => row.node_type === 'service').summary, /SECRETSUMMARY/, 'the member\'s node is untouched');
  const ours = rows.filter((row) => row.project_id === P);
  assert.deepEqual(ours.map((row) => row.node_type).sort(), ['decision', 'service'], JSON.stringify(rows.map((r) => [r.canonical_key, r.project_id])));
  for (const row of ours) assert.match(row.canonical_key, new RegExp(`::in\\.${P}$`));

  for (const [key, who] of [[t.keys.O, 'owner'], [t.keys.M2, 'member']]) {
    for (const query of [name, `Adyen${mk}`]) {
      const seen = await mcpCall(key, t.T, 'recall', { action: 'entities', query });
      assert.doesNotMatch(seen.text, /SECRET/, `${who}: ${seen.text}`);
    }
  }
  const owners = await mcpCall(t.keys.O, t.T, 'recall', { action: 'entities', query: `Adyen${mk}` });
  assert.match(owners.text, new RegExp(`Adyen${mk}`, 'i'), 'the owner\'s own rebuild node is there');
  const graph = await as('get', `/api/v1/context/graph/projects/${P}`, t.M2, t.T);
  assert.doesNotMatch(JSON.stringify(graph.body), /SECRET/);
  const exp = await as('get', '/api/v1/context/graph/export', t.M2, t.T);
  assert.doesNotMatch(String(exp.text || JSON.stringify(exp.body)), /SECRET/);
  const theirs = await mcpCall(t.keys.M, t.T, 'recall', { action: 'entities', query: name });
  assert.match(theirs.text, /SECRETSUMMARY/, 'the member still reads their own');
});

test('L1 (b/p84): the session-end flush lands the owner\'s stack and decision on the owner\'s own nodes; owner can save and resolve them', async () => {
  const t = await team('s32p84');
  const mk = tag();
  const Side = await newProject(t.M, 'Side84', t.T);
  await share(t.M, t.T, Side, { visibility: 'personal' });
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: Side });
  const dec = `Decided to use Postgres${mk} for the billing ledger.`;
  const redis = `Redis${mk}`;
  const personal = await upsert(t.keys.M, t.T, { entities: [
    { entity_type: 'decision', title: dec, summary: `PERSONAL-NOTE${mk}: my side gig ledger; Postgres on my NAS, admin creds in my notes.` },
    { entity_type: 'service', title: redis, summary: `PERSONAL-NOTE${mk}: my home-lab Redis on the NAS, used for the side gig queue.` },
  ] });
  assert.equal(personal.err, false, personal.text);

  const P = await newProject(t.O, 'Team84', t.T);
  await mcpCall(t.keys.O, t.T, 'start_session', { project_id: P });
  const upd = await mcpCall(t.keys.O, t.T, 'manage_memory', { action: 'update', summary: dec });
  assert.equal(upd.err, false, upd.text);
  const ex = await flush(t.O, t.T, P, { tech_stack: [redis], recent_decisions: [{ summary: dec, decided_at: new Date().toISOString() }] });
  assert.equal(ex.status, 202, JSON.stringify(ex.body).slice(0, 300));
  await wait(300);

  assert.deepEqual(await evidenceCrossing(t.T, Side, P), []);
  const ownerRecall = await mcpCall(t.keys.O, t.T, 'recall', { action: 'entities', query: redis });
  assert.doesNotMatch(ownerRecall.text, /PERSONAL-NOTE/, ownerRecall.text);
  const graph = await as('get', `/api/v1/context/graph/projects/${P}`, t.O, t.T);
  assert.doesNotMatch(JSON.stringify(graph.body), /PERSONAL-NOTE/);
  const brief = await mcpCall(t.keys.O, t.T, 'start_session', { project_id: P });
  assert.doesNotMatch(brief.text, /PERSONAL-NOTE/);

  const save = await upsert(t.keys.O, t.T, { entities: [{ entity_type: 'service', title: redis, summary: 'Team job queue and cache for every service.' }] });
  assert.equal(save.err, false, save.text);
  const resolve = await mcpCall(t.keys.O, t.T, 'manage_memory', { action: 'resolve', title: dec });
  assert.equal(resolve.err, false, resolve.text);
  const rows = await nodesLike(t.T, mk);
  const memberDecision = rows.find((row) => row.project_id === Side && row.node_type === 'decision');
  assert.notEqual(memberDecision.metadata.status, 'resolved', 'the member\'s decision stays open');
  const ownerDecision = rows.find((row) => row.project_id === P && row.node_type === 'decision');
  assert.ok(ownerDecision, JSON.stringify(rows.map((r) => [r.canonical_key, r.project_id])));
  assert.equal(ownerDecision.metadata.status, 'resolved');
  assert.match(rows.find((row) => row.project_id === Side && row.node_type === 'service').summary, /PERSONAL-NOTE/);

  // Shared with every section: a teammate still reads none of it.
  const sections = ['current_task', 'current_status', 'recent_decisions', 'tech_stack', 'description', 'goals', 'open_questions', 'constraints', 'file_structure_summary']
    .map((section_key) => ({ section_key, can_view: true, can_edit: true }));
  await share(t.O, t.T, P, { visibility: 'shared', sections, members: [] });
  for (const query of [redis, `Postgres${mk}`]) {
    const seen = await mcpCall(t.keys.M2, t.T, 'recall', { action: 'entities', query });
    assert.doesNotMatch(seen.text, /PERSONAL-NOTE/, seen.text);
  }
});

// ── L1. A row the caller can read but not write ────────────────────────────

test('L1 (b/p87a): a member\'s PRIVATE "Postgres" does not block the owner saving the team\'s', async () => {
  const t = await team('s32p87a');
  const mk = tag();
  const Priv = await newProject(t.M, 'Priv87', t.T);
  await share(t.M, t.T, Priv, { visibility: 'private' });
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: Priv });
  const db1 = `Postgres${mk}`;
  const dec = `Decided to deploy everything on Fly${mk}.`;
  const theirs = await upsert(t.keys.M, t.T, { entities: [
    { entity_type: 'database', title: db1, summary: 'Primary database for the private prototype service.' },
    { entity_type: 'decision', title: dec, summary: dec },
  ] });
  assert.equal(theirs.err, false, theirs.text);
  const P = await newProject(t.O, 'Team87', t.T);
  await mcpCall(t.keys.O, t.T, 'start_session', { project_id: P });
  const ours = await upsert(t.keys.O, t.T, { entities: [
    { entity_type: 'database', title: db1, summary: 'Team primary database for all services.' },
    { entity_type: 'decision', title: dec, summary: dec },
  ] });
  assert.equal(ours.err, false, ours.text);
  const named = await upsert(t.keys.O, t.T, { entities: [{ entity_type: 'database', title: db1, summary: 'Team primary database for all services.', project_id: P }] });
  assert.equal(named.err, false, named.text);
  const rows = await nodesLike(t.T, mk);
  assert.deepEqual(rows.filter((row) => row.project_id === P).map((row) => row.node_type).sort(), ['database', 'decision'], JSON.stringify(rows.map((r) => [r.canonical_key, r.project_id])));
  assert.equal(rows.filter((row) => row.project_id === Priv).length, 2);
  assert.equal(rows.find((row) => row.project_id === Priv && row.node_type === 'database').summary, 'Primary database for the private prototype service.');
});

test('L1 (b/p87b): a member\'s own personal save is not refused over a colleague\'s view-only node', async () => {
  const t = await team('s32p87b');
  const mk = tag();
  const Q = await newProject(t.O, 'Ro87', t.T);
  await share(t.O, t.T, Q, { visibility: 'shared', sections: VIEW_ONLY_STACK_AND_DECISIONS, members: [] });
  const dec = `Decided to use Terraform${mk} for all infrastructure.`;
  const tool = `Terraform Cloud ${mk}`;
  const team_ = await upsert(t.keys.O, t.T, { project_id: Q, entities: [
    { entity_type: 'decision', title: dec, summary: dec },
    { entity_type: 'tool', title: tool, summary: 'Runs every infrastructure plan and apply for the team.' },
  ] });
  assert.equal(team_.err, false, team_.text);
  const Mine = await newProject(t.M2, 'Mine87', t.T);
  await share(t.M2, t.T, Mine, { visibility: 'personal' });
  await mcpCall(t.keys.M2, t.T, 'start_session', { project_id: Mine });
  const mine = await upsert(t.keys.M2, t.T, { entities: [
    { entity_type: 'decision', title: dec, summary: dec },
    { entity_type: 'tool', title: tool, summary: 'My own Terraform Cloud org for the side project.' },
  ] });
  assert.equal(mine.err, false, mine.text);
  const rows = await nodesLike(t.T, mk);
  const inMine = rows.filter((row) => row.project_id === Mine);
  assert.deepEqual(inMine.map((row) => row.node_type).sort(), ['decision', 'tool'], JSON.stringify(rows.map((r) => [r.canonical_key, r.project_id])));
  for (const row of inMine) assert.match(row.canonical_key, new RegExp(`::in\\.${Mine}$`));
  assert.equal(rows.find((row) => row.project_id === Q && row.node_type === 'tool').summary, 'Runs every infrastructure plan and apply for the team.');
});

test('L1 (b/p89): a colleague\'s scoped node is not the caller\'s own; the caller gets theirs', async () => {
  const t = await team('s32p89');
  const mk = tag();
  const Side = await newProject(t.M, 'Side89', t.T);
  await share(t.M, t.T, Side, { visibility: 'personal' });
  const tool = `Datadog${mk}`;
  const dec = `Decided to alert on p99 latency above 800ms ${mk}.`;
  assert.equal((await upsert(t.keys.M, t.T, { project_id: Side, entities: [
    { entity_type: 'tool', title: tool, summary: 'My personal Datadog trial for the side project dashboards.' },
    { entity_type: 'decision', title: dec, summary: dec },
  ] })).err, false);
  const P = await newProject(t.O, 'Team89', t.T);
  await share(t.O, t.T, P, { visibility: 'shared', sections: VIEW_ONLY_STACK_AND_DECISIONS, members: [] });
  await mcpCall(t.keys.O, t.T, 'start_session', { project_id: P });
  const owner = await upsert(t.keys.O, t.T, { entities: [
    { entity_type: 'tool', title: tool, summary: 'Team observability: every service ships metrics and traces here.' },
    { entity_type: 'decision', title: dec, summary: dec },
  ] });
  assert.equal(owner.err, false, owner.text);
  const Mine = await newProject(t.M2, 'Mine89', t.T);
  await share(t.M2, t.T, Mine, { visibility: 'personal' });
  await mcpCall(t.keys.M2, t.T, 'start_session', { project_id: Mine });
  const mine = await upsert(t.keys.M2, t.T, { entities: [
    { entity_type: 'tool', title: tool, summary: 'My notes: the staging API key lives in my keychain.' },
    { entity_type: 'decision', title: dec, summary: dec },
  ] });
  assert.equal(mine.err, false, mine.text);
  const wide = await upsert(t.keys.M2, t.T, { entities: [{ entity_type: 'tool', title: tool, summary: 'Team-wide notes on the Datadog account and its agents.', scope: 'workspace' }] });
  assert.equal(wide.err, false, wide.text);
  const rows = await nodesLike(t.T, mk);
  const keys = rows.map((row) => row.canonical_key);
  const toolKey = rows.find((row) => row.project_id === Side && row.node_type === 'tool').canonical_key;
  assert.ok(keys.includes(`${toolKey}::in.${P}`), JSON.stringify(keys));
  assert.ok(keys.includes(`${toolKey}::in.${Mine}`), JSON.stringify(keys));
  assert.ok(keys.includes(`${toolKey}::in.workspace`), JSON.stringify(keys));
  assert.equal(rows.find((row) => row.canonical_key === `${toolKey}::in.${P}`).summary, 'Team observability: every service ships metrics and traces here.');
  assert.equal(rows.filter((row) => row.node_type === 'decision' && row.project_id === Mine).length, 1);
});

// ── L2. A sighting is not a read grant ─────────────────────────────────────

test('L2 (a/p5): a sighting recorded from a personal project does not keep a colleague\'s node readable after it is unshared', async () => {
  const t = await team('s32p5');
  const mk = tag();
  const P = await newProject(t.M2, 'Deal', t.T);
  await share(t.M2, t.T, P, { visibility: 'shared' });
  const dec = `Pick vendor${mk} for payroll`;
  const know = `Vendor${mk} shortlist`;
  assert.equal((await upsert(t.keys.M2, t.T, { project_id: P, entities: [
    { entity_type: 'decision', project_id: P, title: dec, summary: 'Payroll vendor pick pending review.' },
    { entity_type: 'knowledge', project_id: P, title: know, summary: 'Vendor shortlist pending review now.' },
  ] })).err, false);
  const Mine = await newProject(t.M, 'Mine', t.T);
  await share(t.M, t.T, Mine, { visibility: 'personal' });
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: Mine });
  const resave = await upsert(t.keys.M, t.T, { entities: [{ entity_type: 'decision', title: dec }, { entity_type: 'knowledge', title: know }] });
  assert.equal(resave.err, false, resave.text);
  await share(t.M2, t.T, P, { visibility: 'personal' });
  assert.equal((await upsert(t.keys.M2, t.T, { project_id: P, entities: [
    { entity_type: 'decision', project_id: P, title: dec, summary: `CONFIDENTIAL${mk}: going with Gusto because of the CFO's brother`, metadata: { importance: 'critical' } },
    { entity_type: 'knowledge', project_id: P, title: know, summary: `CONFIDENTIAL${mk} shortlist: Gusto, Deel` },
  ] })).err, false);
  const seen = await mcpCall(t.keys.M, t.T, 'recall', { action: 'entities', query: `vendor${mk}` });
  assert.doesNotMatch(seen.text, /CONFIDENTIAL/, seen.text);
  const exp = await as('get', '/api/v1/context/graph/export', t.M, t.T);
  assert.doesNotMatch(String(exp.text || JSON.stringify(exp.body)), /CONFIDENTIAL/);
  const author = await mcpCall(t.keys.M2, t.T, 'recall', { action: 'entities', query: `vendor${mk}` });
  assert.match(author.text, /CONFIDENTIAL/, 'the author still reads it');
});

// ── L3. Relations and resolve ──────────────────────────────────────────────

test('L3 (a/p10): once the plain key is free, a relation naming it reaches the caller\'s own scoped node', async () => {
  const t = await team('s32p10');
  const mk = tag();
  const Side = await newProject(t.M, 'Side', t.T);
  await share(t.M, t.T, Side, { visibility: 'personal' });
  const name = `Stripe${mk}`;
  await upsert(t.keys.M, t.T, { project_id: Side, entities: [{ entity_type: 'service', title: name, summary: 'Payments for my side project, long enough.' }] });
  const P = await newProject(t.O, 'Team', t.T);
  await mcpCall(t.keys.O, t.T, 'start_session', { project_id: P });
  assert.equal((await upsert(t.keys.O, t.T, { entities: [{ entity_type: 'service', title: name, summary: 'Team billing provider for every product.' }] })).err, false);
  await q('DELETE FROM context_graph_nodes WHERE owner_key=$1 AND project_id=$2 AND node_type=\'service\'', [t.T, Side]);
  const same = await upsert(t.keys.O, t.T, {
    entities: [{ entity_type: 'service', title: name }, { entity_type: 'person', title: `Dana ${mk}`, summary: 'Dana owns billing and the account.' }],
    relations: [{ from_canonical_key: `person:dana-${mk}`, to_canonical_key: `service:${name.toLowerCase()}`, relation_type: 'owns' }],
  });
  assert.equal(same.err, false, same.text);
  assert.match(same.text, /Recorded 1 relation/, same.text);
  const only = await upsert(t.keys.O, t.T, {
    entities: [{ entity_type: 'person', title: `Lee ${mk}`, summary: 'Lee also works on billing daily.' }],
    relations: [{ from_canonical_key: `person:lee-${mk}`, to_canonical_key: `service:${name.toLowerCase()}`, relation_type: 'uses' }],
  });
  assert.equal(only.err, false, only.text);
  assert.match(only.text, /Recorded 1 relation/, only.text);
  assert.equal((await nodesLike(t.T, name)).length, 1, 'still one node for the owner');
});

test('L3 (b/p86): resolve by title prefers the caller\'s node in the working project over an identical title elsewhere', async () => {
  const t = await team('s32p86');
  const mk = tag();
  const Side = await newProject(t.M, 'Side86', t.T);
  await share(t.M, t.T, Side, { visibility: 'personal' });
  const dec = `Decided to bill customers monthly in arrears ${mk}.`;
  assert.equal((await upsert(t.keys.M, t.T, { project_id: Side, entities: [{ entity_type: 'decision', title: dec, summary: dec }] })).err, false);
  const P = await newProject(t.O, 'Team86', t.T);
  await mcpCall(t.keys.O, t.T, 'start_session', { project_id: P });
  assert.equal((await upsert(t.keys.O, t.T, { entities: [{ entity_type: 'decision', title: dec, summary: dec }] })).err, false);
  await share(t.M, t.T, Side, { visibility: 'shared' });
  const resolved = await mcpCall(t.keys.O, t.T, 'manage_memory', { action: 'resolve', title: dec });
  assert.equal(resolved.err, false, resolved.text);
  assert.match(resolved.text, /Marked resolved/, resolved.text);
  const rows = await nodesLike(t.T, mk);
  assert.equal(rows.find((row) => row.project_id === P).metadata.status, 'resolved');
  assert.notEqual(rows.find((row) => row.project_id === Side).metadata.status, 'resolved', 'the member\'s decision is not touched');
});

// ── L4. First-invite privacy by mark ───────────────────────────────────────

test('L4 (a/p9): deleting a project after the first invite leaves the founder\'s pre-team notes, still private', async () => {
  const O = await makePerson('s32p9', { plan: 'developer_pro' });
  const T = O.orgId;
  const key = await mintKey(O, T);
  const Main = await newProject(O, 'Main', T);
  const mk = tag();
  await mcpCall(key, T, 'start_session', { project_id: Main });
  assert.equal((await upsert(key, T, { entities: [
    { entity_type: 'person', title: `Sam ${mk}`, summary: 'Sam is my cofounder and reviews every PR I open.', scope: 'workspace' },
    { entity_type: 'preference', title: `Always use pnpm${mk} in every repo`, summary: 'Use pnpm for every repository I own, never npm.', scope: 'workspace' },
  ] })).err, false);
  await wait(50);
  const Scratch = await newProject(O, 'Scratch', T);
  const M = await makePerson('s32p9m');
  await join(O, M);
  const mkey = await mintKey(M, T);
  const del = await as('delete', `/api/v1/context/projects/${Scratch}`, O, T);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const rows = await nodesLike(T, mk);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.project_id, null, `${row.title} stays workspace-level`);
    assert.equal(row.metadata.private_to, O.userId);
  }
  const mine = await mcpCall(key, T, 'recall', { action: 'entities', query: mk });
  assert.match(mine.text, new RegExp(`Sam ${mk}`, 'i'), mine.text);
  const theirs = await mcpCall(mkey, T, 'recall', { action: 'entities', query: mk });
  assert.match(theirs.text, /No workspace entities found/, theirs.text);
});

test('L4 (a/p6): the founder re-saving a pre-team note with scope:"workspace" shares it, and says so', async () => {
  const O = await makePerson('s32p6', { plan: 'developer_pro' });
  const T = O.orgId;
  const key = await mintKey(O, T);
  const A = await newProject(O, 'Alpha', T);
  const mk = tag();
  await mcpCall(key, T, 'start_session', { project_id: A });
  assert.equal((await upsert(key, T, { entities: [
    { entity_type: 'preference', title: `Always use pnpm${mk} in every repo`, summary: 'Use pnpm for every repository I own.', scope: 'workspace' },
    { entity_type: 'person', title: `Sam ${mk}`, summary: 'Sam is my cofounder and reviews every PR.', scope: 'workspace' },
  ] })).err, false);
  const M = await makePerson('s32p6m');
  await join(O, M);
  const mkey = await mintKey(M, T);
  assert.match((await mcpCall(mkey, T, 'recall', { action: 'entities', query: mk })).text, /No workspace entities found/);
  const publish = await upsert(key, T, { entities: [{ entity_type: 'person', title: `Sam ${mk}`, scope: 'workspace' }] });
  assert.equal(publish.err, false, publish.text);
  assert.match(publish.text, /shared with the workspace/i, publish.text);
  const rows = await nodesLike(T, mk);
  assert.equal(rows.length, 2, 'no duplicate');
  const sam = rows.find((row) => row.node_type === 'person');
  assert.equal(sam.project_id, null);
  assert.ok(!sam.metadata.private_to, JSON.stringify(sam.metadata));
  const theirs = await mcpCall(mkey, T, 'recall', { action: 'entities', query: mk });
  assert.match(theirs.text, new RegExp(`Sam ${mk}`, 'i'), theirs.text);
  assert.doesNotMatch(theirs.text, /pnpm/, 'the note not re-saved stays private');
});

test('L4 (b/p85): the founder filing a pre-team note in the team project adopts it there; teammates then share one node', async () => {
  const O = await makePerson('s32p85', { plan: 'developer_pro' });
  const T = O.orgId;
  const key = await mintKey(O, T);
  const A = await newProject(O, 'Api85', T);
  const mk = tag();
  await mcpCall(key, T, 'start_session', { project_id: A });
  const dec = `Decided every repo uses pnpm workspaces and Node 22 ${mk}.`;
  const sentry = `Sentry${mk}`;
  assert.equal((await upsert(key, T, { entities: [
    { entity_type: 'decision', title: dec, summary: dec, scope: 'workspace' },
    { entity_type: 'service', title: sentry, summary: 'Error tracking for every repo; DSN in 1Password.', scope: 'workspace' },
  ] })).err, false);
  const M = await makePerson('s32p85m');
  await join(O, M);
  const mkey = await mintKey(M, T);
  const C = await newProject(O, 'Team85', T);
  assert.equal((await q('SELECT visibility FROM context_projects WHERE project_id=$1', [C])).rows[0].visibility, 'shared');
  await mcpCall(key, T, 'start_session', { project_id: C });
  const filed = await upsert(key, T, { entities: [
    { entity_type: 'decision', title: dec, summary: dec },
    { entity_type: 'service', title: sentry, summary: 'Error tracking for every repo; DSN in 1Password.', scope: 'workspace' },
  ] });
  assert.equal(filed.err, false, filed.text);
  assert.match(filed.text, /filed under/i, filed.text);
  assert.match(filed.text, /shared with the workspace/i, filed.text);
  let rows = await nodesLike(T, mk);
  assert.equal(rows.length, 2, JSON.stringify(rows.map((r) => [r.canonical_key, r.project_id])));
  const decisionRow = rows.find((row) => row.node_type === 'decision');
  assert.equal(decisionRow.project_id, C);
  assert.ok(!decisionRow.metadata.private_to);
  const sentryRow = rows.find((row) => row.node_type === 'service');
  assert.equal(sentryRow.project_id, null);
  assert.ok(!sentryRow.metadata.private_to);

  await mcpCall(mkey, T, 'start_session', { project_id: C });
  const theirs = await mcpCall(mkey, T, 'recall', { action: 'entities', query: 'pnpm' });
  assert.match(theirs.text, new RegExp(mk), theirs.text);
  const memberSave = await upsert(mkey, T, { entities: [{ entity_type: 'service', title: sentry, summary: 'Error tracking for the team; alerts go to oncall.' }] });
  assert.equal(memberSave.err, false, memberSave.text);
  rows = await nodesLike(T, mk);
  assert.equal(rows.filter((row) => row.node_type === 'service').length, 1, JSON.stringify(rows.map((r) => r.canonical_key)));
  const founder = await mcpCall(key, T, 'recall', { action: 'entities', query: sentry });
  assert.equal((founder.text.match(new RegExp(`${sentry}`, 'gi')) || []).length >= 1, true, founder.text);
  assert.equal((founder.text.match(/Error tracking/g) || []).length, 1, founder.text);
});

test('L4 (b/p91): a founder who never created a project publishes nothing to the first colleague', async () => {
  const O = await makePerson('s32p91', { plan: 'developer_pro' });
  const T = O.orgId;
  const key = await mintKey(O, T);
  const mk = tag();
  await mcpCall(key, T, 'start_session', {});
  assert.equal((await upsert(key, T, { entities: [
    // scope:"workspace": with no project a save that does not ask for the
    // workspace is refused (journey r5); the solo-era note this pins IS one.
    { entity_type: 'person', title: `Dr. Lena Park ${mk}`, summary: 'My cardiologist; follow-up in March about the arrhythmia.', scope: 'workspace' },
    { entity_type: 'decision', title: `Decided to sell the house and move to Lisbon ${mk}.`, summary: `Decided to sell the house and move to Lisbon ${mk}.`, scope: 'workspace' },
  ] })).err, false);
  const before = await nodesLike(T, mk);
  assert.equal(before.length, 2);
  for (const row of before) assert.equal(row.project_id, null);
  const M = await makePerson('s32p91m');
  await join(O, M);
  const mkey = await mintKey(M, T);
  const rows = await nodesLike(T, mk);
  for (const row of rows) assert.equal(row.metadata.private_to, O.userId);
  const start = await mcpCall(mkey, T, 'start_session', {});
  assert.doesNotMatch(start.text, new RegExp(mk), start.text);
  const theirs = await mcpCall(mkey, T, 'recall', { action: 'entities' });
  assert.doesNotMatch(theirs.text, new RegExp(mk), theirs.text);
  const search = await mcpCall(mkey, T, 'recall', { action: 'search', query: `Lisbon cardiologist ${mk}` });
  assert.doesNotMatch(search.text, new RegExp(`arrhythmia|Lisbon ${mk}`), search.text);
  const mine = await mcpCall(key, T, 'recall', { action: 'entities', query: mk });
  assert.match(mine.text, /Lena Park/, mine.text);
  assert.match(mine.text, /Lisbon/, mine.text);
});
