const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

/**
 * build_subagent_brief advertises max_tokens as `number` and parsed it as an int.
 *
 * The published type is deliberate: a parameter declared `integer` was refused
 * end to end on the hosted path (see the cards_per_phase note in routes/mcp.js),
 * so this catalog says `number` everywhere. But the request schema in
 * shared-context is z.number().int(), so a caller obeying the advertised type
 * with 250.5 got a Zod parse failure for passing exactly what the schema invited
 * — and got it as the serialized issue array, which a model has to parse as JSON
 * to learn that one number was fractional.
 *
 * Rounded at the handler rather than by changing the published type, because a
 * ChatGPT app review is in flight against a cached scan of tools/list.
 *
 * Needs the DB harness:
 *   bash scripts/run-db-test.sh node --test tests/integration/mcp-subagent-brief-max-tokens.test.js
 */

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const { closeRedisConnections } = require('../../src/config/redis');

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const dataLine = String(res.text || '').split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : res.text);
}

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Brief tokens ${label}`, 'active'],
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
    [keyId, prefix, hash, `Brief key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
    orgId
  );
  return { orgId, apiKey: key };
}

async function cleanupOrgFixture({ orgId }) {
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], orgId).catch(() => {});
  for (const table of ['product_events', 'api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

const api = (apiKey, method, path) => request(httpServer)[method](path).set('X-Api-Key', apiKey);

async function seedProject(apiKey) {
  const created = await api(apiKey, 'post', '/api/v1/context/projects')
    .send({ project_name: `Brief tokens ${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
  assert.strictEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const projectId = (created.body.project || {}).project_id || created.body.project_id;
  const patched = await api(apiKey, 'patch', `/api/v1/context/projects/${projectId}/context`)
    .send({ current_task: 'Harden the hosted dispatcher' });
  assert.strictEqual(patched.status, 200, `patch failed: ${JSON.stringify(patched.body)}`);
  return projectId;
}

function callTool(apiKey, name, args, id = 1) {
  return request(httpServer)
    .post('/mcp')
    .set(MCP_HEADERS)
    .set('x-api-key', apiKey)
    .send(rpc('tools/call', { name, arguments: args }, id));
}

test('a fractional max_tokens is rounded, not refused with raw Zod JSON', async (t) => {
  const fixture = await createOrgFixture('fractional');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const projectId = await seedProject(fixture.apiKey);

  const body = parseRpc(await callTool(fixture.apiKey, 'build_subagent_brief', {
    project_id: projectId,
    task: 'Review the task board reply path',
    max_tokens: 250.5,
  }));
  const payload = JSON.stringify(body);
  assert.ok(!/invalid_type/.test(payload), `a raw Zod issue array reached the caller: ${payload.slice(0, 300)}`);
  assert.ok(!body.error, `tools/call errored: ${JSON.stringify(body.error)}`);
  assert.strictEqual(body.result?.structuredContent?.max_tokens, 251, 'the advertised number is rounded to the int the schema wants');
});

test('a whole max_tokens is still honoured exactly', async (t) => {
  const fixture = await createOrgFixture('whole');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const projectId = await seedProject(fixture.apiKey);

  const body = parseRpc(await callTool(fixture.apiKey, 'build_subagent_brief', {
    project_id: projectId,
    task: 'Review the task board reply path',
    max_tokens: 400,
  }));
  assert.ok(!body.error, `tools/call errored: ${JSON.stringify(body.error)}`);
  assert.strictEqual(body.result?.structuredContent?.max_tokens, 400);
});
