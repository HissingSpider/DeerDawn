/**
 * A WORKING HOSTED CONNECTION READ AS "0 OF 9 TOOLS CONNECTED".
 *
 * The hosted transport is stateless: a fresh Server per request, and
 * `clientInfo` exists only on the request that carried `initialize`. So every
 * tools/call was recorded with surface 'unknown_web', and Setup, which marks a
 * tool connected only when ITS surface has calls, showed Claude.ai and ChatGPT
 * as "last seen today · Connect" beside four real calls filed under a surface
 * no card maps to (walker, 2026-09-27: claude_web tool_calls 0, unknown_web
 * tool_calls 4). That is every hosted-only person, which is most people.
 *
 * The identity was never missing, only unread: the OAuth grant stamps the
 * client's id and registered name onto the access key it mints, and the auth
 * middleware hands both to every request on that key.
 *
 * What must hold:
 *   - a call on a Claude.ai / ChatGPT OAuth token is filed under that client's
 *     web surface, so the dashboard counts it where Setup looks;
 *   - a call that cannot be identified stays 'unknown_web' (a plain API key,
 *     and an editor such as Claude Code, whose name says "claude" but which is
 *     not Claude.ai), because a guessed label is worse than an honest blank;
 *   - one client never reads as two tools: second_tool_connected, the
 *     retention transition, counts DISTINCT identifying surfaces, so a
 *     handshake labelled one way and calls labelled another would fire it for a
 *     person who connected exactly one thing.
 *
 * Driven end to end through the real routes: register -> authorize -> approve
 * -> token, then initialize and tools/call over /mcp and /mcp/claude.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/hosted-surface-attribution.test.js
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

/** What a real session does: connect, make a project, save, load a brief. */
async function useIt(conn, label) {
  await initialize(conn);
  await callTool(conn, 'manage_projects', { action: 'create', project_name: `${label} ${uuidv4().slice(0, 6)}` });
  await callTool(conn, 'manage_memory', { action: 'update', summary: 'Decided to plant tomatoes along the south fence.' });
  await callTool(conn, 'start_session', {});
}

// Every recorder on this path is fire-and-forget, so wait for the rows rather
// than for the responses.
async function mcpEvents(orgId, { atLeast = 1, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    ({ rows } = await db.query(
      'SELECT event_name, source, surface FROM product_events WHERE org_id = $1 ORDER BY created_at',
      [orgId], 'org-system',
    ));
    if (rows.filter((r) => r.source === 'mcp').length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // One more beat for the stragglers (second_tool_connected is emitted after a read).
  await new Promise((r) => setTimeout(r, 300));
  ({ rows } = await db.query(
    'SELECT event_name, source, surface FROM product_events WHERE org_id = $1 ORDER BY created_at',
    [orgId], 'org-system',
  ));
  return rows;
}

async function surfacesOnSetup(person) {
  const boot = await request(httpServer).get('/api/v1/dashboard/bootstrap').set('Authorization', `Bearer ${person.jwt}`);
  assert.equal(boot.status, 200, boot.text);
  return Object.fromEntries((boot.body.sync_health?.mcp_surfaces || []).map((row) => [row.surface, row]));
}

const IDENTIFYING = (surface) => surface && !['unknown', 'unknown_web'].includes(surface);

test('a Claude.ai connection\'s calls are counted as Claude.ai, where Setup looks for them', async () => {
  const person = await makePerson('claudeai');
  const conn = await connect(person, CLIENTS.claudeai);
  await useIt(conn, 'Garden Planner');
  await mcpEvents(person.orgId, { atLeast: 4 });

  const surfaces = await surfacesOnSetup(person);
  assert.ok(
    (surfaces.claude_web?.tool_calls || 0) >= 3,
    `THE BUG: Claude.ai's own calls are not on its surface. mcp_surfaces: ${JSON.stringify(surfaces)}`,
  );
  assert.ok(
    !(surfaces.unknown_web?.tool_calls > 0),
    `the calls were filed under a surface no Setup card maps to: ${JSON.stringify(surfaces.unknown_web)}`,
  );
});

test('a ChatGPT connection\'s calls are counted as ChatGPT', async () => {
  const person = await makePerson('chatgpt');
  const conn = await connect(person, CLIENTS.chatgpt);
  await useIt(conn, 'Budget');
  await mcpEvents(person.orgId, { atLeast: 4 });

  const surfaces = await surfacesOnSetup(person);
  assert.ok(
    (surfaces.chatgpt_web?.tool_calls || 0) >= 3,
    `THE BUG: ChatGPT's own calls are not on its surface. mcp_surfaces: ${JSON.stringify(surfaces)}`,
  );
  assert.ok(!(surfaces.unknown_web?.tool_calls > 0), JSON.stringify(surfaces.unknown_web));
  assert.ok(!surfaces.claude_web, `a ChatGPT call was labelled Claude.ai: ${JSON.stringify(surfaces)}`);
});

test('a plain API key carries no client, so its calls stay unidentified, as before', async () => {
  const person = await makePerson('apikey');
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'backend', person.userId, person.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    person.orgId,
  );
  const conn = { path: '/mcp', auth: { 'X-Api-Key': key } };
  await callTool(conn, 'manage_projects', { action: 'create', project_name: `Keyed ${uuidv4().slice(0, 6)}` });
  await callTool(conn, 'start_session', {});
  await mcpEvents(person.orgId, { atLeast: 2 });

  const surfaces = await surfacesOnSetup(person);
  assert.ok((surfaces.unknown_web?.tool_calls || 0) >= 2, JSON.stringify(surfaces));
  assert.deepEqual(Object.keys(surfaces).filter(IDENTIFYING), [], `an API key was given an identity it does not carry: ${JSON.stringify(surfaces)}`);
});

test('Claude Code is never guessed to be Claude.ai, at the handshake or on a call', async () => {
  const person = await makePerson('claudecode');
  const conn = await connect(person, CLIENTS.claudecode);
  await useIt(conn, 'Repo');
  await mcpEvents(person.orgId, { atLeast: 4 });

  const surfaces = await surfacesOnSetup(person);
  assert.ok(
    !surfaces.claude_web,
    `THE BUG: an editor whose name contains "claude" was filed as Claude.ai: ${JSON.stringify(surfaces.claude_web)}`,
  );
  assert.ok((surfaces.unknown_web?.tool_calls || 0) >= 3, JSON.stringify(surfaces));
});

test('one client never counts as two tools', async () => {
  for (const [name, client] of Object.entries(CLIENTS)) {
    const person = await makePerson(`one-${name}`);
    const conn = await connect(person, client);
    await useIt(conn, `Solo ${name}`);
    // A second session, which is when the catch-up path re-checks the metric.
    await callTool(conn, 'start_session', {});
    const rows = await mcpEvents(person.orgId, { atLeast: 5 });

    const identifying = new Set(rows.filter((r) => r.source === 'mcp' && IDENTIFYING(r.surface)).map((r) => r.surface));
    assert.ok(identifying.size <= 1, `${name}: one client produced ${identifying.size} identities: ${[...identifying]}`);
    assert.ok(
      !rows.some((r) => r.event_name === 'second_tool_connected'),
      `${name}: second_tool_connected fired for a person who connected one tool`,
    );
  }
});

test('a hosted Claude Code beside the local Claude Code is still one tool', async () => {
  // The local stdio server files its own events under 'claude_code'. Before
  // this, the hosted handshake from the same editor said 'claude_web', and the
  // two labels made the person a two-tool account on the spot.
  const person = await makePerson('bothcode');
  await db.query(
    `INSERT INTO product_events (event_id, event_name, org_id, user_id, source, surface, metadata)
     VALUES ($1, 'mcp_runtime_started', $2, $3, 'mcp', 'claude_code', '{}'::jsonb)`,
    [crypto.randomUUID(), person.orgId, person.userId],
    'org-system',
  );
  const conn = await connect(person, CLIENTS.claudecode);
  await useIt(conn, 'Repo two');
  const rows = await mcpEvents(person.orgId, { atLeast: 5 });
  assert.ok(
    !rows.some((r) => r.event_name === 'second_tool_connected'),
    `THE BUG: one editor on two transports fired second_tool_connected: ${JSON.stringify(rows.filter((r) => r.source === 'mcp').map((r) => r.surface))}`,
  );
});

test('a connection made before keys carried their client\'s name is named again at its next refresh', async () => {
  // Every connection authorised before the refresh record carried client_name
  // rotates into a key with no name, forever: each refresh copies the record
  // forward. Until it is named its calls stay unidentified (never guessed), and
  // the first refresh reads the name back from the registration.
  const { redis } = require('../../src/config/redis');
  const refreshKeyOf = (token) => `oauth:refresh:${crypto.createHash('sha256').update(token).digest('hex')}`;
  const person = await makePerson('legacy');
  const reg = await request(httpServer).post('/api/v1/oauth/register').send({
    ...CLIENTS.claudeai.registration, token_endpoint_auth_method: 'none',
  });
  const clientId = reg.body.client_id;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const resource = `${BASE}/mcp/claude`;
  const redirectUri = CLIENTS.claudeai.registration.redirect_uris[0];
  const authorize = await request(httpServer).get('/api/v1/oauth/authorize').query({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', state: 's', scope: 'context:read context:write', resource,
  });
  const approve = await request(httpServer).post('/api/v1/oauth/approve')
    .set('Authorization', `Bearer ${person.jwt}`).send({ req: authorize.headers.location.slice(CONSENT.length) });
  const token = await request(httpServer).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code: new URL(approve.body.redirect).searchParams.get('code'),
    code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, resource,
  });
  assert.equal(token.status, 200, token.text);

  // Wind it back to the old shape: a key with no client columns, a refresh
  // record with no name.
  await db.query(
    'UPDATE api_keys SET oauth_client_id = NULL, oauth_client_name = NULL WHERE owner_id = $1',
    [person.userId], 'org-system',
  );
  await require('../../src/services/apiKeyCache').invalidateApiKey(
    (await db.query('SELECT key_hash FROM api_keys WHERE owner_id = $1', [person.userId], 'org-system')).rows[0].key_hash,
  );
  const stored = JSON.parse(await redis.get(refreshKeyOf(token.body.refresh_token)));
  delete stored.client_name;
  await redis.set(refreshKeyOf(token.body.refresh_token), JSON.stringify(stored));

  const legacy = { path: '/mcp/claude', auth: { Authorization: `Bearer ${token.body.access_token}` } };
  await callTool(legacy, 'manage_projects', { action: 'create', project_name: `Old ${uuidv4().slice(0, 6)}` });
  let rows = await mcpEvents(person.orgId, { atLeast: 1 });
  assert.deepEqual(
    rows.filter((r) => r.source === 'mcp').map((r) => r.surface),
    ['unknown_web'],
    'a credential that names no client is not guessed at',
  );

  const refreshed = await request(httpServer).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'refresh_token', refresh_token: token.body.refresh_token, client_id: clientId,
  });
  assert.equal(refreshed.status, 200, refreshed.text);
  const renamed = await db.query(
    'SELECT oauth_client_id, oauth_client_name FROM api_keys WHERE owner_id = $1 AND status = \'active\'',
    [person.userId], 'org-system',
  );
  assert.deepEqual(renamed.rows, [{ oauth_client_id: clientId, oauth_client_name: 'Claude' }],
    'THE BUG: the rotated key still names no client, so it never will');

  const healed = { path: '/mcp/claude', auth: { Authorization: `Bearer ${refreshed.body.access_token}` } };
  await callTool(healed, 'start_session', {});
  rows = await mcpEvents(person.orgId, { atLeast: 2 });
  assert.equal(rows.filter((r) => r.source === 'mcp').at(-1).surface, 'claude_web');
});

test('two different hosted tools are two tools, and the metric fires once', async () => {
  const person = await makePerson('two');
  const claude = await connect(person, CLIENTS.claudeai);
  await useIt(claude, 'Shared A');
  await mcpEvents(person.orgId, { atLeast: 4 });
  const chatgpt = await connect(person, CLIENTS.chatgpt);
  await useIt(chatgpt, 'Shared B');
  const rows = await mcpEvents(person.orgId, { atLeast: 8 });
  const fired = rows.filter((r) => r.event_name === 'second_tool_connected');
  assert.equal(fired.length, 1, `expected exactly one second_tool_connected, got ${fired.length}`);

  const surfaces = await surfacesOnSetup(person);
  assert.ok((surfaces.claude_web?.tool_calls || 0) >= 3, JSON.stringify(surfaces));
  assert.ok((surfaces.chatgpt_web?.tool_calls || 0) >= 3, JSON.stringify(surfaces));
});
