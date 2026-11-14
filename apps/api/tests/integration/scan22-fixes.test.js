/**
 * SCAN 22.
 *
 *   1. Round 21 made a member's append to hot paths / debugging notes strictly
 *      additive — and so, once the owner's list was full (it stays full: the
 *      owner's own writes age out the oldest), EVERY member append was refused
 *      forever. The cap is AGING, not rewriting: an append-only write ages out
 *      the caller's own oldest unpinned entry first, else the oldest unpinned
 *      entry overall, and the reply says how many went and nothing about them.
 *      Targeted rewrites (relabel, collapse onto somebody else's note,
 *      supersede) stay refused.
 *   2. A share can make a section view-only. The context write honoured that;
 *      PATCH/DELETE of the section's graph nodes, resolve / mark_resolved and
 *      the resolved-decision propagation (a substring match) did not.
 *   3. viewProjectsForActor / listProjects read each project's share policy one
 *      at a time: 3 queries + a role lookup per project.
 *   4. A member append of only already-recorded paths still saved.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan22-fixes.test.js
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
const service = require('../../src/services/contextSyncService');

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
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
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

const MARK_RE = /ZQ[A-Z]+/g;
const markers = (payload) => [...new Set((JSON.stringify(payload) || '').match(MARK_RE) || [])].sort();

// Distinct words with no digits: debuggingNoteKey folds numbers, so "finding 1"
// and "finding 2" would be one note.
const word = (i) => {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  return `${a[i % 26]}${a[Math.floor(i / 26) % 26]}q${a[(i * 7) % 26]}`;
};

// A team, a shared project, and the owner's lists pre-filled to the cap.
async function team({ sections = null, notes = 0, paths = 0, pinFirstPath = false } = {}) {
  const tag = uuidv4().slice(0, 6);
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  await join(O, M);
  const T = O.orgId;
  const created = await as('post', '/api/v1/context/projects', O, T).send({ project_name: `Ledger ${tag}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const P = created.body.project.project_id;
  const res = await as('patch', `/api/v1/teams/projects/${P}/sharing`, O, T)
    .send(sections ? { visibility: 'shared', sections } : { visibility: 'shared' });
  assert.equal(res.status, 200, `sharing: ${res.status} ${JSON.stringify(res.body)}`);
  const raw = await store.getProject(T, P);
  const Oactor = { id: O.userId, org_id: T, workspace_key: T, type: 'user', role: 'admin' };
  const base = Date.now() - 86400000;
  const context = {
    ...(raw.context || {}),
    project_name: raw.project_name,
    recent_decisions: [{ summary: 'Decided: ZQDEC we will lay off the payments team', decided_at: new Date().toISOString() }],
    debugging_notes: Array.from({ length: notes }, (_, i) => ({
      summary: `ZQOWNNOTE module ${word(i)} stalls when the ${word(i + 40)} queue drains`,
      paths: [],
      added_at: new Date(base + i * 60000).toISOString(),
      contributed_by: O.userId,
    })),
    hot_paths: Array.from({ length: paths }, (_, i) => ({
      label: `ZQOWNPATH ${word(i)}`,
      path: `src/owner/${word(i)}.js`,
      purpose: 'ZQOWNPURPOSE',
      ...(pinFirstPath && i === 0 ? { pinned: true } : {}),
    })),
  };
  await store.saveProject({ ...raw, context, updated_at: new Date().toISOString() }, Oactor);
  const Mactor = { id: M.userId, org_id: M.orgId, workspace_key: T, type: 'user', role: 'admin' };
  return { O, M, T, P, Oactor, Mactor, stored: async () => (await store.getProject(T, P)).context };
}

// ── 1: a full list ages ─────────────────────────────────────────────────────

test('1a: a member finding into a FULL log lands; the oldest note ages out; the reply names nothing', async () => {
  const { O, M, T, P, stored } = await team({ notes: 30 });
  assert.equal((await stored()).debugging_notes.length, 30);
  const key = await mintKey(M, T);

  const first = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T)
    .send({ summary: 'webhook signature check is skipped on retry' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.aged_out, 1);
  assert.equal(first.body.debugging_notes, undefined, 'no stored log for a section the member cannot read');
  assert.deepEqual(first.body.evicted, []);
  assert.deepEqual(markers(first.body), [], 'the aged-out note is not named');
  let c = await stored();
  assert.equal(c.debugging_notes.length, 30);
  assert.ok(c.debugging_notes.some((d) => /webhook signature/.test(d.summary)), 'the member note landed');
  assert.ok(!c.debugging_notes.some((d) => d.summary.includes(word(0))), 'the globally oldest note aged out');
  assert.ok(c.debugging_notes.some((d) => d.summary.includes(word(1))), 'only one went');

  // Hosted MCP: succeeds, says the log is full, names nothing.
  const viaMcp = await mcpCall(key, T, 'manage_memory', { action: 'record_finding', project_id: P, summary: 'payout worker double-sends on a gateway timeout' });
  assert.equal(viaMcp.err, false, viaMcp.text);
  assert.match(viaMcp.text, /aged out/);
  assert.deepEqual(markers(viaMcp.raw), []);
  c = await stored();
  // The caller's OWN oldest note goes before anybody else's.
  assert.ok(!c.debugging_notes.some((d) => /webhook signature/.test(d.summary)), 'the member\'s own oldest note aged out first');
  assert.ok(c.debugging_notes.some((d) => d.summary.includes(word(1))), 'the owner\'s notes were left alone');
  assert.ok(c.debugging_notes.some((d) => /payout worker/.test(d.summary)));

  // /events: same path, same rule.
  const ev = await as('post', '/api/v1/context/events', M, T).send({ event_type: 'debug_finding', project_id: P, summary: 'cache warmer never expires the tenant list' });
  assert.equal(ev.status, 202, JSON.stringify(ev.body).slice(0, 300));
  assert.deepEqual(markers(ev.body), []);
  assert.ok((await stored()).debugging_notes.some((d) => /cache warmer/.test(d.summary)));

  // Targeted rewrites stay refused: collapsing onto the owner's note leaves it
  // untouched (scan 23: answered as already recorded, not refused)...
  const collide = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T)
    .send({ summary: `ZQOWNNOTE module ${word(5)} stalls when the ${word(45)} queue drains 2` });
  assert.equal(collide.status, 200, JSON.stringify(collide.body));
  assert.equal(collide.body.already_recorded, true);
  assert.deepEqual(markers(collide.body), []);
  assert.ok(!(await stored()).debugging_notes.some((d) => / drains 2$/.test(d.summary)), 'the owner\'s note was not rewritten');
  // ...and superseding.
  const sup = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T).send({ summary: 'correction', supersedes: 'stalls' });
  assert.equal(sup.status, 403);

  // The owner's own flow is unchanged: a full log, the owner sees what went.
  const own = await as('post', `/api/v1/context/projects/${P}/debug-findings`, O, T).send({ summary: 'ledger rounding drifts on currency pairs' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.debugging_notes.length, 30);
  assert.equal(own.body.evicted.length, 1);
  assert.equal(own.body.aged_out, 1);
});

test('1b: a member path into a FULL list lands, ages the oldest UNPINNED entry, and never a pinned one', async () => {
  const { M, T, P, stored } = await team({ paths: 40, pinFirstPath: true });
  const key = await mintKey(M, T);

  const one = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T)
    .send({ items: [{ label: 'mine', path: 'src/member/one.js', purpose: 'x' }] });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.stored, 1);
  assert.equal(one.body.aged_out, 1);
  assert.equal(one.body.hot_paths, undefined);
  assert.deepEqual(markers(one.body), []);
  let c = await stored();
  assert.equal(c.hot_paths.length, 40);
  assert.ok(c.hot_paths.some((h) => h.path === `src/owner/${word(0)}.js` && h.pinned), 'the pinned (oldest) path is kept');
  assert.ok(!c.hot_paths.some((h) => h.path === `src/owner/${word(1)}.js`), 'the oldest unpinned path aged out');
  assert.ok(c.hot_paths.some((h) => h.path === 'src/member/one.js'));

  // MCP: the member's own path ages first.
  const two = await mcpCall(key, T, 'manage_memory', { action: 'record_paths', project_id: P, items: [{ label: 'mine2', path: 'src/member/two.js', purpose: 'x' }] });
  assert.equal(two.err, false, two.text);
  assert.deepEqual(markers(two.raw), []);
  c = await stored();
  assert.ok(!c.hot_paths.some((h) => h.path === 'src/member/one.js'), 'the member\'s own oldest path aged out first');
  assert.ok(c.hot_paths.some((h) => h.path === `src/owner/${word(2)}.js`), 'no further owner path went');

  // A relabel of the owner's path is still not a rewrite.
  const same = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T)
    .send({ items: [{ label: 'relabel', path: `src/owner/${word(3)}.js`, purpose: 'M overwrote' }] });
  assert.equal(same.status, 200);
  assert.equal(same.body.already_recorded, 1);
  assert.equal((await stored()).hot_paths.find((h) => h.path === `src/owner/${word(3)}.js`).label, `ZQOWNPATH ${word(3)}`);

  // One write may not age out more than ten entries that are not the caller's.
  const flood = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T)
    .send({ items: Array.from({ length: 12 }, (_, i) => ({ label: `f${word(i)}`, path: `src/flood/${word(i)}.js` })) });
  assert.equal(flood.status, 403, JSON.stringify(flood.body));
  assert.deepEqual(markers(flood.body), []);
  assert.ok((await stored()).hot_paths.some((h) => h.path === `src/owner/${word(3)}.js`), 'nothing saved');
});

// ── 2: view-only sections ───────────────────────────────────────────────────

const DECISION = 'Decided: ZQDEC we will lay off the payments team';

async function nodesFor(T, P) {
  return (await q(
    'SELECT node_id, node_type, title, metadata->>\'status\' AS status FROM context_graph_nodes WHERE owner_key = $1 AND project_id = $2 AND node_type IN (\'decision\', \'service\') ORDER BY title',
    [T, P],
  )).rows;
}

async function seedNodes(O, T, P) {
  const res = await as('post', '/api/v1/context/workspace/entities', O, T).send({
    entities: [
      { entity_type: 'decision', scope: 'project', project_id: P, title: DECISION, summary: 'Payments team is cut' },
      { entity_type: 'service', scope: 'project', project_id: P, title: 'ZQSVC Payments Ledger Worker', summary: 'Consumes payout events and writes ledger rows' },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.deepEqual((await nodesFor(T, P)).map((n) => n.node_type).sort(), ['decision', 'service'], JSON.stringify({ skipped: res.body.skipped, e: (res.body.entities || []).map((x) => [x.node_type, x.project_id, x.title]) }));
}

test('2: a view-only section\'s decision cannot be resolved, flipped, patched or deleted by a member', async () => {
  const { O, M, T, P, stored } = await team({
    sections: [
      { section_key: 'goals', can_view: true, can_edit: true },
      { section_key: 'recent_decisions', can_view: true, can_edit: false },
      { section_key: 'tech_stack', can_view: true, can_edit: false },
    ],
  });
  await seedNodes(O, T, P);
  const key = await mintKey(M, T);
  const resolved = async () => (await stored()).recent_decisions.find((d) => d.summary === DECISION).resolved;

  // (a) resolve / mark_resolved.
  const mr = await mcpCall(key, T, 'manage_memory', { action: 'resolve', title: DECISION, project_id: P });
  assert.equal(mr.err, true, mr.text);
  assert.match(mr.text, /share_write_forbidden/);
  assert.notEqual(await resolved(), true);
  assert.equal((await nodesFor(T, P)).find((n) => n.node_type === 'decision').status, null);

  // (b) a NEW decision node with status resolved does not flip the owner's decision.
  const flip = await as('post', '/api/v1/context/workspace/entities', M, T).send({
    entities: [{ entity_type: 'decision', scope: 'project', project_id: P, title: 'lay off the', summary: 'we will lay off the payments team', metadata: { status: 'resolved' } }],
  });
  assert.ok([200, 403].includes(flip.status), JSON.stringify(flip.body).slice(0, 200));
  assert.notEqual(await resolved(), true, 'the propagation did not flip a decision the member may not edit');

  // (c) PATCH / DELETE of the section's nodes.
  for (const node of (await nodesFor(T, P)).filter((n) => n.title === DECISION || /ZQSVC/.test(n.title))) {
    const patch = await as('patch', `/api/v1/context/graph/nodes/${node.node_id}`, M, T).send({ title: 'M rewrote', summary: 'M rewrote' });
    assert.equal(patch.status, 403, `${node.node_type} PATCH: ${JSON.stringify(patch.body).slice(0, 200)}`);
    const del = await as('delete', `/api/v1/context/graph/nodes/${node.node_id}`, M, T);
    assert.equal(del.status, 403, `${node.node_type} DELETE: ${JSON.stringify(del.body).slice(0, 200)}`);
  }
  const after = await nodesFor(T, P);
  assert.ok(after.some((n) => n.title === DECISION), 'decision node survives');
  assert.ok(after.some((n) => /ZQSVC/.test(n.title)), 'service node survives');

  // The owner still can.
  const own = await mcpCall(await mintKey(O, T), T, 'manage_memory', { action: 'resolve', title: DECISION, project_id: P });
  assert.equal(own.err, false, own.text);
  assert.equal(await resolved(), true);
});

test('2b: on an editable share a resolve propagates by the decision itself, never by a substring', async () => {
  const { O, M, T, P, stored } = await team();
  await seedNodes(O, T, P);
  const resolved = async () => (await stored()).recent_decisions.find((d) => d.summary === DECISION).resolved;

  // A fragment is not the decision.
  const frag = await as('post', '/api/v1/context/workspace/entities', O, T).send({
    entities: [{ entity_type: 'decision', scope: 'project', project_id: P, title: 'we will lay off the payments', summary: 'we will lay off the payments', metadata: { status: 'resolved' } }],
  });
  assert.equal(frag.status, 200, JSON.stringify(frag.body).slice(0, 200));
  assert.notEqual(await resolved(), true, 'a substring no longer resolves a decision');

  // The member may edit decisions on a default share: their resolve lands and propagates.
  const key = await mintKey(M, T);
  const mr = await mcpCall(key, T, 'manage_memory', { action: 'resolve', title: DECISION, project_id: P });
  assert.equal(mr.err, false, mr.text);
  assert.equal(await resolved(), true);
});

// ── 3: batched share policies ───────────────────────────────────────────────

test('3: 60 shared projects cost a constant number of policy queries, with identical results', async (t) => {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  await join(O, M);
  const T = O.orgId;
  const Oactor = { id: O.userId, org_id: T, workspace_key: T, type: 'user', role: 'admin' };
  const Mactor = { id: M.userId, org_id: M.orgId, workspace_key: T, type: 'user', role: 'admin' };
  for (let i = 0; i < 60; i += 1) {
    const project = await service.createProject(Oactor, { project_name: `Perf ${word(i)} ${uuidv4().slice(0, 4)}` });
    const context = { ...(project.context || {}), current_task: `ZQTASK ${i}`, description: `ZQDESC ${i}` };
    await store.saveProject({ ...project, context }, Oactor);
    if (i % 3 === 0) {
      await store.upsertProjectShare(project.project_id, {
        org_id: T,
        enabled: true,
        sections: [{ section_key: 'current_task', can_view: true, can_edit: true }, { section_key: 'description', can_view: i % 2 === 0, can_edit: false }],
        members: [],
      });
    }
  }
  await q('UPDATE context_projects SET visibility = \'shared\' WHERE owner_key = $1', [T]);
  const raw = await store.listProjects(T, { system: true });
  assert.ok(raw.length >= 60);

  // The per-project answer, computed the old way.
  const expected = [];
  for (const project of raw) {
    const policy = await service.getProjectSharePolicy(Mactor, project);
    if (!service.canViewProjectForActor(Mactor, project, policy)) continue;
    expected.push(service.projectViewForActor(Mactor, project, policy));
  }
  assert.ok(expected.some((p) => /ZQDESC/.test(JSON.stringify(p.context))), 'some rows grant the description');
  assert.ok(expected.some((p) => !/ZQDESC/.test(JSON.stringify(p.context))), 'some withhold it');

  let count = 0;
  const original = db.query;
  db.query = (...args) => { count += 1; return original.apply(db, args); };
  let viewed;
  let viewCount;
  let listed;
  let listCount;
  try {
    viewed = await service.viewProjectsForActor(Mactor, raw);
    viewCount = count;
    count = 0;
    listed = await service.listProjects(Mactor);
    listCount = count;
  } finally {
    db.query = original;
  }
  t.diagnostic(`queries: viewProjectsForActor=${viewCount} listProjects=${listCount} over ${raw.length} projects`);
  assert.ok(viewCount <= 6, `viewProjectsForActor over ${raw.length} projects ran ${viewCount} queries`);
  assert.ok(listCount <= 15, `listProjects over ${raw.length} projects ran ${listCount} queries`);
  assert.deepEqual(viewed, expected, 'the batch answers exactly what the per-project path did');
  const byId = (list) => new Map(list.map((p) => [p.project_id, JSON.stringify(p.context)]));
  assert.deepEqual(byId(listed), byId(viewed));
});

// ── 4: a no-op append does not save ─────────────────────────────────────────

test('4: a member append of only already-recorded paths saves nothing', async () => {
  const { M, T, P } = await team({ paths: 3 });
  const before = await store.getProject(T, P);
  const res = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T)
    .send({ items: [{ label: 'again', path: `src/owner/${word(1)}.js` }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.already_recorded, 1);
  const after = await store.getProject(T, P);
  assert.equal(after.updated_at, before.updated_at, 'the owner\'s updated_at did not move');
});
