/**
 * TOOL AND TRANSPORT, RECORDED SEPARATELY (journey round 3, design B; round 6).
 *
 * One field, `surface`, carried both which tool is calling and how it connects:
 * `claude_code` meant the editor over a local install, `claude_web` meant
 * Claude.ai over the hosted connector, and a hosted Claude Code, Codex or Cursor
 * had no value and was filed as 'unknown_web'. So Setup could not say which tool
 * a hosted connection was, and the same name could be shown for two different
 * connections.
 *
 * Now product events, sessions and session loads carry `tool` and `transport`
 * as fields of their own; `surface` is unchanged (dashboards read it by name);
 * older rows are read through a derivation; and the displays use the right one.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r6-tool-transport.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.API_BASE_URL = process.env.API_BASE_URL || 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../../src/app');
const db = require('../../src/config/db');
const { generateToken, hashPassword, generateApiKey } = require('../../src/utils/security');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const BASE = process.env.API_BASE_URL.replace(/\/+$/, '');
const CONSENT = 'https://app.deerdawn.test/oauth/consent?req=';
const created = { orgs: [] };

test.after(async () => {
  for (const orgId of created.orgs) {
    await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId], 'org-system').catch(() => {});
    for (const table of ['context_graph_edges', 'context_graph_evidence', 'context_graph_nodes', 'context_sessions', 'context_session_loads', 'context_workspace_pointers', 'context_projects', 'context_audit_logs']) {
      await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [orgId], 'org-system').catch(() => {});
    }
    await db.query('DELETE FROM product_events WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
  }
});

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
    [userId, `${label}-${uuidv4().slice(0, 8)}@surface.test`, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  created.orgs.push(orgId);
  return { label, orgId, userId, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin' }) };
}

// The registrations and handshakes the real clients send (matrix.out, and
// tests/fixtures/oauth-real-clients.json for the registration shapes).
const CLIENTS = {
  claudeai: {
    registration: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
    clientInfo: { name: 'claude-ai', version: '0.1.0' },
    path: '/mcp/claude',
  },
  chatgpt: {
    registration: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] },
    clientInfo: { name: 'openai-mcp', version: '1.0.0' },
    path: '/mcp',
  },
  claudecode: {
    registration: { client_name: 'Claude Code (deerdawn)', redirect_uris: ['http://localhost:52341/callback'] },
    clientInfo: { name: 'claude-code', version: '2.1.0' },
    path: '/mcp',
  },
};

/** register -> authorize -> approve (as the person) -> token. */
async function connect(person, client) {
  const reg = await request(httpServer).post('/api/v1/oauth/register').send({
    ...client.registration,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.body.client_id;
  const redirectUri = client.registration.redirect_uris[0];
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const resource = `${BASE}${client.path}`;
  const authorize = await request(httpServer).get('/api/v1/oauth/authorize').query({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's',
    scope: 'context:read context:write', resource,
  });
  assert.equal(authorize.status, 302, authorize.text);
  const reqId = authorize.headers.location.slice(CONSENT.length);
  const approve = await request(httpServer).post('/api/v1/oauth/approve')
    .set('Authorization', `Bearer ${person.jwt}`).send({ req: reqId });
  assert.equal(approve.status, 200, approve.text);
  const code = new URL(approve.body.redirect).searchParams.get('code');
  const token = await request(httpServer).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId,
    redirect_uri: redirectUri, resource,
  });
  assert.equal(token.status, 200, token.text);
  return { ...client, clientId, access: token.body.access_token, auth: { Authorization: `Bearer ${token.body.access_token}` } };
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const line = String(res.text || '').split('\n').reverse().find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : res.text);
}

async function rpc(conn, method, params) {
  const res = await request(httpServer).post(conn.path || '/mcp')
    .set(MCP_HEADERS).set(conn.auth)
    .send({ jsonrpc: '2.0', id: 1, method, params });
  assert.equal(res.status, 200, `${method}: ${res.text}`);
  return parseRpc(res);
}

async function initialize(conn) {
  return rpc(conn, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: conn.clientInfo });
}

async function callTool(conn, name, args = {}) {
  const payload = await rpc(conn, 'tools/call', { name, arguments: args });
  assert.ok(!payload.error && !payload.result?.isError, `${name}: ${JSON.stringify(payload.error || payload.result)}`);
  return payload;
}


async function eventsOf(orgId, { atLeast = 1, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    ({ rows } = await db.query(
      'SELECT event_name, source, surface, tool, transport FROM product_events WHERE org_id = $1 AND source = \'mcp\' ORDER BY created_at',
      [orgId], 'org-system',
    ));
    if (rows.length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
  ({ rows } = await db.query(
    'SELECT event_name, source, surface, tool, transport FROM product_events WHERE org_id = $1 AND source = \'mcp\' ORDER BY created_at',
    [orgId], 'org-system',
  ));
  return rows;
}

async function bootstrapTools(person) {
  const boot = await request(httpServer).get('/api/v1/dashboard/bootstrap').set('Authorization', `Bearer ${person.jwt}`);
  assert.equal(boot.status, 200, boot.text);
  return boot.body.sync_health || {};
}

async function toolsStatus(person) {
  const res = await request(httpServer).get('/api/v1/context/tools/status').set('Authorization', `Bearer ${person.jwt}`);
  assert.equal(res.status, 200, res.text);
  return res.body;
}

async function keyConnection(person) {
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'backend', person.userId, person.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    person.orgId,
  );
  return { path: '/mcp', auth: { 'X-Api-Key': key }, key };
}

test('a hosted Claude Code is Claude Code over a hosted OAuth connection, not an unnamed web client', async () => {
  const person = await makePerson('r6-cc');
  const conn = await connect(person, CLIENTS.claudecode);
  await initialize(conn);
  await callTool(conn, 'manage_projects', { action: 'create', project_name: `Repo ${uuidv4().slice(0, 6)}` });
  await callTool(conn, 'start_session', {});
  const rows = await eventsOf(person.orgId, { atLeast: 3 });

  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.equal(row.tool, 'claude_code', `event ${row.event_name} names the wrong tool: ${row.tool}`);
    assert.equal(row.transport, 'hosted_oauth', `event ${row.event_name} names the wrong transport: ${row.transport}`);
    assert.equal(row.surface, 'unknown_web', 'surface keeps its old meaning; dashboards read it by name');
  }
  const health = await bootstrapTools(person);
  const cc = (health.mcp_tools || []).find((row) => row.tool === 'claude_code');
  assert.ok(cc && cc.transport === 'hosted_oauth' && cc.tool_calls >= 2, `Setup cannot see the hosted Claude Code: ${JSON.stringify(health.mcp_tools)}`);
  assert.ok(!(health.mcp_tools || []).some((row) => row.tool === 'claude_web'), 'a Claude Code connection was shown as Claude.ai');
  assert.ok((health.mcp_surfaces || []).some((row) => row.surface === 'unknown_web'), 'mcp_surfaces is unchanged');

  const status = await toolsStatus(person);
  assert.ok(status.tools.claude_code, JSON.stringify(status));
  assert.ok(!status.tools.claude_web, `the tool status page says Claude.ai for a Claude Code connection: ${JSON.stringify(status)}`);
  const session = (status.connections || []).find((row) => row.tool === 'claude_code');
  assert.equal(session?.transport, 'hosted_oauth', JSON.stringify(status.connections));
});

test('a Claude.ai connection is Claude.ai over a hosted OAuth connection, and never Claude Code', async () => {
  const person = await makePerson('r6-web');
  const conn = await connect(person, CLIENTS.claudeai);
  await initialize(conn);
  await callTool(conn, 'manage_projects', { action: 'create', project_name: `Garden ${uuidv4().slice(0, 6)}` });
  await callTool(conn, 'start_session', {});
  const rows = await eventsOf(person.orgId, { atLeast: 3 });
  for (const row of rows) {
    assert.equal(row.tool, 'claude_web');
    assert.equal(row.transport, 'hosted_oauth');
    assert.equal(row.surface, 'claude_web');
  }
  const status = await toolsStatus(person);
  assert.ok(status.tools.claude_web);
  assert.ok(!status.tools.claude_code, `the tool status page says Claude Code for a Claude.ai connection: ${JSON.stringify(status)}`);
});

test('a hosted API key names no client: its sessions are not Claude.ai', async () => {
  const person = await makePerson('r6-key');
  const conn = await keyConnection(person);
  await callTool(conn, 'manage_projects', { action: 'create', project_name: `Keyed ${uuidv4().slice(0, 6)}` });
  await callTool(conn, 'start_session', {});
  const rows = await eventsOf(person.orgId, { atLeast: 2 });
  for (const row of rows) {
    assert.equal(row.tool, null, 'a key names no client');
    assert.equal(row.transport, 'hosted_api_key');
  }
  const stored = (await db.query('SELECT tool, transport FROM context_sessions WHERE owner_key = $1', [person.orgId], 'org-system')).rows;
  assert.ok(stored.length && stored.every((row) => row.transport === 'hosted_api_key'), JSON.stringify(stored));
  const status = await toolsStatus(person);
  assert.ok(!status.tools.claude_web, `an API-key connection was reported as Claude.ai: ${JSON.stringify(status)}`);
  assert.ok(status.tools.unidentified, JSON.stringify(status));
});

test('the local server\'s events and a session start are local_stdio, and old rows read the same way', async () => {
  const person = await makePerson('r6-local');
  const conn = await keyConnection(person);
  // What the local server sends: a product event with its surface and execution_source.
  const evt = await request(httpServer).post('/api/v1/product-events').set(conn.auth)
    .send({ event_name: 'mcp_tool_call_succeeded', source: 'mcp', surface: 'claude_code', metadata: { tool_name: 'update_context', execution_source: 'stdio' } });
  assert.ok([200, 201, 202].includes(evt.status), evt.text);
  // A row written before the columns existed, one per legacy shape.
  await db.query(
    `INSERT INTO product_events (event_id, event_name, org_id, user_id, source, surface, metadata) VALUES
       ($1, 'mcp_tool_call_succeeded', $3, $4, 'mcp', 'cursor', '{"execution_source":"stdio"}'::jsonb),
       ($2, 'mcp_tool_call_succeeded', $3, $4, 'mcp', 'chatgpt_web', '{"transport":"http"}'::jsonb)`,
    [crypto.randomUUID(), crypto.randomUUID(), person.orgId, person.userId], 'org-system',
  );
  const rows = await eventsOf(person.orgId, { atLeast: 3 });
  const fresh = rows.find((row) => row.surface === 'claude_code');
  assert.deepEqual([fresh.tool, fresh.transport], ['claude_code', 'local_stdio']);

  const health = await bootstrapTools(person);
  const byTool = Object.fromEntries((health.mcp_tools || []).map((row) => [row.tool, row]));
  assert.equal(byTool.claude_code?.transport, 'local_stdio');
  assert.equal(byTool.cursor?.transport, 'local_stdio', 'an old local row reads as local');
  assert.equal(byTool.chatgpt_web?.transport, 'hosted', 'an old hosted row reads as hosted');

  // A local session start.
  const project = await request(httpServer).post('/api/v1/context/projects').set(conn.auth).send({ project_name: `Local ${uuidv4().slice(0, 6)}` });
  assert.ok([200, 201].includes(project.status), project.text);
  const sessionId = `agent-x1-${crypto.randomBytes(3).toString('hex')}`;
  const active = await request(httpServer).get('/api/v1/context/active').query({ tool: 'claude_code', mark_session: '1', session_id: sessionId }).set(conn.auth);
  assert.equal(active.status, 200, active.text);
  const session = (await db.query('SELECT tool, transport FROM context_sessions WHERE owner_key = $1 AND session_id = $2', [person.orgId, sessionId], 'org-system')).rows[0];
  assert.deepEqual(session, { tool: 'claude_code', transport: 'local_stdio' });
  const load = (await db.query('SELECT tool, transport FROM context_session_loads WHERE owner_key = $1', [person.orgId], 'org-system')).rows;
  assert.ok(load.some((row) => row.tool === 'claude_code' && row.transport === 'local_stdio'), JSON.stringify(load));
});

test('a listed hosted connection says its tool and that it is a hosted OAuth grant', async () => {
  const person = await makePerson('r6-list');
  await connect(person, CLIENTS.claudecode);
  const res = await request(httpServer).get('/api/v1/connections').set('Authorization', `Bearer ${person.jwt}`);
  assert.equal(res.status, 200, res.text);
  const listed = (res.body.connections || [])[0];
  assert.ok(listed, res.text);
  assert.equal(listed.tool, 'claude_code');
  assert.equal(listed.transport, 'hosted_oauth');
  assert.equal(listed.surface, 'claude_code', 'surface is unchanged');
});

test('ensureSchema does not backfill inline; old rows read right meanwhile; the backfill runs in batches later', async () => {
  const person = await makePerson('r6-backfill');
  const suffix = crypto.randomBytes(3).toString('hex');
  const rows = [
    [`web-claude_web-${suffix}`, 'claude_web'],
    [`web-claude_code-${suffix}`, 'claude_code'],
    [`agent-abc-${suffix}`, 'claude_code'],
    [`sess-${suffix}`, 'claude_web'],
  ];
  for (const [id, tool] of rows) {
    await db.query(
      'INSERT INTO context_sessions (session_id, owner_key, tool, surface_type, transport) VALUES ($1, $2, $3, \'browser\', NULL)',
      [id, person.orgId, tool], 'org-system',
    );
  }
  await db.query(
    `INSERT INTO context_session_loads (load_id, owner_key, tool, transport) VALUES
       ($1, $3, 'unknown_web', NULL), ($2, $3, 'cursor', NULL)`,
    [`sload_${crypto.randomUUID()}`, `sload_${crypto.randomUUID()}`, person.orgId], 'org-system',
  );
  const nulls = async () => ({
    sessions: (await db.query('SELECT count(*)::int AS n FROM context_sessions WHERE owner_key = $1 AND transport IS NULL', [person.orgId], 'org-system')).rows[0].n,
    loads: (await db.query('SELECT count(*)::int AS n FROM context_session_loads WHERE owner_key = $1 AND transport IS NULL', [person.orgId], 'org-system')).rows[0].n,
  });
  const cwd = require('node:path').join(__dirname, '..', '..');
  const child = (code, env = {}) => require('node:child_process').execFileSync(process.execPath, ['-e', code], {
    cwd, env: { ...process.env, ...env }, timeout: 60000,
  }).toString();

  // A fresh process runs ensureSchema. The backfill is scheduled for later
  // (the delay is long enough that it cannot have started), so nothing has been
  // written when ensureSchema returns.
  child('require(\'./src/store/contextSyncStore\').ensureSchema().then(() => process.exit(0), () => process.exit(1))', { DEERDAWN_TRANSPORT_BACKFILL_DELAY_MS: '600000' });
  assert.deepEqual(await nulls(), { sessions: 4, loads: 2 }, 'ensureSchema wrote rows on the request path');

  // Until it has run, the old rows are read through the derivation.
  const status = await toolsStatus(person);
  const transports = Object.fromEntries((status.connections || []).map((row) => [`${row.tool}:${row.transport}`, true]));
  assert.ok(transports['claude_web:hosted'], JSON.stringify(status.connections));
  assert.ok(transports['claude_code:hosted'] && transports['claude_code:local_stdio'], JSON.stringify(status.connections));

  // Then it runs, in batches, and can be run again.
  const first = JSON.parse(child(
    'const s = require(\'./src/store/contextSyncStore\'); s.runTransportBackfill({ batchSize: 2 }).then((r) => { console.log(JSON.stringify(r)); process.exit(0); }, (e) => { console.error(e); process.exit(1); })',
    { DEERDAWN_TRANSPORT_BACKFILL_DELAY_MS: '600000' },
  ).trim().split('\n').pop());
  assert.ok(first.batches >= 2, `the backfill was not batched: ${JSON.stringify(first)}`);
  const sessions = Object.fromEntries((await db.query('SELECT session_id, transport FROM context_sessions WHERE owner_key = $1', [person.orgId], 'org-system')).rows.map((r) => [r.session_id.split('-').slice(0, 2).join('-'), r.transport]));
  assert.equal(sessions['web-claude_web'], 'hosted');
  assert.equal(sessions['agent-abc'], 'local_stdio');
  assert.equal(sessions[`sess-${suffix}`], null, 'an id that could have come either way is not guessed');
  const loads = Object.fromEntries((await db.query('SELECT tool, transport FROM context_session_loads WHERE owner_key = $1', [person.orgId], 'org-system')).rows.map((r) => [r.tool, r.transport]));
  assert.equal(loads.unknown_web, 'hosted');
  assert.equal(loads.cursor, 'local_stdio');
  const second = JSON.parse(child(
    'require(\'./src/store/contextSyncStore\').runTransportBackfill({ batchSize: 2 }).then((r) => { console.log(JSON.stringify(r)); process.exit(0); })',
    { DEERDAWN_TRANSPORT_BACKFILL_DELAY_MS: '600000' },
  ).trim().split('\n').pop());
  assert.equal(second.updated, 0, 'a second run changed rows');
});

test('ensureSchema asks the catalog before adding the transport columns, so a booted database takes no table lock', async () => {
  const cwd = require('node:path').join(__dirname, '..', '..');
  const out = require('node:child_process').execFileSync(process.execPath, ['-e', `
    const db = require('./src/config/db');
    const seen = [];
    const original = db.query.bind(db);
    db.query = (sql, ...rest) => { seen.push(String(sql)); return original(sql, ...rest); };
    require('./src/store/contextSyncStore').ensureSchema().then(() => {
      console.log(JSON.stringify(seen.filter((sql) => /ALTER TABLE context_(sessions|session_loads)\\s+ADD COLUMN[^;]*transport/i.test(sql) || /UPDATE context_(sessions|session_loads)/i.test(sql))));
      process.exit(0);
    }, (e) => { console.error(e); process.exit(1); });
  `], { cwd, env: { ...process.env, DEERDAWN_TRANSPORT_BACKFILL_DELAY_MS: '600000' }, timeout: 60000 }).toString().trim().split('\n').pop();
  assert.deepEqual(JSON.parse(out), [], 'ensureSchema ran an ALTER or an UPDATE on the session tables');
});

test('only one instance runs the transport backfill; the others skip quietly; the run logs one line', async () => {
  const store = require('../../src/store/contextSyncStore');
  const person = await makePerson('r6-lock');
  const suffix = crypto.randomBytes(3).toString('hex');
  await db.query(
    'INSERT INTO context_sessions (session_id, owner_key, tool, surface_type, transport) VALUES ($1, $2, \'claude_web\', \'browser\', NULL)',
    [`web-claude_web-${suffix}`, person.orgId], 'org-system',
  );
  const cwd = require('node:path').join(__dirname, '..', '..');
  const run = () => require('node:child_process').execFileSync(process.execPath, ['-e', 'require(\'./src/store/contextSyncStore\').runTransportBackfill({ pauseMs: 0 }).then((r) => { console.log(JSON.stringify(r)); process.exit(0); }, (e) => { console.error(e); process.exit(1); })'], {
    cwd, env: { ...process.env, DEERDAWN_TRANSPORT_BACKFILL_DELAY_MS: '600000' }, timeout: 60000,
  }).toString().trim().split('\n');
  const nullRows = async () => (await db.query('SELECT count(*)::int AS n FROM context_sessions WHERE owner_key = $1 AND transport IS NULL', [person.orgId], 'org-system')).rows[0].n;

  // Another instance holds the lock (a different connection, as another machine would).
  assert.equal(typeof store.TRANSPORT_BACKFILL_LOCK_KEY, 'number', 'the backfill has no fixed advisory lock key');
  const holder = await db.pool.connect();
  try {
    await holder.query('SELECT pg_advisory_lock($1)', [store.TRANSPORT_BACKFILL_LOCK_KEY]);
    const lines = run();
    assert.deepEqual(JSON.parse(lines[lines.length - 1]), { skipped: true });
    assert.ok(!lines.some((line) => /transport backfill/.test(line)), `a skipped run was not quiet: ${lines.join(' | ')}`);
    assert.equal(await nullRows(), 1, 'a skipped run changed rows');
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [store.TRANSPORT_BACKFILL_LOCK_KEY]).catch(() => {});
    holder.release();
  }

  // The lock is free: it runs, and says what it did in one line.
  const lines = run();
  const finished = lines.filter((line) => /transport backfill finished/.test(line));
  assert.equal(finished.length, 1, `expected one finish line: ${lines.join(' | ')}`);
  assert.match(finished[0], /context_sessions updated=\d+, context_session_loads updated=\d+/);
  assert.equal(await nullRows(), 0);
  // And the lock was released at the end: a third run can take it.
  const again = run();
  assert.ok(!JSON.parse(again[again.length - 1]).skipped, 'the lock was not released');
});

test('the backfill is never scheduled inside a test process, and an env flag turns it off anywhere', async () => {
  const person = await makePerson('r6-sched');
  const id = `web-claude_web-${crypto.randomBytes(3).toString('hex')}`;
  await db.query(
    'INSERT INTO context_sessions (session_id, owner_key, tool, surface_type, transport) VALUES ($1, $2, \'claude_web\', \'browser\', NULL)',
    [id, person.orgId], 'org-system',
  );
  const cwd = require('node:path').join(__dirname, '..', '..');
  const transport = async () => (await db.query('SELECT transport FROM context_sessions WHERE owner_key = $1 AND session_id = $2', [person.orgId, id], 'org-system')).rows[0].transport;
  // ensureSchema, then stay alive long enough for a zero-delay timer to have fired.
  const boot = (env) => require('node:child_process').execFileSync(process.execPath, ['-e', 'require(\'./src/store/contextSyncStore\').ensureSchema().then(() => setTimeout(() => process.exit(0), 2500), () => process.exit(1))'], {
    cwd, env: { ...process.env, DEERDAWN_TRANSPORT_BACKFILL_DELAY_MS: '0', ...env }, timeout: 60000,
  });

  boot({ NODE_ENV: 'test' });
  assert.equal(await transport(), null, 'a test process scheduled the backfill (it contends with whatever the suite is measuring)');
  boot({ NODE_ENV: 'development', DEERDAWN_TRANSPORT_BACKFILL_DISABLE: '1' });
  assert.equal(await transport(), null, 'the disable flag did not stop the backfill');
  // Control: outside a test process, and not disabled, it does run.
  boot({ NODE_ENV: 'development' });
  assert.equal(await transport(), 'hosted', 'the control run never backfilled, so the two checks above prove nothing');
});
