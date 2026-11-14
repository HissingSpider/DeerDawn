/**
 * JOURNEY R4 — `start_session` WITH A NAMED PROJECT MOVES THE CONNECTION, AND
 * NOW SAYS SO.
 *
 * On a hosted connection, `start_session { project_id: B }` binds the
 * connection to B (it has since before round 3): the next save with no
 * project_id lands in B. The reply said only "Resuming B", so a person who
 * opened B's brief to look at it was not told that their next id-less saves
 * would be filed there.
 *
 * The owner's decision: naming a project in start_session counts as choosing
 * it, and the reply says so in the words `select` uses. start_session with NO
 * project named moves nothing and says nothing new; nor does one naming a
 * project this caller cannot read (it falls back, as it always has).
 *
 * The local stdio start_session has no project argument at all (its schema is
 * `verbosity` only), so there is nothing to say there.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r4-start-session-moves.test.js
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
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `${label}-${uuidv4().slice(0, 8)}@e2e.test`, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  return { label, orgId, userId };
}

async function addConnection(person) {
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_client_id, oauth_client_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      `key-${uuidv4()}`, prefix, hash, 'connector', person.userId, person.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write'],
      `https://claude.ai/${uuidv4()}`, 'Claude',
    ],
    person.orgId,
  );
  return { apiKey: key };
}

async function cleanup(people) {
  for (const person of people) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await q(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId]).catch(() => {});
    }
    await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_session_loads WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
}

async function call(connection, name, args = {}, { path = '/mcp' } = {}) {
  const res = await request(httpServer)
    .post(path)
    .set({ Accept: 'application/json, text/event-stream' })
    .set('X-Api-Key', connection.apiKey)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return {
    text: (body.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || JSON.stringify(body.error || body),
    isError: body.result?.isError === true || Boolean(body.error),
    data: body.result?.structuredContent,
  };
}

async function onePersonTwoProjects(tag) {
  const person = await makePerson(tag);
  const conn = await addConnection(person);
  const ids = [];
  for (const prefix of ['Home', 'Other']) {
    const created = await call(conn, 'manage_projects', { action: 'create', project_name: `${prefix} ${tag} ${uuidv4().slice(0, 6)}` });
    assert.equal(created.isError, false, created.text);
    ids.push(created.data.project_id);
  }
  const names = new Map();
  for (const id of ids) names.set(id, (await store.getProject(person.orgId, id)).project_name);
  // Something in each brief, so start_session renders a brief and not the guide.
  for (const id of ids) {
    await call(conn, 'manage_memory', { action: 'update', project_id: id, task: `Work on ${names.get(id)}` });
  }
  return { person, conn, home: ids[0], other: ids[1], names };
}

async function onlyBinding(person) {
  const rows = await q('SELECT project_id FROM context_sessions WHERE owner_key = $1 AND session_id LIKE \'web-%\'', [person.orgId]);
  assert.equal(rows.rows.length, 1, `one connection must mean one hosted session row, got ${JSON.stringify(rows.rows)}`);
  return rows.rows[0].project_id;
}

const MOVED = (name) => `This connection now works in "${name}". Other connections are unchanged.`;

for (const path of ['/mcp', '/mcp/claude']) {
  test(`start_session naming a project says the connection moved, in select's words (${path})`, async () => {
    const fx = await onePersonTwoProjects(`named${path.length}`);
    const { conn, home, other, names } = fx;
    try {
      const selected = await call(conn, 'manage_projects', { action: 'select', project_id: home }, { path });
      assert.equal(selected.text, MOVED(names.get(home)), 'select\'s sentence is the one being reused');
      assert.equal(await onlyBinding(fx.person), home);

      const started = await call(conn, 'start_session', { project_id: other }, { path });
      assert.equal(started.isError, false, started.text);
      assert.equal(await onlyBinding(fx.person), other, 'naming a project in start_session moves the connection, as before');
      assert.ok(
        started.text.includes(`Resuming ${names.get(other)}\n${MOVED(names.get(other))}\n\n`),
        `THE BUG: start_session moved the connection and its reply did not say so:\n${started.text.slice(0, 600)}`,
      );
      assert.equal(started.text.split(MOVED(names.get(other))).length - 1, 1, 'said once');

      // And it is true: the next id-less save lands in the project named.
      const next = await call(conn, 'manage_memory', { action: 'update', summary: 'Decided the next save follows start_session.' }, { path });
      assert.equal(next.data?.project_id, other, next.text);
    } finally {
      await cleanup([fx.person]);
    }
  });
}

test('start_session with no project named moves nothing and says nothing new', async () => {
  const fx = await onePersonTwoProjects('none');
  const { conn, home, names } = fx;
  try {
    await call(conn, 'manage_projects', { action: 'select', project_id: home });
    const started = await call(conn, 'start_session', {});
    assert.equal(started.isError, false, started.text);
    assert.equal(await onlyBinding(fx.person), home);
    assert.ok(started.text.includes(`Resuming ${names.get(home)}\n\n`), started.text.slice(0, 400));
    assert.ok(!started.text.includes('This connection now works in'), started.text.slice(0, 400));
  } finally {
    await cleanup([fx.person]);
  }
});

test('start_session naming a project the caller cannot read moves nothing and says nothing new', async () => {
  const fx = await onePersonTwoProjects('unseen');
  const stranger = await makePerson('stranger');
  const { conn, home, names } = fx;
  try {
    const theirs = await call(await addConnection(stranger), 'manage_projects', { action: 'create', project_name: `Theirs ${uuidv4().slice(0, 6)}` });
    await call(conn, 'manage_projects', { action: 'select', project_id: home });
    for (const id of [theirs.data.project_id, `project_${uuidv4()}`]) {
      const started = await call(conn, 'start_session', { project_id: id });
      assert.equal(started.isError, false, started.text);
      assert.equal(await onlyBinding(fx.person), home);
      assert.ok(!started.text.includes('This connection now works in'), started.text.slice(0, 400));
      assert.ok(started.text.includes(`Resuming ${names.get(home)}\n\n`), started.text.slice(0, 400));
    }
  } finally {
    await cleanup([fx.person, stranger]);
  }
});
