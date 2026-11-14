/**
 * SCAN 33. What round 32's landing rule and per-person profile left open.
 *
 *   S1. Evidence never NARROWS a workspace-level node. A node with no project
 *       is every member's (unless metadata.private_to names someone else); the
 *       projects it was seen in decide nothing about who reads it. Before, the
 *       first session anywhere that named it took it from everyone else: a
 *       member's personal flush (a/p1, b/p94), the owner's own flush in a
 *       project whose share withholds services (b/p94b), and the founder's
 *       publish of a pre-team note a solo session had mentioned (a/p3).
 *   S2. Erasing a person erases their private_to notes in every workspace
 *       (a/p4).
 *   S3. The rebuild never forks what one person alone reads: a private_to row
 *       is landed on for the writer's own personal project, and the writer's
 *       own `::in.<H>` copy wins over their private row (a/p2, b/p95). Round 33
 *       also landed on a row homed in another of the writer's own projects with
 *       the same readers; scan 34 REVERTED that (a later visibility change
 *       published it — scan34-fixes.test.js T1), so b/p98 and b/p101 now pin
 *       their intent on the read side: one scoped copy per project, and the
 *       portfolio still counts the entity once, across both projects.
 *   S4. A scoped decision's key matches its own text, so resolving a long one
 *       resolves it (b/p97).
 *   S5. A "you" profile in a teammate's project's extraction is saved nowhere
 *       (b/p96). Round 33 saved it to the member's own profile; journey round 5
 *       (owner decision) made extraction never write the profile at all, so this
 *       now pins that neither the member's nor the author's profile moves.
 *   S6. A resolve refused over one title in several homes names the homes and
 *       asks for project_id (b/p100).
 *   S7. The platform system key keeps its pre-person profile (a/F5).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan33-fixes.test.js
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
const { createTeamWorkspaceFixture } = require('../helpers/teamWorkspaceFixture');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const erasure = require('../../src/services/dataErasureService');

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
  let r = request(httpServer).post('/mcp').set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  r = await r.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
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
const recall = (key, ws, query) => mcpCall(key, ws, 'recall', { action: 'entities', query });
// The portfolio rows (unlocked) whose title is `title`.
async function portfolioRows(person, ws, title) {
  const res = await as('get', `/api/v1/context/portfolio?q=${encodeURIComponent(title)}`, person, ws);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.locked, false, 'precondition: the portfolio is unlocked on this plan');
  return (res.body.entities?.entries || []).filter((entry) => entry.title === title);
}

const graphRows = async (ownerKey, types = ['service', 'decision', 'person']) => (await q(
  `SELECT node_id, node_type, title, summary, canonical_key, project_id, metadata
     FROM context_graph_nodes
    WHERE owner_key = $1 AND node_type = ANY($2)
    ORDER BY created_at`,
  [ownerKey, types],
)).rows;

// The non-explicit POST /extraction every end-of-session flush makes: the delta
// is applied and the project's graph is rebuilt from its whole stored context.
async function flush(person, ws, projectId, delta) {
  const res = await as('post', '/api/v1/context/extraction', person, ws).send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: projectId,
    chunk: { role: 'user', text: 'status update' },
    extraction: { match_decision: 'matched_existing', confidence: 0.9, should_create_project: false, needs_user_confirmation: false, delta },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body).slice(0, 300));
  await wait(300);
  return res;
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

const today = () => new Date().toISOString();

// ── S1. Evidence never narrows a workspace-level node ─────────────────────────

test('S1 (a/p1): a member\'s personal flush neither hides the team\'s workspace node nor rewrites it', async () => {
  const t = await team('s33p1');
  const mk = tag();
  const kafka = `Kafka${mk}`;
  const vault = `Vault${mk}`;
  const S = await newProject(t.O, 'TeamS', t.T);
  await share(t.O, t.T, S, { visibility: 'shared' });
  const saved = await upsert(t.keys.O, t.T, { entities: [
    { entity_type: 'service', title: kafka, summary: `TEAMWIDE${mk} event bus for every service we run`, scope: 'workspace' },
    // Shorter than the 40 characters the store keeps: a derived write could replace it.
    { entity_type: 'service', title: vault, summary: `TEAMV${mk} secrets`, scope: 'workspace' },
  ] });
  assert.equal(saved.err, false, saved.text);
  assert.match((await recall(t.keys.M2, t.T, kafka)).text, /TEAMWIDE/, 'precondition: a teammate reads it');

  const Side = await newProject(t.M, 'SideHustle', t.T);
  await share(t.M, t.T, Side, { visibility: 'personal' });
  await flush(t.M, t.T, Side, { tech_stack: [kafka, vault] });

  const rows = (await graphRows(t.T, ['service'])).filter((row) => row.title.includes(mk));
  assert.equal(rows.length, 2, JSON.stringify(rows.map((r) => r.canonical_key)));
  for (const row of rows) assert.equal(row.project_id, null, 'still workspace-level');
  const vaultRow = rows.find((row) => row.title.includes('Vault'));
  assert.match(vaultRow.summary, /TEAMV/, 'the team\'s description is not replaced by the member\'s project');
  assert.doesNotMatch(vaultRow.summary, /SideHustle/);

  for (const [who, key] of [['owner', t.keys.O], ['member', t.keys.M2], ['the flusher', t.keys.M]]) {
    const seen = await recall(key, t.T, kafka);
    assert.match(seen.text, /TEAMWIDE/, `${who} lost the team node: ${seen.text}`);
    assert.doesNotMatch(seen.text, /SideHustle/, `${who}: ${seen.text}`);
  }
  const listed = await as('get', '/api/v1/context/workspace/entities', t.M2, t.T);
  assert.ok(JSON.stringify(listed.body).includes(`TEAMWIDE${mk}`), 'REST entities list it for a teammate');
  // Where it was seen stays with that project's readers.
  const graph = await as('get', `/api/v1/context/graph/nodes/${rows[0].node_id}`, t.M2, t.T);
  assert.doesNotMatch(JSON.stringify(graph.body), new RegExp(Side), 'the member\'s personal evidence does not travel');
});

test('S1 (b/p94): the team node and decision stay resolvable and re-savable after a member\'s personal flush', async () => {
  const t = await team('s33p94');
  const P = await newProject(t.O, 'Team94', t.T);
  await share(t.O, t.T, P, { visibility: 'shared' });
  await mcpCall(t.keys.O, t.T, 'start_session', { project_id: P });
  const D = 'Decided to run every service on Fly.io.';
  const saved = await upsert(t.keys.O, t.T, { entities: [
    { title: 'Postgres', entity_type: 'service', scope: 'workspace', summary: 'TEAM: primary database on RDS us-east-1 for every service.' },
    { title: D, entity_type: 'decision', scope: 'workspace', summary: 'TEAM: Fly.io for all deploys, agreed at the kickoff.' },
  ] });
  assert.equal(saved.err, false, saved.text);

  const MP = await newProject(t.M, 'Side94', t.T);
  await share(t.M, t.T, MP, { visibility: 'personal' });
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: MP });
  await flush(t.M, t.T, MP, { tech_stack: ['postgres'], recent_decisions: [{ summary: D, decided_at: today() }] });

  assert.match((await recall(t.keys.O, t.T, 'Postgres')).text, /TEAM: primary database/);
  assert.match((await recall(t.keys.M2, t.T, 'Postgres')).text, /TEAM: primary database/);
  assert.match((await recall(t.keys.M2, t.T, 'Fly.io')).text, /Fly\.io/);

  const resolved = await mcpCall(t.keys.O, t.T, 'manage_memory', { action: 'resolve', title: D });
  assert.match(resolved.text, /Marked resolved/, resolved.text);

  const again = await upsert(t.keys.O, t.T, { entities: [{ title: 'Postgres', entity_type: 'service', scope: 'workspace', summary: 'TEAM: primary database.' }] });
  assert.equal(again.err, false, again.text);
  const scoped = (await graphRows(t.T)).filter((row) => row.canonical_key.includes('::in.'));
  assert.deepEqual(scoped.map((row) => row.canonical_key), [], 'the owner\'s re-save lands on the team node, no fork');
});

test('S1 (b/p94b): the owner\'s own flush in a project that withholds services from members does not hide the workspace node', async () => {
  const O = await makePerson('s33p94bo', { plan: 'developer_pro' });
  const M = await makePerson('s33p94bm');
  await join(O, M);
  const T = O.orgId;
  const okey = await mintKey(O, T);
  const mkey = await mintKey(M, T);
  const P = await newProject(O, 'Team94b', T);
  await mcpCall(okey, T, 'start_session', { project_id: P });
  const saved = await upsert(okey, T, { entities: [
    { title: 'Postgres', entity_type: 'service', scope: 'workspace', summary: 'TEAM: the one database every service uses.' },
  ] });
  assert.equal(saved.err, false, saved.text);
  await mcpCall(mkey, T, 'start_session', { project_id: P });
  assert.match((await recall(mkey, T, 'Postgres')).text, /TEAM: the one database/, 'precondition');

  await flush(O, T, P, { tech_stack: ['Postgres'] });
  const seen = await recall(mkey, T, 'Postgres');
  assert.match(seen.text, /TEAM: the one database/, seen.text);
});

test('S1 (a/p3): the founder publishing a pre-team note a solo session mentioned publishes it', async () => {
  const O = await makePerson('s33p3', { plan: 'developer_pro' });
  const T = O.orgId;
  const key = await mintKey(O, T);
  const mk = tag();
  const sentry = `Sentry${mk}`;
  const A = await newProject(O, 'Alpha', T);
  await mcpCall(key, T, 'start_session', { project_id: A });
  const s = await upsert(key, T, { entities: [{ entity_type: 'service', title: sentry, summary: 'Error tracking for every repo; DSN in 1Password.', scope: 'workspace' }] });
  assert.equal(s.err, false, s.text);
  await flush(O, T, A, { tech_stack: [sentry] });
  const M = await makePerson('s33p3m');
  await join(O, M);
  const mkey = await mintKey(M, T);
  assert.match((await recall(mkey, T, sentry)).text, /No workspace entities found/, 'precondition: private until published');

  const pub = await upsert(key, T, { entities: [{ entity_type: 'service', title: sentry, scope: 'workspace' }] });
  assert.match(pub.text, /now shared with the workspace/, pub.text);
  const theirs = await recall(mkey, T, sentry);
  assert.match(theirs.text, /Error tracking for every repo/, `the reply said shared: ${theirs.text}`);
});

// ── S2. Erasure takes private_to notes ───────────────────────────────────────

test('S2 (a/p4): erasing the founder erases their pre-team private notes in the team they leave behind', async () => {
  const O = await makePerson('s33p4', { plan: 'developer_pro' });
  const T = O.orgId;
  const key = await mintKey(O, T);
  const mk = tag();
  const A = await newProject(O, 'Alpha', T);
  await mcpCall(key, T, 'start_session', { project_id: A });
  const s = await upsert(key, T, { entities: [
    { entity_type: 'person', title: `Dr. Lena Park ${mk}`, summary: `CARDIO${mk}: my cardiologist; follow-up in March about the arrhythmia.`, scope: 'workspace' },
  ] });
  assert.equal(s.err, false, s.text);
  const M = await makePerson('s33p4m');
  await join(O, M);
  await q('UPDATE workspace_members SET role = \'owner\' WHERE owner_key = $1 AND user_id = $2', [T, M.userId]);
  const note = async () => (await q(
    'SELECT node_id, project_id, metadata->>\'private_to\' AS pt FROM context_graph_nodes WHERE owner_key = $1 AND summary ILIKE $2',
    [T, `%CARDIO${mk}%`],
  )).rows;
  const before = await note();
  assert.equal(before.length, 1);
  assert.equal(before[0].pt, O.userId, 'precondition: marked private to the founder');
  const vectors = await q('SELECT COUNT(*)::int AS n FROM context_graph_embeddings WHERE target_id = $1', [before[0].node_id]).catch(() => ({ rows: [{ n: 0 }] }));

  const report = await erasure.erasePersonData({ userIds: [O.userId], identities: [O.userId] });
  assert.deepEqual(await note(), [], `the founder's private note survived erasure: ${JSON.stringify(report)}`);
  assert.equal(report.private_to_context_graph_nodes, 1);
  if (vectors.rows[0].n) {
    const left = await q('SELECT COUNT(*)::int AS n FROM context_graph_embeddings WHERE target_id = $1', [before[0].node_id]);
    assert.equal(left.rows[0].n, 0, 'its vector goes with it');
  }
});

test('S2: DELETE-account erasure (purgeOwnerData) takes the person\'s private notes in other workspaces too', async () => {
  const O = await makePerson('s33p4b', { plan: 'developer_pro' });
  const T = O.orgId;
  const key = await mintKey(O, T);
  const mk = tag();
  await upsert(key, T, { entities: [{ entity_type: 'knowledge', title: `Diary ${mk}`, summary: `DIARY${mk}: private solo-era note.`, scope: 'workspace' }] });
  const M = await makePerson('s33p4bm');
  await join(O, M);
  const count = async () => Number((await q('SELECT COUNT(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1 AND summary ILIKE $2', [T, `%DIARY${mk}%`])).rows[0].n);
  assert.equal(await count(), 1);
  // The founder's HOME org is some other workspace here: T is erased as "elsewhere".
  const home = await makeOrg('s33p4b-home', 'free');
  const report = await erasure.purgeOwnerData(home, { userIds: [O.userId], identities: [O.userId] });
  assert.equal(await count(), 0, JSON.stringify(report));
});

// ── S3. The rebuild never forks what one person alone reads ──────────────────

// Scan 34 changed this pin: the founder's Redis is homed in Alpha, and Beta's
// rebuild now writes Beta's own copy (the rebuild never lands on a row homed in
// another project — T1). What still holds: the pre-team note is not forked,
// stays private and unseen, and the portfolio counts Redis once, in both.
test('S3 (a/p2): the founder\'s flushes after the first invite fork no private note; the portfolio still counts one Redis', async () => {
  const O = await makePerson('s33p2', { plan: 'developer_pro' });
  const T = O.orgId;
  const key = await mintKey(O, T);
  const mk = tag();
  const redis = `Redis${mk}`;
  const sentry = `Sentry${mk}`;
  const A = await newProject(O, 'Alpha', T);
  const B = await newProject(O, 'Beta', T);
  await mcpCall(key, T, 'start_session', { project_id: A });
  await upsert(key, T, { entities: [{ entity_type: 'service', title: sentry, summary: 'Error tracking everywhere', scope: 'workspace' }] });
  await flush(O, T, A, { tech_stack: [redis, sentry] });
  await flush(O, T, B, { tech_stack: [redis, sentry] });
  const mine = async () => (await graphRows(T, ['service'])).filter((row) => row.title.includes(mk));
  assert.equal((await mine()).length, 2, 'precondition: one node each, solo');

  const M = await makePerson('s33p2m');
  await join(O, M);
  const mkey = await mintKey(M, T);
  for (let i = 0; i < 2; i += 1) {
    await flush(O, T, A, { current_task: `task ${i}` });
    await flush(O, T, B, { current_task: `task ${i}` });
  }
  const rows = await mine();
  const sentries = rows.filter((row) => row.title.includes('Sentry'));
  assert.equal(sentries.length, 1, `the pre-team note forked: ${JSON.stringify(rows.map((r) => r.canonical_key))}`);
  assert.equal(sentries[0].metadata.private_to, O.userId, 'the pre-team note stays private');
  assert.deepEqual(
    rows.filter((row) => row.title.includes('Redis')).map((row) => row.canonical_key).sort(),
    [`service:${redis.toLowerCase()}`, `service:${redis.toLowerCase()}::in.${B}`].sort(),
    'Beta holds its own copy of Redis; Alpha keeps the node it was first seen in',
  );
  assert.match((await recall(mkey, T, mk)).text, /No workspace entities found/, 'the member sees none of it');
  const listed = await portfolioRows(O, T, redis);
  assert.equal(listed.length, 1, JSON.stringify(listed));
  assert.equal(listed[0].project_count, 2);
});

test('S3 (b/p95): the founder\'s save in a team project reuses the copy the rebuild made there', async () => {
  const F = await makePerson('s33p95', { plan: 'developer_pro' });
  const T = F.orgId;
  const fkey = await mintKey(F, T);
  const D1 = 'Decided to use Stripe for billing.';
  const solo = await upsert(fkey, T, { entities: [
    // scope:"workspace": no project yet, and a save must ask for the workspace (journey r5).
    { title: D1, entity_type: 'decision', summary: 'Stripe Billing with usage-based metering.', scope: 'workspace' },
    { title: 'Stripe', entity_type: 'service', summary: 'Payments provider; account under the company email.', scope: 'workspace' },
  ] });
  assert.equal(solo.err, false, solo.text);
  const M = await makePerson('s33p95m');
  await join(F, M);
  const P = await newProject(F, 'Team95', T);
  await mcpCall(fkey, T, 'start_session', { project_id: P });
  await flush(F, T, P, { tech_stack: ['Stripe'], recent_decisions: [{ summary: D1, decided_at: today() }] });

  const saved = await upsert(fkey, T, { entities: [{ title: 'Stripe', entity_type: 'service', summary: 'Payments provider for the team.' }] });
  assert.equal(saved.err, false, saved.text);
  const inP = (await graphRows(T, ['service'])).filter((row) => row.project_id === P && /stripe/i.test(row.title));
  assert.equal(inP.length, 1, `two Stripe nodes in the team project: ${JSON.stringify(inP.map((r) => r.canonical_key))}`);
  const brief = await mcpCall(fkey, T, 'start_session', { project_id: P });
  assert.doesNotMatch(brief.text, /service: Stripe \| service: Stripe/, brief.text);
  // The pre-team note itself is still the founder's alone.
  const mkey = await mintKey(M, T);
  assert.doesNotMatch((await recall(mkey, T, 'Stripe')).text, /company email/);
});

// Scan 34 changed these two pins (T1): after the invite, each of the founder's
// projects holds its own copy of an entity first seen in the other, because
// a rebuild never lands on a row homed in another project. The intent they
// pinned — the entity counts as ONE cross-project entity — is now kept on the
// read side (portfolioService groups copies by their plain key). recall lists
// both copies; that duplication is the accepted cost.
test('S3 (b/p98): after the first invite the founder\'s projects each keep a copy, and the portfolio counts one entity in both', async () => {
  const F = await makePerson('s33p98', { plan: 'developer_pro' });
  const T = F.orgId;
  const D = 'Decided every service logs JSON to stdout.';
  const A = await newProject(F, 'Api98', T);
  const W = await newProject(F, 'Web98', T);
  const stack = (extra = []) => ({ tech_stack: ['Postgres', 'Redis', ...extra], recent_decisions: [{ summary: D, decided_at: today() }] });
  await flush(F, T, A, stack());
  await flush(F, T, W, stack());
  const M = await makePerson('s33p98m');
  await join(F, M);
  await flush(F, T, W, stack(['Kafka0']));
  await flush(F, T, A, stack(['Sentry0']));

  const rows = await graphRows(T, ['service', 'decision']);
  const scoped = rows.filter((row) => row.canonical_key.includes('::in.'));
  assert.ok(scoped.every((row) => row.canonical_key.endsWith(`::in.${W}`) && row.project_id === W),
    `only Web98's own copies: ${JSON.stringify(scoped.map((r) => r.canonical_key))}`);
  assert.equal(rows.filter((row) => row.canonical_key === 'service:postgres').length, 1);
  const pg = await portfolioRows(F, T, 'Postgres');
  assert.equal(pg.length, 1, JSON.stringify(pg));
  assert.equal(pg[0].project_count, 2, 'one entity, counted across both projects');
  assert.deepEqual(pg[0].projects.map((p) => p.project_id).sort(), [A, W].sort());
  // Nobody else reads either copy.
  const mkey = await mintKey(M, T);
  assert.match((await recall(mkey, T, 'Postgres')).text, /No workspace entities found/);
});

test('S3 (b/p101): one person in a workspace created as a team: one copy per project, one portfolio entity', async () => {
  const F = await makePerson('s33p101', { plan: 'developer_pro' });
  const created = await createTeamWorkspaceFixture(F, `Acme ${tag()}`);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const W = created.body.workspace;
  const A = await newProject(F, 'Api101', W);
  const B = await newProject(F, 'Web101', W);
  const D = 'Decided every service logs JSON to stdout.';
  await flush(F, W, A, { tech_stack: ['Postgres'], recent_decisions: [{ summary: D, decided_at: today() }] });
  await flush(F, W, B, { tech_stack: ['Postgres'], recent_decisions: [{ summary: D, decided_at: today() }] });
  const rows = await graphRows(W, ['service', 'decision']);
  assert.deepEqual(
    rows.filter((row) => row.node_type === 'service').map((row) => row.canonical_key).sort(),
    ['service:postgres', `service:postgres::in.${B}`].sort(),
  );
  // The portfolio is a paid view; the new workspace starts on its own plan.
  await q('UPDATE organizations SET plan = $2, plan_tier = $2 WHERE org_id = $1', [W, 'developer_pro']);
  const pg = await portfolioRows(F, W, 'Postgres');
  assert.equal(pg.length, 1, JSON.stringify(pg));
  assert.equal(pg[0].project_count, 2);
});

test('S3: a teammate\'s rebuild still never lands on a founder\'s private note or a colleague\'s personal node', async () => {
  const t = await team('s33keep');
  const mk = tag();
  const Side = await newProject(t.M, 'Side', t.T);
  await share(t.M, t.T, Side, { visibility: 'personal' });
  await upsert(t.keys.M, t.T, { project_id: Side, entities: [{ entity_type: 'service', title: `Redis${mk}`, summary: `MINE${mk}: personal cache` }] });
  // A personal project of the OWNER's: same visibility, different author.
  const OSide = await newProject(t.O, 'OSide', t.T);
  await share(t.O, t.T, OSide, { visibility: 'personal' });
  await flush(t.O, t.T, OSide, { tech_stack: [`Redis${mk}`] });
  const rows = (await graphRows(t.T, ['service'])).filter((row) => row.title.includes(mk));
  const members = rows.find((row) => row.project_id === Side);
  assert.match(members.summary, /MINE/);
  const crossing = await q('SELECT COUNT(*)::int AS n FROM context_graph_evidence WHERE node_id = $1 AND project_id = $2', [members.node_id, OSide]);
  assert.equal(crossing.rows[0].n, 0, 'no evidence across two different people\'s personal projects');
  assert.ok(rows.some((row) => row.canonical_key.endsWith(`::in.${OSide}`)), JSON.stringify(rows.map((r) => r.canonical_key)));
});

// ── S4. A scoped decision matches its own text ───────────────────────────────

test('S4 (b/p97): resolving a long decision whose node here is a scoped copy resolves that node', async () => {
  const O = await makePerson('s33p97o', { plan: 'developer_pro' });
  const M = await makePerson('s33p97m');
  await join(O, M);
  const T = O.orgId;
  const okey = await mintKey(O, T);
  const mkey = await mintKey(M, T);
  const P1 = await newProject(O, 'Api97', T);
  const P2 = await newProject(M, 'Web97', T);
  const D = 'Decided to keep every tenant in one Postgres cluster with row-level security, because per-tenant databases multiplied migration time by the tenant count, made cross-tenant analytics impossible without an ETL job, and our largest customer contract requires a single audited data store with point-in-time recovery.';
  await mcpCall(okey, T, 'start_session', { project_id: P1 });
  await flush(O, T, P1, { recent_decisions: [{ summary: D, decided_at: today() }] });
  await mcpCall(mkey, T, 'start_session', { project_id: P2 });
  await flush(M, T, P2, { recent_decisions: [{ summary: D, decided_at: today() }] });
  const scopedRow = async () => (await graphRows(T, ['decision'])).find((row) => row.canonical_key.endsWith(`::in.${P2}`));
  assert.ok(await scopedRow(), 'precondition: Web97 has its own scoped copy');

  const brief = await mcpCall(mkey, T, 'start_session', { project_id: P2 });
  const shown = (brief.text.match(/Recent decisions: ([^\n]+)/) || [])[1] || D;
  const resolved = await mcpCall(mkey, T, 'manage_memory', { action: 'resolve', title: shown });
  assert.match(resolved.text, /Marked resolved/, resolved.text);
  assert.equal((await scopedRow()).metadata.status, 'resolved', 'the scoped node itself is resolved');
  const after = await mcpCall(mkey, T, 'start_session', { project_id: P2 });
  assert.doesNotMatch(after.text, /Knowledge web:[^\n]*decision: Decided to keep every tenant/, after.text);
});

// ── S5. The "you" profile is the person's, wherever they work ───────────────

test('S5 (b/p96): a member\'s you_profile in a teammate\'s shared project is saved to nobody\'s profile', async () => {
  const O = await makePerson('s33p96o', { plan: 'developer_pro' });
  const M = await makePerson('s33p96m');
  await join(O, M);
  const T = O.orgId;
  const P = await newProject(O, 'Team96', T);
  await as('patch', '/api/v1/context/global', O, T).send({ user_profile: 'O-PROFILE: founder.' });
  const mk = tag();
  await flush(M, T, P, { you_profile: { goals: [`M goal ${mk}`], working_style: `M-STYLE${mk} terse` } });
  await wait(500);
  const row = async (personId) => (await q('SELECT global FROM context_globals WHERE owner_key = $1 AND person_id = $2', [T, personId])).rows[0]?.global || {};
  const mine = await row(M.userId);
  assert.doesNotMatch(JSON.stringify(mine), new RegExp(mk), 'extraction never writes the profile');
  assert.doesNotMatch(JSON.stringify(await row(O.userId)), new RegExp(mk), 'nothing lands on the author\'s profile');
  // And it changed nothing in the project it was learned in.
  const project = await as('get', `/api/v1/context/projects/${P}/inject`, O, T);
  assert.doesNotMatch(JSON.stringify(project.body), new RegExp(`M-STYLE${mk}`));
});

// ── S6. One title in several homes ──────────────────────────────────────────

test('S6 (b/p100): a resolve refused over identical titles names the projects and asks for project_id', async () => {
  const O = await makePerson('s33p100o', { plan: 'developer_pro' });
  const M = await makePerson('s33p100m');
  await join(O, M);
  const T = O.orgId;
  const okey = await mintKey(O, T);
  const mkey = await mintKey(M, T);
  const Api = await newProject(O, 'Api100', T);
  const Gw = await newProject(M, 'Gateway100', T);
  const Scratch = await newProject(M, 'Scratch100', T);
  const D = 'Decided to rate-limit the public API at 100 requests per minute.';
  await mcpCall(okey, T, 'start_session', { project_id: Api });
  await flush(O, T, Api, { recent_decisions: [{ summary: D, decided_at: today() }] });
  await mcpCall(mkey, T, 'start_session', { project_id: Gw });
  await flush(M, T, Gw, { recent_decisions: [{ summary: D, decided_at: today() }] });

  await mcpCall(mkey, T, 'start_session', { project_id: Scratch });
  const refused = await mcpCall(mkey, T, 'manage_memory', { action: 'resolve', title: D });
  assert.match(refused.text, /nothing was resolved/, refused.text);
  assert.match(refused.text, /project_id/, refused.text);
  assert.ok(refused.text.includes(Gw), `the member's own copy is named by project: ${refused.text}`);
  assert.match(refused.text, /Gateway100/, refused.text);
  assert.doesNotMatch(refused.text, /Re-run with the exact, complete title/, refused.text);
  const done = await mcpCall(mkey, T, 'manage_memory', { action: 'resolve', title: D, project_id: Gw });
  assert.match(done.text, /Marked resolved|resolved/i, done.text);
});

// ── S7. The system key's profile ─────────────────────────────────────────────

test('S7 (a/F5): the platform system key keeps its pre-person profile', async () => {
  const system = { type: 'system', id: 'system-key', role: 'admin', org_id: 'org-system', scopes: ['*'] };
  const mk = tag();
  const reset = async () => {
    await q('DELETE FROM context_globals WHERE owner_key = $1 AND person_id IN ($2, $3)', ['org-system', '', 'system:system-key']);
    await q('INSERT INTO context_globals (owner_key, global) VALUES ($1, $2)', ['org-system', JSON.stringify({ user_profile: `SYSTEM-PROFILE-${mk}` })]);
  };
  // Read lazily: the key claims its row on first read.
  await reset();
  assert.equal((await service.getGlobalContext(system)).user_profile, `SYSTEM-PROFILE-${mk}`);
  // Claimed at boot.
  await reset();
  await store.claimLegacyGlobals();
  const rows = (await q('SELECT person_id FROM context_globals WHERE owner_key = $1 AND global::text LIKE $2', ['org-system', `%SYSTEM-PROFILE-${mk}%`])).rows;
  assert.deepEqual(rows.map((row) => row.person_id), ['system:system-key']);
  assert.equal((await service.getGlobalContext(system)).user_profile, `SYSTEM-PROFILE-${mk}`);
});
