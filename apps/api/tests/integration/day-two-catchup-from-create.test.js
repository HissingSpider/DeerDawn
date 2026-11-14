/**
 * DAY-TWO CATCH-UP FOR THE PERSON IT EXISTS FOR (activation plan, Thing 3a/3b).
 *
 * A brand-new account's first start_session has no project, so it booked no
 * session. The person then created a project and saved into it in the same
 * sitting — and their NEXT start_session was "session 1", which says nothing.
 * The catch-up ("last session you decided X") never reached the one person who
 * most needed proof that DeerDawn remembered.
 *
 * Fixed by booking session one when a project is CREATED from an MCP session,
 * before the first save: hosted, in the create_project dispatch; local, in
 * POST /projects with an explicit flag (a brief made on the website is not a
 * session). Create only, never select.
 *
 * Acceptance (X5, lab): an empty account creates a project and saves a
 * decision; a start_session more than two minutes later returns the catch-up
 * header for session 2 naming that decision. Production has no simulated
 * clock, so the gap is injected here by backdating the session-one row.
 *
 * Real app, real API keys, real database:
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/day-two-catchup-from-create.test.js
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
const { dispatchTool } = require('../../src/routes/mcp');

const MINUTE = 60 * 1000;

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const keyId = `key-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@daytwo.test`;
  const { key, prefix, hash } = generateApiKey();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'free', 'free', 'active'],
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
    [keyId, prefix, hash, `${label} key`, userId, orgId, 'production', expiresAt, ['context:read', 'context:write']],
    orgId,
  );
  return { label, orgId, userId, keyId, email, apiKey: key };
}

async function cleanup(person) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
    await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId], 'org-system').catch(() => {});
  }
  await db.query('DELETE FROM context_session_loads WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
  await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : res.text);
}

async function hosted(person, name, args) {
  const res = await request(httpServer).post('/mcp').set(MCP_HEADERS).set('X-Api-Key', person.apiKey).send(rpc(name, args));
  assert.equal(res.status, 200, res.text);
  const payload = parseRpc(res);
  assert.ok(!payload.error, JSON.stringify(payload.error));
  return payload;
}

const textOf = (payload) => payload.result?.content?.map((c) => c.text).join('\n') || '';

async function loads(person, projectId) {
  const res = await db.query(
    'SELECT tool, user_id, created_at FROM context_session_loads WHERE owner_key = $1 AND project_id = $2 ORDER BY created_at',
    [person.orgId, projectId],
    'org-system',
  );
  return res.rows;
}

// The injected clock: move every session-one row for the project back in time,
// as if the person had created it `ms` ago.
async function backdateLoads(person, projectId, ms) {
  await db.query(
    `UPDATE context_session_loads SET created_at = created_at - make_interval(secs => $3)
      WHERE owner_key = $1 AND project_id = $2`,
    [person.orgId, projectId, ms / 1000],
    'org-system',
  );
}

test('X5: create, save a decision, and the next start_session (>2 min later) is session 2 naming it', async () => {
  const person = await makePerson('daytwo');
  try {
    // An EMPTY account: the first start_session has no project, so it books nothing.
    const first = await hosted(person, 'start_session', {});
    assert.ok(textOf(first).length > 0, 'the empty account gets its first-session answer');

    const name = `Garden Plan ${uuidv4().slice(0, 6)}`;
    const created = await hosted(person, 'manage_projects', { action: 'create', project_name: name });
    const projectId = created.result?.structuredContent?.project_id;
    assert.ok(projectId, textOf(created));

    const booked = await loads(person, projectId);
    assert.equal(booked.length, 1, 'THE FIX: creating the project from an MCP session books session one');
    assert.equal(booked[0].user_id, person.userId, 'booked to the person, not the key');

    // Session one happened three minutes ago; the save lands after it.
    await backdateLoads(person, projectId, 3 * MINUTE);
    const DECISION = `We decided to plant tomatoes along the south fence. DEC-${uuidv4().slice(0, 8)}`;
    const saved = await hosted(person, 'manage_memory', { action: 'update', summary: DECISION });
    assert.equal(saved.result?.structuredContent?.stored, true, textOf(saved));

    const second = await hosted(person, 'start_session', {});
    const text = textOf(second);
    assert.match(text, new RegExp(`Session 2 on ${name}`), `the catch-up header for session 2:\n${text}`);
    assert.match(text, /last session earlier today/);
    assert.ok(text.includes(`decided: ${DECISION.slice(0, 60)}`), `the catch-up names the decision:\n${text}`);

    // 3b: the receipt is the brief's first line, and it is data.
    const firstLine = text.split('\n')[0];
    assert.match(firstLine, new RegExp(`^DeerDawn loaded ${name}: 1 decision, 0 open questions, last saved `), firstLine);
    // A plain API key names no client, so the save's tool (the catalog default)
    // is not credited by name.
    assert.doesNotMatch(firstLine, / in (Claude|ChatGPT)/, firstLine);
  } finally {
    await cleanup(person);
  }
});

test('selecting an existing project books no session; only create does', async () => {
  const person = await makePerson('select');
  try {
    const created = await hosted(person, 'manage_projects', { action: 'create', project_name: `Select Me ${uuidv4().slice(0, 6)}` });
    const projectId = created.result?.structuredContent?.project_id;
    const other = await hosted(person, 'manage_projects', { action: 'create', project_name: `Other ${uuidv4().slice(0, 6)}` });
    const otherId = other.result?.structuredContent?.project_id;
    assert.equal((await loads(person, projectId)).length, 1);

    await hosted(person, 'manage_projects', { action: 'select', project_id: projectId });
    assert.equal((await loads(person, projectId)).length, 1, 'select is not the start of a project\'s history');
    assert.equal((await loads(person, otherId)).length, 1);
  } finally {
    await cleanup(person);
  }
});

test('local POST /projects books session one only with the MCP flag', async () => {
  const person = await makePerson('local');
  try {
    const plain = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', person.apiKey)
      .send({ project_name: `Plain ${uuidv4().slice(0, 6)}` });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    assert.equal((await loads(person, plain.body.project.project_id)).length, 0, 'no flag, no session');

    const flagged = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', person.apiKey)
      .send({ project_name: `Flagged ${uuidv4().slice(0, 6)}`, from_mcp_session: true, session_tool: 'claude_code', session_id: 'agent-test-1' });
    assert.equal(flagged.status, 201, JSON.stringify(flagged.body));
    assert.equal(flagged.body.project.from_mcp_session, undefined, 'the flag is not stored on the project');
    const rows = await loads(person, flagged.body.project.project_id);
    assert.equal(rows.length, 1, 'the local create_project tool books session one');
    assert.equal(rows[0].tool, 'claude_code');

    // Nothing in the session fields can fail a create: an over-long tool (a long
    // DEERDAWN_SURFACE_ID), an over-long session id and a non-boolean flag are
    // all read as absent, never a 400.
    const long = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', person.apiKey)
      .send({ project_name: `Long ${uuidv4().slice(0, 6)}`, from_mcp_session: true, session_tool: 'x'.repeat(300), session_id: 'y'.repeat(500) });
    assert.equal(long.status, 201, JSON.stringify(long.body));
    const longRows = await loads(person, long.body.project.project_id);
    assert.equal(longRows.length, 1);
    assert.equal(longRows[0].tool, null);
    const odder = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', person.apiKey)
      .send({ project_name: `Odder ${uuidv4().slice(0, 6)}`, from_mcp_session: 'yes', session_tool: 42, session_id: {} });
    assert.equal(odder.status, 201, JSON.stringify(odder.body));
    assert.equal((await loads(person, odder.body.project.project_id)).length, 0, 'only a true flag books a session');

    // An unrecognised tool never fails the create; it is stored as no tool.
    const odd = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', person.apiKey)
      .send({ project_name: `Odd ${uuidv4().slice(0, 6)}`, from_mcp_session: true, session_tool: 'some-new-editor' });
    assert.equal(odd.status, 201, JSON.stringify(odd.body));
    const oddRows = await loads(person, odd.body.project.project_id);
    assert.equal(oddRows.length, 1);
    assert.equal(oddRows[0].tool, null);
  } finally {
    await cleanup(person);
  }
});

test('the next catch-up says which tool the last session was in, and a task set since then', async () => {
  const person = await makePerson('tool');
  try {
    const actor = {
      type: 'key', id: person.keyId, owner_id: person.userId, org_id: person.orgId,
      scopes: ['context:read', 'context:write'],
    };
    const chatgpt = { clientInfo: { name: 'ChatGPT', version: '1' } };
    const name = `Kitchen Remodel ${uuidv4().slice(0, 6)}`;
    const created = await dispatchTool('create_project', { project_name: name }, actor, 'chatgpt_web', chatgpt);
    const projectId = created.structuredContent?.project_id;
    assert.equal((await loads(person, projectId))[0]?.tool, 'chatgpt_web');
    await backdateLoads(person, projectId, 5 * MINUTE);

    await dispatchTool('manage_memory', {
      action: 'update', summary: 'Current task: get three quotes for the cabinets',
    }, actor, 'chatgpt_web', chatgpt);

    const opened = await dispatchTool('start_session', {}, actor, 'chatgpt_web', chatgpt);
    const text = opened.content.map((c) => c.text).join('\n');
    assert.match(text, new RegExp(`Session 2 on ${name} — last session earlier today in ChatGPT\\.`), text);
    assert.match(text, /new task: get three quotes for the cabinets/, text);
    assert.doesNotMatch(text, /Nothing new recorded/, 'a task set since then is news');
  } finally {
    await cleanup(person);
  }
});

test('a local session whose client was not identified is not said to have been "in Claude Code"', async () => {
  const person = await makePerson('unidentified');
  try {
    // Windsurf, say: the local server renders it as claude_code (the default)
    // and says so with tool_identified=0. The create sends no session_tool.
    const created = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', person.apiKey)
      .send({ project_name: `Unplaced ${uuidv4().slice(0, 6)}`, from_mcp_session: true, session_id: 'agent-unplaced' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.project_id;
    await backdateLoads(person, projectId, 3 * 60 * MINUTE);

    const active = await request(httpServer).get('/api/v1/context/active').set('X-Api-Key', person.apiKey)
      .query({ tool: 'claude_code', mark_session: 1, tool_identified: 0, session_id: 'agent-unplaced' });
    assert.equal(active.status, 200, JSON.stringify(active.body));
    assert.equal(active.body.project_id, projectId, 'the only project resolves');
    const rows = await loads(person, projectId);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].tool, 'unknown', 'the session row names no tool');

    // The THIRD session: the previous one was the unidentified load.
    await backdateLoads(person, projectId, 3 * 60 * MINUTE);
    const again = await request(httpServer).get('/api/v1/context/active').set('X-Api-Key', person.apiKey)
      .query({ tool: 'claude_code', mark_session: 1, tool_identified: 0, session_id: 'agent-unplaced-2' });
    assert.equal(again.body.catchup?.previous_session?.tool_label, null);
    assert.ok(again.body.catchup?.text, JSON.stringify(again.body.catchup));
    assert.match(again.body.catchup.text, /^Session 3 on .* — last session earlier today\./);
    assert.doesNotMatch(again.body.catchup.text, / in Claude Code/);

    // And an IDENTIFIED one is named: the default parameter is absent.
    await backdateLoads(person, projectId, 3 * 60 * MINUTE);
    await request(httpServer).get('/api/v1/context/active').set('X-Api-Key', person.apiKey)
      .query({ tool: 'cursor', mark_session: 1, session_id: 'agent-cursor' });
    await backdateLoads(person, projectId, 3 * 60 * MINUTE);
    const named = await request(httpServer).get('/api/v1/context/active').set('X-Api-Key', person.apiKey)
      .query({ tool: 'claude_code', mark_session: 1, session_id: 'agent-cc' });
    assert.equal(named.body.catchup?.previous_session?.tool_label, 'Cursor');
  } finally {
    await cleanup(person);
  }
});
