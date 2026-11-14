/**
 * ROUND-11 SCAN: HOSTED MCP USAGE, PROVEN THROUGH /mcp AND A READ-BACK.
 *
 * Every test drives the hosted connector the way a web client does and then
 * reads the stored row (or the audit log) — never the tool's own success string,
 * which reported success over each of these defects.
 *
 *   1. manage_projects select WITH workspace_key wrote a pointer row hosted
 *      resolution never reads; the next id-less write landed in the project the
 *      connection was on before.
 *   2. export_trail's archive was walked by sanitizeToolResult: tech_stack (a
 *      SENSITIVE_KEY substring hit) and every card past the 100th were dropped,
 *      so importing it failed its checksum.
 *   3. A summary could never set current_task on hosted.
 *   4. Completing a card at the Done cap evicted the oldest Done card silently,
 *      and board completions never reached `shipped`.
 *   7. "No active project" and a refused upsert_entities came back as
 *      internal_error "could not be completed"; a CJK entity summary was
 *      refused as too generic.
 *   8. The client's hostname / cwd became durable graph entities.
 *  10. Hosted MCP audit rows carried no actor_user_id.
 *
 * Needs the DB harness:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan11-hosted-mcp-usage.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const realAxios = require('axios');
const originalLoad = Module._load;

const savedApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'sk-test-scan11-hosted-usage';

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
  await db.query('INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)', [orgId, `Scan11 ${label}`, 'active'], orgId);
  await db.query('INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId], orgId);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [`key-${uuidv4()}`, prefix, hash, `Scan11 key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
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

// ─── 1 ───────────────────────────────────────────────────────────────────────

for (const route of ['/mcp', '/mcp/claude']) {
  test(`select WITH workspace_key points this connection at the project (${route})`, async (t) => {
    const fx = await createOrgFixture('select-ws');
    t.after(() => cleanupOrgFixture(fx));
    const a = (await call(fx.apiKey, 'manage_projects', { action: 'create', project_name: `Alpha ${uuidv4().slice(0, 6)}` }, route)).structured.project_id;
    const b = (await call(fx.apiKey, 'manage_projects', { action: 'create', project_name: `Beta ${uuidv4().slice(0, 6)}` }, route)).structured.project_id;

    const sel = await call(fx.apiKey, 'manage_projects', { action: 'select', project_id: a, workspace_key: 'github.com/acme/alpha' }, route);
    assert.ok(!sel.isError, sel.text);

    const marker = `MARKER-${uuidv4().slice(0, 8)}`;
    const upd = await call(fx.apiKey, 'manage_memory', { action: 'update', summary: `Decision ${marker}: use Redis streams for the queue.` }, route);
    assert.ok(!upd.isError, upd.text);

    const inA = JSON.stringify((await readBack(fx, a)).context).includes(marker);
    const inB = JSON.stringify((await readBack(fx, b)).context).includes(marker);
    assert.ok(inA, 'THE BUG: after selecting A (with a workspace_key) the next id-less write did not land in A');
    assert.ok(!inB, 'the write landed in the previously bound project');
  });
}

// ─── 2 ───────────────────────────────────────────────────────────────────────

test('an export_trail through /mcp imports cleanly: tech_stack and all 150 cards survive', async (t) => {
  const fx = await createOrgFixture('trail-rt');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Trail Roundtrip ${uuidv4().slice(0, 6)}`);
  const now = new Date().toISOString();
  const cards = Array.from({ length: 150 }, (_, i) => ({
    id: `card-${i}`,
    title: `Roundtrip card ${i}`,
    phase: i % 3 === 0 ? 'done' : 'backlog',
    created_at: now,
    ...(i % 3 === 0 ? { completed_at: now } : {}),
  }));
  await seedContext(fx, projectId, { tech_stack: ['Node.js', 'Postgres', 'Redis'], todo_items: cards });

  const exp = await call(fx.apiKey, 'manage_memory', { action: 'export_trail', project_id: projectId });
  assert.ok(!exp.isError, exp.text);
  const trail = exp.structured?.trail;
  assert.ok(trail && typeof trail === 'object', 'no archive in structuredContent');
  assert.deepStrictEqual(trail.content?.brief?.tech_stack, ['Node.js', 'Postgres', 'Redis'], 'tech_stack was stripped from the archive');
  assert.strictEqual(trail.content?.board?.cards?.length, 150, 'cards past the 100th were clamped off');

  const imp = await call(fx.apiKey, 'manage_memory', {
    action: 'import_trail', trail: JSON.stringify(trail), new_project_name: `Imported ${uuidv4().slice(0, 6)}`, dry_run: true,
  });
  assert.ok(!imp.isError, `THE BUG: the exported archive does not import: ${imp.text}`);
  assert.doesNotMatch(imp.text, /checksum/i);
});

test('a credential-shaped string in the brief is redacted from the archive, which stays importable', async (t) => {
  const fx = await createOrgFixture('trail-redact');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Trail Redact ${uuidv4().slice(0, 6)}`);
  // The minted shape (dd_<8 hex>_<64 hex>). This used to be any `dd_` + 36
  // characters, which only the hosted mask's old `dd_` + 16 guess caught — the
  // guess that also rewrote Datadog identifiers (dd_trace_id_propagation) in
  // every reply, replaced by the exact shapes in round 14.
  const secret = `dd_${'a1b2c3d4'}_${'e5f6a7b8'.repeat(8)}`;
  await seedContext(fx, projectId, { current_status: `Rotated the key ${secret} yesterday` });

  const exp = await call(fx.apiKey, 'manage_memory', { action: 'export_trail', project_id: projectId });
  assert.ok(!exp.isError, exp.text);
  assert.ok(!JSON.stringify(exp.body).includes(secret), 'a dd_ key left the server inside the archive');
  const imp = await call(fx.apiKey, 'manage_memory', {
    action: 'import_trail', trail: JSON.stringify(exp.structured.trail), new_project_name: `Redacted ${uuidv4().slice(0, 6)}`, dry_run: true,
  });
  assert.ok(!imp.isError, `a redacted archive must be re-sealed so it still imports: ${imp.text}`);
});

// ─── 3 ───────────────────────────────────────────────────────────────────────

test('a hosted summary can set current_task when no task was set explicitly', async (t) => {
  const fx = await createOrgFixture('task-summary');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Gamma Billing ${uuidv4().slice(0, 6)}`);
  const TASK = `Build the invoice PDF renderer ${uuidv4().slice(0, 6)}`;
  providerReply = llmReply({ current_task: TASK });
  try {
    const r = await call(fx.apiKey, 'manage_memory', { action: 'update', project_id: projectId, summary: `Current task: ${TASK}.` });
    assert.ok(!r.isError, r.text);
  } finally {
    providerReply = null;
  }
  assert.strictEqual((await readBack(fx, projectId)).context.current_task, TASK, 'THE BUG: current_task is unreachable through the advertised hosted surface');
});

test('a summary still cannot replace a task somebody set explicitly', async (t) => {
  const fx = await createOrgFixture('task-protected');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Protected Task ${uuidv4().slice(0, 6)}`);
  const TASK = `Cut the release ${uuidv4().slice(0, 6)}`;
  const set = await call(fx.apiKey, 'manage_memory', { action: 'update', project_id: projectId, task: TASK });
  assert.ok(!set.isError, set.text);
  providerReply = llmReply({ current_task: 'Investigate the deployment issues in the pipeline', next_action: 'Read the logs' });
  try {
    await call(fx.apiKey, 'manage_memory', { action: 'update', project_id: projectId, summary: `Deployed and verified the health check ${uuidv4()}` });
  } finally {
    providerReply = null;
  }
  const ctx = (await readBack(fx, projectId)).context;
  assert.strictEqual(ctx.current_task, TASK);
  assert.strictEqual(ctx.next_action || '', '');
});

// ─── 4 ───────────────────────────────────────────────────────────────────────

test('completing a card at the Done cap names the evicted card, and the completion reaches shipped', async (t) => {
  const fx = await createOrgFixture('done-cap');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Done Cap ${uuidv4().slice(0, 6)}`);
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const done = Array.from({ length: 100 }, (_, i) => ({
    id: `done-${i}`,
    title: `Finished card ${i}`,
    phase: 'done',
    created_at: new Date(base + i * 60_000).toISOString(),
    completed_at: new Date(base + i * 60_000).toISOString(),
  }));
  const open = { id: 'open-1', title: 'Wire the retry budget', phase: 'in_progress', created_at: new Date().toISOString() };
  await seedContext(fx, projectId, { todo_items: [...done, open], shipped: [] });

  const r = await call(fx.apiKey, 'manage_tasks', { action: 'complete', project_id: projectId, todos: ['Wire the retry budget'] });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /"Finished card 0"/, `THE BUG: the reply does not name the Done card the cap evicted:\n${r.text}`);
  assert.deepStrictEqual(r.structured.evicted, ['Finished card 0']);

  const ctx = (await readBack(fx, projectId)).context;
  assert.ok(!ctx.todo_items.some((c) => c.id === 'done-0'), 'precondition: the oldest completion was evicted');
  assert.ok(ctx.todo_items.some((c) => c.id === 'open-1' && c.phase === 'done'));
  assert.ok((ctx.shipped || []).some((s) => s.summary === 'Wire the retry budget'), 'THE BUG: a board completion never reached shipped');
});

test('a Trail-style add straight into Done does not flood shipped', async (t) => {
  const fx = await createOrgFixture('done-add');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Done Add ${uuidv4().slice(0, 6)}`);
  const r = await call(fx.apiKey, 'manage_tasks', { action: 'add', project_id: projectId, cards: [{ title: 'Historic completed thing', phase: 'done' }] });
  assert.ok(!r.isError, r.text);
  const ctx = (await readBack(fx, projectId)).context;
  assert.ok(ctx.todo_items.some((c) => c.title === 'Historic completed thing' && c.phase === 'done'));
  assert.deepStrictEqual(ctx.shipped || [], [], 'a card that ARRIVED in Done is a record, not a completion');
});

// ─── 7 ───────────────────────────────────────────────────────────────────────

test('manage_tasks with no active project says what to do, not "could not be completed"', async (t) => {
  const fx = await createOrgFixture('noproj');
  t.after(() => cleanupOrgFixture(fx));
  for (const args of [{ action: 'add', todos: ['x'] }, { action: 'list' }]) {
    const r = await call(fx.apiKey, 'manage_tasks', args);
    assert.ok(r.isError);
    assert.doesNotMatch(r.text, /could not be completed|internal_error/, `THE BUG: masked as internal_error: ${r.text}`);
    assert.match(r.text, /No active project/);
  }
});

test('a refused upsert_entities surfaces its reason, and a CJK summary is not "too generic"', async (t) => {
  const fx = await createOrgFixture('entities');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Entities ${uuidv4().slice(0, 6)}`);

  const generic = await call(fx.apiKey, 'manage_memory', { action: 'upsert_entities', entities: [{ title: 'Billing svc', entity_type: 'service', summary: 'svc' }] });
  assert.ok(generic.isError);
  assert.match(generic.text, /too generic/, `THE BUG: the refusal reason was masked: ${generic.text}`);
  assert.doesNotMatch(generic.text, /internal_error/);

  const cjk = await call(fx.apiKey, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ title: '認証サービス', entity_type: 'service', summary: '日本語の認証サービス', scope: 'project', project_id: projectId }],
  });
  assert.ok(!cjk.isError, `THE BUG: a specific Japanese summary was refused: ${cjk.text}`);
});

// ─── 8 ───────────────────────────────────────────────────────────────────────

test('the client hostname and cwd are not minted into graph entities', async (t) => {
  const fx = await createOrgFixture('host-entity');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Host Entity ${uuidv4().slice(0, 6)}`);
  const HOST = `mac-${uuidv4().slice(0, 6)}.scan11.example.edu`;
  providerReply = llmReply({ current_status: `Working on the parser rewrite ${uuidv4().slice(0, 6)}`, tech_stack: ['Rust'] });
  try {
    const res = await request(httpServer)
      .post('/api/v1/context/extraction')
      .set('x-api-key', fx.apiKey)
      .send({
        session_id: `sess-${uuidv4()}`,
        tool: 'claude_code',
        project_id: projectId,
        chunks: [{ role: 'user', text: `Rewrote the parser in Rust today. ${uuidv4()}` }],
        session_context: { surface_type: 'cli', status: 'active', host: HOST, cwd: '/Users/someone/private-project' },
      });
    assert.ok([200, 202].includes(res.status), res.text);
  } finally {
    providerReply = null;
  }
  // Graph writes may trail the response; give them a moment, and prove they ran.
  let nodes = [];
  for (let i = 0; i < 20; i += 1) {
    nodes = (await db.query('SELECT node_type, title, summary FROM context_graph_nodes WHERE owner_key = $1', [fx.orgId], fx.orgId)).rows;
    if (nodes.some((n) => n.title === 'Rust')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(nodes.some((n) => n.title === 'Rust'), `precondition: graph artifacts were recorded (${JSON.stringify(nodes)})`);
  assert.ok(!nodes.some((n) => n.title === HOST || String(n.summary).includes('Browser host')), `THE BUG: the hostname became an entity: ${JSON.stringify(nodes)}`);
  assert.ok(!nodes.some((n) => String(n.summary).includes('/Users/someone')), 'a home path became an entity');
});

// ─── 10 ──────────────────────────────────────────────────────────────────────

test('hosted MCP audit rows name the person who wrote', async (t) => {
  const fx = await createOrgFixture('audit');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createViaMcp(fx, `Audit ${uuidv4().slice(0, 6)}`);
  await call(fx.apiKey, 'manage_memory', { action: 'record_finding', project_id: projectId, summary: `Found the retry storm ${uuidv4()}` });
  const rows = (await db.query(
    'SELECT actor_user_id FROM context_audit_logs WHERE owner_key = $1 AND action = \'mcp_tool_write\'',
    [fx.orgId], fx.orgId,
  )).rows;
  assert.ok(rows.length > 0, 'precondition: the write was audited');
  assert.ok(rows.every((row) => row.actor_user_id === fx.userId), `THE BUG: unattributed audit rows: ${JSON.stringify(rows)}`);
});
