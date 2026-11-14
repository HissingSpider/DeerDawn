/**
 * Scan 12 (2026-09-22), visibility. Each test pins one defect with the request
 * that exposed it:
 *
 *   #1 HIGH  "solo" was decided by today's member count. When a two-person team
 *            shrank to one, the filters switched themselves off: the remaining
 *            owner read the departed member's PERSONAL activity (/audit, graph
 *            export) and LOST their org-owned PRIVATE projects (list, export,
 *            recall) — the continuity case owners read private work for.
 *   #2 MED   /audit judged a row by its project's CURRENT readability, so the
 *            deletion (or move-out) of a SHARED project was visible only to the
 *            person who did it.
 *   #3 LOW   the stream filter read every channel suffix as a project id, so
 *            `:preferences`, `:global` and `:session:<id>` never reached anyone
 *            on a shared workspace.
 *   #4 MED   POST /graph/nodes stamps source_tool 'dashboard', which the node
 *            schema rejected: one hand-added node broke start_session, recall
 *            context and the graph reads until it was deleted.
 *   #5 HIGH  session_context.host / cwd were `string | undefined`; the round-11
 *            mcp-server sends null, so every local summary update 400'd.
 *
 * Run: bash scripts/run-db-test.sh node --test tests/integration/scan12-visibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);

const db = require('../../src/config/db');
const { generateApiKey, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const contextRoutes = require('../../src/routes/context/context-sync');

const created = { orgs: new Set() };

test.after(async () => {
  for (const orgId of created.orgs) {
    for (const sql of [
      'DELETE FROM context_audit_logs WHERE owner_key = $1',
      'DELETE FROM context_graph_evidence WHERE owner_key = $1',
      'DELETE FROM context_graph_edges WHERE owner_key = $1',
      'DELETE FROM context_graph_nodes WHERE owner_key = $1',
      'DELETE FROM context_sessions WHERE owner_key = $1',
      'DELETE FROM context_projects WHERE owner_key = $1',
      'DELETE FROM workspace_members WHERE owner_key = $1',
      'DELETE FROM workspace_invites WHERE owner_key = $1',
      'DELETE FROM workspace_ownership_backfills WHERE owner_key = $1',
    ]) await db.query(sql, [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
  }
  await new Promise((resolve) => httpServer.close(resolve));
  const { closeRedisConnections } = require('../../src/config/redis');
  await closeRedisConnections().catch(() => {});
  await db.pool.end().catch(() => {});
});

// A separate org per person, always: the org plan cache holds for 300s.
async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@scan12.test`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5], orgId,
  );
  await db.query('INSERT INTO users (user_id, email, role, org_id) VALUES ($1, $2, $3, $4)', [userId, email, 'admin', orgId], orgId);
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${label} key`, userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    orgId,
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  created.orgs.add(orgId);
  return { label, orgId, userId, email, apiKey: key, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin' }) };
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, path, person, { ws = null, key = false } = {}) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${key ? person.apiKey : person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function createProject(person, ws, name) {
  const res = await as('post', '/api/v1/context/projects', person, { ws, key: true })
    .send({ project_name: name, current_task: `${name} task` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.project.project_id;
}

async function setVisibility(projectId, visibility) {
  await db.query('UPDATE context_projects SET visibility = $1 WHERE project_id = $2', [visibility, projectId], 'org-system');
}

async function audit(ownerKey, { projectId = null, action, actor, metadata = {} }) {
  await db.query(
    `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata)
     VALUES ($1, $2, $3, $4, 'user', $5, 'dashboard', $6)`,
    [`audit_${uuidv4()}`, ownerKey, projectId, action, actor.userId, metadata],
    'org-system',
  );
}

let rpcId = 1;
async function mcp(person, name, args = {}) {
  const res = await request(httpServer).post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('x-api-key', person.apiKey)
    .send({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
  let body = res.body;
  if (!body || !Object.keys(body).length) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  const text = (body?.result?.content || []).map((c) => c.text).join('\n') || body?.error?.message || '';
  return { isError: Boolean(body?.error || body?.result?.isError), text };
}

const auditRows = async (person, ws) => {
  const res = await as('get', '/api/v1/context/audit?limit=100', person, { ws });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.logs;
};
const projectOf = (row) => row.project_id || row.metadata?.project_id;

// ── #1 ──────────────────────────────────────────────────────────────────────

test('#1 a team that shrinks to one: the owner keeps the private work and still cannot read the personal', async () => {
  const owner = await makePerson('shrinkowner', { plan: 'developer_pro' });
  const member = await makePerson('shrinkmember');
  await join(owner, member, 'member');
  const tag = uuidv4().slice(0, 6);

  const priv = await createProject(member, owner.orgId, `Handover PRIVATE ${tag}`);
  const personal = await createProject(member, owner.orgId, `Side SECRET ${tag}`);
  await setVisibility(priv, 'private');
  await setVisibility(personal, 'personal');
  const node = await as('post', '/api/v1/context/graph/nodes', member, { ws: owner.orgId, key: true })
    .send({ project_id: personal, node_type: 'decision', title: `Competitor offer SECRET ${tag}` });
  assert.equal(node.status, 201, JSON.stringify(node.body));
  await audit(owner.orgId, { projectId: personal, action: 'context_write', actor: member });

  const removed = await as('delete', `/api/v1/teams/members/${member.userId}`, owner);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await workspace.isSharedWorkspace(owner.orgId), false, 'precondition: the team is down to one');

  // Every check is collected, so a failure names ALL of what broke rather than
  // the first: on main both directions fail at once.
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };

  // Private: the owner still reads it — list, export, recall.
  const list = await as('get', '/api/v1/context/projects', owner);
  const names = list.body.projects.map((p) => p.project_name);
  check(names.includes(`Handover PRIVATE ${tag}`), `list: owner lost the departed member's private project (${names})`);
  check(!names.includes(`Side SECRET ${tag}`), 'list: personal must stay the author\'s');

  const exported = await as('get', '/api/v1/context/export', owner);
  assert.equal(exported.status, 200);
  const exportText = JSON.stringify(exported.body) + (exported.text || '');
  check(exportText.includes(`Handover PRIVATE ${tag}`), 'export: must carry the private project');
  check(!exportText.includes(`SECRET ${tag}`), 'export: must not carry the personal project');

  const recalled = await mcp(owner, 'recall', { action: 'projects' });
  assert.equal(recalled.isError, false, recalled.text);
  check(recalled.text.includes(`Handover PRIVATE ${tag}`), 'recall projects: must list the private project');
  check(!recalled.text.includes(`SECRET ${tag}`), 'recall projects: must not list the personal project');

  // Personal: still hidden from the owner — audit and graph export.
  const rows = await auditRows(owner);
  check(!rows.some((r) => projectOf(r) === personal), 'audit: owner read the departed member\'s personal activity');
  const graphExport = await as('get', '/api/v1/context/graph/export', owner);
  assert.equal(graphExport.status, 200);
  check(!(JSON.stringify(graphExport.body) + (graphExport.text || '')).includes(`SECRET ${tag}`),
    'graph export: carries the personal project\'s node');

  assert.deepEqual(problems, []);
});

test('#1 control: a genuinely solo account is unfiltered, and costs one visibility query', async () => {
  const solo = await makePerson('shrinksolo');
  const pid = await createProject(solo, null, `Solo ${uuidv4().slice(0, 6)}`);
  const actor = { type: 'user', id: solo.userId, org_id: solo.orgId, role: 'admin', scopes: [] };
  // null = "no filter", the answer every solo read path depends on.
  assert.equal(await service.visibleProjectIdsForActor(actor, solo.orgId), null);

  // The shortcut is one query, not a roster walk: count the statements it runs.
  //
  // Only ITS statements, on a cold call. Two things made this a race that a
  // loaded CI runner lost and a fast machine never did:
  //  - The answer is memoised on the actor object for 2s (MAY_HOLD_OTHERS_TTL_MS),
  //    so re-asking with the same actor usually ran NO query and the count was
  //    whatever else happened to be running. A fresh actor object measures the
  //    shortcut itself.
  //  - The patch replaces db.query for the whole process, and work earlier tests
  //    fired and forgot (graph cleanup, product events) was still landing
  //    queries in the window. An AsyncLocalStorage context follows this call
  //    through every await it makes, and nothing started before it carries it.
  const { AsyncLocalStorage } = require('node:async_hooks');
  const measuring = new AsyncLocalStorage();
  const coldActor = { ...actor };
  const original = db.query;
  let statements = 0;
  db.query = function counted(...args) {
    if (measuring.getStore()) statements += 1;
    return original.apply(this, args);
  };
  let answer;
  try {
    answer = await measuring.run(true, () => service.visibleProjectIdsForActor(coldActor, solo.orgId));
  } finally {
    db.query = original;
  }
  assert.equal(answer, null);
  assert.ok(statements >= 1, 'the cold call must actually ask the database (else this measures nothing)');
  assert.ok(statements <= 1, `a solo visibility check ran ${statements} queries`);

  const del = await as('delete', `/api/v1/context/projects/${pid}`, solo);
  assert.equal(del.status, 200);
  const rows = await auditRows(solo);
  assert.ok(rows.some((r) => r.action === 'project_deleted' && projectOf(r) === pid), 'a solo owner sees their own deletion');
});

// ── #2 ──────────────────────────────────────────────────────────────────────

test('#2 the deletion of a SHARED project is the team\'s news; a personal one stays its author\'s', async () => {
  const owner = await makePerson('delowner', { plan: 'developer_pro' });
  const member = await makePerson('delmember');
  const viewer = await makePerson('delviewer');
  await join(owner, member, 'member');
  await join(owner, viewer, 'viewer');

  const shared = await createProject(member, owner.orgId, `Team thing ${uuidv4().slice(0, 6)}`);
  const personal = await createProject(member, owner.orgId, `Side thing ${uuidv4().slice(0, 6)}`);
  const priv = await createProject(member, owner.orgId, `Org thing ${uuidv4().slice(0, 6)}`);
  await setVisibility(shared, 'shared');
  await setVisibility(personal, 'personal');
  await setVisibility(priv, 'private');
  for (const pid of [shared, personal, priv]) {
    const del = await as('delete', `/api/v1/context/projects/${pid}`, member, { ws: owner.orgId, key: true });
    assert.equal(del.status, 200, JSON.stringify(del.body));
  }

  // The contract with teams.js: project_moved_out carries the visibility too.
  const movedShared = `project_${uuidv4()}`;
  const movedPersonal = `project_${uuidv4()}`;
  await audit(owner.orgId, { action: 'project_moved_out', actor: member, metadata: { project_id: movedShared, to: member.orgId, visibility: 'shared' } });
  await audit(owner.orgId, { action: 'project_moved_out', actor: member, metadata: { project_id: movedPersonal, to: member.orgId, visibility: 'personal' } });
  // A legacy row about a gone project, with nothing recorded: stays with its actor.
  const legacy = `project_${uuidv4()}`;
  await audit(owner.orgId, { projectId: legacy, action: 'project_deleted', actor: member, metadata: { project_id: legacy } });

  const seen = async (person) => new Set((await auditRows(person, owner.orgId)).map(projectOf));

  const ownerSees = await seen(owner);
  assert.ok(ownerSees.has(shared), 'owner must see a shared project\'s deletion');
  assert.ok(ownerSees.has(priv), 'owner must see a private project\'s deletion (owners read private)');
  assert.ok(ownerSees.has(movedShared), 'owner must see a shared project moving out');
  assert.ok(!ownerSees.has(personal), 'owner must not see a personal project\'s deletion');
  assert.ok(!ownerSees.has(movedPersonal));
  assert.ok(!ownerSees.has(legacy), 'a legacy row with no recorded visibility stays with its actor');

  const viewerSees = await seen(viewer);
  assert.ok(viewerSees.has(shared), 'viewer must see a shared project\'s deletion');
  assert.ok(viewerSees.has(movedShared));
  assert.ok(!viewerSees.has(personal));
  assert.ok(!viewerSees.has(priv), 'a viewer does not read private work, deleted or not');
  assert.ok(!viewerSees.has(legacy));

  const memberSees = await seen(member);
  for (const pid of [shared, personal, priv, movedShared, movedPersonal, legacy]) {
    assert.ok(memberSees.has(pid), `the actor sees their own row for ${pid}`);
  }

  const row = (await auditRows(owner, owner.orgId)).find((r) => projectOf(r) === shared && r.action === 'project_deleted');
  assert.equal(row.metadata.visibility, 'shared', 'project_deleted records the visibility at the time');
});

// ── #3 ──────────────────────────────────────────────────────────────────────
//
// The stream's Redis branch never runs under NODE_ENV=test, so the per-message
// filter it uses is pinned directly.

test('#3 the stream filter passes workspace channels and routes a session channel to its person', async () => {
  const owner = await makePerson('chanowner', { plan: 'developer_pro' });
  const member = await makePerson('chanmember');
  await join(owner, member, 'member');
  const personal = await createProject(member, owner.orgId, `Member side ${uuidv4().slice(0, 6)}`);
  await setVisibility(personal, 'personal');

  const ownerActor = { type: 'user', id: owner.userId, org_id: owner.orgId, role: 'admin', scopes: [] };
  const memberActor = { type: 'user', id: member.userId, org_id: member.orgId, workspace_key: owner.orgId, role: 'admin', scopes: [] };
  const ownerMay = contextRoutes.createStreamProjectFilter(ownerActor, owner.orgId);
  const memberMay = contextRoutes.createStreamProjectFilter(memberActor, owner.orgId);

  for (const may of [ownerMay, memberMay]) {
    assert.equal(await may('preferences'), true, 'preferences_updated is workspace-wide');
    assert.equal(await may('global'), true, 'global_updated is workspace-wide');
  }

  // A session with a person: to that person only.
  const now = new Date().toISOString();
  const base = {
    owner_key: owner.orgId, tool: 'claude_code', surface_type: 'code', conversation_ref: '', cwd: '', host: '', tab_id: '',
    status: 'active', routing_state: 'matched', match_confidence: 1, created_at: now, updated_at: now, last_seen_at: now,
  };
  const memberSession = `sess-${uuidv4()}`;
  await store.saveSession({ ...base, session_id: memberSession, user_id: member.userId, project_id: personal });
  assert.equal(await memberMay(`session:${memberSession}`), true, 'a person\'s own session event reaches them');
  assert.equal(await ownerMay(`session:${memberSession}`), false, 'and nobody else');

  // No person behind it: judged by the project it is bound to.
  const anonymous = `sess-${uuidv4()}`;
  await store.saveSession({ ...base, session_id: anonymous, user_id: null, project_id: personal });
  assert.equal(await ownerMay(`session:${anonymous}`), false, 'an unattributed session on a hidden project stays hidden');
  const unbound = `sess-${uuidv4()}`;
  await store.saveSession({ ...base, session_id: unbound, user_id: null, project_id: null });
  assert.equal(await ownerMay(`session:${unbound}`), true, 'an unattributed, unbound session passes as before');

  // Project channels are unchanged.
  assert.equal(await ownerMay(personal), false);
  assert.equal(await memberMay(personal), true);
});

// ── #4 ──────────────────────────────────────────────────────────────────────

test('#4 a node added from the dashboard does not break the brief or the graph reads', async () => {
  const person = await makePerson('dashnode');
  const pid = await createProject(person, null, `Dash nodes ${uuidv4().slice(0, 6)}`);
  const upd = await mcp(person, 'manage_memory', { action: 'update', project_id: pid, summary: 'Decided: Postgres advisory locks for the queue.' });
  assert.equal(upd.isError, false, upd.text);

  const created = await as('post', '/api/v1/context/graph/nodes', person, { key: true })
    .send({ project_id: pid, node_type: 'concept', title: 'Manually added concept', summary: 's', metadata: { x: 1 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const nodeId = created.body.node.node_id;

  const session = await mcp(person, 'start_session', { project_id: pid });
  assert.equal(session.isError, false, `start_session: ${session.text.slice(0, 200)}`);
  const recalled = await mcp(person, 'recall', { action: 'context', project_id: pid });
  assert.equal(recalled.isError, false, `recall context: ${recalled.text.slice(0, 200)}`);
  const graph = await as('get', `/api/v1/context/graph/projects/${pid}`, person, { key: true });
  assert.equal(graph.status, 200, JSON.stringify(graph.body).slice(0, 300));
  assert.ok(graph.body.graph?.nodes?.some((n) => n.node_id === nodeId) || JSON.stringify(graph.body).includes(nodeId));
  const one = await as('get', `/api/v1/context/graph/nodes/${nodeId}`, person, { key: true });
  assert.equal(one.status, 200, JSON.stringify(one.body).slice(0, 300));
});

test('#4 one stored node the schema rejects is skipped, not allowed to fail the read', async () => {
  const person = await makePerson('badnode');
  const pid = await createProject(person, null, `Bad nodes ${uuidv4().slice(0, 6)}`);
  const good = await as('post', '/api/v1/context/graph/nodes', person, { key: true })
    .send({ project_id: pid, node_type: 'concept', title: 'Readable concept' });
  assert.equal(good.status, 201);
  // A provenance value nobody has listed yet — the next 'dashboard'.
  const badId = `node_${uuidv4()}`;
  await db.query(
    `UPDATE context_graph_nodes SET source_tool = 'some_future_tool', node_id = $2
      WHERE owner_key = $1 AND node_id = $3`,
    [person.orgId, badId, good.body.node.node_id],
    'org-system',
  );
  const readable = await as('post', '/api/v1/context/graph/nodes', person, { key: true })
    .send({ project_id: pid, node_type: 'concept', title: 'Second readable concept' });
  assert.equal(readable.status, 201);

  const session = await mcp(person, 'start_session', { project_id: pid });
  assert.equal(session.isError, false, `start_session: ${session.text.slice(0, 200)}`);
  const graph = await as('get', `/api/v1/context/graph/projects/${pid}`, person, { key: true });
  assert.equal(graph.status, 200, JSON.stringify(graph.body).slice(0, 300));
  const body = JSON.stringify(graph.body);
  assert.ok(body.includes(readable.body.node.node_id), 'the readable node is still served');
  assert.ok(!body.includes(badId), 'the unreadable node is skipped');
});

// ── #5 ──────────────────────────────────────────────────────────────────────

test('#5 a summary update with host:null (and cwd:null) is accepted, as is one without', async () => {
  const person = await makePerson('hostnull');
  const pid = await createProject(person, null, `Host null ${uuidv4().slice(0, 6)}`);
  const contexts = [
    { cwd: '/tmp/r', host: null, status: 'active' },
    { cwd: null, host: null, status: 'active' },
    { cwd: '/tmp/r', status: 'active' },
  ];
  for (const sessionContext of contexts) {
    const res = await as('post', '/api/v1/context/extraction', person, { key: true }).send({
      session_id: `agent-${uuidv4().slice(0, 8)}`,
      tool: 'claude_code',
      project_id: pid,
      explicit: true,
      session_context: sessionContext,
      chunks: [{ role: 'assistant', text: `Chose advisory locks ${uuidv4().slice(0, 4)}.` }],
    });
    assert.equal(res.status, 202, `${JSON.stringify(sessionContext)} -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }

  const patched = await as('patch', `/api/v1/context/sessions/agent-${uuidv4().slice(0, 8)}`, person, { key: true })
    .send({ tool: 'claude_code', host: null, cwd: '/tmp/r' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 300));
  assert.equal(patched.body.session.host, '', 'null is stored as absent');
});

test('#5 the Stop-hook flush\'s workspace_key reaches the extraction path', async () => {
  const person = await makePerson('flushkey');
  const pid = await createProject(person, null, `Flush key ${uuidv4().slice(0, 6)}`);
  const key = `github.com/scan12/${uuidv4().slice(0, 8)}`;
  const res = await as('post', '/api/v1/context/extraction', person, { key: true }).send({
    session_id: `agent-${uuidv4().slice(0, 8)}`,
    tool: 'claude_code',
    project_id: pid,
    session_context: { cwd: '/tmp/flushkey', host: 'claude_code', surface_type: 'code', workspace_key: key },
    chunks: [{ role: 'user', text: 'Decide the queue.' }, { role: 'assistant', text: 'Chose Postgres advisory locks for the queue.' }],
    extraction: {
      match_decision: 'matched_existing', confidence: 0.9, should_create_project: false, needs_user_confirmation: false,
      delta: { recent_decisions: [{ summary: 'Chose Postgres advisory locks for the queue.', decided_at: new Date().toISOString() }] },
    },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body).slice(0, 300));
  const stored = await store.getProject(person.orgId, pid);
  assert.equal(stored.workspace_key, key, 'the repo key the flush sent must tag the project it landed in');
});
