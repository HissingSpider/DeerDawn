/**
 * ROUTING, ROUND E — over the wire.
 *
 * The service-level half is tests/unit/context-routing-round-e.test.js. These
 * are the defects that only exist at the HTTP / MCP boundary: a request field
 * the schema strips, a refusal that has to reach the caller as a status and a
 * sentence, a response that has to say how far it can be trusted.
 *
 * Real app, real database, real credentials. DB-backed:
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/integration/project-routing-round-e.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const { closeRedisConnections } = require('../../src/config/redis');

const PEOPLE = [];

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  const { key, prefix, hash } = generateApiKey();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, plan, plan, 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${label} key`, userId, orgId, 'production', expiresAt, ['context:read', 'context:write']],
    orgId,
  );
  const person = { label, orgId, userId, email, apiKey: key };
  PEOPLE.push(person);
  return person;
}

test.after(async () => {
  for (const person of PEOPLE) {
    for (const table of ['context_graph_edges', 'context_graph_evidence', 'context_graph_nodes', 'context_workspace_pointers', 'context_sessions']) {
      await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId], 'org-system').catch(() => {});
    }
    await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

const api = (person) => ({
  get: (path) => request(httpServer).get(`/api/v1/context${path}`).set('X-Api-Key', person.apiKey),
  post: (path) => request(httpServer).post(`/api/v1/context${path}`).set('X-Api-Key', person.apiKey),
  patch: (path) => request(httpServer).patch(`/api/v1/context${path}`).set('X-Api-Key', person.apiKey),
});

async function createProject(person, body) {
  const res = await api(person).post('/projects').send({ description: 'routing', goals: [], ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.project;
}

// ─── f. workspace_key survives the request schema ────────────────────────────

test('f: POST /projects keeps the workspace_key it is sent, so the new project can be pinned', async () => {
  const ana = await makePerson('ana');
  const repo = `git:acme/wire-${uuidv4().slice(0, 6)}`;
  const umbrella = await createProject(ana, { project_name: `Wire Umbrella ${uuidv4().slice(0, 6)}`, workspace_key: repo });
  const stream = await createProject(ana, { project_name: `Wire Stream ${uuidv4().slice(0, 6)}`, parent_project_id: umbrella.project_id });

  const pin = await api(ana).post('/subproject/switch').send({ project_id: stream.project_id, workspace_key: repo });
  assert.equal(pin.status, 200, JSON.stringify(pin.body));

  const active = await api(ana).get(`/active?workspace_key=${encodeURIComponent(repo)}`);
  assert.equal(active.status, 200);
  assert.equal(active.body.project_id, stream.project_id, 'the switch reported success and the next session opened somewhere else');
  assert.equal(active.body.match_kind, 'pinned');
});

// ─── g. an archived project refuses writes, and says how to restore it ───────

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : res.text);
}

async function hosted(person, name, args) {
  const res = await request(httpServer).post('/mcp').set(MCP_HEADERS).set('X-Api-Key', person.apiKey)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  return parseRpc(res);
}

async function storedContext(projectId) {
  const row = await db.query('SELECT owner_key FROM context_projects WHERE project_id = $1', [projectId], 'org-system');
  const project = await require('../../src/store/contextSyncStore').getProject(row.rows[0].owner_key, projectId);
  return project.context;
}

test('g: every write to an archived project is refused with the way back, and lands nothing', async () => {
  const ana = await makePerson('ana');
  const project = await createProject(ana, { project_name: `Dormant Work ${uuidv4().slice(0, 6)}`, current_task: 'the task as archived' });
  const id = project.project_id;
  const archived = await api(ana).post(`/projects/${id}/archive`).send({});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));

  const attempts = [
    ['PATCH context', () => api(ana).patch(`/projects/${id}/context`).send({ current_task: 'written into the archive' })],
    ['explicit update', () => api(ana).post('/extraction').send({
      session_id: `sess-${uuidv4()}`, tool: 'claude_code', project_id: id, explicit: true,
      chunks: [{ role: 'assistant', text: 'Decided to move the archive write test into the integration suite.' }],
    })],
    ['hot paths', () => api(ana).post(`/projects/${id}/hot-paths`).send({ items: [{ label: 'entry', path: 'src/index.js' }] })],
    ['debug finding', () => api(ana).post(`/projects/${id}/debug-findings`).send({ summary: 'The archive swallowed a write and reported success.' })],
    ['event', () => api(ana).post('/events').send({ event_type: 'decision_made', project_id: id, summary: 'Decided something inside an archived project.' })],
  ];
  for (const [label, attempt] of attempts) {
    const res = await attempt();
    assert.equal(res.status, 409, `${label}: expected a refusal, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'project_archived', label);
    assert.match(res.body.message, /restore/i, `${label}: the refusal must name the way back`);
    assert.match(res.body.message, /unarchive/, label);
  }

  // Over MCP, through handlers that each wrap service errors their own way. The
  // sentence naming the restore has to survive every one of them.
  const hostedWrites = [
    ['manage_memory', { action: 'update', project_id: id, summary: 'Decided to write into the archive over MCP.' }],
    ['manage_memory', { action: 'record_finding', project_id: id, summary: 'The archive swallowed a finding and reported success.' }],
    ['manage_memory', { action: 'record_paths', project_id: id, items: [{ label: 'entry', path: 'src/index.js' }] }],
    ['manage_memory', { action: 'upsert_entities', entities: [{ title: 'Archive write probe entity', entity_type: 'knowledge', summary: 'Filed under an archived project over MCP.', project_id: id }] }],
    ['manage_tasks', { action: 'add', project_id: id, todos: ['a card added to an archived board'] }],
  ];
  for (const [tool, args] of hostedWrites) {
    const mcp = await hosted(ana, tool, args);
    const mcpText = JSON.stringify(mcp);
    assert.ok(mcp.error || mcp.result?.isError, `${tool} ${args.action}: the hosted write must be an error: ${mcpText}`);
    assert.match(mcpText, /archived/, `${tool} ${args.action}: ${mcpText}`);
    assert.match(mcpText, /restore/, `${tool} ${args.action}: ${mcpText}`);
  }

  const context = await storedContext(id);
  assert.equal(context.current_task, 'the task as archived');
  assert.equal((context.recent_decisions || []).length, 0, 'a refused write still stored a decision');
  assert.equal((context.hot_paths || []).length, 0);
  assert.equal((context.debugging_notes || []).length, 0);
  assert.equal((context.todo_items || []).length, 0, 'a card landed on an archived board');
});

test('g: the restore itself works on an archived project, so does a rename, and then writes land', async () => {
  const ana = await makePerson('ana');
  const project = await createProject(ana, { project_name: `Coming Back ${uuidv4().slice(0, 6)}` });
  const id = project.project_id;
  await api(ana).post(`/projects/${id}/archive`).send({});

  // Renaming is how an archived project's name is freed for reuse.
  const renamed = await api(ana).post(`/projects/${id}/rename`).send({ project_name: `Came Back ${uuidv4().slice(0, 6)}` });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  const restored = await hosted(ana, 'manage_projects', { action: 'restore', project_id: id });
  assert.ok(!restored.error && !restored.result?.isError, JSON.stringify(restored));

  const write = await api(ana).patch(`/projects/${id}/context`).send({ current_task: 'back at work' });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  assert.equal((await storedContext(id)).current_task, 'back at work');
});

// ─── b. /active says how far its match can be trusted ────────────────────────

test('b: a name guess is readable, flagged, never bound to the session, and refused to a caller about to write', async () => {
  const ana = await makePerson('ana');
  const tag = uuidv4().slice(0, 6);
  const lookalike = await createProject(ana, { project_name: `Therapist notes ${tag}` });
  const sessionId = `sess-${uuidv4()}`;
  const cwd = encodeURIComponent('/Users/ana/code/api');

  const read = await api(ana).get(`/active?cwd=${cwd}&mark_session=1&session_id=${sessionId}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.project_id, lookalike.project_id, 'a read is still shown the guess');
  assert.equal(read.body.match_kind, 'name');
  assert.equal(read.body.match_confidence, 'low');
  assert.equal(read.body.write_target, false);

  // The binding is what a later capture with no project_id follows.
  const session = await db.query('SELECT project_id FROM context_sessions WHERE session_id = $1', [sessionId], 'org-system');
  assert.equal(session.rows[0]?.project_id ?? null, null, 'the session was bound to a project it matched only by name');

  const write = await api(ana).get(`/active?cwd=${cwd}&purpose=write`);
  assert.equal(write.status, 200);
  assert.equal(write.body.project_id, null, 'a caller resolving a WRITE target was handed the name guess');

  // A capture from that session, naming no project, must not land there.
  const capture = await api(ana).post('/extraction').send({
    session_id: sessionId,
    tool: 'claude_code',
    session_context: { cwd: '/Users/ana/code/api' },
    chunks: [{ role: 'assistant', text: 'Switched the API gateway to keep-alive connections.' }],
    extraction: {
      match_decision: 'ambiguous', confidence: 0.9, delta: { current_status: 'API gateway uses keep-alive.' },
      should_create_project: false, needs_user_confirmation: false,
    },
  });
  assert.equal(capture.status, 404, JSON.stringify(capture.body));
  assert.notEqual((await storedContext(lookalike.project_id)).current_status, 'API gateway uses keep-alive.');
});

test('b: a real location match is high confidence, a write target, and binds the session', async () => {
  const ana = await makePerson('ana');
  // Below a linked directory the project owns the folder only in the same
  // repository (the folder rule): the local server always sends its identity.
  const identity = 'remote:github.com/ana/linked';
  const project = await createProject(ana, { project_name: `Linked Repo ${uuidv4().slice(0, 6)}`, linked_paths: ['/Users/ana/code/linked'], workspace_key: identity });
  const sessionId = `sess-${uuidv4()}`;
  const active = await api(ana).get(`/active?cwd=${encodeURIComponent('/Users/ana/code/linked/src')}&workspace_key=${encodeURIComponent(identity)}&purpose=write&mark_session=1&session_id=${sessionId}`);
  assert.equal(active.body.project_id, project.project_id);
  assert.equal(active.body.match_kind, 'path');
  assert.equal(active.body.match_confidence, 'high');
  assert.equal(active.body.write_target, true);
  const session = await db.query('SELECT project_id FROM context_sessions WHERE session_id = $1', [sessionId], 'org-system');
  assert.equal(session.rows[0]?.project_id, project.project_id);
});
