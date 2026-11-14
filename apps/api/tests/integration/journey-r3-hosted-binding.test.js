/**
 * JOURNEY R3 (H3-1) — ONE NOTE FILED TO ANOTHER PROJECT MOVED THE CONNECTION.
 *
 * A person on a hosted connection (Claude.ai, ChatGPT, anything pointed at the
 * hosted URL) with two projects, the connection selected into A. They file ONE
 * note to B by id: `manage_memory(update, project_id:B, summary)` answers
 * "Context updated for "B"", which is right. The conversation carries on about
 * A with no project_id, and the next decision answered "Context updated for
 * "B"", the card "Added to "B"", and `finish_task` "Cleanup complete for B" —
 * B's open task marked Completed and Shipped, A's finished task still open.
 *
 * Of the twelve calls that can name another project, only that one moved the
 * connection: the hosted dispatcher hands the connection's stable session id to
 * the shared save path, and applyExtraction bound that session to the project
 * the write named.
 *
 * The owner's decision: naming a project applies to THAT CALL ONLY. The
 * connection stays where it was. Only `select` and `create` move it, and
 * `create` says so, in the words `select` already uses.
 *
 * Pinned beside it, unchanged on purpose: `select`; a connection with no
 * binding yet (its first call naming a project); and the LOCAL path through the
 * REST route, which shares recordExplicitUpdate and binds its session exactly
 * as it always did.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r3-hosted-binding.test.js
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

/** Where THIS connection is: its id-less board read, which resolves through its binding. */
async function boardOf(connection) {
  let board = await call(connection, 'manage_tasks', { action: 'list' });
  // A read that timed out under load says "Retry once"; so does this. It is a
  // read, and where it resolves is what is being asked, not whether it is fast.
  if (/Error \[timeout\]/.test(board.text)) board = await call(connection, 'manage_tasks', { action: 'list' });
  const m = /Task board for ([^:\n]+)/.exec(board.text);
  return m ? m[1] : `(no board: ${board.text.slice(0, 120)})`;
}

/**
 * One person, one hosted connection, two projects. Only one connection, so the
 * person has exactly one hosted session row and "where is the connection" is
 * that row.
 */
async function onePersonTwoProjects(tag) {
  const person = await makePerson(tag);
  const conn = await addConnection(person);
  const home = await createProject(conn, `Home ${tag} ${uuidv4().slice(0, 6)}`);
  const other = await createProject(conn, `Other ${tag} ${uuidv4().slice(0, 6)}`);
  const names = new Map();
  for (const id of [home, other]) names.set(id, (await store.getProject(person.orgId, id)).project_name);
  return { person, conn, home, other, names };
}

async function onlyBinding(person) {
  const rows = await bindings(person);
  assert.equal(rows.size, 1, `one connection must mean one hosted session row, got ${JSON.stringify([...rows])}`);
  return [...rows.values()][0];
}

// The twelve kinds of call that can name another project: four reads, eight writes.
const TWELVE = (other) => [
  ['recall context', 'recall', { action: 'context', project_id: other }],
  ['recall map', 'recall', { action: 'map', project_id: other }],
  ['manage_tasks list', 'manage_tasks', { action: 'list', project_id: other }],
  ['build_subagent_brief', 'build_subagent_brief', { task: 'write the release notes for the export fix', project_id: other }],
  ['manage_tasks add', 'manage_tasks', { action: 'add', project_id: other, todos: ['probe card'] }],
  ['manage_memory update task', 'manage_memory', { action: 'update', project_id: other, task: 'probe task' }],
  ['manage_memory record_paths', 'manage_memory', { action: 'record_paths', project_id: other, items: [{ label: 'probe', path: 'src/probe.ts' }] }],
  ['manage_memory record_finding', 'manage_memory', { action: 'record_finding', project_id: other, summary: 'Probe finding, long enough to be stored as a finding.' }],
  ['manage_memory upsert_entities', 'manage_memory', { action: 'upsert_entities', project_id: other, entities: [{ title: 'Probe service', entity_type: 'service', summary: 'A probe entity that is long enough to be stored durably.' }] }],
  ['manage_memory finish_task', 'manage_memory', { action: 'finish_task', project_id: other }],
  ['manage_projects rename', 'manage_projects', { action: 'rename', project_id: other, project_name: null }],
  ['manage_memory update summary', 'manage_memory', { action: 'update', project_id: other, summary: 'Decided the probe summary belongs to the other project.' }],
];

// THE WALKER'S JOURNEY, call for call (repro-h3-1.js).
test('H3-1: one note filed to another project by id leaves the connection where it was', async () => {
  const fx = await onePersonTwoProjects('h31');
  const { conn, home: A, other: B, names } = fx;
  try {
    await call(conn, 'manage_memory', { action: 'update', project_id: B, task: 'Beta open task: fix image captions' });
    const selected = await call(conn, 'manage_projects', { action: 'select', project_id: A });
    assert.equal(selected.isError, false, selected.text);
    await call(conn, 'manage_memory', { action: 'update', task: 'Alpha open task: invoice numbering' });
    const one = await call(conn, 'manage_memory', { action: 'update', summary: 'Decided alpha-one: stays in Alpha.' });
    assert.equal(one.data?.project_id, A, one.text);

    // The one note for the other project, by id. The reply names the project it
    // wrote to, as it always has.
    const note = await call(conn, 'manage_memory', { action: 'update', project_id: B, summary: 'Decided beta-note: write a post about the launch.' });
    assert.equal(note.isError, false, note.text);
    assert.equal(note.data?.project_id, B);
    assert.match(note.text, new RegExp(`^Context updated for "${names.get(B)}"\\.`), note.text);
    assert.equal(await onlyBinding(fx.person), A, 'THE BUG: naming B for one note moved the connection to B');

    // The conversation carries on about A, with no project_id.
    const two = await call(conn, 'manage_memory', { action: 'update', summary: 'Decided alpha-two: retries three times then export_failed.' });
    assert.equal(two.data?.project_id, A, `THE BUG: the next id-less decision was filed to the other project: ${two.text}`);
    assert.match(two.text, new RegExp(`^Context updated for "${names.get(A)}"\\.`), two.text);
    const card = await call(conn, 'manage_tasks', { action: 'add', todos: ['alpha-card: add export_failed status'] });
    assert.match(card.text, new RegExp(`^Added to "${names.get(A)}"`), `THE BUG: the card went to the other project: ${card.text}`);
    // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
    await call(conn, 'manage_memory', { action: 'finish_task' });
    const done = await call(conn, 'manage_memory', { action: 'finish_task', complete_task: true, confirm_complete: true });
    assert.ok(done.text.includes(names.get(A)) && !done.text.includes(names.get(B)), `THE BUG: finish_task closed the other project's task: ${done.text}`);

    // What each brief now holds.
    const a = (await store.getProject(fx.person.orgId, A)).context;
    const b = (await store.getProject(fx.person.orgId, B)).context;
    const summaries = (ctx) => (ctx.recent_decisions || []).map((d) => d.summary);
    assert.ok(summaries(a).includes('Decided alpha-two: retries three times then export_failed.'), JSON.stringify(summaries(a)));
    assert.deepEqual(summaries(b), ['Decided beta-note: write a post about the launch.'], 'B holds its own note and nothing of A\'s');
    assert.ok((a.todo_items || []).some((t) => t.title === 'alpha-card: add export_failed status'), JSON.stringify(a.todo_items));
    assert.deepEqual((b.todo_items || []).map((t) => t.title), []);
    assert.deepEqual((b.shipped || []).map((s) => s.summary), [], 'THE BUG: B lists as shipped a task nobody did');
    assert.equal(b.current_task, 'Beta open task: fix image captions');
    assert.notEqual(b.task_progress, 'completed', 'B\'s open task is still open');
    assert.equal(a.task_progress, 'completed', 'A\'s task, the one the person finished, is completed');
  } finally {
    await cleanup([fx.person]);
  }
});

test('H3-1: none of the twelve calls that name another project moves the connection', async () => {
  const fx = await onePersonTwoProjects('twelve');
  const { conn, home, other, names } = fx;
  try {
    await call(conn, 'manage_memory', { action: 'update', project_id: other, task: 'Other open task' });
    const moved = [];
    for (const [label, tool, rawArgs] of TWELVE(other)) {
      const args = tool === 'manage_projects' ? { ...rawArgs, project_name: names.get(other) } : rawArgs;
      await call(conn, 'manage_projects', { action: 'select', project_id: home });
      assert.equal(await onlyBinding(fx.person), home, `select did not put the connection back in HOME before "${label}"`);
      const reply = await call(conn, tool, args);
      assert.equal(reply.isError, false, `${label}: ${reply.text}`);
      const bound = await onlyBinding(fx.person);
      const board = await boardOf(conn);
      if (bound !== home || board !== names.get(home)) {
        moved.push(`${label}: connection now bound to ${names.get(bound) || bound}, its next id-less read opens ${board}`);
      }
    }
    assert.deepEqual(moved, [], `THE BUG: a call that named another project moved the connection:\n${moved.join('\n')}`);

    // The writes that named the other project did land there, and each reply
    // said so (spot-check the one that used to move the connection).
    const other1 = (await store.getProject(fx.person.orgId, other)).context;
    assert.ok((other1.recent_decisions || []).some((d) => d.summary === 'Decided the probe summary belongs to the other project.'));
  } finally {
    await cleanup([fx.person]);
  }
});

test('H3-1: the same holds on /mcp/claude, the Claude.ai endpoint', async () => {
  const fx = await onePersonTwoProjects('claude');
  const { conn, home, other, names } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: home }, { path: '/mcp/claude' });
    const note = await call(conn, 'manage_memory', { action: 'update', project_id: other, summary: 'Decided one note for the other project.' }, { path: '/mcp/claude' });
    assert.equal(note.data?.project_id, other, note.text);
    assert.equal(await onlyBinding(fx.person), home, 'THE BUG: naming a project on /mcp/claude moved the connection');
    const next = await call(conn, 'manage_memory', { action: 'update', summary: 'Decided the next note has no project_id.' }, { path: '/mcp/claude' });
    assert.equal(next.data?.project_id, home, next.text);
    assert.match(next.text, new RegExp(`^Context updated for "${names.get(home)}"\\.`));
  } finally {
    await cleanup([fx.person]);
  }
});

test('create still moves the connection, and now says so in the words select uses', async () => {
  const fx = await onePersonTwoProjects('create');
  const { conn, home } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: home });
    const name = `Gamma Taxes ${uuidv4().slice(0, 6)}`;
    const created = await call(conn, 'manage_projects', { action: 'create', project_name: name });
    assert.equal(created.isError, false, created.text);
    const id = created.data.project_id;
    // Its structuredContent keeps the shape it has always had: no field in it
    // (nor in select's) says where the connection is.
    assert.deepEqual(Object.keys(created.data).sort(), ['project_id', 'project_name']);
    assert.equal(await onlyBinding(fx.person), id, 'create moves the connection, by design');

    // The sentence is select's, reused, not a new one.
    const selectSays = (await call(conn, 'manage_projects', { action: 'select', project_id: id })).text;
    assert.equal(selectSays, `This connection now works in "${name}". Other connections are unchanged.`);
    assert.equal(
      created.text,
      `Created project "${name}" (${id}). ${selectSays}`,
      'THE BUG: create moved the connection and its reply did not say so',
    );

    const next = await call(conn, 'manage_memory', { action: 'update', summary: 'Decided this goes in the project just created.' });
    assert.equal(next.data?.project_id, id, next.text);
  } finally {
    await cleanup([fx.person]);
  }
});

test('select is unchanged: it moves the connection and says so', async () => {
  const fx = await onePersonTwoProjects('select');
  const { conn, home, other, names } = fx;
  try {
    const selected = await call(conn, 'manage_projects', { action: 'select', project_id: other });
    assert.equal(selected.text, `This connection now works in "${names.get(other)}". Other connections are unchanged.`);
    assert.deepEqual(selected.data, { project_id: other, project_name: names.get(other) });
    assert.equal(await onlyBinding(fx.person), other);
    const back = await call(conn, 'manage_projects', { action: 'select', project_id: home });
    assert.equal(back.text, `This connection now works in "${names.get(home)}". Other connections are unchanged.`);
    assert.equal(await onlyBinding(fx.person), home);
    assert.equal(await boardOf(conn), names.get(home));
  } finally {
    await cleanup([fx.person]);
  }
});

// ITEM 4, NOT DECIDED HERE: a brand-new connection whose FIRST call names a
// project behaves exactly as it did. Only `manage_memory(update, summary)`
// creates its session row, bound to the project it named; the other eleven
// create no row, and its next id-less call resolves through the person's most
// recent binding anywhere (here HOME, where another connection is).
test('a connection with no binding yet keeps today\'s behaviour when its first call names a project', async () => {
  const person = await makePerson('nobind');
  try {
    const c0 = await addConnection(person, { clientId: `https://claude.ai/c0-${uuidv4()}`, clientName: 'Claude' });
    const home = await createProject(c0, `Home nobind ${uuidv4().slice(0, 6)}`);
    const other = await createProject(c0, `Other nobind ${uuidv4().slice(0, 6)}`);
    const names = new Map();
    for (const id of [home, other]) names.set(id, (await store.getProject(person.orgId, id)).project_name);
    await call(c0, 'manage_memory', { action: 'update', project_id: other, task: 'Other open task' });

    const seen = [];
    let n = 0;
    for (const [label, tool, rawArgs] of TWELVE(other)) {
      const args = tool === 'manage_projects' ? { ...rawArgs, project_name: names.get(other) } : rawArgs;
      await call(c0, 'manage_projects', { action: 'select', project_id: home });
      const before = await bindings(person);
      const fresh = await addConnection(person, { clientId: `https://example.test/fresh-${n += 1}-${uuidv4()}`, clientName: 'Cursor' });
      const reply = await call(fresh, tool, args);
      assert.equal(reply.isError, false, `${label}: ${reply.text}`);
      const after = await bindings(person);
      const own = [...after].filter(([sessionId]) => !before.has(sessionId)).map(([, projectId]) => names.get(projectId) || projectId);
      seen.push(`${label} -> row: ${own.length ? own.join(',') : 'none'}; next id-less: ${await boardOf(fresh)}`);
    }
    const want = TWELVE(other).map(([label]) => (label === 'manage_memory update summary'
      ? `${label} -> row: ${names.get(other)}; next id-less: ${names.get(other)}`
      : `${label} -> row: none; next id-less: ${names.get(home)}`));
    assert.deepEqual(seen, want);
  } finally {
    await cleanup([person]);
  }
});

// The same boundary, from the other side. Round 3 read a binding to a project
// since archived as no binding, so a save naming a project bound the connection
// there. Round 5 REVERSES that (owner decision): the binding stands, so a note
// filed to B by id does not move the connection, and its id-less writes are
// refused until the person restores A or selects another project.
// tests/integration/journey-r5-binding.test.js covers the refusals.
test('a connection bound to an archived project keeps that binding when a save names another project (round 5)', async () => {
  const fx = await onePersonTwoProjects('archived');
  const { conn, home, other } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: home });
    const archived = await call(conn, 'manage_projects', { action: 'archive', project_id: home });
    assert.equal(archived.isError, false, archived.text);
    const note = await call(conn, 'manage_memory', { action: 'update', project_id: other, summary: 'Decided this goes to the live project.' });
    assert.equal(note.data?.project_id, other, note.text);
    assert.equal(await onlyBinding(fx.person), home, 'naming another project does not move a connection, archived binding or not');
    const idless = await call(conn, 'manage_memory', { action: 'update', summary: 'Decided this names no project.' });
    assert.equal(idless.isError, true, idless.text);
    assert.match(idless.text, /archived/i);
  } finally {
    await cleanup([fx.person]);
  }
});

// LOCAL SESSIONS ARE NOT IN SCOPE. The local stdio server saves through the
// REST route, which shares recordExplicitUpdate. How a local session ties to a
// project is a separate question the owner has not answered, so this pins the
// local path exactly as it is: an explicit write naming a project binds the
// local agent session to it.
test('the local path is unchanged: an explicit save naming a project binds the local agent session to it', async () => {
  const person = await makePerson('local');
  try {
    const { key, prefix, hash } = generateApiKey();
    await db.query(
      `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [`key-${uuidv4()}`, prefix, hash, 'local', person.userId, person.orgId, 'production',
        new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
      person.orgId,
    );
    const rest = (method, path, body) => request(httpServer)[method](path).set('X-Api-Key', key).send(body);
    const mk = async (name) => {
      const res = await rest('post', '/api/v1/context/projects', { project_name: name });
      assert.ok(res.status < 300, res.text);
      return res.body.project?.project_id || res.body.project_id;
    };
    const A = await mk(`Local Alpha ${uuidv4().slice(0, 6)}`);
    const B = await mk(`Local Beta ${uuidv4().slice(0, 6)}`);
    const sessionId = `agent-${uuidv4().slice(0, 6)}-abc123`;
    const save = (projectId, text) => rest('post', '/api/v1/context/extraction', {
      session_id: sessionId,
      tool: 'claude_code',
      project_id: projectId,
      explicit: true,
      session_context: { cwd: '/tmp/local-journey', surface_type: 'cli' },
      chunks: [{ role: 'assistant', text }],
    });
    const first = await save(A, 'Decided local-one: this belongs to Alpha.');
    assert.equal(first.status, 202, first.text);
    assert.equal(first.body.stored, true);
    assert.equal(first.body.session.project_id, A);

    const second = await save(B, 'Decided local-two: this belongs to Beta.');
    assert.equal(second.status, 202, second.text);
    assert.equal(second.body.stored, true);
    assert.equal(second.body.project.project_id, B);
    assert.equal(second.body.session.project_id, B, 'the local session is re-bound to the project the save named, as before');
    assert.equal(second.body.session.routing_state, 'matched');
    const row = await q('SELECT project_id FROM context_sessions WHERE owner_key = $1 AND session_id = $2', [person.orgId, sessionId]);
    assert.equal(row.rows[0].project_id, B);
  } finally {
    await cleanup([person]);
  }
});
