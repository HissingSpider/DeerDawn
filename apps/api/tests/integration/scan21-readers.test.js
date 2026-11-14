/**
 * SCAN 21 — READERS.
 *
 * Four readers loaded project rows themselves and put their content in front of
 * a teammate without going through the section-filtered view, so a share that
 * narrowed which sections travel withheld them from the brief and served them
 * everywhere else:
 *
 *   1. GET /projects/:id/share/preview built the preview from the raw row: a
 *      member or viewer saw the description, stack, decisions, open questions,
 *      landmines and shipped work the author withheld.
 *   2. /portfolio (and MCP recall portfolio, which delegates to the same
 *      service) merged decisions from the raw rows.
 *   3. The "Related elsewhere" block in the brief of ANY other project drew its
 *      candidates (decisions, debugging notes) from the raw rows.
 *   4. GET /shares handed every teammate who can read a shared project the
 *      token of the author's unlisted link — and the public page serves the
 *      author's whole brief.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan21-readers.test.js
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

async function mintKey(person, orgId, scopes) {
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
  return JSON.stringify(body);
}

async function createProject(person, ws, name) {
  const res = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name });
  assert.equal(res.status, 201, `project create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.project.project_id;
}

async function share(person, ws, projectId, sections) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws)
    .send(sections ? { visibility: 'shared', sections } : { visibility: 'shared' });
  assert.equal(res.status, 200, `sharing: ${res.status} ${JSON.stringify(res.body)}`);
}

// Written through the store as the author — the production write path — so the
// fixture does not depend on any route's merge rules.
async function writeContext(person, ws, projectId, patch) {
  const raw = await store.getProject(ws, projectId);
  const actor = { id: person.userId, org_id: ws, workspace_key: ws, type: 'user', role: 'admin' };
  await store.saveProject({
    ...raw,
    context: { ...(raw.context || {}), ...patch, project_name: raw.project_name },
    updated_at: new Date().toISOString(),
  }, actor);
}

// Every section carries its own marker, so a leak names the section it came from.
function secretContext(tag) {
  const now = new Date().toISOString();
  return {
    description: `ZQDESC${tag} acquisition is the real plan`,
    current_task: `ZQTASK${tag} migrate the ledger quietly`,
    current_status: `ZQSTATUS${tag} layoffs pending`,
    goals: [`VISGOAL${tag} ship the ledger`],
    open_questions: [`ZQQUEST${tag} should we tell the board?`],
    recent_decisions: [{ summary: `ZQDEC${tag} lay off the payments team`, decided_at: now }],
    tech_stack: [`ZQSTACK${tag} oracle`],
    debugging_notes: [{ summary: `ZQDEBUG${tag} the payroll job double-pays execs`, paths: ['src/zqdebug.js'], added_at: now }],
    landmines: [{ summary: `ZQLAND${tag} never touch the exec table`, added_at: now }],
    shipped: [{ summary: `ZQSHIP${tag} severance calculator`, shipped_at: now }],
  };
}

const markers = (text, tag) => [...new Set(String(text).match(new RegExp(`ZQ[A-Z]+${tag}`, 'g')) || [])];

async function team(tag) {
  const O = await makePerson(`owner${tag}`, { plan: 'developer_pro' });
  const M = await makePerson(`member${tag}`);
  const V = await makePerson(`viewer${tag}`);
  await join(O, M);
  await join(O, V, 'viewer');
  return { O, M, V, T: O.orgId };
}

// ── 1 ────────────────────────────────────────────────────────────────────────

test('1: a teammate\'s share preview shows only what the share lets them read; the author\'s shows the brief', async () => {
  const tag = uuidv4().slice(0, 6).replace(/[^a-z]/g, 'x');
  const { O, M, V, T } = await team(tag);

  // P: narrowed to goals. PD: shared at the defaults (task, status, decisions, board).
  const P = await createProject(O, T, `Ledger ${tag}`);
  await share(O, T, P, [{ section_key: 'goals', can_view: true, can_edit: true }]);
  await writeContext(O, T, P, secretContext(tag));
  const PD = await createProject(O, T, `Ledger default ${tag}`);
  await share(O, T, PD);
  await writeContext(O, T, PD, secretContext(tag));

  const own = await as('get', `/api/v1/context/projects/${P}/share/preview`, O, T);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.ok(JSON.stringify(own.body).includes(`ZQDEC${tag}`), 'the author previews the whole brief (control)');

  for (const reader of [M, V]) {
    const narrow = await as('get', `/api/v1/context/projects/${P}/share/preview`, reader, T);
    assert.equal(narrow.status, 200, JSON.stringify(narrow.body));
    assert.deepEqual(markers(JSON.stringify(narrow.body), tag), [], `${reader.label}: narrow-share preview leaked`);

    const dflt = await as('get', `/api/v1/context/projects/${PD}/share/preview`, reader, T);
    assert.equal(dflt.status, 200, JSON.stringify(dflt.body));
    const leaked = markers(JSON.stringify(dflt.body), tag)
      // Decisions travel on a default share; everything else in the preview does not.
      .filter((m) => !m.startsWith('ZQDEC'));
    assert.deepEqual(leaked, [], `${reader.label}: default-share preview leaked`);
    assert.ok(JSON.stringify(dflt.body).includes(`ZQDEC${tag}`), `${reader.label}: a shared section still previews`);
  }
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test('2: the portfolio (REST and MCP) merges only the decisions a teammate may read', async () => {
  const tag = uuidv4().slice(0, 6).replace(/[^a-z]/g, 'x');
  const { O, M, V, T } = await team(tag);

  const P = await createProject(O, T, `Ledger ${tag}`);
  await share(O, T, P, [{ section_key: 'goals', can_view: true, can_edit: true }]);
  await writeContext(O, T, P, secretContext(tag));

  const own = await as('get', '/api/v1/context/portfolio', O, T);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.locked, false, 'portfolio unlocked on the team plan');
  assert.ok(JSON.stringify(own.body).includes(`ZQDEC${tag}`), 'the author\'s portfolio carries the decision (control)');

  for (const reader of [M, V]) {
    const rest = await as('get', '/api/v1/context/portfolio', reader, T);
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.deepEqual(markers(JSON.stringify(rest.body), tag), [], `${reader.label}: /portfolio leaked`);

    const key = await mintKey(reader, T, reader === V ? ['context:read'] : ['context:read', 'context:write']);
    const viaMcp = await mcp(key, 'recall', { action: 'portfolio' });
    assert.ok(!/isError":true/.test(viaMcp), `${reader.label}: recall portfolio errored: ${viaMcp.slice(0, 300)}`);
    assert.deepEqual(markers(viaMcp, tag), [], `${reader.label}: recall portfolio leaked`);
  }
});

// ── 3 ────────────────────────────────────────────────────────────────────────

test('3: "Related elsewhere" in a teammate\'s own brief carries nothing a share withholds', async () => {
  const tag = uuidv4().slice(0, 6).replace(/[^a-z]/g, 'x');
  const { O, M, V, T } = await team(tag);

  const P = await createProject(O, T, `Ledger ${tag}`);
  await share(O, T, P, [{ section_key: 'goals', can_view: true, can_edit: true }]);
  await writeContext(O, T, P, secretContext(tag));

  // A task that bears on P's decision ("payments") and debugging note ("payroll").
  const task = {
    current_task: 'reconcile the payroll payments before quarter close',
    open_questions: ['why does payroll double-pay the payments batch?'],
  };
  // The owner's own neighbour proves the retrieval would surface P's work here —
  // without it, an empty block would pass the leak assertions for free.
  const QO = await createProject(O, T, `Payroll owner ${tag}`);
  await writeContext(O, T, QO, task);
  const control = await as('get', `/api/v1/context/projects/${QO}/inject?tool=claude_code&verbosity=detailed`, O, T);
  assert.equal(control.status, 200, control.text);
  assert.ok(markers(control.text, tag).some((m) => m.startsWith('ZQDEC') || m.startsWith('ZQDEBUG')),
    `control: the owner's related block surfaces P (got ${markers(control.text, tag)})`);

  // M's own project, and a defaults-shared project V can read.
  const QM = await createProject(M, T, `Payroll member ${tag}`);
  await writeContext(M, T, QM, task);
  const QV = await createProject(O, T, `Payroll viewer ${tag}`);
  await share(O, T, QV);
  await writeContext(O, T, QV, task);

  for (const [reader, projectId] of [[M, QM], [V, QV]]) {
    const inject = await as('get', `/api/v1/context/projects/${projectId}/inject?tool=claude_code&verbosity=detailed`, reader, T);
    assert.equal(inject.status, 200, inject.text);
    assert.deepEqual(markers(inject.text, tag), [], `${reader.label}: brief of their own project leaked P`);

    const key = await mintKey(reader, T, reader === V ? ['context:read'] : ['context:read', 'context:write']);
    const session = await mcp(key, 'start_session', { project_id: projectId });
    assert.deepEqual(markers(session, tag), [], `${reader.label}: start_session leaked P`);
    const recalled = await mcp(key, 'recall', { action: 'context', project_id: projectId });
    assert.deepEqual(markers(recalled, tag), [], `${reader.label}: recall context leaked P`);
  }
});

// ── 4 ────────────────────────────────────────────────────────────────────────

test('4: a share link\'s token is listed only to its author and workspace owners', async () => {
  const tag = uuidv4().slice(0, 6).replace(/[^a-z]/g, 'x');
  const { O, M, V, T } = await team(tag);
  const O2 = await makePerson(`coowner${tag}`);
  await join(O, O2, 'owner');

  // Authored by M, so the workspace owner O is not the author: the owner branch
  // is exercised on its own.
  const P = await createProject(M, T, `Ledger ${tag}`);
  await share(M, T, P, [{ section_key: 'goals', can_view: true, can_edit: true }]);
  await writeContext(M, T, P, secretContext(tag));

  let minted = await as('post', `/api/v1/context/projects/${P}/share`, M, T).send({ visibility: 'unlisted' });
  if (minted.status === 422) {
    const ids = (minted.body.scan?.findings || []).map((f) => f.id);
    minted = await as('post', `/api/v1/context/projects/${P}/share`, M, T)
      .send({ visibility: 'unlisted', acknowledged_finding_ids: ids });
  }
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const token = minted.body.share.token;
  assert.ok(token);

  const rowFor = async (person) => {
    const res = await as('get', '/api/v1/context/shares', person, T);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { text: JSON.stringify(res.body), row: (res.body.shares || []).find((s) => s.project_id === P) };
  };

  const author = await rowFor(M);
  assert.equal(author.row?.token, token, 'the link\'s author holds the token');
  for (const owner of [O, O2]) {
    const listed = await rowFor(owner);
    assert.equal(listed.row?.token, token, `${owner.label}: a workspace owner holds the token (may revoke it)`);
  }

  // A second member who can read P (goals only) sees the link exists, not the key.
  const M2 = await makePerson(`member2${tag}`);
  await join(O, M2);
  for (const reader of [V, M2]) {
    const listed = await rowFor(reader);
    assert.ok(listed.row, `${reader.label}: the link is still listed`);
    assert.equal(listed.row.token, null, `${reader.label}: no token`);
    assert.equal(listed.row.token_withheld, true);
    assert.ok(!listed.text.includes(token), `${reader.label}: token appears nowhere in the listing`);
  }
});

// ── 5 (found by the reader sweep) ────────────────────────────────────────────

test('5: presence names a peer\'s held card and recent nodes only from sections the reader may read', async () => {
  const tag = uuidv4().slice(0, 6).replace(/[^a-z]/g, 'x');
  const { O, M, T } = await team(tag);
  const service = require('../../src/services/contextSyncService');

  // P: goals only. PB: the board and decisions shared (defaults) — the control.
  const P = await createProject(O, T, `Ledger ${tag}`);
  await share(O, T, P, [{ section_key: 'goals', can_view: true, can_edit: true }]);
  const PB = await createProject(O, T, `Board ${tag}`);
  await share(O, T, PB);

  const now = new Date().toISOString();
  for (const projectId of [P, PB]) {
    const peer = `sess-o-${projectId}`;
    await writeContext(O, T, projectId, {
      goals: [`VISGOAL${tag}`],
      todo_items: [{
        id: `card-${tag}`, title: `ZQCARD${tag} draft the severance letters`, status: 'in_progress',
        phase: 'in_progress', held_by: peer, held_at: now, created_at: now, updated_at: now,
      }],
    });
    await store.saveSession({
      session_id: peer, owner_key: T, user_id: O.userId, tool: 'claude_code', surface_type: 'coding',
      project_id: projectId, status: 'active', created_at: now, updated_at: now, last_seen_at: now,
    });
    await store.upsertGraphNode({
      node_id: `graph_node_${uuidv4()}`, owner_key: T, project_id: projectId, node_type: 'decision',
      canonical_key: `decision:${uuidv4()}`, title: `ZQNODE${tag} lay off the payments team`, summary: 'x',
      metadata: { entity_type: 'decision', scope: 'project' }, confidence: 0.9,
      source_session_id: peer, source_tool: 'claude_code', created_at: now, updated_at: now, last_seen_at: now,
    });
  }

  const actor = { id: M.userId, org_id: M.orgId, workspace_key: T, type: 'user', role: 'admin' };
  const shown = await service.getProjectPresence(actor, PB, 'sess-m');
  assert.equal(shown.length, 1, 'control: the peer is present');
  assert.ok(JSON.stringify(shown).includes(`ZQCARD${tag}`), 'control: a shared board names the held card');
  assert.ok(JSON.stringify(shown).includes(`ZQNODE${tag}`), 'control: shared decisions name the scope');

  const narrowed = await service.getProjectPresence(actor, P, 'sess-m');
  assert.equal(narrowed.length, 1, 'the peer is still present');
  assert.deepEqual(markers(JSON.stringify(narrowed), tag), [], 'presence leaked withheld sections');
});

// ── 6 (found by the reader sweep) ────────────────────────────────────────────

test('6: the activity strip never names a colleague\'s personal project', async () => {
  const tag = uuidv4().slice(0, 6).replace(/[^a-z]/g, 'x');
  const { O, M, T } = await team(tag);

  const mine = await createProject(O, T, `Owner stale ${tag}`);
  const theirs = await createProject(M, T, `ZQPERSONAL${tag} job hunt`);
  const res = await as('patch', `/api/v1/teams/projects/${theirs}/sharing`, M, T).send({ visibility: 'personal' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await q('UPDATE context_projects SET updated_at = NOW() - INTERVAL \'30 days\' WHERE project_id = ANY($1)', [[mine, theirs]]);

  const owner = await as('get', '/api/v1/context/activity', O, T);
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.ok(owner.body.activity.stale_project_names.includes(`Owner stale ${tag}`), 'control: own stale project named');
  assert.deepEqual(markers(JSON.stringify(owner.body), tag), [], 'a colleague\'s personal project was named');
  assert.equal(owner.body.activity.stale_projects, owner.body.activity.stale_project_names.length,
    'the stale count does not count what the names withhold');

  const author = await as('get', '/api/v1/context/activity', M, T);
  assert.ok(author.body.activity.stale_project_names.includes(`ZQPERSONAL${tag} job hunt`), 'its author still sees it');
});
