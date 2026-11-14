/**
 * SCAN 23.
 *
 *   1. HIGH: round 22's aging never aged a PINNED entry and aged the caller's
 *      own first — and a member could pin. So a member filing pinned notes /
 *      paths made their own entries unageable and every append aged the
 *      owner's, until none were left; the owner's next write was then ranked
 *      out of a list of pins. Pin and importance are edit-level now (stripped
 *      from an append-only write), and a caller's OWN entries age even when
 *      pinned.
 *   2. HIGH: /events hot_path_discovered handed metadata.items through
 *      unvalidated and recordHotPaths kept a caller-supplied contributed_by, so
 *      a member stamped their paths as the owner's, none counted as "theirs",
 *      and every write aged ten owner paths. The stamp is the server's, always.
 *   3. MEDIUM: the overflow was counted before validation — invalid items aged
 *      owner paths out and were then dropped, storing nothing.
 *   4. MEDIUM: a full log of pinned notes ranked an editor's new note out and
 *      the reply said "recorded".
 *   5. LOW: an unmapped graph node type's edit gate mirrors its read gate.
 *   6. LOW: a share read that fails withholds the project from a non-author
 *      (fails closed), where it used to serve it as "shared, default sections".
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan23-fixes.test.js
 */


process.env.NODE_ENV = 'test';
// This file makes well over 120 API calls a minute (the per-minute apiLimiter),
// and a 429 is not what any of it is testing.
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

// Distinct words with no digits: debuggingNoteKey folds numbers, so "finding 1"
// and "finding 2" would be one note.
const word = (i) => {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  return `${a[i % 26]}${a[Math.floor(i / 26) % 26]}q${a[(i * 7) % 26]}`;
};

// A team, a shared project, and the owner's lists pre-filled to the cap.
async function team({ sections = null, notes = 0, paths = 0, pinFirstPath = false, seed = null } = {}) {
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
  if (seed) seed(context, { O, M });
  await store.saveProject({ ...raw, context, updated_at: new Date().toISOString() }, Oactor);
  const Mactor = { id: M.userId, org_id: M.orgId, workspace_key: T, type: 'user', role: 'admin' };
  return { O, M, T, P, Oactor, Mactor, stored: async () => (await store.getProject(T, P)).context };
}

const ownerPaths = (c) => c.hot_paths.filter((h) => /ZQOWNPATH/.test(h.label)).length;
const ownerNotes = (c) => c.debugging_notes.filter((d) => /ZQOWNNOTE/.test(d.summary)).length;

// ── 1: pinning is an edit ───────────────────────────────────────────────────

test('1a: a member filing PINNED findings into a full log ages their own notes, not the owner\'s', async () => {
  const { O, M, T, P, stored } = await team({ notes: 30 });
  for (let i = 0; i < 12; i += 1) {
    const r = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T)
      .send({ summary: `junk ${word(i + 100)} memberpin`, pinned: true, importance: 'critical' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  let c = await stored();
  assert.equal(c.debugging_notes.length, 30);
  assert.equal(ownerNotes(c), 29, 'only the first append aged an owner note; after that the member\'s own aged');
  const memberNotes = c.debugging_notes.filter((d) => /memberpin/.test(d.summary));
  assert.equal(memberNotes.length, 1);
  assert.ok(memberNotes.every((d) => !d.pinned && !d.importance), 'an append-only note carries no pin and no importance');
  assert.ok(memberNotes.every((d) => d.contributed_by === M.userId));

  // The owner's own write still lands.
  const own = await as('post', `/api/v1/context/projects/${P}/debug-findings`, O, T).send({ summary: 'owner real finding about ledger rounding' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  c = await stored();
  assert.ok(c.debugging_notes.some((d) => /owner real finding/.test(d.summary)));
});

test('1b: a member posting PINNED paths into a full list ages their own paths after the first write', async () => {
  const { O, M, T, P, stored } = await team({ paths: 40 });
  for (let k = 0; k < 4; k += 1) {
    const r = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T)
      .send({ items: Array.from({ length: 10 }, (_, i) => ({ label: `m${word(k * 10 + i)}`, path: `src/m/${word(k * 10 + i)}.js`, pinned: true, importance: 'critical' })) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stored, 10);
  }
  let c = await stored();
  assert.equal(c.hot_paths.length, 40);
  assert.equal(ownerPaths(c), 30, 'ten owner paths aged once; every later write aged the member\'s own');
  const memberPaths = c.hot_paths.filter((h) => h.path.startsWith('src/m/'));
  assert.ok(memberPaths.every((h) => !h.pinned && !h.importance && h.contributed_by === M.userId));

  const own = await as('post', `/api/v1/context/projects/${P}/hot-paths`, O, T).send({ items: [{ label: 'owner new', path: 'src/owner/new.js' }] });
  assert.equal(own.status, 200);
  assert.equal(own.body.stored, 1, JSON.stringify(own.body).slice(0, 300));
  c = await stored();
  assert.ok(c.hot_paths.some((h) => h.path === 'src/owner/new.js'));
});

test('1c: entries a member pinned BEFORE the fix age ahead of anybody else\'s', async () => {
  const { M, T, P, stored } = await team({
    notes: 20,
    paths: 30,
    seed: (context, { M: member }) => {
      const base = Date.now() - 3600000;
      for (let i = 0; i < 10; i += 1) {
        context.debugging_notes.push({
          summary: `ZQMEMBERPIN legacy ${word(i + 200)} pinned by the member`,
          paths: [],
          added_at: new Date(base + i * 1000).toISOString(),
          contributed_by: member.userId,
          pinned: true,
        });
        context.hot_paths.push({ label: `ZQMEMBERPIN ${word(i + 200)}`, path: `src/legacy/${word(i + 200)}.js`, contributed_by: member.userId, pinned: true });
      }
    },
  });
  const note = await as('post', `/api/v1/context/projects/${P}/debug-findings`, M, T).send({ summary: 'fresh member finding about retries' });
  assert.equal(note.status, 200, JSON.stringify(note.body));
  const path = await as('post', `/api/v1/context/projects/${P}/hot-paths`, M, T).send({ items: [{ label: 'fresh', path: 'src/member/fresh.js' }] });
  assert.equal(path.status, 200, JSON.stringify(path.body));
  const c = await stored();
  assert.equal(ownerNotes(c), 20, 'no owner note aged');
  assert.equal(ownerPaths(c), 30, 'no owner path aged');
  assert.equal(c.debugging_notes.filter((d) => /ZQMEMBERPIN/.test(d.summary)).length, 9, 'the member\'s own pinned note aged');
  assert.equal(c.hot_paths.filter((h) => /ZQMEMBERPIN/.test(h.label)).length, 9, 'the member\'s own pinned path aged');
});

// ── 2: attribution is the server's ─────────────────────────────────────────

test('2a: /events hot_path_discovered cannot stamp a member\'s paths as the owner\'s', async () => {
  const { O, M, T, P, stored } = await team({ paths: 40 });
  for (let k = 0; k < 4; k += 1) {
    const r = await as('post', '/api/v1/context/events', M, T).send({
      event_type: 'hot_path_discovered', project_id: P, summary: 'x',
      metadata: { items: Array.from({ length: 10 }, (_, i) => ({ label: `s${word(k * 10 + i)}`, path: `src/s/${word(k * 10 + i)}.js`, contributed_by: O.userId })) },
    });
    assert.equal(r.status, 202, JSON.stringify(r.body).slice(0, 300));
  }
  const c = await stored();
  assert.equal(ownerPaths(c), 30, 'only the first write aged owner paths');
  const spoofed = c.hot_paths.filter((h) => h.path.startsWith('src/s/'));
  assert.ok(spoofed.length > 0);
  assert.ok(spoofed.every((h) => h.contributed_by === M.userId), 'every member path is stamped with the member');
});

test('2b: recordHotPaths replaces a claimed contributed_by on every door, including an editor\'s', async () => {
  const { O, M, T, P, Oactor, Mactor, stored } = await team({ paths: 2 });
  await service.recordHotPaths(Mactor, P, [{ label: 'claimed', path: 'src/claimed/member.js', contributed_by: O.userId }]);
  await service.recordHotPaths(Oactor, P, [{ label: 'claimed', path: 'src/claimed/owner.js', contributed_by: M.userId }]);
  const c = await stored();
  assert.equal(c.hot_paths.find((h) => h.path === 'src/claimed/member.js').contributed_by, M.userId);
  assert.equal(c.hot_paths.find((h) => h.path === 'src/claimed/owner.js').contributed_by, O.userId);
  void T;
});

// ── 3: nothing ages for items that never land ──────────────────────────────

test('3: invalid items age nothing and are reported as not stored', async () => {
  const { M, O, T, P, Oactor, stored } = await team({ paths: 40 });
  const r = await as('post', '/api/v1/context/events', M, T).send({
    event_type: 'hot_path_discovered', project_id: P, summary: 'x',
    metadata: { items: Array.from({ length: 10 }, (_, i) => ({ label: `x${word(i)}`, path: `src/x/${word(i)}.js`, purpose: 7 })) },
  });
  assert.equal(r.status, 202, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.stored, 0);
  assert.equal(r.body.not_stored, 10);
  let c = await stored();
  assert.equal(ownerPaths(c), 40, 'no owner path aged for items that were never stored');

  // An editor's invalid item does not delete the path it names either.
  const res = await service.recordHotPaths(Oactor, P, [{ label: 'bad', path: `src/owner/${word(4)}.js`, purpose: 9 }]);
  assert.equal(res.stored, 0);
  assert.equal(res.not_stored, 1);
  assert.equal(res.already_recorded, undefined, 'an invalid item is not "already recorded"');
  c = await stored();
  assert.ok(c.hot_paths.some((h) => h.path === `src/owner/${word(4)}.js` && /ZQOWNPATH/.test(h.label)));
  void O;
});

// ── 4: a full log of pins says so ──────────────────────────────────────────

test('4: an editor\'s finding into a log of pinned notes is refused, not reported as recorded', async () => {
  const { O, T, P, stored } = await team({
    notes: 30,
    seed: (context) => { for (const note of context.debugging_notes) note.pinned = true; },
  });
  const before = await store.getProject(T, P);
  const r = await as('post', `/api/v1/context/projects/${P}/debug-findings`, O, T).send({ summary: 'owner finding that has no room' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'debug_log_full_pinned');
  assert.match(r.body.message, /nothing was saved/);
  const after = await store.getProject(T, P);
  assert.equal(after.updated_at, before.updated_at, 'nothing saved');

  const viaMcp = await mcpCall(await mintKey(O, T), T, 'manage_memory', { action: 'record_finding', project_id: P, summary: 'another owner finding with no room' });
  assert.equal(viaMcp.err, true, viaMcp.text);
  assert.match(viaMcp.text, /debug_log_full_pinned/);
  assert.equal(ownerNotes(await stored()), 30);

  // Hot paths already answer this with the read-back counts; kept honest.
  const { O: O2, T: T2, P: P2 } = await team({ paths: 40, seed: (context) => { for (const p of context.hot_paths) p.pinned = true; } });
  const hp = await as('post', `/api/v1/context/projects/${P2}/hot-paths`, O2, T2).send({ items: [{ label: 'n', path: 'src/owner/none.js' }] });
  assert.equal(hp.status, 200);
  assert.equal(hp.body.stored, 0);
  assert.equal(hp.body.not_stored, 1);
  const hpMcp = await mcpCall(await mintKey(O2, T2), T2, 'manage_memory', { action: 'record_paths', project_id: P2, items: [{ label: 'n2', path: 'src/owner/none2.js' }] });
  assert.match(hpMcp.text, /Recorded 0 hot paths[\s\S]*could not be stored/);
});

// ── solo flows are unchanged ────────────────────────────────────────────────

test('solo: the 41st path and the 31st finding land and the reply names what went', async () => {
  const S = await makePerson('solo', { plan: 'developer_pro' });
  const created = await as('post', '/api/v1/context/projects', S, S.orgId).send({ project_name: `Solo ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201);
  const P = created.body.project.project_id;
  for (let k = 0; k < 4; k += 1) {
    await as('post', `/api/v1/context/projects/${P}/hot-paths`, S, S.orgId)
      .send({ items: Array.from({ length: 10 }, (_, i) => ({ label: `p${word(k * 10 + i)}`, path: `src/p/${word(k * 10 + i)}.js` })) });
  }
  const p41 = await as('post', `/api/v1/context/projects/${P}/hot-paths`, S, S.orgId).send({ items: [{ label: 'forty-one', path: 'src/p/fortyone.js', pinned: true }] });
  assert.equal(p41.status, 200);
  assert.equal(p41.body.stored, 1);
  assert.equal(p41.body.evicted, 1);
  assert.ok(p41.body.hot_paths.some((h) => h.path === 'src/p/fortyone.js' && h.pinned), 'a solo author may still pin');
  for (let i = 0; i < 30; i += 1) {
    const r = await as('post', `/api/v1/context/projects/${P}/debug-findings`, S, S.orgId).send({ summary: `solo ${word(i + 300)} finding` });
    assert.equal(r.status, 200);
  }
  const f31 = await as('post', `/api/v1/context/projects/${P}/debug-findings`, S, S.orgId).send({ summary: 'solo thirty first finding', pinned: true });
  assert.equal(f31.status, 200, JSON.stringify(f31.body));
  assert.equal(f31.body.evicted.length, 1);
  assert.ok(f31.body.debugging_notes.some((d) => d.summary === 'solo thirty first finding' && d.pinned));
});

// ── 5: an unmapped node's edit gate mirrors its read gate ───────────────────
//
// A type no section governs (workflow, a hand-written knowledge node) is read
// through the default share: visible when the four default sections are. Its
// edit gate is those same four sections with can_edit — no more (goals, stack
// or anything else the share adds is not consulted) and no less.

test('5: an unmapped graph node is editable exactly where it is readable and the default sections are editable', async () => {
  const DEF = ['current_task', 'current_status', 'recent_decisions', 'todo_items'];
  const cases = [
    { label: 'default share', sections: null, read: 200, patch: 200 },
    { label: 'defaults editable, stack view-only', sections: [...DEF.map((s) => ({ section_key: s, can_view: true, can_edit: true })), { section_key: 'tech_stack', can_view: true, can_edit: false }], read: 200, patch: 200 },
    { label: 'defaults view-only', sections: DEF.map((s) => ({ section_key: s, can_view: true, can_edit: false })), read: 200, patch: 403 },
    { label: 'narrowed below the defaults', sections: DEF.filter((s) => s !== 'todo_items').map((s) => ({ section_key: s, can_view: true, can_edit: true })), read: 404, patch: 404 },
  ];
  for (const c of cases) {
    const { O, M, T, P } = await team({ sections: c.sections });
    const made = await as('post', '/api/v1/context/workspace/entities', O, T).send({
      entities: [{ entity_type: 'workflow', scope: 'project', project_id: P, title: `ZQFLOW Nightly ledger reconciliation workflow ${uuidv4().slice(0, 4)}`, summary: 'Runs the ledger reconciliation job against Stripe payouts every night and pages on drift' }],
    });
    assert.equal(made.status, 200, `${c.label}: ${JSON.stringify(made.body).slice(0, 200)}`);
    const node = (await q('SELECT node_id FROM context_graph_nodes WHERE owner_key = $1 AND project_id = $2 AND node_type = $3', [T, P, 'workflow'])).rows[0];
    const read = await as('get', `/api/v1/context/graph/nodes/${node.node_id}`, M, T);
    assert.equal(read.status, c.read, `${c.label} read`);
    const patch = await as('patch', `/api/v1/context/graph/nodes/${node.node_id}`, M, T).send({ summary: 'M edit of the reconciliation workflow' });
    assert.equal(patch.status, c.patch, `${c.label} patch: ${JSON.stringify(patch.body).slice(0, 200)}`);
  }
});

// ── 6: a share that cannot be read shares nothing ───────────────────────────

test('6: a failed share read withholds a shared project from a non-author, in the batch and the single form', async () => {
  const { O, M, T, P, Oactor, Mactor } = await team();
  const second = await as('post', '/api/v1/context/projects', O, T).send({ project_name: `Second ${uuidv4().slice(0, 6)}` });
  assert.equal(second.status, 201);
  await as('patch', `/api/v1/teams/projects/${second.body.project.project_id}/sharing`, O, T).send({ visibility: 'shared' });
  // A project the MEMBER wrote, private: its author and a workspace owner read it.
  const theirs = await service.createProject(Mactor, { project_name: `Member private ${uuidv4().slice(0, 6)}` });
  await q('UPDATE context_projects SET visibility = $1 WHERE project_id = $2', ['private', theirs.project_id]);

  const raw = (await store.listProjects(T, { system: true })).filter((p) => [P, second.body.project.project_id, theirs.project_id].includes(p.project_id));
  assert.equal(raw.length, 3);
  const healthy = await service.viewProjectsForActor(Mactor, raw);
  assert.equal(healthy.length, 3, 'with the share readable the member sees both shared projects and their own');

  const originalMany = store.getProjectShares;
  const originalOne = store.getProjectShare;
  store.getProjectShares = async () => { throw new Error('simulated share read failure'); };
  store.getProjectShare = async () => { throw new Error('simulated share read failure'); };
  try {
    const member = await service.viewProjectsForActor(Mactor, raw);
    assert.deepEqual(member.map((p) => p.project_id), [theirs.project_id], 'only the member\'s own project survives');
    const owner = await service.viewProjectsForActor(Oactor, raw);
    assert.equal(owner.length, 3, 'the author reads their own; a workspace owner still reads org-owned private work');

    const policy = await service.getProjectSharePolicy(Mactor, raw.find((p) => p.project_id === P));
    assert.equal(service.canViewProjectForActor(Mactor, raw.find((p) => p.project_id === P), policy), false);
    assert.equal(await service.getProject(Mactor, P), null, 'the single form fails closed the same way');
    assert.ok(await service.getProject(Oactor, P), 'the author is unaffected');
  } finally {
    store.getProjectShares = originalMany;
    store.getProjectShare = originalOne;
  }
  void M;
});

// ── B2: a member's finding is judged against the log as the merge sees it ───

test('B2: a teammate\'s duplicate finding is already recorded, and an old look-alike pair does not refuse an unrelated one', async () => {
  const seedNotes = (summaries) => (context, { O }) => {
    context.debugging_notes = summaries.map((summary, i) => ({
      summary, paths: [], added_at: new Date(Date.now() - (10 - i) * 60000).toISOString(), contributed_by: O.userId,
    }));
  };

  // The same finding the owner already filed, and one differing only by a number.
  let t = await team({ seed: seedNotes(['Payout webhook retry fires twice on 502 from the gateway']) });
  const mkey = await mintKey(t.M, t.T);
  const same = await mcpCall(mkey, t.T, 'manage_memory', { action: 'record_finding', project_id: t.P, summary: 'Payout webhook retry fires twice on 502 from the gateway' });
  assert.equal(same.err, false, same.text);
  assert.match(same.text, /Already recorded/);
  const variant = await as('post', `/api/v1/context/projects/${t.P}/debug-findings`, t.M, t.T)
    .send({ summary: 'Payout webhook retry fires twice on 504 from the gateway' });
  assert.equal(variant.status, 200, JSON.stringify(variant.body));
  assert.equal(variant.body.already_recorded, true);
  assert.equal(variant.body.stored, false);
  let c = await t.stored();
  assert.deepEqual(c.debugging_notes.map((d) => d.summary), ['Payout webhook retry fires twice on 502 from the gateway'], 'the owner\'s note is untouched');

  // A pre-#495 log holding two of the owner's notes that now collapse into one.
  t = await team({ seed: seedNotes([
    'Nightly smoke test failed at 03:00 UTC on staging',
    'Nightly smoke test failed at 04:00 UTC on staging',
    'Ledger rounding drifts',
  ]) });
  const key2 = await mintKey(t.M, t.T);
  const unrelated = await mcpCall(key2, t.T, 'manage_memory', { action: 'record_finding', project_id: t.P, summary: 'Redis connection pool exhausts under load test' });
  assert.equal(unrelated.err, false, unrelated.text);
  assert.match(unrelated.text, /Recorded debugging finding/);
  c = await t.stored();
  assert.ok(c.debugging_notes.some((d) => /Redis connection pool/.test(d.summary)));
  assert.ok(c.debugging_notes.some((d) => /Ledger rounding/.test(d.summary)));
  const ev = await as('post', '/api/v1/context/events', t.M, t.T).send({ event_type: 'debug_finding', project_id: t.P, summary: 'Worker heartbeat stops after the queue drains' });
  assert.equal(ev.status, 202, JSON.stringify(ev.body).slice(0, 300));
  assert.ok((await t.stored()).debugging_notes.some((d) => /Worker heartbeat/.test(d.summary)));
});

// ── B1 / B3: the nightly vault remediation ─────────────────────────────────

const vault = require('../../src/jobs/vaultRemediationJob');
const { mergeContextObject } = require('../../../../packages/shared-context/src/index.js');

async function soloProject(label) {
  const S = await makePerson(label, { plan: 'developer_pro' });
  const created = await as('post', '/api/v1/context/projects', S, S.orgId).send({ project_name: `${label} ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201);
  const P = created.body.project.project_id;
  const actor = { id: S.userId, org_id: S.orgId, workspace_key: S.orgId, type: 'user', role: 'admin' };
  const writeRaw = async (patch) => {
    const raw = await store.getProject(S.orgId, P);
    await store.saveProject({ ...raw, context: { ...(raw.context || {}), ...patch, project_name: raw.project_name } }, actor);
  };
  return { S, P, writeRaw, stored: async () => (await store.getProject(S.orgId, P)).context };
}

async function resolvedNode(ownerKey, projectId, title, resolvedAt) {
  const now = new Date().toISOString();
  await store.upsertGraphNode({
    node_id: `graph_node_${uuidv4()}`, owner_key: ownerKey, project_id: projectId, node_type: 'decision',
    canonical_key: `decision:${uuidv4()}`, title, summary: title,
    metadata: { entity_type: 'decision', scope: 'project', status: 'resolved', resolved_at: resolvedAt }, confidence: 0.9,
    source_session_id: '', source_tool: 'claude_code', created_at: now, updated_at: now, last_seen_at: now,
  });
}

test('B1: nightly phase 6 resolves the decision itself, never a longer one that contains it or one made after the resolve', async () => {
  const { S, P, writeRaw, stored } = await soloProject('vault');
  const day = 86400000;
  await writeRaw({ recent_decisions: [
    { summary: 'Adopt Redis as the cache layer for sessions', decided_at: new Date(Date.now() - 3 * day).toISOString() },
    { summary: 'Adopt Redis as the cache layer for sessions and the payout queue streams', decided_at: new Date(Date.now() - 3 * day).toISOString() },
    { summary: 'Move billing webhooks to the queue worker', decided_at: new Date().toISOString() },
  ] });
  await resolvedNode(S.orgId, P, 'Adopt Redis as the cache layer for sessions', new Date(Date.now() - day).toISOString());
  // Resolved YESTERDAY; the decision with this exact text was made today.
  await resolvedNode(S.orgId, P, 'Move billing webhooks to the queue worker', new Date(Date.now() - day).toISOString());

  await vault.propagateResolvedDecisions();
  const resolved = Object.fromEntries((await stored()).recent_decisions.map((d) => [d.summary, Boolean(d.resolved)]));
  assert.equal(resolved['Adopt Redis as the cache layer for sessions'], true, 'the decision the node stands for is resolved');
  assert.equal(resolved['Adopt Redis as the cache layer for sessions and the payout queue streams'], false, 'a longer decision containing its text is not');
  assert.equal(resolved['Move billing webhooks to the queue worker'], false, 'a decision made after the resolve is not');
});

test('B3: the blocker stamp is the server\'s, and the nightly job (phase 7 is retired) clears no blocker', async () => {
  const { S, P, writeRaw, stored } = await soloProject('blocker');
  const old = { summary: 'Resolved: Stripe webhook signature verification failing on staging', decided_at: '2026-08-01T12:00:00.000Z' };
  let r = await as('patch', `/api/v1/context/projects/${P}/context`, S, S.orgId).send({ recent_decisions: [old] });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  r = await as('patch', `/api/v1/context/projects/${P}/context`, S, S.orgId)
    .send({ blocking_issue: 'Stripe webhook signature verification failing on staging again after the key rotation', blocking_issue_set_at: '2020-01-01T00:00:00.000Z' });
  assert.equal(r.status, 200);
  let c = await stored();
  const setAt = Date.parse(c.blocking_issue_set_at);
  assert.ok(setAt > Date.now() - 60000, 'the server stamps when the blocker was set, whatever the caller claims');

  // A resolving decision made AFTER the blocker used to clear it; phase 7 is retired, so it stays.
  await writeRaw({ recent_decisions: [old, { summary: 'Resolved: Stripe webhook signature verification on staging fixed and deployed after the key rotation', decided_at: new Date(Date.now() + 1000).toISOString() }] });
  assert.equal(vault.reconcileStaleBlockers, undefined, 'phase 7 is gone');
  await vault.runVaultRemediation();
  c = await stored();
  assert.match(c.blocking_issue, /again after the key rotation/);
  assert.equal(c.blocker_reconciled_at, undefined);

  // The extraction merge stamps it too, and clears it with the blocker.
  const base = { ...(await stored()), last_updated: new Date().toISOString() };
  const merged = mergeContextObject(base, { blocking_issue: 'Deploys hang on the migration lock', blocking_issue_set_at: '2020-01-01T00:00:00.000Z' }, 'x');
  assert.ok(Date.parse(merged.blocking_issue_set_at) > Date.now() - 60000);
  const same = mergeContextObject(merged, { blocking_issue: 'Deploys hang on the migration lock' }, 'x');
  assert.equal(same.blocking_issue_set_at, merged.blocking_issue_set_at, 'restating the same blocker keeps its time');
  assert.equal(mergeContextObject(merged, { blocking_issue: '' }, 'x').blocking_issue_set_at, undefined);
});

// ── B4: event-derived nodes are governed by the section their event writes ──

test('B4: a command or blocker event\'s graph node does not reach a teammate the share withholds that section from', async () => {
  const { O, M, T, P } = await team();
  const e1 = await as('post', '/api/v1/context/events', O, T).send({ event_type: 'blocker_opened', project_id: P, summary: 'ZQBLOCK Legal has frozen the Acme contract pending the acquisition review' });
  const e2 = await as('post', '/api/v1/context/events', O, T).send({ event_type: 'command_confirmed', project_id: P, summary: 'ZQCMD Rotate the prod DB credentials', metadata: { label: 'ZQCMD rotate creds', run: 'psql $PROD_URL -f rotate_zq.sql' } });
  assert.equal(e1.status, 202);
  assert.equal(e2.status, 202);
  const nodes = (await q('SELECT node_id, node_type, title, metadata->>\'event_type\' AS ev FROM context_graph_nodes WHERE owner_key = $1 AND project_id = $2 AND title LIKE \'ZQ%\'', [T, P])).rows;
  const cmd = nodes.find((n) => n.ev === 'command_confirmed');
  const blocker = nodes.find((n) => n.ev === 'blocker_opened');
  assert.ok(cmd && blocker, JSON.stringify(nodes));

  // The owner reads them; the member on a default share does not.
  const ownGraph = await as('get', `/api/v1/context/graph/projects/${P}`, O, T);
  assert.ok(JSON.stringify(ownGraph.body).includes('rotate_zq.sql'));
  const graph = await as('get', `/api/v1/context/graph/projects/${P}`, M, T);
  assert.equal(graph.status, 200);
  assert.ok(!/ZQCMD|ZQBLOCK|rotate_zq/.test(JSON.stringify(graph.body)), 'no event node from a withheld section');
  for (const node of [cmd, blocker]) {
    const one = await as('get', `/api/v1/context/graph/nodes/${node.node_id}`, M, T);
    assert.equal(one.status, 404, `${node.ev}: ${JSON.stringify(one.body).slice(0, 200)}`);
  }
  const key = await mintKey(M, T);
  const recalled = await mcpCall(key, T, 'recall', { action: 'entities', project_id: P });
  assert.ok(!/ZQCMD|ZQBLOCK|rotate_zq/.test(recalled.raw), recalled.text.slice(0, 300));

  // A share that grants the blocker lets its node through; commands never travel.
  const granted = await team({ sections: [
    { section_key: 'current_task', can_view: true, can_edit: true },
    { section_key: 'blocking_issue', can_view: true, can_edit: false },
  ] });
  await as('post', '/api/v1/context/events', granted.O, granted.T).send({ event_type: 'blocker_opened', project_id: granted.P, summary: 'ZQBLOCK Vendor API quota exhausted until the contract renews' });
  const g2 = await as('get', `/api/v1/context/graph/projects/${granted.P}`, granted.M, granted.T);
  assert.ok(/ZQBLOCK Vendor API quota/.test(JSON.stringify(g2.body)), 'the blocker node follows the blocker section');
});

// ── B5: a Trail dry run predicts the creation refusal ──────────────────────

test('B5: a Trail import dry run into a new project answers 409 duplicate_project_name when the real import would', async () => {
  const { S, P } = await soloProject('trail');
  await as('patch', `/api/v1/context/projects/${P}/context`, S, S.orgId).send({ current_task: 'Ship the reconciliation worker' });
  const exported = await as('get', `/api/v1/context/projects/${P}/trail`, S, S.orgId);
  assert.equal(exported.status, 200, JSON.stringify(exported.body).slice(0, 200));
  const trail = exported.body.trail || exported.body;
  const projectName = (await store.getProject(S.orgId, P)).project_name;

  const real = await as('post', '/api/v1/context/trail/import', S, S.orgId).send({ trail, new_project_name: projectName });
  assert.equal(real.status, 409, JSON.stringify(real.body).slice(0, 200));
  const dry = await as('post', '/api/v1/context/trail/import', S, S.orgId).send({ trail, new_project_name: projectName, dry_run: true });
  assert.equal(dry.status, 409, JSON.stringify(dry.body).slice(0, 300));
  assert.equal(dry.body.error, 'duplicate_project_name');
  assert.match(dry.body.message, /Dry run/);
  assert.equal(dry.body.existing_project_id, P);

  const fine = await as('post', '/api/v1/context/trail/import', S, S.orgId).send({ trail, new_project_name: `Fresh copy ${uuidv4().slice(0, 6)}`, dry_run: true });
  assert.equal(fine.status, 200, JSON.stringify(fine.body).slice(0, 300));
  assert.equal(fine.body.applied, false);
});

// ── C: a teammate completes their task; the owner's state is left alone ─────

const seedTaskState = (context) => {
  context.current_task = 'Harden the payout retry worker';
  context.current_task_source = 'explicit';
  context.task_progress = 'in_progress';
  context.commands = [{ label: 'ZQCMD test', run: 'npm test -- payouts' }];
  context.open_questions = ['ZQQ Do retries need an idempotency key?'];
  context.blocking_issue = 'ZQBLK Waiting on the gateway sandbox credentials';
};

test('C1: a member on a DEFAULT share finishes a task via hosted finish_task; the owner\'s commands, questions and blocker stay', async () => {
  const { O, M, T, P, stored } = await team({ seed: seedTaskState });
  const key = await mintKey(M, T);
  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await mcpCall(key, T, 'manage_memory', { action: 'finish_task', project_id: P });
  const out = await mcpCall(key, T, 'manage_memory', { action: 'finish_task', project_id: P, complete_task: true, confirm_complete: true });
  assert.equal(out.err, false, out.text);
  assert.match(out.text, /Task remains recorded as completed: "Harden the payout retry worker"/);
  assert.match(out.text, /Left as they were \(not shared for editing with you\): [^\n]*command log/);
  for (const label of ['open questions', 'blocker']) assert.ok(out.text.includes(label), `${label} named: ${out.text}`);
  assert.doesNotMatch(out.text, /Cleared:/);
  const c = await stored();
  assert.equal(c.current_status, 'Completed: Harden the payout retry worker');
  // Round 24: the progress marker is the task's own bookkeeping and follows the
  // completion the member may write (scan24-a-fixes 1b).
  assert.equal(c.task_progress, 'completed');
  assert.equal(c.commands.length, 1);
  assert.deepEqual(c.open_questions, ['ZQQ Do retries need an idempotency key?']);
  assert.match(c.blocking_issue, /ZQBLK/);

  // The owner's own completion is unchanged: everything clears, nothing is "left".
  const ownerKey = await mintKey(O, T);
  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await mcpCall(ownerKey, T, 'manage_memory', { action: 'finish_task', project_id: P });
  const own = await mcpCall(ownerKey, T, 'manage_memory', { action: 'finish_task', project_id: P, complete_task: true, confirm_complete: true });
  assert.equal(own.err, false, own.text);
  assert.match(own.text, /Cleared: 1 open question, the blocking issue, 1 command log entry\./);
  assert.doesNotMatch(own.text, /Left as they were/);
  const after = await stored();
  assert.equal(after.task_progress, 'completed');
  assert.deepEqual(after.open_questions, []);
  assert.equal(after.blocking_issue, '');
});

test('C2: a member\'s /events task_completed lands the completion and names what it skipped', async () => {
  const { M, T, P, stored } = await team({ seed: seedTaskState });
  const ev = await as('post', '/api/v1/context/events', M, T).send({ event_type: 'task_completed', project_id: P, summary: 'Harden the payout retry worker' });
  assert.equal(ev.status, 202, JSON.stringify(ev.body).slice(0, 300));
  // task_progress follows the completion since round 24 (scan24-a-fixes 1d).
  assert.deepEqual([...ev.body.skipped_sections].sort(), ['commands', 'shipped']);
  const c = await stored();
  assert.equal(c.current_status, 'Completed: Harden the payout retry worker');
  assert.equal(c.task_progress, 'completed');
  assert.equal(c.commands.length, 1);

  // task_started: the task lands, and its progress marker with it (round 24).
  const started = await as('post', '/api/v1/context/events', M, T).send({ event_type: 'task_started', project_id: P, summary: 'Wire the ledger reconciliation alerts' });
  assert.equal(started.status, 202, JSON.stringify(started.body).slice(0, 300));
  assert.equal(started.body.skipped_sections, undefined);
  assert.equal((await stored()).task_progress, 'in_progress');
  assert.equal((await stored()).current_task, 'Wire the ledger reconciliation alerts');
});

test('C3: a caller-supplied section the member may not edit is still refused, with or without the opt-in', async () => {
  const { M, T, P, stored } = await team({ seed: seedTaskState });
  const plain = await as('patch', `/api/v1/context/projects/${P}/context`, M, T).send({ current_status: 'Completed', open_questions: [] });
  assert.equal(plain.status, 403, JSON.stringify(plain.body));
  const optedIn = await as('patch', `/api/v1/context/projects/${P}/context`, M, T)
    .send({ current_status: 'Completed', goals: ['ZQGOAL rewrite everything'], skip_unwritable_derived: true });
  assert.equal(optedIn.status, 403, JSON.stringify(optedIn.body));
  assert.deepEqual(optedIn.body.blocked_fields, ['goals']);
  const onlyDerived = await as('patch', `/api/v1/context/projects/${P}/context`, M, T).send({ open_questions: [], skip_unwritable_derived: true });
  assert.equal(onlyDerived.status, 403, 'nothing of theirs left to write is a refusal');
  const withFlag = await as('patch', `/api/v1/context/projects/${P}/context`, M, T)
    .send({ current_status: 'Completed: payouts', commands: [], open_questions: [], blocking_issue: '', task_progress: 'completed', skip_unwritable_derived: true });
  assert.equal(withFlag.status, 200, JSON.stringify(withFlag.body).slice(0, 300));
  // The completion's own marker lands with the completion (round 24); the
  // owner's command log, questions and blocker are still skipped.
  assert.deepEqual([...withFlag.body.skipped_sections].sort(), ['blocking_issue', 'commands', 'open_questions']);
  const c = await stored();
  assert.equal(c.current_status, 'Completed: payouts');
  assert.match(c.blocking_issue, /ZQBLK/);
});

// Round 24 reversed this pin's expectation: the reset is the task's own
// bookkeeping, and a member who may set the task resets it (a stale 'completed'
// left the new task unprotected). See scan24-a-fixes 1a / 1c.
test('C4: a member setting a new task resets a completed task_progress with it', async () => {
  const { M, T, P, stored } = await team({ seed: (context) => { seedTaskState(context); context.task_progress = 'completed'; } });
  const res = await as('patch', `/api/v1/context/projects/${P}/context`, M, T).send({ current_task: 'Draft the Q4 capacity plan' });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.skipped_sections, undefined);
  const c = await stored();
  assert.equal(c.current_task, 'Draft the Q4 capacity plan');
  assert.equal(c.task_progress, '');
});
