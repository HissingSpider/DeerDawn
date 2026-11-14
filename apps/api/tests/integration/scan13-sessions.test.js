/**
 * Scan 13 (2026-09-22), sessions and the write path. Each test pins one defect
 * with the request that exposed it:
 *
 *   #1 HIGH  PATCH /sessions/:id loaded the row by (owner_key, session_id) only,
 *            so any teammate — a viewer's dashboard session included — could
 *            rewrite a colleague's session (user_id taken over, project rebound,
 *            cwd overwritten) and the victim's next flush landed in the rebound
 *            project. The same missing author check sat on /extraction, the
 *            passive /active touch and the topic chip. PATCH also stored ANY
 *            project id, so an owner could bind a session to a colleague's
 *            personal project (an existence oracle), and a viewer could write.
 *   #2 MED-H GET /sessions returned every member's sessions — personal project
 *            ids, cwd, host, conversation_ref — to any member, viewer or read key.
 *   #3 MED   the explicit-update reply relayed the REQUEST's delta, so a task the
 *            explicit-task gate refused came back as "Task → X"; duplicate list
 *            items came back as added.
 *   #4 MED   next_action survived an explicit task change and a finish_task.
 *   #5 LOW   hosted finish_task emitted no task_completed, so a task finished
 *            from claude.ai never reached `shipped` (the local dispatcher does).
 *   #6 LOW   a solo account ran workspaceMayHoldOthersWork twice per graph read
 *            and per hosted start_session.
 *   #7 HIGH  the secret redactor ran on a few fields only: a key pasted into a
 *            finding, a decision headline, the task/status/goals, a graph node
 *            or the event log was stored verbatim and served on /active (the
 *            SessionStart hook injects it), /inject and /trail.
 *
 * Run: bash scripts/run-db-test.sh node --test tests/integration/scan13-sessions.test.js
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
const trailFormat = require('../../src/services/trail/trailFormat');

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
async function makePerson(label, { plan = 'free', scopes = ['context:read', 'context:write'] } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@scan13.test`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5], orgId,
  );
  await db.query('INSERT INTO users (user_id, email, role, org_id) VALUES ($1, $2, $3, $4)', [userId, email, 'admin', orgId], orgId);
  const person = { label, orgId, userId, email, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin' }) };
  person.apiKey = await mintKey(person, orgId, scopes);
  await workspace.ensureOwnerMembership(orgId, userId);
  created.orgs.add(orgId);
  return person;
}

async function mintKey(person, orgId, scopes) {
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${person.label} key`, person.userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), scopes],
    orgId,
  );
  return key;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, path, person, { ws = null, key = false, apiKey = null } = {}) {
  const token = apiKey || (key ? person.apiKey : person.jwt);
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${token}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function createProject(person, ws, name) {
  const res = await as('post', '/api/v1/context/projects', person, { ws })
    .send({ project_name: name });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.project.project_id;
}

async function setVisibility(projectId, visibility) {
  await db.query('UPDATE context_projects SET visibility = $1 WHERE project_id = $2', [visibility, projectId], 'org-system');
}

async function sessionRow(ownerKey, sessionId) {
  const result = await db.query(
    'SELECT project_id, cwd, host, user_id FROM context_sessions WHERE owner_key = $1 AND session_id = $2',
    [ownerKey, sessionId],
    'org-system',
  );
  return result.rows[0] || null;
}

let rpcId = 1;
async function mcp(person, name, args = {}, { apiKey = null } = {}) {
  const res = await request(httpServer).post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('x-api-key', apiKey || person.apiKey)
    .send({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
  let body = res.body;
  if (!body || !Object.keys(body).length) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  const text = (body?.result?.content || []).map((c) => c.text).join('\n') || body?.error?.message || '';
  return { isError: Boolean(body?.error || body?.result?.isError), text };
}

async function team() {
  const owner = await makePerson('owner', { plan: 'developer_pro' });
  const member = await makePerson('member');
  const viewer = await makePerson('viewer');
  await join(owner, member, 'member');
  await join(owner, viewer, 'viewer');
  const tag = uuidv4().slice(0, 6);
  const personal = await createProject(member, owner.orgId, `Job hunt ${tag}`);
  await setVisibility(personal, 'personal');
  const shared = await createProject(owner, owner.orgId, `Team shared ${tag}`);
  await setVisibility(shared, 'shared');
  const sid = `claude_code-${uuidv4()}`;
  const up = await as('patch', `/api/v1/context/sessions/${sid}`, member, { ws: owner.orgId })
    .send({ tool: 'claude_code', project_id: personal, cwd: '/Users/mem/interviews/acme', host: 'mems-macbook' });
  assert.equal(up.status, 200, `the member registers their own session: ${JSON.stringify(up.body)}`);
  return { owner, member, viewer, personal, shared, sid, ws: owner.orgId };
}

const ownerActor = (person, ws) => ({ type: 'user', id: person.userId, org_id: person.orgId, workspace_key: ws, role: 'admin', scopes: [] });

// ── #1 ──────────────────────────────────────────────────────────────────────

test('#1 a teammate cannot rewrite a colleague\'s session, by any path', async () => {
  const { owner, member, viewer, personal, shared, sid, ws } = await team();
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  const untouched = async (label) => {
    const row = await sessionRow(ws, sid);
    check(row?.project_id === personal, `${label}: session rebound to ${row?.project_id}`);
    check(row?.cwd === '/Users/mem/interviews/acme', `${label}: cwd overwritten to ${row?.cwd}`);
    check(row?.user_id === member.userId, `${label}: session taken over by ${row?.user_id}`);
  };

  const byOwner = await as('patch', `/api/v1/context/sessions/${sid}`, owner, { ws })
    .send({ project_id: shared, cwd: '/tmp/hijack' });
  check(byOwner.status === 404, `owner PATCH of the member's session answered ${byOwner.status}`);
  await untouched('owner PATCH');

  const byViewer = await as('patch', `/api/v1/context/sessions/${sid}`, viewer, { ws })
    .send({ project_id: shared });
  check(byViewer.status === 403 || byViewer.status === 404, `viewer PATCH answered ${byViewer.status}`);
  await untouched('viewer PATCH');

  // /extraction takes the session id from the body too.
  const flush = await as('post', '/api/v1/context/extraction', owner, { ws }).send({
    session_id: sid,
    tool: 'claude_code',
    project_id: shared,
    chunks: [{ role: 'assistant', text: 'Owner flush on somebody else\'s session.' }],
    extraction: { match_decision: 'matched_existing', confidence: 0.95, delta: { current_status: 'owner flush' }, should_create_project: false, needs_user_confirmation: false },
  });
  check(flush.status === 404, `owner /extraction on the member's session answered ${flush.status}`);
  await untouched('owner /extraction');

  // The passive /active touch re-points a session by the id on the query string.
  await service.touchSession(ownerActor(owner, ws), sid, shared);
  await untouched('owner passive touch');

  // Binding a session to a project the caller cannot read is not found — no oracle.
  const sid2 = `claude_code-${uuidv4()}`;
  const oracle = await as('patch', `/api/v1/context/sessions/${sid2}`, owner, { ws })
    .send({ tool: 'claude_code', project_id: personal });
  check(oracle.status === 404, `owner binding a session to a colleague's personal project answered ${oracle.status}`);
  check(!(await sessionRow(ws, sid2)), 'the refused binding still created a session row');

  // A viewer writes nothing, not even a new session of their own.
  const viewerNew = await as('patch', `/api/v1/context/sessions/claude_code-${uuidv4()}`, viewer, { ws })
    .send({ tool: 'claude_code' });
  check(viewerNew.status === 403, `a viewer creating a session answered ${viewerNew.status}`);

  // The topic chip reads a colleague's session as no session.
  const rebind = await as('patch', `/api/v1/context/sessions/${sid}`, member, { ws }).send({ project_id: shared });
  check(rebind.status === 200, `the member rebinding their OWN session answered ${rebind.status}`);
  const topic = await service.getSessionTopic(ownerActor(owner, ws), { session_id: sid, tool: 'claude_web' });
  check(!topic.active_topic, 'the topic chip reported the member\'s session binding to the owner');

  // Controls: the owner may still create and bind their own session.
  const own = await as('patch', `/api/v1/context/sessions/claude_code-${uuidv4()}`, owner, { ws })
    .send({ tool: 'claude_code', project_id: shared });
  check(own.status === 200, `the owner creating their own session answered ${own.status}`);

  assert.deepEqual(problems, []);
});

// ── #2 ──────────────────────────────────────────────────────────────────────

test('#2 GET /sessions lists only the caller\'s own sessions; a solo account sees all of its own', async () => {
  const { owner, member, viewer, sid, ws } = await team();
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  const has = (res) => (res.body.sessions || []).some((s) => s.session_id === sid);

  const viewerKey = await mintKey(viewer, ws, ['context:read']);
  for (const [label, res] of [
    ['viewer', await as('get', '/api/v1/context/sessions', viewer, { ws })],
    ['viewer read key', await as('get', '/api/v1/context/sessions', viewer, { apiKey: viewerKey })],
    ['owner', await as('get', '/api/v1/context/sessions', owner, { ws })],
  ]) {
    check(res.status === 200, `${label}: ${res.status}`);
    check(!has(res), `${label} listed the member's session (personal project, cwd, host)`);
  }
  const mine = await as('get', '/api/v1/context/sessions', member, { ws });
  check(has(mine), 'the member no longer sees their own session');

  const solo = await makePerson('solo');
  const s1 = `claude_code-${uuidv4()}`;
  const made = await as('patch', `/api/v1/context/sessions/${s1}`, solo).send({ tool: 'claude_code' });
  check(made.status === 200, `solo PATCH: ${made.status}`);
  // An unattributed row (it predates attribution) is still the solo owner's.
  const s2 = `legacy-${uuidv4()}`;
  await db.query(
    `INSERT INTO context_sessions (session_id, owner_key, user_id, tool, surface_type, status, routing_state, match_confidence, created_at, updated_at, last_seen_at)
     VALUES ($1, $2, NULL, 'claude_web', 'browser', 'active', 'global_only', 0, NOW(), NOW(), NOW())`,
    [s2, solo.orgId],
    'org-system',
  );
  const soloList = await as('get', '/api/v1/context/sessions', solo);
  const ids = (soloList.body.sessions || []).map((s) => s.session_id);
  check(ids.includes(s1) && ids.includes(s2), `solo list lost a session: ${ids}`);

  assert.deepEqual(problems, []);
});

// ── #3 ──────────────────────────────────────────────────────────────────────

test('#3 the write reply reports what was applied, not what was asked for', async () => {
  const person = await makePerson('taskrep');
  const pid = await createProject(person, null, `TaskRep ${uuidv4().slice(0, 6)}`);
  const set = await as('patch', `/api/v1/context/projects/${pid}/context`, person, { key: true })
    .send({ current_task: 'Port auth middleware', goals: ['Ship Fastify port'] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const actor = { type: 'key', id: `key-${uuidv4()}`, owner_id: person.userId, org_id: person.orgId, scopes: ['context:read', 'context:write'] };

  const outcome = await service.recordExplicitUpdate(actor, {
    session_id: `agent-${uuidv4().slice(0, 8)}`,
    tool: 'claude_code',
    project_id: pid,
    summary: 'Benchmarked things.',
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.95,
      project_candidate: { project_id: pid },
      delta: { current_task: 'Something invented', goals: ['Ship Fastify port', 'Add tracing'] },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });
  assert.equal(outcome.project.context.current_task, 'Port auth middleware', 'precondition: the explicit task held');
  assert.equal(outcome.extraction.delta.current_task, undefined, 'the reply reported a task the server refused');
  assert.deepEqual(outcome.extraction.delta.goals, ['Add tracing'], 'the reply reported an already-stored goal as added');
  assert.equal(outcome.extraction.delta.current_task_source, undefined, 'server bookkeeping is not a change the caller made');

  // The plain /extraction route relays the same thing.
  const res = await as('post', '/api/v1/context/extraction', person, { key: true }).send({
    session_id: `agent-${uuidv4().slice(0, 8)}`,
    tool: 'claude_code',
    project_id: pid,
    chunks: [{ role: 'assistant', text: 'More benchmarking.' }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.95,
      delta: { current_task: 'Invented again', goals: ['Add tracing', 'Cut p95'] },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.extraction.delta.current_task, undefined);
  assert.deepEqual(res.body.extraction.delta.goals, ['Cut p95']);
});

// ── #4 ──────────────────────────────────────────────────────────────────────

test('#4 next_action does not outlive its task', async () => {
  const person = await makePerson('nextaction');
  const pid = await createProject(person, null, `Next ${uuidv4().slice(0, 6)}`);
  const patch = async (body) => {
    const res = await as('patch', `/api/v1/context/projects/${pid}/context`, person, { key: true }).send(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.project.context;
  };

  let ctx = await patch({ current_task: 'Build the importer', next_action: 'Write the CSV parser' });
  assert.equal(ctx.next_action, 'Write the CSV parser');
  ctx = await patch({ current_task: 'Harden the webhook' });
  assert.equal(ctx.next_action || '', '', `a new task kept the old task's next step: ${ctx.next_action}`);

  // A request that names both keeps both.
  ctx = await patch({ current_task: 'Cut the release', next_action: 'Tag v2.1' });
  assert.equal(ctx.next_action, 'Tag v2.1');

  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid });
  const finished = await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid, complete_task: true, confirm_complete: true });
  assert.equal(finished.isError, false, finished.text);
  const after = await store.getProject(person.orgId, pid);
  assert.equal(after.context.task_progress, 'completed');
  assert.equal(after.context.next_action || '', '', `finish_task kept the finished task's next step: ${after.context.next_action}`);
});

// ── #5 ──────────────────────────────────────────────────────────────────────

test('#5 hosted finish_task lands the task in shipped, once', async () => {
  const person = await makePerson('finishparity');
  const pid = await createProject(person, null, `Finish ${uuidv4().slice(0, 6)}`);
  const set = await as('patch', `/api/v1/context/projects/${pid}/context`, person, { key: true })
    .send({ current_task: 'Ship the importer' });
  assert.equal(set.status, 200);
  // The same work is also a board card, completed first: it must not ship twice.
  const add = await mcp(person, 'manage_tasks', { action: 'add', project_id: pid, todos: ['Ship the importer'] });
  assert.equal(add.isError, false, add.text);
  const done = await mcp(person, 'manage_tasks', { action: 'complete', project_id: pid, todos: ['Ship the importer'] });
  assert.equal(done.isError, false, done.text);

  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid });
  const finished = await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid, complete_task: true, confirm_complete: true });
  assert.equal(finished.isError, false, finished.text);
  const after = await store.getProject(person.orgId, pid);
  const shipped = (after.context.shipped || []).filter((entry) => /ship the importer/i.test(entry.summary));
  assert.equal(shipped.length, 1, `shipped: ${JSON.stringify(after.context.shipped)}`);

  // And a task that was never a card reaches shipped too — the part that was missing.
  const pid2 = await createProject(person, null, `Finish2 ${uuidv4().slice(0, 6)}`);
  await as('patch', `/api/v1/context/projects/${pid2}/context`, person, { key: true }).send({ current_task: 'Migrate the billing cron' });
  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid2 });
  const finished2 = await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid2, complete_task: true, confirm_complete: true });
  assert.equal(finished2.isError, false, finished2.text);
  const after2 = await store.getProject(person.orgId, pid2);
  assert.deepEqual((after2.context.shipped || []).map((entry) => entry.summary), ['Migrate the billing cron']);

  // The completion EVENT (which both dispatchers now send) must not erase what
  // it completes. It cleared current_task_source, and a person-set task shaped
  // like probe wording — and the `Completed: …` status quoting it — were then
  // blanked by normalizeContextForSchema as connection-test chatter.
  const pid3 = await createProject(person, null, `Finish3 ${uuidv4().slice(0, 6)}`);
  await as('patch', `/api/v1/context/projects/${pid3}/context`, person, { key: true }).send({ current_task: 'Run the smoke test' });
  await service.applyStructuredContextEvent(
    { type: 'user', id: person.userId, org_id: person.orgId, scopes: [] },
    { event_type: 'task_completed', project_id: pid3, summary: 'Run the smoke test', metadata: { source: 'cleanup_context', surface: 'claude_code' } },
  );
  const after3 = await store.getProject(person.orgId, pid3);
  assert.equal(after3.context.current_task, 'Run the smoke test', 'the completion erased the task it completed');
  assert.equal(after3.context.current_status, 'Completed: Run the smoke test', 'the completion erased its own status');
  assert.equal(after3.context.task_progress, 'completed');
});

// ── #6 ──────────────────────────────────────────────────────────────────────

test('#6 a solo account asks workspaceMayHoldOthersWork once per graph read and per hosted start_session', async () => {
  const person = await makePerson('memo');
  const pid = await createProject(person, null, `Memo ${uuidv4().slice(0, 6)}`);
  const node = await as('post', '/api/v1/context/graph/nodes', person, { key: true })
    .send({ project_id: pid, node_type: 'concept', title: 'Memo concept' });
  assert.equal(node.status, 201, JSON.stringify(node.body));

  const original = store.workspaceMayHoldOthersWork;
  let calls = 0;
  store.workspaceMayHoldOthersWork = function counted(...args) { calls += 1; return original.apply(this, args); };
  try {
    const graph = await as('get', `/api/v1/context/graph/projects/${pid}`, person, { key: true });
    assert.equal(graph.status, 200);
    assert.equal(calls, 1, `GET /graph/projects/:id asked ${calls} times`);

    calls = 0;
    // No project_id: resolving the active project lists projects (the owner
    // check) and then filters the brief's graph (the visibility check) — the
    // two helpers that each asked on their own.
    const started = await mcp(person, 'start_session', {});
    assert.equal(started.isError, false, started.text.slice(0, 200));
    assert.equal(calls, 1, `hosted start_session asked ${calls} times`);
  } finally {
    store.workspaceMayHoldOthersWork = original;
  }
});

// ── #7 ──────────────────────────────────────────────────────────────────────
//
// Provider patterns the redactor already knows on this base; DeerDawn's own
// dd_/ddr_ key shapes join the same function in #535 and are covered by these
// same choke points the moment they do.

test('#7 a pasted secret is stored redacted on every write path, and the REST reads mask older rows', async () => {
  const OPENAI = `sk-${'A1b2C3d4'.repeat(5)}`;
  const GITHUB = `ghp_${'Z9y8X7w6'.repeat(5)}`;
  const leaks = (text) => [OPENAI, GITHUB].filter((secret) => String(text).includes(secret));
  const person = await makePerson('secrets');
  const pid = await createProject(person, null, `Secrets ${uuidv4().slice(0, 6)}`);
  const problems = [];
  const check = (text, where) => {
    const found = leaks(text);
    if (found.length) problems.push(`${where} holds ${found.map((s) => s.slice(0, 6)).join(', ')}`);
  };

  const patched = await as('patch', `/api/v1/context/projects/${pid}/context`, person, { key: true }).send({
    current_task: `Rotate the leaked key ${OPENAI}`,
    current_status: `Blocked until ${GITHUB} is revoked`,
    description: `Billing service, key ${OPENAI}`,
    goals: [`Stop pasting ${GITHUB} into chat`],
    blocking_issue: `CI still reads ${OPENAI}`,
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 300));

  const finding = await mcp(person, 'manage_memory', { action: 'record_finding', project_id: pid, summary: `The webhook logged ${GITHUB} on retry`, paths: ['src/webhook.ts'] });
  assert.equal(finding.isError, false, finding.text);

  const actor = { type: 'key', id: `key-${uuidv4()}`, owner_id: person.userId, org_id: person.orgId, scopes: ['context:read', 'context:write'] };
  await service.recordExplicitUpdate(actor, {
    session_id: `agent-${uuidv4().slice(0, 8)}`,
    tool: 'claude_code',
    project_id: pid,
    summary: 'Decided to move every provider key into the vault.',
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.95,
      project_candidate: { project_id: pid },
      delta: {
        recent_decisions: [{ summary: 'Move keys into the vault', headline: `Vault replaces ${OPENAI}` }],
        tech_stack: [`Vault fronting ${GITHUB}`],
      },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });

  const node = await as('post', '/api/v1/context/graph/nodes', person, { key: true })
    .send({ project_id: pid, node_type: 'decision', title: `Revoke ${GITHUB}`, summary: `Old key ${OPENAI}` });
  assert.equal(node.status, 201, JSON.stringify(node.body).slice(0, 300));
  check(JSON.stringify(node.body), 'POST /graph/nodes reply');

  // Stored: the context, the event log, graph nodes and evidence.
  const stored = await store.getProject(person.orgId, pid);
  check(JSON.stringify(stored.context), 'stored context');
  const events = await db.query('SELECT delta::text AS d FROM context_events WHERE project_id = $1', [pid], 'org-system');
  check(events.rows.map((r) => r.d).join('\n'), 'context_events');
  const nodes = await db.query(
    'SELECT title, summary, canonical_key, metadata::text AS m FROM context_graph_nodes WHERE owner_key = $1',
    [person.orgId], 'org-system',
  );
  check(JSON.stringify(nodes.rows), 'graph nodes');
  const evidence = await db.query('SELECT excerpt, metadata::text AS m FROM context_graph_evidence WHERE owner_key = $1', [person.orgId], 'org-system');
  check(JSON.stringify(evidence.rows), 'graph evidence');
  if (!JSON.stringify(stored.context).includes('[REDACTED]')) problems.push('stored context: the secret was dropped rather than masked');

  // Served: a row written before the store redacted (simulated by writing the
  // column directly) is still masked on the three REST reads.
  await db.query(
    'UPDATE context_projects SET context = context || jsonb_build_object(\'next_action\', $2::text) WHERE project_id = $1',
    [pid, `Paste ${OPENAI} into the deploy`], 'org-system',
  );
  const injectJson = await as('get', `/api/v1/context/projects/${pid}/inject?format=json`, person, { key: true });
  assert.equal(injectJson.status, 200);
  check(JSON.stringify(injectJson.body), '/inject?format=json');
  const injectText = await as('get', `/api/v1/context/projects/${pid}/inject?tool=claude_code&verbosity=detailed`, person, { key: true });
  check(JSON.stringify(injectText.body), '/inject');
  const active = await as('get', '/api/v1/context/active?format=json', person, { key: true });
  assert.equal(active.status, 200);
  if (active.body.context?.project_id === pid) check(JSON.stringify(active.body), '/active?format=json');
  else problems.push(`/active did not resolve the project (${active.body.context?.project_id})`);
  const trail = await as('get', `/api/v1/context/projects/${pid}/trail`, person, { key: true });
  assert.equal(trail.status, 200);
  check(trail.text, '/trail');
  const trailDoc = JSON.parse(trail.text);
  assert.deepEqual(trailFormat.verifyChecksum(trailDoc), { valid: true }, 'the masked trail is re-sealed, so it still verifies');
  const trailMd = await as('get', `/api/v1/context/projects/${pid}/trail?format=markdown`, person, { key: true });
  check(trailMd.text, '/trail markdown');

  assert.deepEqual(problems, []);
});
