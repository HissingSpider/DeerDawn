/**
 * SCAN 21 — WRITERS.
 *
 * Round 19/20 filtered what a teammate READS. The write paths still answered, and
 * wrote, as if the share did not exist:
 *
 *   1. PATCH /projects/:id/context returned updateProjectContext's raw row, so a
 *      member editing the one section a default share lets them edit got every
 *      withheld section back in the reply.
 *   2. Hot paths and debugging notes let a member APPEND to sections the share
 *      withholds (both are withheld on every default share); the reply handed
 *      back the stored list and the text of what the write replaced or evicted,
 *      and the write itself relabelled the owner's path, evicted every hidden
 *      path at the cap, and evicted the owner's note at the cap.
 *   3. POST /verify matched the claim against the raw decision log before the
 *      edit gate, and the 403 named the section it matched: an oracle over text
 *      the caller may not read.
 *   4. A member's extraction overwrote the withheld source_summary with
 *      "Updated from <tool>".
 *
 * THE WRITE RULE for hot paths and debugging notes: the author, a solo account
 * and can_edit rewrite freely; any other member may APPEND, strictly additively
 * (no relabel, no collapse, no eviction of anybody else's entry — refused and
 * nothing saved), and hears stored content only if the share lets them read it.
 * Round 22 refined the eviction half: a FULL list ages (the member's own oldest
 * entry first, never a pinned one) instead of refusing every member write
 * forever — see scan22-fixes.test.js.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan21-writers.test.js
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

async function createProject(person, ws, name) {
  const res = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name });
  assert.equal(res.status, 201, `project create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.project.project_id;
}

const MARK_RE = /ZQ[A-Z]+/g;
const markers = (payload) => [...new Set((JSON.stringify(payload) || '').match(MARK_RE) || [])].sort();

const CONTEXT = () => ({
  description: 'ZQDESC acquisition of Initech',
  current_task: 'ZQTASK migrate ledger quietly',
  current_status: 'ZQSTATUS layoffs pending',
  goals: ['VISGOAL ship the ledger'],
  open_questions: ['ZQQUEST should we tell the board?'],
  recent_decisions: [{ summary: 'Decided: ZQDEC we will cut the payments team', decided_at: new Date().toISOString() }],
  tech_stack: ['ZQSTACK oracle'],
  blocking_issue: 'ZQBLOCK legal hold',
  source_summary: 'ZQSRC exec notes',
  hot_paths: [{ label: 'ZQHOTLABEL payroll', path: 'src/zqhotpath/payroll.js', purpose: 'ZQHOTPURPOSE' }],
  debugging_notes: [{ summary: 'ZQDEBUG the payroll job double-pays execs', paths: ['src/zqdebug.js'], added_at: new Date().toISOString() }],
  landmines: [{ summary: 'ZQLAND never touch the exec table', added_at: new Date().toISOString() }],
});

// A team and a shared project holding a marker in every section. `sections`
// null = the default share (no rows); otherwise the explicit rows.
async function team(sections = null) {
  const tag = uuidv4().slice(0, 6);
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  await join(O, M);
  const T = O.orgId;
  const P = await createProject(O, T, `Ledger ${tag}`);
  const res = await as('patch', `/api/v1/teams/projects/${P}/sharing`, O, T)
    .send(sections ? { visibility: 'shared', sections } : { visibility: 'shared' });
  assert.equal(res.status, 200, `sharing: ${res.status} ${JSON.stringify(res.body)}`);
  const raw = await store.getProject(T, P);
  const Oactor = { id: O.userId, org_id: T, workspace_key: T, type: 'user', role: 'admin' };
  await store.saveProject({ ...raw, context: { ...(raw.context || {}), ...CONTEXT(), project_name: raw.project_name }, updated_at: new Date().toISOString() }, Oactor);
  return { O, M, T, P, name: raw.project_name, stored: async () => (await store.getProject(T, P)).context };
}

// ── 1 ────────────────────────────────────────────────────────────────────────

test('1: PATCH /context answers a member with their view, not the owner\'s row', async () => {
  const { O, M, T, P, stored } = await team();
  const res = await as('patch', `/api/v1/context/projects/${P}/context`, M, T).send({ current_status: 'M status update' });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.project.context.current_status, 'M status update', 'the edit is in the reply');
  // The default share carries task, status, decisions and the board; the task
  // and decision markers are the member's to read. Nothing else is.
  assert.deepEqual(markers(res.body), ['ZQDEC', 'ZQTASK'], 'no withheld section comes back');
  assert.ok((res.body.project.context.withheld_sections || []).includes('hot_paths'), 'the reply says what it withholds');
  assert.equal((await stored()).description, 'ZQDESC acquisition of Initech', 'the save kept the withheld sections');

  // The author still gets the whole row.
  const own = await as('patch', `/api/v1/context/projects/${P}/context`, O, T).send({ current_status: 'O status' });
  assert.equal(own.status, 200);
  assert.equal(own.body.project.context.description, 'ZQDESC acquisition of Initech');
  assert.equal(own.body.project.context.withheld_sections, undefined);
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test('2a: a member appends BLIND to withheld sections: additive only, and the reply reveals nothing stored', async () => {
  const { M, T, P, stored } = await team();
  const before = await stored();
  const key = await mintKey(M, T);

  // The owner's path: left exactly as it was, counted, and not echoed.
  const same = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T)
    .send({ items: [{ label: 'mine', path: 'src/zqhotpath/payroll.js', purpose: 'M overwrote' }] });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.stored, 0);
  assert.equal(same.body.already_recorded, 1);
  assert.equal(same.body.hot_paths, undefined, 'no stored list for a section the member cannot read');
  assert.deepEqual(markers(same.body), []);

  // A new path lands; the reply is counts, not the list.
  const fresh = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T)
    .send({ items: [{ label: 'mine', path: 'src/mine.js' }] });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.stored, 1);
  assert.equal(fresh.body.hot_paths, undefined);
  assert.deepEqual(markers(fresh.body), []);

  // A finding that would collapse onto the owner's note (differs by a count)
  // leaves it alone. Scan 23: answered as already recorded (nothing saved),
  // not refused — and still with no stored text in the reply.
  const collide = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T)
    .send({ summary: 'ZQDEBUG the payroll job double-pays execs 2' });
  assert.equal(collide.status, 200, JSON.stringify(collide.body));
  assert.equal(collide.body.already_recorded, true);
  assert.equal(collide.body.debugging_notes, undefined);
  assert.deepEqual(markers(collide.body), [], 'the reply names no stored text');

  // A new finding lands; the reply carries no stored note and no replaced text.
  const note = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T)
    .send({ summary: 'retries are capped at three in the worker' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  assert.equal(note.body.debugging_notes, undefined);
  assert.equal(note.body.replaced, null);
  assert.deepEqual(note.body.evicted, []);
  assert.deepEqual(markers(note.body), []);

  // /events: same rule, same silence.
  const ev = await as('post', '/api/v1/context/events', M, T).send({
    event_type: 'hot_path_discovered', project_id: P, summary: 'x',
    metadata: { items: [{ label: 'm', path: 'src/zqhotpath/payroll.js' }] },
  });
  assert.equal(ev.status, 202, JSON.stringify(ev.body).slice(0, 300));
  assert.deepEqual(markers(ev.body), []);
  const ev2 = await as('post', '/api/v1/context/events', M, T).send({ event_type: 'debug_finding', project_id: P, summary: 'M event note about queues' });
  assert.equal(ev2.status, 202, JSON.stringify(ev2.body).slice(0, 300));
  assert.deepEqual(markers(ev2.body), []);

  // MCP: record_paths succeeds without echoing; a colliding record_finding is
  // answered as already recorded (scan 23; it was refused) and rewrites nothing.
  const call = async (args) => {
    const r = await request(httpServer).post('/mcp').set({ Accept: 'application/json, text/event-stream' })
      .set('Authorization', `Bearer ${key}`).set('x-deerdawn-workspace', T)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'manage_memory', arguments: args } });
    return r.text || JSON.stringify(r.body);
  };
  const paths = await call({ action: 'record_paths', project_id: P, items: [{ label: 'm2', path: 'src/zqhotpath/payroll.js', purpose: 'M overwrote' }] });
  assert.match(paths, /already recorded/);
  assert.deepEqual(markers(paths), []);
  const finding = await call({ action: 'record_finding', project_id: P, summary: 'ZQDEBUG the payroll job double-pays execs 2' });
  assert.match(finding, /Already recorded/);
  assert.deepEqual(markers(finding).filter((m) => m !== 'ZQDEBUG'), [], 'only the caller\'s own words');
  assert.doesNotMatch(finding, /Replaced an earlier note/, 'no replaced-note text');

  // Supersede is a rewrite: still refused.
  const sup = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T).send({ summary: 'correction', supersedes: 'payroll' });
  assert.equal(sup.status, 403);

  const after = await stored();
  const owners = after.hot_paths.find((h) => h.path === 'src/zqhotpath/payroll.js');
  assert.deepEqual(owners, before.hot_paths[0], 'the owner\'s hot path is untouched');
  assert.ok(after.hot_paths.some((h) => h.path === 'src/mine.js'), 'the member\'s path landed');
  assert.ok(after.debugging_notes.some((d) => d.summary === 'ZQDEBUG the payroll job double-pays execs'), 'the owner\'s note is untouched');
  assert.ok(after.debugging_notes.some((d) => /retries are capped/.test(d.summary)), 'the member\'s note landed');
});

// Round 22: a full list AGES (scan22-fixes.test.js). A member's write makes room
// by aging out their own oldest entry first, else the oldest unpinned one — so
// 40 paths in one call push out the owner's single (oldest) path, and 31
// findings age the member's own notes, never the owner's.
test('2b: 40 paths and 31 findings from a member AGE the lists and echo nothing (default share)', async () => {
  const { M, T, P, stored } = await team();
  const items = Array.from({ length: 40 }, (_, i) => ({ label: `m${i}`, path: `src/m${i}.js`, purpose: 'm' }));
  const hp = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T).send({ items });
  assert.equal(hp.status, 200, JSON.stringify(hp.body));
  assert.equal(hp.body.stored, 40);
  assert.equal(hp.body.aged_out, 1, 'the owner\'s one (oldest) path aged out to make room');
  assert.equal(hp.body.hot_paths, undefined);
  assert.deepEqual(markers(hp.body), []);
  for (let i = 0; i < 31; i += 1) {
    const a = 'abcdefghijklmnopqrstuvwxyz';
    const r = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T)
      .send({ summary: `M finding number ${a[i % 26]}${a[Math.floor(i / 26)]} about module x${a[i % 26]}`, paths: [`src/q${i}.js`] });
    assert.ok([200, 403].includes(r.status), `finding ${i}: ${r.status}`);
    assert.deepEqual(markers(r.body), [], `finding ${i} echoes nothing`);
  }
  const c = await stored();
  assert.equal(c.hot_paths.length, 40);
  assert.ok(!c.hot_paths.some((h) => /ZQHOTLABEL/.test(h.label)), 'the oldest path aged out');
  assert.ok(c.debugging_notes.some((d) => /ZQDEBUG/.test(d.summary)), 'owner note survives: the member\'s own notes aged first');
});

test('2c: viewable but not editable is strictly additive, and the reply carries only what the member may read', async () => {
  const { M, T, P, stored } = await team([
    { section_key: 'current_status', can_view: true, can_edit: true },
    { section_key: 'hot_paths', can_view: true, can_edit: false },
    { section_key: 'debugging_notes', can_view: true, can_edit: false },
  ]);
  // An append lands, and the reply holds the visible sections only.
  const ok = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T).send({ items: [{ label: 'mine', path: 'src/mine.js' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.stored, 1);
  assert.deepEqual(markers(ok.body), ['ZQHOTLABEL', 'ZQHOTPURPOSE'], 'only the section the member may read');

  // Recording the owner's path does not relabel it.
  const same = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T)
    .send({ items: [{ label: 'm2', path: 'src/zqhotpath/payroll.js', purpose: 'M overwrote' }] });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.stored, 0);
  assert.equal(same.body.already_recorded, 1);
  let c = await stored();
  const owners = c.hot_paths.find((h) => h.path === 'src/zqhotpath/payroll.js');
  assert.equal(owners.label, 'ZQHOTLABEL payroll');
  assert.equal(owners.purpose, 'ZQHOTPURPOSE');

  // Filling the capped list AGES it (round 22): the member's own path goes
  // first, then the oldest unpinned one — here the owner's.
  const items = Array.from({ length: 40 }, (_, i) => ({ label: `m${i}`, path: `src/m${i}.js`, purpose: 'm' }));
  const full = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T).send({ items });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal(full.body.aged_out, 2);
  c = await stored();
  assert.equal(c.hot_paths.length, 40);
  assert.ok(!c.hot_paths.some((h) => h.path === 'src/mine.js'), 'the member\'s own path aged first');
  assert.ok(!c.hot_paths.some((h) => /ZQHOTLABEL/.test(h.label)), 'then the oldest unpinned one');

  // A finding that collapses into the owner's note (differs only by a count)
  // leaves it alone (scan 23: already recorded, not refused).
  const collide = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T)
    .send({ summary: 'ZQDEBUG the payroll job double-pays execs 2' });
  assert.equal(collide.status, 200, JSON.stringify(collide.body));
  assert.equal(collide.body.already_recorded, true);
  c = await stored();
  assert.ok(c.debugging_notes.some((d) => d.summary === 'ZQDEBUG the payroll job double-pays execs'), 'owner note kept verbatim');

  // A genuinely new finding lands, and the reply holds the visible log only.
  const fresh = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T).send({ summary: 'retries are capped at three in the worker' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.deepEqual(markers(fresh.body), ['ZQDEBUG']);
  assert.equal(fresh.body.replaced, null);
});

// ── 3 ────────────────────────────────────────────────────────────────────────

test('3: /verify answers the same whatever the hidden text holds', async () => {
  // Only goals travel: decisions and status are withheld.
  const { M, T, P, stored } = await team([{ section_key: 'goals', can_view: true, can_edit: true }]);
  const bodies = [];
  for (const claim of ['a', 'e', 'status', 'payments team', 'zzzz-no-such-claim']) {
    const r = await as('post', `/api/v1/context/projects/${P}/verify`, M, T).send({ claim });
    assert.equal(r.status, 403, `${claim}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(markers(r.body), []);
    bodies.push(JSON.stringify(r.body));
  }
  assert.equal(new Set(bodies).size, 1, 'every claim gets the identical refusal');
  assert.equal((await stored()).recent_decisions[0].verified_at, undefined);
});

test('3b: a member who may stamp the status never has the hidden decision log consulted', async () => {
  const { M, T, P, stored } = await team([{ section_key: 'current_status', can_view: true, can_edit: true }]);
  const hit = await as('post', `/api/v1/context/projects/${P}/verify`, M, T).send({ claim: 'payments team' });
  assert.equal(hit.status, 200, JSON.stringify(hit.body));
  assert.equal(hit.body.verified, null, 'a claim only a hidden decision matches finds nothing');
  const miss = await as('post', `/api/v1/context/projects/${P}/verify`, M, T).send({ claim: 'zzzz-no-such-claim' });
  assert.deepEqual(miss.body, hit.body, 'identical to a claim that matches nothing anywhere');
  assert.equal((await stored()).recent_decisions[0].verified_at, undefined);
  const status = await as('post', `/api/v1/context/projects/${P}/verify`, M, T).send({ claim: 'status' });
  assert.equal(status.status, 200);
  assert.equal(status.body.verified.kind, 'current_status');
});

// ── 4 ────────────────────────────────────────────────────────────────────────

test('4: a member\'s extraction does not overwrite a withheld source_summary', async () => {
  const { M, T, P, name, stored } = await team();
  const res = await as('post', '/api/v1/context/extraction', M, T).send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: P,
    chunks: [{ role: 'user', text: 'x' }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.9,
      project_candidate: { project_id: P, project_name: name, score: 0.9 },
      delta: { current_status: 'M ext status', source_summary: 'M src' },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body).slice(0, 300));
  const c = await stored();
  assert.equal(c.current_status, 'M ext status', 'the editable section landed');
  assert.equal(c.source_summary, 'ZQSRC exec notes', 'the withheld one did not change');
});

// ── 5 ────────────────────────────────────────────────────────────────────────

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
  return { err: Boolean(body.result?.isError || body.error), text };
}

const nodeCount = async (T, P, title) => Number((await q(
  'SELECT count(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1 AND project_id = $2 AND title = $3',
  [T, P, title],
)).rows[0].n);

test('5: a member cannot create a node they could never read back', async () => {
  // Default share: tech_stack (services) withheld, decisions shared.
  const { M, T, P } = await team();
  const key = await mintKey(M, T);
  const service = { entity_type: 'service', scope: 'project', project_id: P, title: 'Payments Ledger Worker', summary: 'Consumes payout events and writes rows' };

  const first = await mcpCall(key, T, 'manage_memory', { action: 'upsert_entities', project_id: P, entities: [service] });
  assert.equal(first.err, true, first.text);
  assert.match(first.text, /share_write_forbidden/);
  assert.match(first.text, /tech_stack/);
  assert.equal(await nodeCount(T, P, service.title), 0, 'nothing was written');

  const rest = await as('post', '/api/v1/context/graph/nodes', M, T).send({ project_id: P, node_type: 'service', title: 'Kafka Bus', summary: 'events' });
  assert.equal(rest.status, 403, JSON.stringify(rest.body));
  assert.deepEqual(rest.body.blocked_fields, ['tech_stack']);
  assert.equal(await nodeCount(T, P, 'Kafka Bus'), 0);

  const viaLocal = await as('post', '/api/v1/context/workspace/entities', M, T).send({ entities: [service] });
  assert.equal(viaLocal.status, 403, JSON.stringify(viaLocal.body));

  // A section the share grants still works end to end, save after save.
  const decision = { entity_type: 'decision', scope: 'project', project_id: P, title: 'Decided: use idempotency keys on payouts', summary: 'Prevents double payouts' };
  const d1 = await mcpCall(key, T, 'manage_memory', { action: 'upsert_entities', project_id: P, entities: [decision] });
  assert.equal(d1.err, false, d1.text);
  assert.doesNotMatch(d1.text, /not be able to read/);
  const d2 = await mcpCall(key, T, 'manage_memory', { action: 'upsert_entities', project_id: P, entities: [{ ...decision, summary: 'Prevents double payouts on retry' }] });
  assert.equal(d2.err, false, d2.text);

  // A service explicitly scoped to the workspace is workspace knowledge,
  // governed by no share. (Since scan 28 an entity with no project and no
  // scope is filed under the active project, so workspace scope is asked for.)
  const ws = await mcpCall(key, T, 'manage_memory', { action: 'upsert_entities', entities: [{ entity_type: 'service', scope: 'workspace', title: 'Shared Redis Cluster', summary: 'Cache for every team service' }] });
  assert.equal(ws.err, false, ws.text);
});

test('5b: a hand-written knowledge node is refused on a share narrowed below the defaults', async () => {
  const { M, T, P } = await team([{ section_key: 'current_status', can_view: true, can_edit: true }]);
  const res = await as('post', '/api/v1/context/graph/nodes', M, T).send({ project_id: P, node_type: 'knowledge', title: 'Payout retry runbook', summary: 'Retry thrice then page' });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.ok(res.body.blocked_fields.length >= 1);
  assert.equal(await nodeCount(T, P, 'Payout retry runbook'), 0);
});

// ── 6 ────────────────────────────────────────────────────────────────────────

test('6: a Trail dry run gives the refusal the real import gives, and names each section once', async () => {
  const { M, T, P } = await team([
    { section_key: 'current_status', can_view: true, can_edit: true },
    { section_key: 'todo_items', can_view: false },
  ]);
  const key = await mintKey(M, T);
  const source = await createProject(M, T, `M src ${uuidv4().slice(0, 4)}`);
  const cards = await mcpCall(key, T, 'manage_tasks', { action: 'add', project_id: source, todos: ['Card one alpha', 'Card two beta'] });
  assert.equal(cards.err, false, cards.text);
  const exported = await as('get', `/api/v1/context/projects/${source}/trail`, M, T);
  assert.equal(exported.status, 200, JSON.stringify(exported.body).slice(0, 200));
  const trail = exported.body.trail || exported.body;

  const dry = await as('post', '/api/v1/context/trail/import', M, T).send({ trail, project_id: P, dry_run: true });
  const real = await as('post', '/api/v1/context/trail/import', M, T).send({ trail, project_id: P });
  assert.equal(real.status, 403, JSON.stringify(real.body).slice(0, 300));
  assert.equal(dry.status, 403, `the dry run predicts the refusal: ${JSON.stringify(dry.body).slice(0, 300)}`);
  assert.equal(dry.body.dry_run, true);
  assert.deepEqual(dry.body.blocked_fields, real.body.blocked_fields);
  assert.equal(new Set(real.body.blocked_fields).size, real.body.blocked_fields.length, 'no section named twice');
  assert.equal((real.body.message.match(/todo_items/g) || []).length, 1, real.body.message);
  assert.match(dry.body.message, /Dry run/);

  const viaMcp = await mcpCall(key, T, 'manage_memory', { action: 'import_trail', trail: JSON.stringify(trail), project_id: P, dry_run: true });
  assert.equal(viaMcp.err, true, viaMcp.text);
  assert.match(viaMcp.text, /share_write_forbidden/);
  assert.equal((await store.getProject(T, P)).context.todo_items?.length || 0, 0, 'nothing was imported');
});
