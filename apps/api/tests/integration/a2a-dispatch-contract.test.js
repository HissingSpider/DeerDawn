/**
 * THE A2A BINDING RUNS THE SAME CALL THE MCP BINDING DOES.
 *
 * a2a.js called the tool dispatcher directly, so an A2A call skipped argument
 * validation, the tool timeout, result sanitising, the write audit and call
 * recording. Its record-memory-update skill also sent `tool: 'a2a'`, which is
 * not a member of the session schema's tool enum: the write was rejected AFTER
 * extraction had run, so every A2A memory update paid for a model call and
 * stored nothing.
 *
 * Dispatch-level, against the real app and a real row: send a message, read the
 * brief back.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/a2a-dispatch-contract.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const realAxios = require('axios');
const originalLoad = Module._load;

const savedApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'sk-test-a2a-stub';

// Set by each test. null => the provider errors.
let providerReply = null;
const providerRequests = [];

const EXTRACTION_PATHS = ['/v1/chat/completions', '/v1/messages'];
const isExtractionUrl = (url) => typeof url === 'string' && EXTRACTION_PATHS.some((p) => url.endsWith(p));

const axiosStub = {
  ...realAxios,
  post: async (url, body, config) => {
    if (isExtractionUrl(url)) {
      providerRequests.push(body);
      if (!providerReply) throw new Error('provider unavailable (test stub)');
      return providerReply(body);
    }
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
const { hashPassword, generateApiKey } = require('../../src/utils/security');

const httpServer = app.listen(0);
test.after(() => {
  Module._load = originalLoad;
  if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedApiKey;
  return new Promise((resolve) => httpServer.close(resolve));
});


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
            no_material_change: false,
            ...overrides,
          }),
        },
      }],
    },
  });
}

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
  const { key, prefix, hash } = generateApiKey();

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Explicit ${label}`, 'active'],
    orgId
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId
  );
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [`key-${uuidv4()}`, prefix, hash, `Explicit key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
    orgId
  );
  return { orgId, userId, apiKey: key };
}

async function cleanupOrgFixture({ orgId }) {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [orgId], orgId).catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], orgId).catch(() => {});
  for (const table of ['product_events', 'api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

async function createProject(apiKey, name, extra = {}) {
  const res = await request(httpServer)
    .post('/api/v1/context/projects')
    .set('x-api-key', apiKey)
    .send({ project_name: name, description: 'A project that already exists', goals: ['Prove writes land'], ...extra });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.project.project_id;
}

async function readBack(fixture, projectId) {
  const project = await store.getProject(fixture.orgId, projectId);
  assert.ok(project, 'project row vanished');
  return project.context || {};
}


function a2a(apiKey, data, text) {
  const parts = [{ data }];
  if (text) parts.push({ text });
  return request(httpServer)
    .post('/a2a/v1')
    .set('x-api-key', apiKey)
    .send({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: uuidv4(), role: 'ROLE_USER', parts } } });
}

function replyText(res) {
  return JSON.stringify(res.body?.result ?? res.body);
}

test('an A2A memory update is stored and can be read back', async (t) => {
  const fx = await createOrgFixture('a2a-write');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'A2A Write Project');

  const MARKER = `A2A-SENTENCE-${uuidv4().slice(0, 8)}`;
  providerReply = llmReply({ current_status: 'Recorded over A2A.' });
  const res = await a2a(fx.apiKey, { skill: 'record-memory-update', projectId }, `Agent handoff: the ingest worker is on v3 now. ${MARKER}`);
  assert.equal(res.status, 200, res.text);
  assert.ok(!res.body.error, `THE BUG: the A2A write was rejected: ${JSON.stringify(res.body.error)}`);

  const stored = JSON.stringify(await readBack(fx, projectId));
  assert.ok(stored.includes(MARKER), `THE BUG: an A2A memory update stored nothing. Reply: ${replyText(res).slice(0, 300)}`);

  // And it can be read back through A2A itself.
  const read = await a2a(fx.apiKey, { skill: 'load-project-brief', projectId, sections: ['decisions'] });
  assert.ok(replyText(read).includes(MARKER));
});

test('an A2A write is audited like an MCP write', async (t) => {
  const fx = await createOrgFixture('a2a-audit');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'A2A Audit Project');

  providerReply = llmReply({});
  await a2a(fx.apiKey, { skill: 'record-memory-update', projectId }, `Audited A2A write ${uuidv4()}`);

  const audit = await db.query(
    'SELECT action, tool FROM context_audit_logs WHERE owner_key = $1 AND action = $2',
    [fx.orgId, 'mcp_tool_write'],
    'org-system',
  );
  assert.ok(
    audit.rows.some((row) => row.tool === 'update_context'),
    'THE BUG: an A2A write left no audit row; the MCP binding writes one for the same call',
  );
});

test('A2A arguments are validated before anything is spent on them', async (t) => {
  const fx = await createOrgFixture('a2a-validate');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'A2A Validate Project');

  providerRequests.length = 0;
  providerReply = llmReply({});
  // limit is a number in the tool's schema; a string must be refused as the
  // caller's mistake, not passed through to the handler.
  const res = await a2a(fx.apiKey, { skill: 'search-memory', query: 'ingest worker', limit: 'lots', projectId });
  assert.ok(res.body.error || /invalid|not a|must be/i.test(replyText(res)), `unvalidated arguments reached the tool: ${replyText(res).slice(0, 300)}`);
  assert.equal(providerRequests.length, 0);
});

test('read-task-board can open a card body over A2A', async (t) => {
  const fx = await createOrgFixture('a2a-board');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'A2A Board Project');

  const BODY = `Acceptance: retries capped at three. BODYMARK-${uuidv4().slice(0, 8)}`;
  const added = await request(httpServer)
    .post('/api/v1/context/events')
    .set('x-api-key', fx.apiKey)
    .send({ event_type: 'todo_added', project_id: projectId, summary: 'Cap the retries', metadata: { todos: [{ title: 'Cap the retries', body: BODY }] } });
  assert.ok([200, 201, 202].includes(added.status), added.text);

  const listing = await a2a(fx.apiKey, { skill: 'read-task-board', projectId });
  assert.ok(replyText(listing).includes('Cap the retries'));
  assert.ok(!replyText(listing).includes(BODY), 'a plain listing should not carry bodies');

  const opened = await a2a(fx.apiKey, { skill: 'read-task-board', projectId, todos: ['Cap the retries'] });
  assert.ok(replyText(opened).includes(BODY), 'THE BUG: A2A dropped `todos`, so a card body could never be opened');
});
