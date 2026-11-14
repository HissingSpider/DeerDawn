/**
 * SCAN 27 (a). A resolve marks exactly the decision or entity the caller means,
 * in the project they are working in (named or active), and when it cannot, the
 * reply says why — while "resolve by the text I see" always works when exactly
 * one thing matches.
 *
 *   1. HIGH (round-26 regression): a decision or task over 80 characters named by
 *      its FULL text was refused ("No entity is titled exactly") — titles are
 *      stored cut to 79 + "...". An entity is now named exactly by its title, its
 *      canonical key (the slug of the full text) or, for a decision, the shared
 *      decision matcher.
 *   2. HIGH: a resolve WITHOUT project_id went to the entity search and resolved
 *      whichever project's node it found: the same decision in A and B with B
 *      active flipped A and left B open for good (a Trail copy flipped its
 *      source). An omitted project_id is the active project, as for update.
 *   3. MEDIUM: project_id naming a PARENT refused a decision recorded in its
 *      subproject (a parent's brief does not carry its subprojects' decisions).
 *      When exactly one subproject holds it, it is resolved there and said.
 *   4. MEDIUM: a stale project_id was a generic resource_not_found. It is an
 *      error naming the id and how to list projects — never a silent resolve
 *      elsewhere.
 *   5. MEDIUM: resolve_question appended its answer with slice(-20), dropping a
 *      critical decision before resolved ones. It uses capDecisions.
 *   6. LOW: upsert_entities {project_id: B, status: "active"} on the node A filed
 *      first answered "Upserted 1" and reopened nothing. It reopens B's entry.
 *   7. LOW: an over-long resolve title (the 500 character cap is frozen) is
 *      refused with the way through: pass the first 80+ characters.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan27-a-fixes.test.js
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
  const created = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: `${name} ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

async function solo(label) {
  const S = await makePerson(label, { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  return { S, key };
}

const decisionsOf = async (ownerKey, projectId) => Object.fromEntries(((await store.getProject(ownerKey, projectId)).context.recent_decisions || [])
  .map((d) => [d.summary, Boolean(d.resolved)]));
const decisionNodes = async (ownerKey, projectId) => (await q(
  `SELECT node_id, canonical_key, title, summary, metadata->>'status' AS status FROM context_graph_nodes
   WHERE owner_key = $1 AND node_type = 'decision' AND ($2::text IS NULL OR project_id = $2) ORDER BY created_at`,
  [ownerKey, projectId],
)).rows;


const extract = (S, P, delta, text) => as('post', '/api/v1/context/extraction', S, S.orgId).send({
  session_id: `s-${uuidv4()}`, tool: 'claude_code', project_id: P, chunk: { role: 'user', text },
  extraction: { match_decision: 'matched_existing', confidence: 0.95, project_candidate: { project_id: P, project_name: 'x' }, delta, should_create_project: false, needs_user_confirmation: false },
});
const decide = (S, P, summary) => extract(S, P, { recent_decisions: [{ summary, decided_at: new Date().toISOString() }] }, `We decided: ${summary}`);
const LONG = (tag) => `Adopt the shared BullMQ queue ${tag} for every background job, with three retries, exponential backoff and a DLQ`;

// ── 1: the complete text of a long decision or task names it ────────────────

test('1a: a decision over 80 characters resolves by its complete text, with and without project_id', async () => {
  for (const withPid of [false, true]) {
    const { S, key } = await solo(`long-dec-${withPid}`);
    const P = await newProject(S, 'long-dec');
    const text = LONG(uuidv4().slice(0, 6));
    assert.equal((await decide(S, P, text)).status, 202);
    const nodes = await decisionNodes(S.orgId, P);
    assert.equal(nodes[0].title.length, 82, 'the node title is the cut one');
    const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: text, ...(withPid ? { project_id: P } : {}) });
    assert.match(r.text, /Marked resolved/, `pid=${withPid}: ${r.text}`);
    assert.equal((await decisionsOf(S.orgId, P))[text], true, `pid=${withPid}: the brief entry is resolved`);
  }
});

test('1b: a task over 80 characters resolves by its complete text, with and without project_id', async () => {
  for (const withPid of [false, true]) {
    for (const et of ['task', undefined]) {
      const { S, key } = await solo(`long-task-${withPid}`);
      const P = await newProject(S, 'long-task');
      const task = `Wire the billing webhook ${uuidv4().slice(0, 6)} into the Team seat counter so removed seats are credited pro rata next cycle`;
      assert.equal((await extract(S, P, { current_task: task }, `Working on: ${task}`)).status, 202);
      const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: task, ...(et ? { entity_type: et } : {}), ...(withPid ? { project_id: P } : {}) });
      assert.match(r.text, /Marked resolved/, `pid=${withPid} et=${et}: ${r.text}`);
      const nodes = (await store.listGraphNodes(S.orgId, { nodeTypes: ['task'], limit: 50, includeResolved: true })).filter((n) => n.project_id === P);
      assert.deepEqual(nodes.map((n) => n.metadata?.status), ['resolved'], `pid=${withPid} et=${et}`);
    }
  }
});

test('1c: a decision aged out of the named brief still resolves its node by its complete text', async () => {
  const { S, key } = await solo('aged-out');
  const P = await newProject(S, 'aged');
  const text = LONG(uuidv4().slice(0, 6));
  await decide(S, P, text);
  for (let i = 0; i < 21; i++) await decide(S, P, `Filler decision number ${i} ${uuidv4().slice(0, 6)} about the cache layout.`);
  assert.equal((await decisionsOf(S.orgId, P))[text], undefined, 'the brief no longer lists it');
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: text, entity_type: 'decision' });
  assert.match(r.text, /Marked resolved/, r.text);
  const node = (await decisionNodes(S.orgId, P)).find((n) => (n.summary || '').startsWith(text.slice(0, 40)));
  assert.equal(node.status, 'resolved');
});

// ── 2: no project_id means the active project ───────────────────────────────

test('2a: the same decision in A and B, B active: a resolve with no project_id resolves B, and only B', async () => {
  for (const path of ['/mcp', '/mcp/claude']) {
    const { S, key } = await solo('active');
    const A = await newProject(S, 'Repo A');
    const B = await newProject(S, 'Repo B');
    const D = `Decided to use Postgres 16 ${uuidv4().slice(0, 6)} for the primary ledger database.`;
    const E = `Decided to keep the payout exporter ${uuidv4().slice(0, 6)} behind a flag until launch.`;
    for (const P of [A, B]) for (const d of [D, E]) {
      assert.equal((await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: d }, path)).err, false);
      await wait(400);
    }
    const sel = await mcpCall(key, S.orgId, 'manage_projects', { action: 'select', project_id: B }, path);
    assert.equal(sel.err, false, sel.text);
    const r1 = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: D }, path);
    assert.match(r1.text, /Marked resolved/, r1.text);
    const r2 = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: E, entity_type: 'decision' }, path);
    assert.match(r2.text, /Marked resolved/, r2.text);
    assert.deepEqual(await decisionsOf(S.orgId, B), { [D]: true, [E]: true }, `${path}: B, the active project, is resolved`);
    assert.deepEqual(await decisionsOf(S.orgId, A), { [D]: false, [E]: false }, `${path}: A is untouched`);
    const again = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: D }, path);
    assert.match(again.text, /already resolved in/, again.text);
  }
});

test('2b: a decision only in another project than the active one is refused, naming the project to pass', async () => {
  const { S, key } = await solo('other');
  const A = await newProject(S, 'Repo A');
  const B = await newProject(S, 'Repo B');
  const D = `Decided to shard the ledger ${uuidv4().slice(0, 6)} by merchant.`;
  await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: A, summary: D });
  await wait(600);
  await mcpCall(key, S.orgId, 'manage_projects', { action: 'select', project_id: B });
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: D });
  assert.match(r.text, /not in the active project/, r.text);
  assert.ok(r.text.includes(`project_id: "${A}"`), r.text);
  assert.equal((await decisionsOf(S.orgId, A))[D], false, 'A was not resolved behind the caller');
});

test('2c: a Trail copy, selected as active, resolves its own decision and not its source', async () => {
  const { S, key } = await solo('trail');
  const P = await newProject(S, 'Trail Src');
  const long = `Decided to keep ${'the settlement worker isolated from the web tier and '.repeat(6)}end ${uuidv4().slice(0, 6)}.`;
  await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: long });
  await wait(1000);
  const exp = await mcpCall(key, S.orgId, 'manage_memory', { action: 'export_trail', project_id: P });
  const sc = JSON.parse(exp.raw).result?.structuredContent || {};
  const trail = sc.trail || sc.archive;
  assert.ok(trail, exp.text.slice(0, 200));
  const copyName = `Trail Copy ${uuidv4().slice(0, 6)}`;
  const imp = await mcpCall(key, S.orgId, 'manage_memory', { action: 'import_trail', trail: typeof trail === 'string' ? trail : JSON.stringify(trail), new_project_name: copyName });
  assert.equal(imp.err, false, imp.text);
  const copyId = (await q('SELECT project_id FROM context_projects WHERE owner_key=$1 AND project_name=$2', [S.orgId, copyName])).rows[0].project_id;
  await wait(800);
  await mcpCall(key, S.orgId, 'manage_projects', { action: 'select', project_id: copyId });
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: long });
  assert.match(r.text, /Marked resolved/, r.text);
  assert.equal((await decisionsOf(S.orgId, copyId))[long], true, 'the copy is resolved');
  assert.equal((await decisionsOf(S.orgId, P))[long], false, 'the source is untouched');
});

// ── 3: a parent names its subproject's decision ─────────────────────────────

test('3: project_id naming a parent resolves the decision in its one subproject, and says so', async () => {
  for (const len of ['short', 'long']) {
    const { S, key } = await solo(`parent-${len}`);
    const parent = await newProject(S, 'Umbrella');
    const sub = await newProject(S, 'Payments sub');
    const link = await as('post', `/api/v1/context/projects/${sub}/parent`, S, S.orgId).send({ parent_project_id: parent });
    assert.ok(link.status < 300, JSON.stringify(link.body));
    const text = len === 'short' ? `Use Postgres ${uuidv4().slice(0, 6)} for the ledger.` : LONG(uuidv4().slice(0, 6));
    await decide(S, sub, text);
    const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: text, project_id: parent, entity_type: 'decision' });
    assert.match(r.text, /In subproject Payments sub/, `${len}: ${r.text}`);
    assert.match(r.text, /Marked resolved/, `${len}: ${r.text}`);
    assert.equal((await decisionsOf(S.orgId, sub))[text], true, `${len}: the subproject's entry is resolved`);
  }
});

test('3b: two subprojects holding it is refused with their names', async () => {
  const { S, key } = await solo('parent-two');
  const parent = await newProject(S, 'Umbrella');
  const text = `Use Postgres ${uuidv4().slice(0, 6)} for the ledger.`;
  const subs = [];
  for (const name of ['Sub one', 'Sub two']) {
    const sub = await newProject(S, name);
    await as('post', `/api/v1/context/projects/${sub}/parent`, S, S.orgId).send({ parent_project_id: parent });
    await decide(S, sub, text);
    subs.push(sub);
  }
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: text, project_id: parent });
  assert.match(r.text, /2 of its subprojects, so nothing was resolved/, r.text);
  for (const sub of subs) assert.equal((await decisionsOf(S.orgId, sub))[text], false);
});

// ── 4: an unknown project_id is said, not swallowed ─────────────────────────

test('4: a project_id that names nothing is an error naming it and how to list projects', async () => {
  const { S, key } = await solo('bogus');
  const P = await newProject(S, 'real');
  const text = `Use Postgres ${uuidv4().slice(0, 6)} for the ledger.`;
  await decide(S, P, text);
  const bogus = `project_${uuidv4()}`;
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', title: text, project_id: bogus, entity_type: 'decision' });
  assert.equal(r.err, true, r.text);
  assert.ok(r.text.includes(`No project "${bogus}" that you can see`), r.text);
  assert.match(r.text, /recall\(action:"projects"\)/, r.text);
  assert.doesNotMatch(r.text, /resource_not_found/, r.text);
  assert.equal((await decisionsOf(S.orgId, P))[text], false, 'nothing was resolved elsewhere');
});

// ── 5: resolve_question keeps the critical decision ─────────────────────────

test('5: resolve_question on a full decision log evicts a resolved decision, never the critical one', async () => {
  const { S, key } = await solo('rq-cap');
  const P = await newProject(S, 'Cap');
  const now = Date.now();
  const decisions = [{ summary: 'CRITICAL: never run migrations against the primary during business hours.', importance: 'critical', decided_at: new Date(now - 40 * 86400000).toISOString() }];
  for (let i = 1; i <= 17; i++) decisions.push({ summary: `Decided detail number ${i} for the payout pipeline.`, decided_at: new Date(now - (20 - i) * 3600000).toISOString() });
  decisions.push({ summary: 'Decided to drop the old CSV exporter.', resolved: true, decided_at: new Date(now - 3600000).toISOString() });
  decisions.push({ summary: 'Decided to use SQS for the retry queue.', resolved: true, decided_at: new Date(now - 1800000).toISOString() });
  const seeded = await as('patch', `/api/v1/context/projects/${P}/context`, S).send({ recent_decisions: decisions, open_questions: ['Which region hosts the worker?'] });
  assert.equal(seeded.status, 200);
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve_question', project_id: P, question: 'Which region hosts the worker?', answer: 'iad, next to the primary database.' });
  assert.match(r.text, /Resolved/, r.text);
  const after = (await store.getProject(S.orgId, P)).context.recent_decisions;
  assert.equal(after.length, 20);
  assert.ok(after.some((d) => d.summary.startsWith('CRITICAL')), 'the critical decision is kept');
  assert.ok(after.some((d) => d.summary === 'Decided: iad, next to the primary database.'), 'the answer is recorded');
  assert.equal(after.filter((d) => d.resolved).length, 1, 'a resolved decision made the room');
});

// ── 6: a reopen naming B reopens B ──────────────────────────────────────────

test('6: upsert_entities status active naming B reopens B\'s entry, not A\'s node', async () => {
  const { S, key } = await solo('reopen');
  const A = await newProject(S, 'Repo A');
  const B = await newProject(S, 'Repo B');
  const D = `Decided to use Postgres 16 ${uuidv4().slice(0, 6)} for the primary ledger database.`;
  for (const P of [A, B]) { await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: D }); await wait(600); }
  const entity = (status) => ({ entity_type: 'decision', scope: 'project', project_id: B, title: D, summary: D, metadata: { status } });
  const r1 = await mcpCall(key, S.orgId, 'manage_memory', { action: 'upsert_entities', entities: [entity('resolved')] });
  assert.match(r1.text, /Resolved in the decision log/, r1.text);
  assert.equal((await decisionsOf(S.orgId, B))[D], true);
  const r2 = await mcpCall(key, S.orgId, 'manage_memory', { action: 'upsert_entities', entities: [entity('active')] });
  assert.match(r2.text, /Reopened in the decision log of Repo B/, r2.text);
  assert.equal((await decisionsOf(S.orgId, B))[D], false, 'B is open again');
  assert.equal((await decisionsOf(S.orgId, A))[D], false, 'A was never touched');
  const r3 = await mcpCall(key, S.orgId, 'manage_memory', { action: 'upsert_entities', entities: [entity('active')] });
  assert.match(r3.text, /already open in the decision log/, r3.text);
});

// ── 7: an over-long title says how to name the decision instead ─────────────

test('7: an over-long resolve title is refused with the way through', async () => {
  const { S, key } = await solo('overlong');
  const P = await newProject(S, 'long');
  const r = await mcpCall(key, S.orgId, 'manage_memory', { action: 'resolve', project_id: P, title: `Decided ${'x'.repeat(520)}` });
  assert.equal(r.err, true);
  assert.match(r.text, /exceeds the 500 character limit/, r.text);
  assert.match(r.text, /first 80 or more characters/, r.text);
});
