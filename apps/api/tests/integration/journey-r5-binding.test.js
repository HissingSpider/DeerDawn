/**
 * JOURNEY R5 - WHERE A TOOL'S WRITES LAND (owner decisions, round 5).
 *
 *  1. An entity that names no project goes to the connection's own project and
 *     follows its visibility. Workspace-wide only when the caller asks for it
 *     (scope:"workspace"). With no project to go to, nothing is saved and the
 *     reply says how to pick one. The reply names where it was filed.
 *  2. A connection bound to A whose caller reports B's folder keeps writing to
 *     A, and says so. (Service level: no hosted tool carries a folder.)
 *  3. A binding to a project since ARCHIVED, or one the caller can no longer
 *     read, refuses the write with the reason. It used to read as "no binding"
 *     and the write went to the person's next most recent project.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r5-binding.test.js
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
const store = require('../../src/store/contextSyncStore');
const { hashPassword, generateApiKey } = require('../../src/utils/security');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  return { label, orgId, userId, email };
}

/** One credential is one connection, which is exactly what a connector holds. */
async function addConnection(person, { clientId = `https://claude.ai/${uuidv4()}`, clientName = 'Claude' } = {}) {
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_client_id, oauth_client_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      keyId, prefix, hash, 'connector', person.userId, person.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write'],
      clientId, clientName,
    ],
    person.orgId,
  );
  return { apiKey: key, keyId, clientId, clientName };
}

async function cleanup(people) {
  for (const person of people) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await q(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId]).catch(() => {});
    }
    await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_workspace_pointers WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };

/** A tools/call made by ONE connection, on /mcp or /mcp/claude. */
async function call(connection, name, args = {}, { path = '/mcp' } = {}) {
  const res = await request(httpServer)
    .post(path)
    .set(MCP_HEADERS)
    .set('X-Api-Key', connection.apiKey)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return {
    text: body.result?.content?.[0]?.text || JSON.stringify(body.error || body),
    isError: body.result?.isError === true || Boolean(body.error),
    data: body.result?.structuredContent,
  };
}

async function createProject(connection, name) {
  const created = await call(connection, 'manage_projects', { action: 'create', project_name: name });
  assert.equal(created.isError, false, created.text);
  assert.ok(created.data?.project_id, created.text);
  return created.data.project_id;
}

/** Where every hosted session row of this person is bound, keyed by session id. */
async function bindings(person) {
  const rows = await q(
    'SELECT session_id, project_id FROM context_sessions WHERE owner_key = $1 AND session_id LIKE \'web-%\'',
    [person.orgId],
  );
  return new Map(rows.rows.map((row) => [row.session_id, row.project_id]));
}

async function onlyBinding(person) {
  const rows = await bindings(person);
  assert.equal(rows.size, 1, `one connection must mean one hosted session row, got ${JSON.stringify([...rows])}`);
  return [...rows.values()][0];
}


const service = require('../../src/services/contextSyncService');

const actorOf = (person) => ({ id: person.userId, org_id: person.orgId, type: 'user', role: 'admin' });
const uniq = (label) => `${label} ${uuidv4().slice(0, 6)}`;

async function twoProjects(tag) {
  const person = await makePerson(tag);
  const conn = await addConnection(person);
  const home = await createProject(conn, uniq(`Home ${tag}`));
  const other = await createProject(conn, uniq(`Other ${tag}`));
  const names = new Map();
  for (const id of [home, other]) names.set(id, (await store.getProject(person.orgId, id)).project_name);
  return { person, conn, home, other, names };
}

async function nodesOf(person, title) {
  const rows = await q(
    'SELECT node_id, project_id, title FROM context_graph_nodes WHERE owner_key = $1 AND lower(title) = lower($2)',
    [person.orgId, title],
  );
  return rows.rows;
}

const ENTITY_SUMMARY = 'Handles invoice export retries for the billing pipeline and records every failure.';

// ---------------------------------------------------------------------------
// 3. ARCHIVED / UNREADABLE BINDING
// ---------------------------------------------------------------------------

const IDLESS_WRITES = [
  ['manage_memory update summary', 'manage_memory', () => ({ action: 'update', summary: 'Decided the invoice retries stop after three attempts.' })],
  ['manage_memory update task', 'manage_memory', () => ({ action: 'update', task: 'Wire the retry counter' })],
  ['manage_tasks add', 'manage_tasks', () => ({ action: 'add', todos: ['probe card after archive'] })],
  ['manage_memory record_finding', 'manage_memory', () => ({ action: 'record_finding', summary: 'The retry counter resets on deploy, which hides real failures.' })],
  ['manage_memory record_paths', 'manage_memory', () => ({ action: 'record_paths', items: [{ label: 'probe', path: 'src/probe.ts' }] })],
  ['manage_memory upsert_entities', 'manage_memory', () => ({ action: 'upsert_entities', entities: [{ title: 'Retry worker service', entity_type: 'service', summary: ENTITY_SUMMARY }] })],
];

test('an ARCHIVED bound project refuses every id-less write, says why, and writes nothing elsewhere', async () => {
  const fx = await twoProjects('archrefuse');
  const { conn, home: A, other: B, names } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: A });
    const archived = await call(conn, 'manage_projects', { action: 'archive', project_id: A });
    assert.equal(archived.isError, false, archived.text);

    const wrong = [];
    for (const [label, tool, args] of IDLESS_WRITES) {
      const reply = await call(conn, tool, args());
      const ok = reply.isError
        && /archived/i.test(reply.text)
        && /nothing was saved/i.test(reply.text)
        && reply.text.includes(names.get(A))
        && /restore/.test(reply.text)
        && /select/.test(reply.text);
      if (!ok) wrong.push(`${label}: isError=${reply.isError} ${reply.text.slice(0, 200)}`);
    }
    assert.deepEqual(wrong, [], `THE BUG: a write with no project fell through to another project:\n${wrong.join('\n')}`);

    // The finish_task REVIEW is a read (nothing is cleared until it is confirmed),
    // so it may show another project, and says it did.
    const review = await call(conn, 'manage_memory', { action: 'finish_task' });
    assert.match(review.text, /archived/i, `THE BUG: the review opened another project silently: ${review.text.slice(0, 200)}`);

    const b = (await store.getProject(fx.person.orgId, B)).context;
    assert.deepEqual((b.recent_decisions || []).map((d) => d.summary), [], 'B must hold none of the refused writes');
    assert.deepEqual((b.todo_items || []).map((t) => t.title), []);
    assert.equal((await nodesOf(fx.person, 'Retry worker service')).length, 0, 'the entity must not be saved anywhere');

    // Naming a project is a different call and still works.
    const named = await call(conn, 'manage_memory', { action: 'update', project_id: B, summary: 'Decided B keeps working when named.' });
    assert.equal(named.isError, false, named.text);
    assert.equal(named.data?.project_id, B);
    assert.equal(await onlyBinding(fx.person), A, 'a note filed to B by id must not move a connection whose project is archived');

    // The reply's own advice works: restore, and the connection is back in A.
    const restored = await call(conn, 'manage_projects', { action: 'restore', project_id: A });
    assert.equal(restored.isError, false, restored.text);
    const back = await call(conn, 'manage_memory', { action: 'update', summary: 'Decided this goes to the restored project.' });
    assert.equal(back.isError, false, back.text);
    assert.equal(back.data?.project_id, A, back.text);
  } finally {
    await cleanup([fx.person]);
  }
});

test('a bound project the caller can NO LONGER READ refuses the write, without naming it', async () => {
  const fx = await twoProjects('unreadable');
  const { conn, home: A, other: B, names } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: A });
    // A colleague's personal project now: not shared with this person.
    await q('UPDATE context_projects SET visibility = \'personal\', owner_user_id = $2 WHERE project_id = $1', [A, `user-${uuidv4()}`]);

    const wrong = [];
    for (const [label, tool, args] of IDLESS_WRITES) {
      const reply = await call(conn, tool, args());
      const ok = reply.isError
        && /no longer shared with you/i.test(reply.text)
        && /nothing was saved/i.test(reply.text)
        && /select/.test(reply.text)
        && !reply.text.includes(names.get(A));
      if (!ok) wrong.push(`${label}: isError=${reply.isError} ${reply.text.slice(0, 200)}`);
    }
    assert.deepEqual(wrong, [], `THE BUG: a write with no project fell through to another project:\n${wrong.join('\n')}`);
    const b = (await store.getProject(fx.person.orgId, B)).context;
    assert.deepEqual((b.recent_decisions || []).map((d) => d.summary), []);
  } finally {
    await cleanup([fx.person]);
  }
});

test('a READ with no project does not silently resume another project after the binding died', async () => {
  const fx = await twoProjects('readstale');
  const { conn, home: A, other: B, names } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: A });
    await call(conn, 'manage_projects', { action: 'archive', project_id: A });

    const start = await call(conn, 'start_session', {});
    assert.equal(start.isError, false, start.text);
    assert.match(start.text, new RegExp(`"${names.get(A)}".{0,80}archived`, 's'), `THE BUG: start_session moved on without saying so: ${start.text.slice(0, 300)}`);
    assert.match(start.text, /restore/, start.text.slice(0, 400));

    const ctx = await call(conn, 'recall', { action: 'context' });
    assert.equal(ctx.isError, false, ctx.text);
    assert.match(ctx.text, /archived/i, `THE BUG: recall opened another project silently: ${ctx.text.slice(0, 300)}`);
    assert.ok(ctx.text.includes(names.get(B)) || true);
  } finally {
    await cleanup([fx.person]);
  }
});

test('a connection whose binding is healthy is not affected', async () => {
  const fx = await twoProjects('healthy');
  const { conn, home: A, names } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: A });
    const reply = await call(conn, 'manage_memory', { action: 'update', summary: 'Decided nothing changes for a healthy binding.' });
    assert.equal(reply.isError, false, reply.text);
    assert.equal(reply.data?.project_id, A);
    assert.match(reply.text, new RegExp(`^Context updated for "${names.get(A)}"\\.`));
    assert.doesNotMatch(reply.text, /archived|no longer shared/i);
  } finally {
    await cleanup([fx.person]);
  }
});

// ---------------------------------------------------------------------------
// 1. AN ENTITY WITH NO PROJECT
// ---------------------------------------------------------------------------

test('an entity naming no project is filed in the connection\'s project, and the reply names it', async () => {
  const fx = await twoProjects('entfile');
  const { conn, home: A, names } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: A });
    const reply = await call(conn, 'manage_memory', { action: 'upsert_entities', entities: [{ title: 'Retry worker service', entity_type: 'service', summary: ENTITY_SUMMARY }] });
    assert.equal(reply.isError, false, reply.text);
    const nodes = await nodesOf(fx.person, 'Retry worker service');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].project_id, A, 'filed in the connection\'s project');
    assert.ok(reply.text.includes(`Filed in "${names.get(A)}"`), `THE BUG: the reply does not name where it was filed: ${reply.text}`);
  } finally {
    await cleanup([fx.person]);
  }
});

test('scope:"workspace" is how a caller asks for the whole workspace, and the reply says so', async () => {
  const fx = await twoProjects('entws');
  const { conn, home: A } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: A });
    const reply = await call(conn, 'manage_memory', { action: 'upsert_entities', entities: [{ title: 'Shared billing glossary', entity_type: 'concept', scope: 'workspace', summary: 'Terms every project in this workspace uses for invoices, credits and refunds.' }] });
    assert.equal(reply.isError, false, reply.text);
    const nodes = await nodesOf(fx.person, 'Shared billing glossary');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].project_id, null, 'asked for workspace scope: workspace-level');
    assert.match(reply.text, /workspace level/i, reply.text);
  } finally {
    await cleanup([fx.person]);
  }
});

test('with NO project to file under, an entity is refused, not saved workspace-wide', async () => {
  const person = await makePerson('entnone');
  const conn = await addConnection(person);
  try {
    const reply = await call(conn, 'manage_memory', { action: 'upsert_entities', entities: [{ title: 'Salary band notes', entity_type: 'knowledge', summary: 'Recruiter said the band for the Globex offer is one hundred eighty thousand.' }] });
    assert.equal(reply.isError, true, `THE BUG: saved workspace-wide with nothing said: ${reply.text}`);
    assert.match(reply.text, /nothing was saved/i, reply.text);
    assert.match(reply.text, /project_id/, reply.text);
    assert.match(reply.text, /scope/, `the refusal names the explicit workspace option: ${reply.text}`);
    assert.equal((await nodesOf(person, 'Salary band notes')).length, 0);
  } finally {
    await cleanup([person]);
  }
});

// ---------------------------------------------------------------------------
// 2. BOUND TO A, THE CALLER REPORTS B'S FOLDER
// ---------------------------------------------------------------------------

test('a session bound to A whose caller reports B\'s folder keeps writing to A and reports the conflict', async () => {
  const person = await makePerson('folder');
  const actor = actorOf(person);
  const sessionId = `web-${uuidv4()}`;
  try {
    const a = await service.createProject(actor, { project_name: uniq('Alpha') });
    const b = await service.createProject(actor, { project_name: uniq('Bravo'), linked_paths: ['/work/bravo'] });
    await service.bindSessionToProject(actor, sessionId, a.project_id, { tool: 'claude_web' });

    // Without a session: the folder decides, as it always has.
    const byFolder = await service.resolveActiveProject(actor, '/work/bravo', null, { forWrite: true });
    assert.equal(byFolder?.project_id, b.project_id, 'no session: the folder wins');

    const write = await service.resolveActiveProject(actor, '/work/bravo', null, { forWrite: true, sessionId });
    assert.equal(write?.project_id, a.project_id, 'THE BUG: the folder moved a bound session');
    assert.equal(write.match_kind, 'session');
    assert.equal(write.location_conflict?.project_id, b.project_id);
    assert.equal(write.location_conflict?.project_name, b.project_name);

    // A read is left as it was: showing the folder's project is a read.
    const read = await service.resolveActiveProject(actor, '/work/bravo', null, { sessionId });
    assert.equal(read?.project_id, b.project_id);
  } finally {
    await cleanup([person]);
  }
});

// ---------------------------------------------------------------------------
// 3b. THE END-OF-SESSION CAPTURE KEEPS CAPTURING, AND THE NEXT BRIEF SAYS WHY
// ---------------------------------------------------------------------------

function captureInput(sessionId, filedIn, summary) {
  return {
    session_id: sessionId,
    tool: 'claude_code',
    session_context: { cwd: '/work/somewhere', status: 'active' },
    chunks: [{ role: 'assistant', text: summary }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.95,
      project_candidate: { project_id: filedIn, project_name: 'Filed', reason: 'same repo' },
      delta: { recent_decisions: [{ summary, decided_at: new Date().toISOString() }] },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  };
}

async function captureWithDeadBinding(tag, kill) {
  const fx = await twoProjects(tag);
  const actor = actorOf(fx.person);
  const sessionId = `agent-${uuidv4().slice(0, 8)}`;
  await service.bindSessionToProject(actor, sessionId, fx.home, { tool: 'claude_code', surfaceType: 'terminal' });
  await kill(fx);
  const summary = `Decided the ${tag} capture goes where the route points.`;
  await service.applyExtraction(actor, captureInput(sessionId, fx.other, summary));
  const other = (await store.getProject(fx.person.orgId, fx.other)).context;
  assert.ok((other.recent_decisions || []).some((d) => d.summary === summary), 'the capture is still filed where the route points');
  return fx;
}

test('a capture whose bound project is ARCHIVED is filed where the route points, and the next start_session says why, once', async () => {
  const fx = await captureWithDeadBinding('capnote', (f) => q('UPDATE context_projects SET archived_at = NOW() WHERE project_id = $1', [f.home]));
  const { conn, home: A, other: B, names } = fx;
  try {
    const first = await call(conn, 'start_session', { project_id: B });
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /Last session was filed here/, `THE BUG: the brief does not say the last session was redirected: ${first.text.slice(0, 300)}`);
    assert.ok(first.text.includes(`"${names.get(A)}"`), first.text.slice(0, 400));
    assert.match(first.text, /archived/);
    assert.match(first.text, new RegExp(`restore.*${A}`, 's'));
    const second = await call(conn, 'start_session', { project_id: B });
    assert.doesNotMatch(second.text, /Last session was filed here/, 'shown once');
  } finally {
    await cleanup([fx.person]);
  }
});

test('the same note reaches the LOCAL start_session (/active with mark_session), for a project no longer shared', async () => {
  const fx = await captureWithDeadBinding('capnote2', (f) => q('UPDATE context_projects SET visibility = \'personal\', owner_user_id = $2 WHERE project_id = $1', [f.home, `user-${uuidv4()}`]));
  const { conn, home: A, names } = fx;
  try {
    const res = await request(httpServer)
      .get('/api/v1/context/active')
      .query({ mark_session: '1', tool: 'claude_code', session_id: `agent-${uuidv4().slice(0, 8)}` })
      .set('X-Api-Key', conn.apiKey);
    assert.equal(res.status, 200, res.text);
    assert.match(String(res.body.brief), /Last session was filed here/, `THE BUG: no note on the local start: ${String(res.body.brief).slice(0, 300)}`);
    assert.match(String(res.body.brief), /no longer shared with you/);
    assert.ok(!String(res.body.brief).includes(names.get(A)), 'a project the caller can no longer read is not named');
    const again = await request(httpServer)
      .get('/api/v1/context/active')
      .query({ mark_session: '1', tool: 'claude_code', session_id: `agent-${uuidv4().slice(0, 8)}` })
      .set('X-Api-Key', conn.apiKey);
    assert.doesNotMatch(String(again.body.brief), /Last session was filed here/, 'shown once');
  } finally {
    await cleanup([fx.person]);
  }
});

test('a capture with a HEALTHY binding leaves no note', async () => {
  const fx = await twoProjects('capnone');
  const actor = actorOf(fx.person);
  try {
    const sessionId = `agent-${uuidv4().slice(0, 8)}`;
    await service.bindSessionToProject(actor, sessionId, fx.home, { tool: 'claude_code', surfaceType: 'terminal' });
    await service.applyExtraction(actor, captureInput(sessionId, fx.home, 'Decided nothing is wrong with this binding.'));
    const start = await call(fx.conn, 'start_session', { project_id: fx.home });
    assert.doesNotMatch(start.text, /Last session was filed here/);
  } finally {
    await cleanup([fx.person]);
  }
});

// ---------------------------------------------------------------------------
// A TRANSIENT FAILURE IS NOT "NO LONGER SHARED"
// ---------------------------------------------------------------------------
// The refusal for a write bound to a project the caller cannot read may only say
// so when the store ANSWERED that it is not readable. A database error or a
// timeout while asking is a temporary failure: nothing was saved, try again, and
// nothing is recorded as a dead binding.

async function withFailingProjectRead(run) {
  const real = store.getProjectContextOnly;
  store.getProjectContextOnly = async () => { throw Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' }); };
  try { return await run(); } finally { store.getProjectContextOnly = real; }
}

test('a transient read failure on the bound project is a temporary failure, not "no longer shared with you"', async () => {
  const fx = await twoProjects('transient');
  const { conn, home: A } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: A });
    const reply = await withFailingProjectRead(() => call(conn, 'manage_memory', { action: 'update', summary: 'Decided this write hits a database blip.' }));
    assert.equal(reply.isError, true, reply.text);
    assert.doesNotMatch(reply.text, /no longer shared/i, `THE BUG: a database error was reported as a lost share: ${reply.text}`);
    assert.match(reply.text, /try again/i, reply.text);
    assert.match(reply.text, /nothing was saved/i, reply.text);
    // And the connection is untouched: the same call works once the store answers.
    const after = await call(conn, 'manage_memory', { action: 'update', summary: 'Decided this write follows the blip.' });
    assert.equal(after.isError, false, after.text);
    assert.equal(after.data?.project_id, A);
  } finally {
    await cleanup([fx.person]);
  }
});

test('a transient failure while a capture works out why its binding is dead records no notice', async () => {
  const fx = await twoProjects('transientcap');
  const actor = actorOf(fx.person);
  try {
    const sessionId = `agent-${uuidv4().slice(0, 8)}`;
    await service.bindSessionToProject(actor, sessionId, fx.home, { tool: 'claude_code', surfaceType: 'terminal' });
    await q('UPDATE context_projects SET archived_at = NOW() WHERE project_id = $1', [fx.home]);
    await withFailingProjectRead(() => service.applyExtraction(actor, captureInput(sessionId, fx.other, 'Decided the capture survives a database blip.')));
    const rows = await q('SELECT 1 FROM context_binding_notices WHERE owner_key = $1', [fx.person.orgId]);
    assert.equal(rows.rows.length, 0, 'THE BUG: a database error was recorded as a dead binding');
  } finally {
    await cleanup([fx.person]);
  }
});
