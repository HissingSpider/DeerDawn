/**
 * SCAN 36 (b). Writes that said they landed, and a boot that waited on a lock.
 *
 *   W1. Every write that rebuilds a list from the row it read (the decision
 *       log, the debugging log, hot paths, the board, open questions) saves
 *       with a compare-and-swap and re-runs from a fresh read when it loses.
 *       A concurrent teammate's entry that lands between the read and the save
 *       is kept, and a write that loses the swap on every attempt answers
 *       "Context NOT updated … Retry" instead of "Context updated" (b/p112).
 *   W2. ensureSchema skips an index that already exists with a catalog read,
 *       so a booting machine is not queued behind another machine's
 *       CREATE INDEX CONCURRENTLY (a/F3).
 *   W3. recall never prints an internal canonical key (with a project id) as
 *       the summary of a node whose summary is empty.
 *   W4. A founder's brief keeps its "Related projects" line after the first
 *       invite split their shared nodes into per-project copies.
 *
 * The concurrency pins are deterministic: store.saveProject is wrapped so a
 * second writer's request runs to completion INSIDE the first writer's save,
 * after its read and before its write — the exact interleaving that lost data.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan36-b-fixes.test.js
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
const store = require('../../src/store/contextSyncStore');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const q = (sql, params) => db.query(sql, params, 'org-system');
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

async function flush(person, ws, projectId, delta) {
  const res = await as('post', '/api/v1/context/extraction', person, ws).send({
    session_id: `s36-${uuidv4()}`, tool: 'claude_code', project_id: projectId,
    chunk: { role: 'user', text: 'work' },
    extraction: { match_decision: 'matched_existing', confidence: 0.9, should_create_project: false, needs_user_confirmation: false, delta },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body));
}

// A second writer's decision, filed through the REST events route.
async function concurrentDecision(person, ws, projectId, summary) {
  const res = await as('post', '/api/v1/context/events', person, ws)
    .send({ event_type: 'decision_made', project_id: projectId, summary });
  assert.equal(res.status, 202, JSON.stringify(res.body));
}

// Runs `concurrent` inside the first save whose row `match`es — after that
// writer read the project and before its write reaches the table — up to
// `times` times. The concurrent writer's own saves pass straight through.
function interleaveSaves(match, concurrent, { times = 1 } = {}) {
  const original = store.saveProject;
  let fired = 0;
  let busy = false;
  store.saveProject = async function wrapped(project, ...rest) {
    if (!busy && fired < times && match(project)) {
      fired += 1;
      busy = true;
      try { await concurrent(fired); } finally { busy = false; }
    }
    return original.call(this, project, ...rest);
  };
  return { restore() { store.saveProject = original; }, get fired() { return fired; } };
}

const decisionsOf = async (ws, projectId) => ((await store.getProject(ws, projectId)).context.recent_decisions || []).map((d) => d.summary);
const hasDecision = (project, marker) => (project?.context?.recent_decisions || []).some((d) => String(d?.summary || '').includes(marker));

// ─── W1 ──────────────────────────────────────────────────────────────────────

test('W1: a decision filed between an update\'s read and its save survives, and both callers are told the truth', async () => {
  const O = await makePerson('w1a', { plan: 'developer_pro' });
  const key = await mintKey(O, O.orgId);
  const P = await newProject(O, 'Race36');
  await mcpCall(key, O.orgId, 'start_session', { project_id: P });
  const t = tag();

  const hook = interleaveSaves(
    (project) => project.project_id === P && hasDecision(project, `ALPHA36${t}`),
    () => concurrentDecision(O, O.orgId, P, `Decided BETA36${t}: keep the queue.`),
  );
  let reply;
  try {
    reply = await mcpCall(key, O.orgId, 'manage_memory', { action: 'update', project_id: P, summary: `Decided ALPHA36${t}: use libalpha.` });
  } finally {
    hook.restore();
  }
  assert.equal(hook.fired, 1, 'the interleaving must actually have happened');
  const decisions = await decisionsOf(O.orgId, P);
  assert.ok(decisions.some((d) => d.includes(`BETA36${t}`)), `the concurrent decision was overwritten: ${JSON.stringify(decisions)}`);
  assert.ok(decisions.some((d) => d.includes(`ALPHA36${t}`)), JSON.stringify(decisions));
  assert.match(reply.text, /Context updated/, reply.text);
});

test('W1: an update that loses the swap on every attempt says NOT updated, and overwrites nobody', async () => {
  const O = await makePerson('w1b', { plan: 'developer_pro' });
  const key = await mintKey(O, O.orgId);
  const P = await newProject(O, 'Hot36');
  await mcpCall(key, O.orgId, 'start_session', { project_id: P });
  const t = tag();

  const hook = interleaveSaves(
    (project) => project.project_id === P && hasDecision(project, `GAMMA36${t}`),
    (n) => concurrentDecision(O, O.orgId, P, `Decided BUSY36${t} number ${n}: other writer.`),
    { times: 10 },
  );
  let reply;
  try {
    reply = await mcpCall(key, O.orgId, 'manage_memory', { action: 'update', project_id: P, summary: `Decided GAMMA36${t}: use libgamma.` });
  } finally {
    hook.restore();
  }
  const decisions = await decisionsOf(O.orgId, P);
  for (let n = 1; n <= hook.fired; n += 1) {
    assert.ok(decisions.some((d) => d.includes(`BUSY36${t} number ${n}:`)), `other writer #${n} was overwritten: ${JSON.stringify(decisions)}`);
  }
  assert.ok(!decisions.some((d) => d.includes(`GAMMA36${t}`)), 'a write that never won the swap is not in the brief');
  assert.match(reply.text, /Context NOT updated/, reply.text);
  assert.match(reply.text, /context_write_conflict: nothing was saved/, reply.text);
  assert.match(reply.text, /Retry/, reply.text);
});

test('W1: record_finding, record_paths, the board and resolve_question re-read instead of overwriting a concurrent decision', async () => {
  const O = await makePerson('w1c', { plan: 'developer_pro' });
  const key = await mintKey(O, O.orgId);
  const P = await newProject(O, 'Lists36');
  await mcpCall(key, O.orgId, 'start_session', { project_id: P });
  const t = tag();
  await flush(O, O.orgId, P, { open_questions: [`Which queue QUESTION36${t}?`] });

  const cases = [
    {
      name: 'record_finding',
      match: (project) => (project.context?.debugging_notes || []).some((n) => String(n?.summary || '').includes(`FINDING36${t}`)),
      run: () => mcpCall(key, O.orgId, 'manage_memory', { action: 'record_finding', project_id: P, summary: `FINDING36${t}: the webhook retries twice.`, paths: ['src/webhook.js'] }),
    },
    {
      name: 'record_paths',
      match: (project) => (project.context?.hot_paths || []).some((h) => String(h?.path || '').includes(`hot36${t}`)),
      run: () => mcpCall(key, O.orgId, 'manage_memory', { action: 'record_paths', project_id: P, items: [{ label: `Hot ${t}`, path: `src/hot36${t}.js`, purpose: 'entry' }] }),
    },
    {
      name: 'board',
      match: (project) => (project.context?.todo_items || []).some((c) => String(c?.title || '').includes(`CARD36${t}`)),
      run: () => as('post', '/api/v1/context/events', O, O.orgId).send({ event_type: 'todo_added', project_id: P, summary: `CARD36${t} wire the exporter`, metadata: { todos: [`CARD36${t} wire the exporter`] } }),
    },
    {
      name: 'resolve_question',
      match: (project) => hasDecision(project, `ANSWER36${t}`),
      run: () => mcpCall(key, O.orgId, 'manage_memory', { action: 'resolve_question', project_id: P, question: `Which queue QUESTION36${t}?`, answer: `ANSWER36${t} use SQS` }),
    },
  ];
  for (const c of cases) {
    const marker = `SIDE36${t}-${c.name}`;
    const hook = interleaveSaves(c.match, () => concurrentDecision(O, O.orgId, P, `Decided ${marker}: side writer.`));
    try {
      await c.run();
    } finally {
      hook.restore();
    }
    assert.equal(hook.fired, 1, `${c.name}: the interleaving must actually have happened`);
    const decisions = await decisionsOf(O.orgId, P);
    assert.ok(decisions.some((d) => d.includes(marker)), `${c.name} overwrote the concurrent decision: ${JSON.stringify(decisions)}`);
    const ctx = (await store.getProject(O.orgId, P)).context;
    assert.ok(c.match({ context: ctx }), `${c.name}'s own write landed too`);
  }
});

test('W1: teammates updating a shared project at once — every "Context updated" decision is in the brief', async () => {
  const O = await makePerson('w1d', { plan: 'developer_pro' });
  const A = await makePerson('w1da');
  const B = await makePerson('w1db');
  await join(O, A, 'member');
  await join(O, B, 'member');
  const T = O.orgId;
  const P = await newProject(O, 'Team36', T);
  const shared = await as('patch', `/api/v1/teams/projects/${P}/sharing`, O, T).send({ visibility: 'shared', sections: ['current_task', 'recent_decisions', 'tech_stack', 'open_questions', 'current_status'] });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const keys = { O: await mintKey(O, T), A: await mintKey(A, T), B: await mintKey(B, T) };
  for (const k of Object.values(keys)) await mcpCall(k, T, 'start_session', { project_id: P });
  const t = tag();
  const names = [];
  const calls = [];
  for (let round = 0; round < 2; round += 1) {
    for (const [n, k] of Object.entries(keys)) {
      names.push(`${n}${round}`);
      calls.push(mcpCall(k, T, 'manage_memory', { action: 'update', project_id: P, summary: `Decided PAR36${t} ${n}${round}: use lib${n}${round}.` }));
    }
  }
  const replies = await Promise.all(calls);
  const decisions = await decisionsOf(T, P);
  replies.forEach((reply, i) => {
    const present = decisions.some((d) => d.includes(`PAR36${t} ${names[i]}:`));
    if (/Context updated/.test(reply.text)) assert.ok(present, `${names[i]} was told "Context updated" but its decision is gone: ${reply.text}`);
    else assert.match(reply.text, /Context NOT updated|context_write_conflict/, reply.text);
  });
});

// ─── W2 ──────────────────────────────────────────────────────────────────────

test('W2: a booting machine\'s ensureSchema is not queued behind a CONCURRENTLY build\'s lock on context_graph_nodes', async () => {
  await store.ensureSchema();
  // What CREATE INDEX CONCURRENTLY holds for its whole run.
  const holder = await db.pool.connect();
  let pending = null;
  try {
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE context_graph_nodes IN SHARE UPDATE EXCLUSIVE MODE');
    // A second machine: a fresh copy of the store, whose schema bootstrap has
    // not run in this process.
    const path = require.resolve('../../src/store/contextSyncStore');
    const cached = require.cache[path];
    delete require.cache[path];
    let freshStore;
    try {
      freshStore = require('../../src/store/contextSyncStore');
    } finally {
      require.cache[path] = cached;
    }
    const started = Date.now();
    pending = freshStore.ensureSchema().then(() => 'done', (err) => `failed: ${err.message}`);
    const outcome = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('blocked'), 4000))]);
    assert.equal(outcome, 'done', `ensureSchema waited on the build's lock (${Date.now() - started}ms)`);
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    holder.release();
    if (pending) await pending;
  }
});

// ─── W3 / W4 ─────────────────────────────────────────────────────────────────

async function founderWithTwoProjects(label) {
  const F = await makePerson(`${label}f`, { plan: 'developer_pro' });
  const T = F.orgId;
  const fkey = await mintKey(F, T);
  const t = tag();
  const apiName = `Api${label}${t}`;
  const webName = `Web${label}${t}`;
  const A = (await as('post', '/api/v1/context/projects', F, T).send({ project_name: apiName })).body.project.project_id;
  const W = (await as('post', '/api/v1/context/projects', F, T).send({ project_name: webName })).body.project.project_id;
  const decision = `Decided every service logs JSON to stdout ${t}.`;
  const service = `Postgres${t}`;
  for (const P of [A, W]) {
    await mcpCall(fkey, T, 'start_session', { project_id: P });
    await flush(F, T, P, { tech_stack: [service], recent_decisions: [{ summary: decision, decided_at: new Date().toISOString() }] });
    await new Promise((r) => setTimeout(r, 300));
  }
  return { F, T, fkey, A, W, apiName, webName, decision, service, t };
}

test('W3: recall never prints an internal key or a project id for a node with no summary', async () => {
  const { F, T, fkey, service, t } = await founderWithTwoProjects('w3');
  const M = await makePerson('w3m');
  await join(F, M, 'member');
  // The first invite split the founder's shared nodes into per-project copies,
  // written with an empty summary.
  const blank = (await q(
    'SELECT canonical_key FROM context_graph_nodes WHERE owner_key = $1 AND canonical_key LIKE \'%::in.%\' AND coalesce(summary, \'\') = \'\'',
    [T],
  )).rows;
  assert.ok(blank.length > 0, 'the scenario must produce a blank per-project copy');
  for (const query of [service, `stdout ${t}`]) {
    const hosted = await mcpCall(fkey, T, 'recall', { action: 'entities', query });
    assert.ok(!hosted.err, hosted.text);
    assert.doesNotMatch(hosted.text, /::in\.|project_[0-9a-f-]{8}/, `hosted recall: ${hosted.text}`);
    const rest = await as('get', '/api/v1/context/workspace/entities', F, T).query({ query });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.doesNotMatch(String(rest.body.text || ''), /::in\.|project_[0-9a-f-]{8}/, `REST text: ${rest.body.text}`);
  }
  const hosted = await mcpCall(fkey, T, 'recall', { action: 'entities', query: service });
  assert.match(hosted.text, new RegExp(`- ${service}`), hosted.text);

  // The workspace overview's lists render the same way (shared-context).
  const { formatWorkspaceOverview } = require('../../../../packages/shared-context/src/index.js');
  const now = new Date().toISOString();
  const node = {
    node_id: 'n36', owner_key: T, project_id: 'project_36', node_type: 'service', canonical_key: 'service:pg36::in.project_1234abcd-5678',
    title: 'Pg36', summary: '', metadata: {}, confidence: 0.9, source_tool: 'claude_code', created_at: now, updated_at: now, last_seen_at: now,
  };
  const overview = formatWorkspaceOverview({ mode: 'overview', knowledge: [node], tools: [node], capabilities: [node] });
  assert.doesNotMatch(overview, /::in\.|project_1234/, overview);
  assert.match(overview, /- Pg36\n/, overview);
});

test('W4: the founder\'s brief keeps "Related projects" after the first invite; a teammate is not told about a project they cannot read', async () => {
  const { F, T, fkey, A, W, apiName, webName } = await founderWithTwoProjects('w4');
  const before = (await mcpCall(fkey, T, 'start_session', { project_id: W })).text;
  assert.match(before, new RegExp(`Related projects:[^\\n]*${apiName}`), `solo brief: ${before}`);

  const M = await makePerson('w4m');
  await join(F, M, 'member');
  const after = (await mcpCall(fkey, T, 'start_session', { project_id: W })).text;
  assert.match(after, new RegExp(`Related projects:[^\\n]*${apiName}`), `founder brief after the invite: ${after}`);
  const afterA = (await mcpCall(fkey, T, 'start_session', { project_id: A })).text;
  assert.match(afterA, new RegExp(`Related projects:[^\\n]*${webName}`), `founder brief of the other project: ${afterA}`);

  // Web shared with the team; Api stays the founder's own.
  const shared = await as('patch', `/api/v1/teams/projects/${W}/sharing`, F, T).send({ visibility: 'shared' });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const mkey = await mintKey(M, T);
  const teammate = (await mcpCall(mkey, T, 'start_session', { project_id: W })).text;
  assert.doesNotMatch(teammate, new RegExp(apiName), `teammate brief names the founder's unshared project: ${teammate}`);
  assert.doesNotMatch(teammate, new RegExp(A), `teammate brief carries the unshared project's id: ${teammate}`);
});
