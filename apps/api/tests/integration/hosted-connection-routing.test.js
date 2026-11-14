/**
 * ONE CONNECTOR, ONE PROJECT. Another connector's work must not move it.
 *
 * Every hosted client shared a single session row, because hostedSessionId
 * hashed (workspace, person, tool) and `tool` was the catalog default on every
 * call. So claude.ai, ChatGPT and a Claude Code connector were indistinguishable,
 * and resolveActiveProject fell through to "this person's most recent binding on
 * any surface" on every call. Reproduced live: a Claude Code session working in
 * one repo was handed a project a browser tab had written to fifteen minutes
 * earlier, and record_finding, manage_tasks add and finish_task all followed it
 * there. `manage_projects select` could not fix it either: without a
 * workspace_key it errored, and with one it wrote a pointer row no hosted call
 * ever reads.
 *
 * Two credentials for ONE person is the whole fixture here: that is what a
 * second connector is.
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/hosted-connection-routing.test.js
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

/** One credential = one connection, which is exactly what a connector holds. */
async function addConnection(person, { clientId = null, clientName = null } = {}) {
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

async function cleanup(people) {
  for (const person of people) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId], 'org-system').catch(() => {});
    }
    await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_workspace_pointers WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : res.text);
}

/** A tools/call made by ONE connection. */
async function call(connection, name, args = {}) {
  const res = await request(httpServer)
    .post('/mcp')
    .set(MCP_HEADERS)
    .set('X-Api-Key', connection.apiKey)
    .send(rpc(name, args));
  assert.equal(res.status, 200, res.text);
  return parseRpc(res);
}

const textOf = (payload) => payload.result?.content?.[0]?.text || '';

async function createProject(connection, name) {
  const payload = await call(connection, 'manage_projects', { action: 'create', project_name: name });
  assert.ok(!payload.error, JSON.stringify(payload.error));
  const id = payload.result?.structuredContent?.project_id;
  assert.ok(id, `no project_id in ${JSON.stringify(payload.result)}`);
  return id;
}

/** One person with two connectors and two projects, each connector on its own. */
async function twoConnections() {
  const person = await makePerson('dana');
  const editor = await addConnection(person, { clientId: 'https://claude.ai/connector', clientName: 'Claude Code' });
  const browser = await addConnection(person, { clientId: 'https://chatgpt.com/connector', clientName: 'ChatGPT' });

  const p1 = await createProject(editor, `Ledger ${uuidv4().slice(0, 6)}`);
  const p2 = await createProject(browser, `Apex Fund ${uuidv4().slice(0, 6)}`);
  return { person, editor, browser, p1, p2 };
}

test('another connection\'s write does not move this connection\'s reads or writes', async () => {
  const fx = await twoConnections();
  try {
    // Connection 1 is working in P1; connection 2 is working in P2 and writes
    // there LAST, which is the whole shape of the live report.
    await call(fx.editor, 'manage_memory', { action: 'update', project_id: fx.p1, summary: 'Editor is working here.' });
    await call(fx.browser, 'manage_memory', { action: 'update', project_id: fx.p2, summary: 'Browser is working here.' });

    const read = await call(fx.editor, 'recall', { action: 'context', sections: ['task'] });
    assert.ok(!read.error, JSON.stringify(read.error));
    assert.ok(
      textOf(read).includes(fx.p1) || !textOf(read).includes(fx.p2),
      `THE BUG: an id-less read followed the other connection. Got: ${textOf(read).slice(0, 300)}`,
    );

    const write = await call(fx.editor, 'manage_memory', { action: 'update', summary: 'A note with no project_id.' });
    assert.ok(!write.error, JSON.stringify(write.error));
    assert.equal(
      write.result?.structuredContent?.project_id,
      fx.p1,
      'THE BUG: an id-less write landed in the project the OTHER connection last touched',
    );
  } finally {
    await cleanup([fx.person]);
  }
});

test('manage_projects select pins this connection and leaves the other alone', async () => {
  const fx = await twoConnections();
  try {
    const selected = await call(fx.editor, 'manage_projects', { action: 'select', project_id: fx.p2 });
    assert.ok(
      !selected.error,
      `THE BUG: selecting a project from a hosted client is refused outright: ${JSON.stringify(selected.error)}`,
    );
    assert.match(
      textOf(selected),
      /This connection now works in/,
      `the reply must say what was actually bound. Got: ${textOf(selected)}`,
    );

    const mine = await call(fx.editor, 'manage_memory', { action: 'update', summary: 'After selecting.' });
    assert.equal(
      mine.result?.structuredContent?.project_id,
      fx.p2,
      'THE BUG: select replied "switched" and bound nothing a hosted call reads',
    );

    // The other connection is untouched by somebody else's choice.
    const theirs = await call(fx.browser, 'manage_memory', { action: 'update', summary: 'Still over here.' });
    assert.equal(theirs.result?.structuredContent?.project_id, fx.p2, 'the browser was already in P2');

    const back = await call(fx.editor, 'manage_projects', { action: 'select', project_id: fx.p1 });
    assert.ok(!back.error, JSON.stringify(back.error));
    const afterBack = await call(fx.editor, 'manage_memory', { action: 'update', summary: 'Back in the first one.' });
    assert.equal(afterBack.result?.structuredContent?.project_id, fx.p1);
  } finally {
    await cleanup([fx.person]);
  }
});

test('start_session with a project_id binds the connection, so the next call stays there', async () => {
  const fx = await twoConnections();
  try {
    const opened = await call(fx.editor, 'start_session', { project_id: fx.p2 });
    assert.ok(!opened.error, JSON.stringify(opened.error));

    // The other connection then moves on, which is exactly what used to drag
    // this one along: without a per-connection binding, "most recent anywhere"
    // is the answer and this write follows the browser into P1.
    await call(fx.browser, 'manage_memory', { action: 'update', project_id: fx.p1, summary: 'Browser moved on.' });

    const next = await call(fx.editor, 'recall', { action: 'context', sections: ['task'] });
    assert.ok(!textOf(next).includes('No active project'), textOf(next));
    const write = await call(fx.editor, 'manage_memory', { action: 'update', summary: 'Following the session.' });
    assert.equal(
      write.result?.structuredContent?.project_id,
      fx.p2,
      'THE BUG: start_session { project_id } bound nothing, so the next call reverted',
    );
  } finally {
    await cleanup([fx.person]);
  }
});

test('the binding survives a token refresh that mints a new key', async () => {
  const fx = await twoConnections();
  try {
    await call(fx.editor, 'manage_projects', { action: 'select', project_id: fx.p1 });

    // What routes/oauth.js does on a refresh_token grant: a NEW api_keys row for
    // the SAME OAuth client. Keying the session on the key id would strand the
    // binding under the retired key, silently, about once a month.
    const refreshed = await addConnection(fx.person, {
      clientId: fx.editor.clientId,
      clientName: fx.editor.clientName,
    });
    const write = await call(refreshed, 'manage_memory', { action: 'update', summary: 'After the refresh.' });
    assert.equal(
      write.result?.structuredContent?.project_id,
      fx.p1,
      'THE BUG: a token refresh orphaned this connection\'s project binding',
    );
  } finally {
    await cleanup([fx.person]);
  }
});

test('a brand-new connection still opens the person\'s most recent project, and says it guessed', async () => {
  const fx = await twoConnections();
  try {
    await call(fx.browser, 'manage_memory', { action: 'update', project_id: fx.p2, summary: 'Most recent work.' });

    const fresh = await addConnection(fx.person, { clientId: 'https://example.test/other', clientName: 'Some Client' });
    const opened = await call(fresh, 'start_session', {});
    assert.ok(!opened.error, JSON.stringify(opened.error));
    const text = textOf(opened);
    assert.match(
      text,
      /^DeerDawn guessed "[^"]+" \([^)]+\): it is where you most recently worked/,
      `a guessed project must say so FIRST, above the brief, and say how to change it. Got: ${text.slice(0, 400)}`,
    );
    assert.match(text, /manage_projects with action "select"/, text.slice(0, 400));
    // The way out is named by id: the person's other project is offered.
    assert.ok(text.includes(`(${fx.p1})`), `the alternative project is listed by id. Got: ${text.slice(0, 600)}`);
  } finally {
    await cleanup([fx.person]);
  }
});

test('a project created by a connection becomes that connection\'s project', async () => {
  const fx = await twoConnections();
  try {
    // The browser writes last, so without the create binding the editor's next
    // id-less save follows it.
    await call(fx.browser, 'manage_memory', { action: 'update', project_id: fx.p2, summary: 'Browser wrote last.' });
    const fresh = await createProject(fx.editor, `Brand New ${uuidv4().slice(0, 6)}`);
    const write = await call(fx.editor, 'manage_memory', { action: 'update', summary: 'First note in the new one.' });
    assert.equal(
      write.result?.structuredContent?.project_id,
      fresh,
      'creating a project then saving must land in the project that was just created',
    );
  } finally {
    await cleanup([fx.person]);
  }
});

test('the session row names the real client, not the catalog default', async () => {
  const fx = await twoConnections();
  try {
    await call(fx.editor, 'manage_memory', { action: 'update', project_id: fx.p1, summary: 'A note from the editor.' });
    const rows = await db.query(
      'SELECT tool FROM context_sessions WHERE owner_key = $1 AND project_id = $2',
      [fx.person.orgId, fx.p1],
      'org-system',
    );
    assert.ok(
      rows.rows.some((r) => r.tool === 'claude_code'),
      `THE BUG: every hosted client files itself as claude_web. Got: ${JSON.stringify(rows.rows)}`,
    );
  } finally {
    await cleanup([fx.person]);
  }
});
