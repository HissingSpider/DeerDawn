/**
 * ROUND-12 SCAN: TWO REGRESSIONS FROM #525's TRAIL CHANGES, PROVEN THROUGH /mcp
 * (and the REST import) WITH A READ-BACK.
 *
 *   3. export_trail's archive is sealed out of sanitizeToolResult, and the
 *      redactDeep that replaced the clamp only rewrote values that LOOK like a
 *      credential. Plain text under password / apiSecret / stackTrace /
 *      debugLog / apilog reached the model, where the clamp had dropped them.
 *   4. A kind:project import lands Done cards in Done (#525), but add_todos
 *      stamped each one completed_at = now. The Done cap keeps the most
 *      recently completed, so importing 50 old completions into a full Done
 *      column evicted 50 of the importer's REAL ones, and the import said
 *      nothing.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/scan12-trail-secrets-and-done-cap.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const realAxios = require('axios');
const originalLoad = Module._load;

const savedApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'sk-test-scan12-trail';

// Set by each test. null => an empty, no-change extraction.
let providerReply = null;
const EXTRACTION_PATHS = ['/v1/chat/completions', '/v1/messages'];
const isExtractionUrl = (url) => typeof url === 'string' && EXTRACTION_PATHS.some((p) => url.endsWith(p));

function llmReply(delta, overrides = {}) {
  return () => ({
    data: {
      choices: [{
        message: {
          content: JSON.stringify({
            match_decision: 'matched_existing',
            confidence: 0.92,
            delta,
            should_create_project: false,
            needs_user_confirmation: false,
            no_material_change: !delta || !Object.keys(delta).length,
            ...overrides,
          }),
        },
      }],
    },
  });
}

const axiosStub = {
  ...realAxios,
  post: async (url, body, config) => {
    if (isExtractionUrl(url)) return (providerReply || llmReply({}))(body);
    return realAxios.post(url, body, config);
  },
};

Module._load = function (request, _parent, _isMain) {
  if (request === 'axios') return axiosStub;
  return originalLoad.apply(this, arguments);
};

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');
const db = require('../../src/config/db');
const store = require('../../src/store/contextSyncStore');
const { generateApiKey, hashPassword } = require('../../src/utils/security');

const httpServer = app.listen(0);
test.after(() => {
  Module._load = originalLoad;
  if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedApiKey;
  return new Promise((resolve) => httpServer.close(resolve));
});

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
let rpcId = 1;

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const dataLine = String(res.text || '').split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : res.text);
}

async function call(apiKey, name, args, route = '/mcp') {
  const res = await request(httpServer)
    .post(route)
    .set(MCP_HEADERS)
    .set('x-api-key', apiKey)
    .send({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
  assert.strictEqual(res.status, 200, res.text);
  const body = parseRpc(res);
  const text = body?.result?.content?.map((c) => c.text).join('\n') || body?.error?.message || '';
  return { body, text, isError: Boolean(body?.error || body?.result?.isError), structured: body?.result?.structuredContent };
}

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
  const { key, prefix, hash } = generateApiKey();
  await db.query('INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)', [orgId, `Scan12 ${label}`, 'active'], orgId);
  await db.query('INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId], orgId);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [`key-${uuidv4()}`, prefix, hash, `Scan12 key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
    orgId,
  );
  return { orgId, userId, apiKey: key };
}

async function cleanupOrgFixture({ orgId }) {
  for (const table of ['context_graph_edges', 'context_graph_evidence', 'context_graph_nodes', 'context_audit_logs', 'context_sessions', 'context_projects']) {
    await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [orgId], orgId).catch(() => {});
  }
  for (const table of ['product_events', 'api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

async function createViaMcp(fx, name) {
  const r = await call(fx.apiKey, 'manage_projects', { action: 'create', project_name: name });
  assert.ok(!r.isError, r.text);
  return r.structured.project_id;
}

async function readBack(fx, projectId) {
  const project = await store.getProject(fx.orgId, projectId);
  assert.ok(project, 'project row vanished');
  return project;
}

async function seedContext(fx, projectId, patch) {
  const project = await readBack(fx, projectId);
  project.context = { ...project.context, ...patch };
  await store.saveProject(project, { id: fx.userId, org_id: fx.orgId });
}


// ─── 3 ───────────────────────────────────────────────────────────────────────

const SECRET_METADATA = {
  importance: 'high',
  password: 'SENT_password',
  apiSecret: 'SENT_apiSecret',
  stackTrace: 'SENT_stackTrace',
  errorStack: 'SENT_errorStack',
  apiLog: 'SENT_apiLog',
  token_log: 'SENT_token_log',
  debugLog: 'SENT_debugLog',
  apilog: 'SENT_apilog',
  debuglog: 'SENT_debuglog',
  accesslog: 'SENT_accesslog',
  nested: { request_log: 'SENT_request_log', changelog: 'kept changelog', catalog: 'kept catalog' },
};

for (const route of ['/mcp', '/mcp/claude']) {
  test(`export_trail withholds values under sensitive metadata keys, and the archive still imports (${route})`, async (t) => {
    const fx = await createOrgFixture('trail-secrets');
    t.after(() => cleanupOrgFixture(fx));
    const projectId = await createViaMcp(fx, `Trail Secrets ${uuidv4().slice(0, 6)}`);
    const up = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('x-api-key', fx.apiKey)
      .send({ entities: [{ entity_type: 'service', title: 'Payment Gateway Service', summary: 'Card payments through the gateway.', scope: 'project', project_id: projectId, metadata: SECRET_METADATA }] });
    assert.ok(up.status < 300, `entity upsert ${up.status}: ${up.text}`);

    const exp = await call(fx.apiKey, 'manage_memory', { action: 'export_trail', project_id: projectId }, route);
    assert.ok(!exp.isError, exp.text);
    const node = (exp.structured?.trail?.content?.graph?.nodes || []).find((n) => n.title === 'Payment Gateway Service');
    assert.ok(node, 'the entity is in the archive');
    const wire = JSON.stringify(exp.body);
    const leaked = [...new Set(wire.match(/SENT_[A-Za-z_]+/g) || [])];
    assert.deepStrictEqual(leaked, [], `THE BUG: sensitive-keyed values reached the model: ${leaked.join(', ')}`);
    // The shape is stable: keys stay, values are withheld, data keys survive.
    assert.strictEqual(node.metadata.password, '[REDACTED]');
    assert.strictEqual(node.metadata.apilog, '[REDACTED]');
    assert.strictEqual(node.metadata.nested.request_log, '[REDACTED]');
    assert.strictEqual(node.metadata.nested.changelog, 'kept changelog');
    assert.strictEqual(node.metadata.nested.catalog, 'kept catalog');
    assert.strictEqual(node.metadata.importance, 'high');

    const imp = await call(fx.apiKey, 'manage_memory', {
      action: 'import_trail', trail: JSON.stringify(exp.structured.trail), new_project_name: `Imported ${uuidv4().slice(0, 6)}`,
    }, route);
    assert.ok(!imp.isError, `the redacted archive must be re-sealed so it still imports: ${imp.text}`);
    assert.doesNotMatch(imp.text, /checksum/i);
  });
}

// ─── 4 ───────────────────────────────────────────────────────────────────────

const OLD = Date.parse('2025-01-01T00:00:00.000Z');

async function sourceTrailWithOldDone(fx, count) {
  const src = await createViaMcp(fx, `History ${uuidv4().slice(0, 6)}`);
  const cards = Array.from({ length: count }, (_, i) => ({
    id: `hist-${i}`,
    title: `Imported history card ${i}`,
    phase: 'done',
    created_at: new Date(OLD + i * 60_000).toISOString(),
    completed_at: new Date(OLD + i * 60_000).toISOString(),
  }));
  await seedContext(fx, src, { todo_items: cards });
  const exp = await call(fx.apiKey, 'manage_memory', { action: 'export_trail', project_id: src });
  assert.ok(!exp.isError, exp.text);
  return exp.structured.trail;
}

async function destinationWithFullDone(fx, count = 100) {
  const dst = await createViaMcp(fx, `Real Work ${uuidv4().slice(0, 6)}`);
  const recent = Date.now() - count * 60_000;
  const cards = Array.from({ length: count }, (_, i) => ({
    id: `mine-${i}`,
    title: `My real completion ${i}`,
    phase: 'done',
    created_at: new Date(recent + i * 60_000).toISOString(),
    completed_at: new Date(recent + i * 60_000).toISOString(),
  }));
  await seedContext(fx, dst, { todo_items: cards });
  return dst;
}

function doneTitles(project) {
  return (project.context?.todo_items || []).filter((c) => c.phase === 'done').map((c) => c.title);
}

test('importing older Done history into a full Done column keeps every real completion, and says what was dropped (MCP)', async (t) => {
  const fx = await createOrgFixture('trail-donecap');
  t.after(() => cleanupOrgFixture(fx));
  const trail = await sourceTrailWithOldDone(fx, 50);
  const dst = await destinationWithFullDone(fx);

  const imp = await call(fx.apiKey, 'manage_memory', { action: 'import_trail', trail: JSON.stringify(trail), project_id: dst });
  assert.ok(!imp.isError, imp.text);

  const done = doneTitles(await readBack(fx, dst));
  const mine = done.filter((title) => title.startsWith('My real completion'));
  assert.strictEqual(mine.length, 100, `THE BUG: the import evicted ${100 - mine.length} of the importer's own completions`);
  assert.strictEqual(done.length, 100, 'the Done cap still holds');
  assert.match(imp.text, /50 cards did not stay on it/, `the reply must say what the cap dropped: ${imp.text}`);
  assert.strictEqual(imp.structured?.evicted_cards?.length, 50);
  assert.ok(imp.structured.evicted_cards.every((c) => c.title.startsWith('Imported history card')));
});

test('an imported Done card keeps its original completion time (REST import reports evictions too)', async (t) => {
  const fx = await createOrgFixture('trail-donecap-rest');
  t.after(() => cleanupOrgFixture(fx));
  const trail = await sourceTrailWithOldDone(fx, 3);

  const fresh = await request(httpServer).post('/api/v1/context/trail/import').set('x-api-key', fx.apiKey)
    .send({ trail, new_project_name: `Fresh ${uuidv4().slice(0, 6)}` });
  assert.strictEqual(fresh.status, 200, fresh.text);
  const card = (await readBack(fx, fresh.body.project_id)).context.todo_items.find((c) => c.title === 'Imported history card 0');
  assert.strictEqual(card?.phase, 'done');
  assert.strictEqual(card?.completed_at, new Date(OLD).toISOString(), 'the source completion time travels with the card');
  assert.strictEqual(fresh.body.evicted_cards, undefined, 'nothing was evicted, so nothing is reported');

  const dst = await destinationWithFullDone(fx);
  const full = await request(httpServer).post('/api/v1/context/trail/import').set('x-api-key', fx.apiKey)
    .send({ trail, project_id: dst });
  assert.strictEqual(full.status, 200, full.text);
  assert.deepStrictEqual(full.body.evicted_cards.map((c) => c.title).sort(), ['Imported history card 0', 'Imported history card 1', 'Imported history card 2']);
  assert.strictEqual(doneTitles(await readBack(fx, dst)).filter((t2) => t2.startsWith('My real completion')).length, 100);
});
