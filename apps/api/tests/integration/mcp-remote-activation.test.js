const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

// Route-level coverage for the hosted activation path (C-1a).
//
// The bug this exists to prevent from ever coming back: the hosted transport
// (Claude.ai / ChatGPT / any remote connector) answers start_session from
// getWorkspaceOverview and never goes through contextSyncService.renderInjection
// — the only place context_delivered and first_sync_completed are emitted. So a
// hosted user could authorize, call start_session, receive their entire
// workspace, and never register as activated. Activation was structurally
// unreachable from every no-install surface.
//
// The unit test (tests/unit/remote-session-delivery.test.js) pins the emit SET.
// This one pins the WIRING: it drives the real /mcp route over HTTP with real
// auth against a real database, and asserts the rows actually land in
// product_events. A unit test cannot catch "start_session forgot to call it",
// which is precisely the shape of the original defect.
//
// Needs the DB harness: bash scripts/run-db-test.sh node --test tests/integration/mcp-remote-activation.test.js

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const { closeRedisConnections } = require('../../src/config/redis');

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

// The transport answers either as JSON or as an SSE frame depending on
// negotiation; mirror the parser the other MCP route tests use.
function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const dataLine = String(res.text || '').split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : res.text);
}

// A FRESH org per scenario. The two milestones are once-per-user by design, and
// the start_session dedup marker is keyed by org — separate fixtures keep each
// scenario honest without depending on ordering or on Redis being present.
async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Activation ${label}`, 'active'],
    orgId
  );
  const passHash = await hashPassword('password123');
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, passHash, 'admin', orgId],
    orgId
  );
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, `Activation key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
    orgId
  );
  return { orgId, userId, apiKey: key };
}

async function cleanupOrgFixture({ orgId }) {
  // context_* tables are keyed by owner_key (the actor's org), not org_id.
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], orgId).catch(() => {});
  for (const table of ['product_events', 'api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

function startSession(apiKey) {
  return request(httpServer)
    .post('/mcp')
    .set(MCP_HEADERS)
    .set('x-api-key', apiKey)
    .send(rpc('tools/call', { name: 'start_session', arguments: {} }, 1));
}

async function eventCounts(orgId) {
  const { rows } = await db.query(
    'SELECT event_name, COUNT(*)::int AS c FROM product_events WHERE org_id = $1 GROUP BY event_name',
    [orgId],
    orgId
  );
  return Object.fromEntries(rows.map((r) => [r.event_name, r.c]));
}

// The emitters are fire-and-forget by design (telemetry must never add latency
// to a tool call), so the rows land shortly AFTER the HTTP response. Poll for
// what we expect; for absence assertions, poll to the deadline so a slow write
// cannot masquerade as a correct absence.
async function waitForEvents(orgId, required, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let counts = {};
  for (;;) {
    counts = await eventCounts(orgId);
    if (required.every((name) => (counts[name] || 0) > 0)) return counts;
    if (Date.now() >= deadline) return counts;
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('hosted start_session on a real workspace records the activation', async (t) => {
  const fx = await createOrgFixture('seeded');
  t.after(() => cleanupOrgFixture(fx));

  // Give the workspace something real to return, so start_session takes the
  // delivering branch rather than the empty-workspace one.
  const created = await request(httpServer)
    .post('/api/v1/context/projects')
    .set('x-api-key', fx.apiKey)
    .send({
      project_name: 'Hosted Activation Workspace',
      description: 'Context that a hosted session should receive',
      goals: ['Prove the hosted path emits activation'],
    });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));

  const res = await startSession(fx.apiKey);
  assert.strictEqual(res.status, 200, res.text);
  const payload = parseRpc(res);
  assert.ok(!payload.error, `start_session errored: ${JSON.stringify(payload.error)}`);

  const counts = await waitForEvents(fx.orgId, ['context_delivered', 'first_sync_completed', 'connection_established']);

  assert.ok(
    (counts.context_delivered || 0) > 0,
    `hosted delivery must record context_delivered — saw ${JSON.stringify(counts)}`
  );
  assert.ok(
    (counts.first_sync_completed || 0) > 0,
    `THE BUG: a hosted session delivered context and never activated — saw ${JSON.stringify(counts)}`
  );
  assert.ok((counts.connection_established || 0) > 0, 'the connection itself is recorded too');

  // Attribution has to reach the human, not just the org: the rest of the funnel
  // (select_plan_viewed → checkout_started → purchase_completed) is user-keyed,
  // so an org-only activation would never join to them.
  const { rows } = await db.query(
    'SELECT user_id, surface FROM product_events WHERE org_id = $1 AND event_name = \'first_sync_completed\'',
    [fx.orgId],
    fx.orgId
  );
  assert.strictEqual(rows.length, 1, 'exactly one activation');
  assert.strictEqual(rows[0].user_id, fx.userId, 'attributed to the key owner, not just the org');
});

test('an empty hosted workspace records the connection but never claims a sync', async (t) => {
  const fx = await createOrgFixture('empty');
  t.after(() => cleanupOrgFixture(fx));

  const res = await startSession(fx.apiKey);
  assert.strictEqual(res.status, 200, res.text);
  const payload = parseRpc(res);
  assert.ok(!payload.error, `start_session errored: ${JSON.stringify(payload.error)}`);

  // Poll to the deadline: connection_established is expected, so reaching it
  // proves the emitters ran at all and that the absences below are real.
  const counts = await waitForEvents(fx.orgId, ['connection_established']);

  assert.ok((counts.connection_established || 0) > 0, 'the tool reached us and got a real answer');
  assert.strictEqual(
    counts.first_sync_completed || 0,
    0,
    'nothing was delivered, so nothing was synced — a false activation hides the real funnel'
  );
  assert.strictEqual(counts.context_delivered || 0, 0, 'an empty workspace delivered no context');
});

test('a second hosted session never double-counts the activation', async (t) => {
  const fx = await createOrgFixture('repeat');
  t.after(() => cleanupOrgFixture(fx));

  const created = await request(httpServer)
    .post('/api/v1/context/projects')
    .set('x-api-key', fx.apiKey)
    .send({ project_name: 'Repeat Session Workspace', goals: ['Stay idempotent'] });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));

  await startSession(fx.apiKey);
  await waitForEvents(fx.orgId, ['first_sync_completed']);
  await startSession(fx.apiKey);
  await new Promise((r) => setTimeout(r, 1200));

  const counts = await eventCounts(fx.orgId);
  assert.strictEqual(counts.first_sync_completed, 1, 'first sync is once per user, forever');
  assert.strictEqual(counts.connection_established, 1, 'so is the connection marker');
});

test.after(async () => {
  await closeRedisConnections().catch(() => {});
});
