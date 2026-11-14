/**
 * ROUND-13 SCAN: DEERDAWN'S OWN CREDENTIALS, THROUGH THE REAL ROUTES.
 *
 *   1. A live API key (`dd_<8 hex>_<64 hex>`) or refresh token (`ddr_<64 hex>`)
 *      written into a summary or a finding was stored verbatim and served back
 *      by /active (SessionStart injects it), /inject, recall and the Trail
 *      export. The Trail preview reported 0 findings and publish answered 200
 *      with the key inside.
 *   2. Credential-NAMED metadata keys (api_key, privateKey, credentials, …)
 *      left the server in export_trail.
 *   3. Since #530, export_trail redacted every ordinary `stack` value
 *      ("Fastify") because the substring `stack` was a sensitive key, so the MCP
 *      archive disagreed with the REST one.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/scan13-deerdawn-credentials.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const realAxios = require('axios');
const originalLoad = Module._load;

const savedApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'sk-test-scan13-creds';

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
  await db.query('INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)', [orgId, `Scan13 ${label}`, 'active'], orgId);
  await db.query('INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId], orgId);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [`key-${uuidv4()}`, prefix, hash, `Scan13 key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
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



// A LEGACY row: written before storage redaction existed (or imported around
// it). store.saveProject now masks every string it persists, so seedContext can
// no longer plant a live key, and the publish gate below would be tested
// against content that carries nothing. This writes the column directly — the
// way a pre-round-13 row sits in the table — encrypting when the store would.
async function seedLegacyContext(fx, projectId, patch) {
  const project = await readBack(fx, projectId);
  let context = { ...project.context, ...patch };
  const encryption = require('../../src/services/encryptionService');
  if (encryption.shouldEncrypt({ id: fx.userId, org_id: fx.orgId })) {
    context = await encryption.encryptContextObject(project.owner_key, context);
  }
  await db.query(
    'UPDATE context_projects SET context = $2::jsonb WHERE project_id = $1',
    [projectId, JSON.stringify(context)],
    'org-system',
  );
}

function mintRefreshToken() {
  return `ddr_${require('crypto').randomBytes(32).toString('hex')}`; // exactly as routes/oauth.js mints it
}

function assertNoCredential(label, payload, secrets) {
  const wire = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const secret of secrets) {
    assert.ok(!wire.includes(secret), `THE BUG: ${label} served ${secret.slice(0, 4)}…: ${wire.slice(0, 400)}`);
    assert.ok(!wire.includes(secret.slice(-40)), `${label} served part of ${secret.slice(0, 4)}…`);
  }
}

// ─── 1: storage ──────────────────────────────────────────────────────────────

test('a live API key and refresh token in a summary are stored and served redacted', async (t) => {
  const fx = await createOrgFixture('ddcreds');
  t.after(() => cleanupOrgFixture(fx));
  const name = `DD Creds ${uuidv4().slice(0, 6)}`;
  const projectId = await createViaMcp(fx, name);
  await call(fx.apiKey, 'manage_projects', { action: 'select', project_id: projectId });
  const KEY = fx.apiKey; // the account's own, freshly minted by generateApiKey
  const RT = mintRefreshToken();

  // The summary itself is what the hosted update stores as the brief's newest
  // decision (the explicit-update floor, through the storage redactor). The
  // extraction returns nothing here, so that floor is the only writer.
  //
  // NOT covered by this file, because the storage redactor is never CALLED on
  // them (a contextSyncService gap for every provider's key, not only ours):
  // a debugging note's summary (record_finding), a decision `headline` taken
  // from the model's reply, and the free-text slots current_status /
  // description / current_task; and the knowledge graph (contextGraphService
  // nodes + evidence, auto-promoted workspace entities), built from the raw
  // input. The MCP output mask is the last line for those on hosted MCP; REST
  // /active, /inject and /trail have none.
  providerReply = null;
  const up = await call(fx.apiKey, 'manage_memory', { action: 'update', project_id: projectId, summary: `CI uses the DeerDawn key ${KEY} for the nightly sync; refresh ${RT} was rejected after rotation.` });
  assert.ok(!up.isError, up.text);

  const stored = await readBack(fx, projectId);
  const storedWire = JSON.stringify(stored.context);
  assert.ok(storedWire.includes('for the nightly sync'), 'the summary was stored (the checks below are not vacuous)');
  assertNoCredential('the stored brief', storedWire, [KEY, RT]);

  // The brief's decisions as /inject serves them. (The whole /active, /inject
  // and /trail bodies also carry the knowledge graph, whose nodes and evidence
  // are written from the RAW input without the storage redactor — see the note
  // above; asserting on those bodies here would test that gap, not this fix.)
  const inject = await request(httpServer).get(`/api/v1/context/projects/${projectId}/inject?format=json`).set('x-api-key', fx.apiKey);
  assert.strictEqual(inject.status, 200, inject.text);
  const decisions = (inject.body.context || inject.body).recent_decisions || [];
  assert.ok(decisions.some((d) => String(d.summary).includes('for the nightly sync')), `the brief carries the stored decision: ${inject.text.slice(0, 300)}`);
  assertNoCredential('/inject decisions', decisions, [KEY, RT]);

  const recall = await call(fx.apiKey, 'recall', { action: 'search', project_id: projectId, query: 'rotation' });
  assertNoCredential('recall search', recall.body, [KEY, RT]);

});

// ─── 1: MCP output masking ───────────────────────────────────────────────────

test('a refresh token already sitting in a stored brief does not leave through hosted MCP', async (t) => {
  const fx = await createOrgFixture('ddcreds-output');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Output Mask ${uuidv4().slice(0, 6)}`);
  const RT = mintRefreshToken();
  // Legacy text, written straight to the store: the output mask is the last line.
  await seedContext(fx, projectId, { current_status: `Refresh ${RT} was rejected after rotation.` });
  for (const route of ['/mcp', '/mcp/claude']) {
    const recall = await call(fx.apiKey, 'recall', { action: 'search', project_id: projectId, query: 'rotation' }, route);
    assert.ok(JSON.stringify(recall.body).includes('rejected after rotation'), `recall found the status (${route}): ${recall.text.slice(0, 300)}`);
    assertNoCredential(`recall search (${route})`, recall.body, [RT]);
    const brief = await call(fx.apiKey, 'recall', { action: 'brief', project_id: projectId }, route);
    assertNoCredential(`recall brief (${route})`, brief.body, [RT]);
  }
});

// ─── 1: publish gate ─────────────────────────────────────────────────────────

test('a Trail whose stored content carries a live key previews a finding and publish is refused (422)', async (t) => {
  const fx = await createOrgFixture('ddcreds-publish');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Legacy Key ${uuidv4().slice(0, 6)}`);
  const RT = mintRefreshToken();
  // Content stored before storage redaction knew the shape (or imported): the
  // table is written directly, bypassing store.redactForStorage, which is
  // exactly what legacy rows are.
  await seedLegacyContext(fx, projectId, {
    description: `The nightly job authenticates with ${fx.apiKey} and refreshes with ${RT}.`,
  });

  const preview = await request(httpServer).get(`/api/v1/context/projects/${projectId}/trail/preview`).set('x-api-key', fx.apiKey);
  assert.strictEqual(preview.status, 200, preview.text);
  const credentials = (preview.body.preview?.findings || []).filter((f) => f.category === 'credential');
  assert.ok(credentials.length >= 2, `THE BUG: the preview reported no DeerDawn credential: ${JSON.stringify(preview.body.preview?.counts)}`);
  assertNoCredential('the preview', preview.text, [fx.apiKey, RT]);

  const pub = await request(httpServer).post(`/api/v1/context/projects/${projectId}/trail/publish`).set('x-api-key', fx.apiKey).send({ decisions: {} });
  assert.strictEqual(pub.status, 422, `THE BUG: a Trail carrying a live key published: ${pub.status} ${pub.text.slice(0, 300)}`);
  assert.strictEqual(pub.body.error, 'trail_publish_blocked');
  assertNoCredential('the refusal', pub.text, [fx.apiKey, RT]);
});

// ─── 2 + 3: export_trail key rules ───────────────────────────────────────────

for (const route of ['/mcp', '/mcp/claude']) {
  test(`export_trail withholds credential-named keys and keeps an ordinary stack value (${route})`, async (t) => {
    const fx = await createOrgFixture('ddcreds-keys');
    t.after(() => cleanupOrgFixture(fx));
    const projectId = await createViaMcp(fx, `Key Names ${uuidv4().slice(0, 6)}`);
    const metadata = {
      stack: 'Fastify',
      api_key: 'SENT_api_key',
      apiKey: 'SENT_apiKey',
      private_key: 'SENT_private_key',
      privateKey: 'SENT_privateKey',
      credentials: 'SENT_credentials',
      session_token: 'SENT_session_token',
      bearer: 'SENT_bearer',
      'x-api-key': 'SENT_x_api_key',
      errorStack: 'SENT_errorStack',
      nested: { stackTrace: 'SENT_stackTrace', keyword: 'kept keyword', session: 'kept session', api_key_prefix: 'dd_0a1b2c3d' },
    };
    const up = await request(httpServer)
      .post('/api/v1/context/workspace/entities')
      .set('x-api-key', fx.apiKey)
      .send({ entities: [{ entity_type: 'service', title: 'Sync Worker Service', summary: 'Runs the nightly sync.', scope: 'project', project_id: projectId, metadata }] });
    assert.ok(up.status < 300, `entity upsert ${up.status}: ${up.text}`);

    const exp = await call(fx.apiKey, 'manage_memory', { action: 'export_trail', project_id: projectId }, route);
    assert.ok(!exp.isError, exp.text);
    const node = (exp.structured?.trail?.content?.graph?.nodes || []).find((n) => n.title === 'Sync Worker Service');
    assert.ok(node, 'the entity is in the archive');
    const leaked = [...new Set(JSON.stringify(exp.body).match(/SENT_[A-Za-z_]+/g) || [])];
    assert.deepStrictEqual(leaked, [], `THE BUG: credential-named values reached the model: ${leaked.join(', ')}`);
    assert.strictEqual(node.metadata.api_key, '[REDACTED]');
    assert.strictEqual(node.metadata['x-api-key'], '[REDACTED]');
    assert.strictEqual(node.metadata.errorStack, '[REDACTED]');
    assert.strictEqual(node.metadata.nested.stackTrace, '[REDACTED]');
    assert.strictEqual(node.metadata.stack, 'Fastify', 'THE BUG: an ordinary stack value was redacted');
    assert.strictEqual(node.metadata.nested.keyword, 'kept keyword');
    assert.strictEqual(node.metadata.nested.session, 'kept session');
    assert.strictEqual(node.metadata.nested.api_key_prefix, 'dd_0a1b2c3d');

    const rest = await request(httpServer).get(`/api/v1/context/projects/${projectId}/trail`).set('x-api-key', fx.apiKey);
    const restNode = (JSON.parse(rest.text).content.graph?.nodes || []).find((n) => n.title === 'Sync Worker Service');
    assert.strictEqual(restNode?.metadata?.stack, node.metadata.stack, 'the MCP and REST archives agree on stack');

    const imp = await call(fx.apiKey, 'manage_memory', {
      action: 'import_trail', trail: JSON.stringify(exp.structured.trail), new_project_name: `Imported ${uuidv4().slice(0, 6)}`, dry_run: true,
    }, route);
    assert.ok(!imp.isError, `the redacted archive still imports: ${imp.text}`);
  });
}
