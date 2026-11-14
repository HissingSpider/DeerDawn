/**
 * THE WRITE PATH, PROVEN BY READING THE ROW BACK.
 *
 * DeerDawn is a memory product, and its signature defect is a write that reports
 * success and stores nothing. Three separate "fixes" to this write path have
 * been recorded as done while still writing nothing, because every one of them
 * was judged on the tool's own success string. A success string is built from
 * the REQUEST. It can lie. The only evidence that counts is re-reading the
 * stored row, so every assertion here goes through contextSyncStore.getProject
 * — the durable row, decrypted, with no rendering layer in between — and every
 * one of them also checks that context.last_updated actually moved.
 *
 * The defect these pin:
 *
 *   extractionService.resolveHeuristicMatch() answers the ROUTING question
 *   ("which project does this belong to?"), and scoreProjectMatch gives +1.4 for
 *   a session already bound to a project — on its own over the 1.25 match
 *   threshold. runExtraction then RETURNED that routing answer as the whole
 *   extraction result: `delta: {}, no_material_change: true`. So for every
 *   session that had ever written once, the model was never called, the delta
 *   was empty by construction, applyExtraction's `mergeChanged` was false, and
 *   the tool still answered "Context updated".
 *
 * A heuristic that knows WHERE something belongs knows nothing about WHETHER
 * there is anything worth storing. Those are two questions and it only answers
 * one of them.
 *
 * Second, independent half: the hosted dispatcher had no floor under extraction
 * at all. The local stdio dispatcher has always followed its extraction call
 * with a deterministic `decision_made` event so the caller's own sentence lands
 * whatever the model does (packages/mcp-server/src/tools/context-sync.ts, in
 * update_context, with a comment saying exactly that). The hosted dispatcher —
 * which is how nearly every real user connects — never gained it, so its entire
 * write depended on an LLM call. A sentence the user explicitly sent must not
 * need a model to be remembered; the no-LLM test below is the one that pins it.
 *
 * Needs the DB harness:
 *   bash scripts/run-db-test.sh node --test tests/integration/context-writeback-readback.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// Stub the extraction provider BEFORE the app loads. The LLM is not the subject
// here — whether the write lands is — so it is made deterministic rather than
// mocked away: requests to the provider URL get a scripted reply, everything
// else falls through to the real axios so nothing else in the app changes.
// ---------------------------------------------------------------------------
const Module = require('module');
const realAxios = require('axios');
const originalLoad = Module._load;

// Set here, not inherited. With no key runExtraction short-circuits before it
// ever reaches the stub, so a suite run without one would pass the no-LLM test
// and silently skip the two that prove the model IS now called — the assertion
// this file exists for would evaporate depending on the operator's shell.
const savedApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'sk-test-writeback-stub';

// Set by each test. null => behave as if the provider errored.
let providerReply = null;
let providerCalls = 0;

// Only the EXTRACTION endpoints, matched on path rather than on host. The host
// alone also catches the embedding call contextSyncService makes on a write, so
// counting by host reported a provider call on a run where extraction had
// already returned without one — and answering it with a chat-shaped body would
// have fed a completion to the embedder.
const EXTRACTION_PATHS = ['/v1/chat/completions', '/v1/messages'];
const isExtractionUrl = (url) => typeof url === 'string' && EXTRACTION_PATHS.some((p) => url.endsWith(p));

const axiosStub = {
  ...realAxios,
  post: async (url, body, config) => {
    if (isExtractionUrl(url)) {
      providerCalls += 1;
      if (!providerReply) throw new Error('provider unavailable (test stub)');
      return providerReply();
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
const { hostedSessionId } = require('../../src/services/hostedSessionIdentity');
const { hashPassword, generateApiKey } = require('../../src/utils/security');

const httpServer = app.listen(0);
test.after(() => {
  Module._load = originalLoad;
  if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedApiKey;
  return new Promise((resolve) => httpServer.close(resolve));
});

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const dataLine = String(res.text || '').split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : res.text);
}

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
    [orgId, `Writeback ${label}`, 'active'],
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
    [`key-${uuidv4()}`, prefix, hash, `Writeback key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
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

async function createProject(apiKey, name) {
  const res = await request(httpServer)
    .post('/api/v1/context/projects')
    .set('x-api-key', apiKey)
    .send({ project_name: name, description: 'A project that already exists', goals: ['Prove writes land'] });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.project.project_id;
}

/**
 * THE PRECONDITION THE BUG NEEDS: a session already bound to the project.
 *
 * Written straight into the store rather than produced by a first tool call,
 * for two reasons. It is the exact state every returning user is in (the
 * hosted session id is derived and permanent, so the second write onwards is
 * always bound), and it keeps each test to ONE extraction call, well clear of
 * the 30s rate guard that would otherwise serve the second call a cached reply
 * and hide whatever the fix did.
 */
async function bindSession(fixture, projectId, tool = 'claude_web') {
  const actor = { id: fixture.userId, org_id: fixture.orgId };
  const sessionId = hostedSessionId(actor, tool);
  const now = new Date().toISOString();
  await store.saveSession({
    session_id: sessionId,
    owner_key: fixture.orgId,
    user_id: fixture.userId,
    tool,
    surface_type: 'browser',
    project_id: projectId,
    conversation_ref: '',
    cwd: '',
    host: '',
    tab_id: '',
    status: 'active',
    routing_state: 'matched',
    match_confidence: 0.9,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });
  return sessionId;
}

/** The stored row, not the tool's account of it. */
async function readBack(fixture, projectId) {
  const project = await store.getProject(fixture.orgId, projectId);
  assert.ok(project, 'project row vanished');
  return project.context || {};
}

function contextMentions(context, needle) {
  return JSON.stringify(context).includes(needle);
}

function hostedUpdate(apiKey, args) {
  return request(httpServer)
    .post('/mcp')
    .set(MCP_HEADERS)
    .set('x-api-key', apiKey)
    .send(rpc('tools/call', { name: 'update_context', arguments: args }, 1));
}

// ---------------------------------------------------------------------------

test('hosted update_context on an already-bound session stores the sentence it was sent', async (t) => {
  const fx = await createOrgFixture('hosted-bound');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Hosted Writeback Project');
  await bindSession(fx, projectId);

  const MARKER = `MARKED-SENTENCE-${uuidv4().slice(0, 8)}`;
  const summary = `Switched the retry budget to three attempts. ${MARKER}`;

  const before = await readBack(fx, projectId);
  assert.ok(!contextMentions(before, MARKER), 'precondition: the marker is not stored yet');

  providerCalls = 0;
  providerReply = llmReply({
    recent_decisions: [{
      summary,
      reasoning: 'Three attempts covers the observed transient rate.',
      decided_at: new Date().toISOString(),
    }],
  });

  const res = await hostedUpdate(fx.apiKey, { project_id: projectId, summary });
  assert.strictEqual(res.status, 200, res.text);
  const payload = parseRpc(res);
  assert.ok(!payload.error, `update_context errored: ${JSON.stringify(payload.error)}`);
  // What the caller is told. Printed rather than asserted on: it is the thing
  // that has lied three times, so it is evidence of nothing and is here only so
  // a failing run shows the claim next to the row that contradicts it.
  const claim = payload.result?.content?.[0]?.text || '';

  // THE BUG, NAMED: the session's prior binding scored 1.4 on its own, the
  // heuristic answered "matched" with an empty delta, and the model was never
  // asked what to store.
  assert.ok(
    providerCalls > 0,
    'THE BUG: the routing heuristic short-circuited extraction — the model was never called, so the delta was empty by construction'
  );

  const after = await readBack(fx, projectId);
  assert.ok(
    contextMentions(after, MARKER),
    `THE BUG: update_context answered ${JSON.stringify(claim)} and stored nothing. Stored context: ${JSON.stringify(after).slice(0, 600)}`
  );
  assert.notStrictEqual(
    after.last_updated,
    before.last_updated,
    'last_updated did not move, so no write reached the row'
  );
});

test('hosted update_context stores the sentence with NO extraction model available', async (t) => {
  const fx = await createOrgFixture('hosted-nollm');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Hosted No-LLM Project');
  await bindSession(fx, projectId);

  const MARKER = `NOLLM-SENTENCE-${uuidv4().slice(0, 8)}`;
  const summary = `Pinned the Fly release to v545 while the console cache clears. ${MARKER}`;

  const before = await readBack(fx, projectId);
  providerCalls = 0;
  providerReply = null; // and if anything did reach the provider, it throws
  // Both no-model branches at once: no key configured at all (runExtraction's
  // earliest return) and a provider that would fail if it were reached.
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  let res;
  try {
    res = await hostedUpdate(fx.apiKey, { project_id: projectId, summary });
  } finally {
    process.env.OPENAI_API_KEY = key;
  }
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(!parseRpc(res).error, 'update_context errored');
  assert.strictEqual(providerCalls, 0, 'no key means no provider call — the write has to land anyway');

  const after = await readBack(fx, projectId);
  assert.ok(
    contextMentions(after, MARKER),
    `A sentence the user explicitly sent must not need an LLM to be remembered. Stored: ${JSON.stringify(after).slice(0, 600)}`
  );
  assert.notStrictEqual(after.last_updated, before.last_updated, 'last_updated did not move');
});

test('hosted update_context without project_id stores against the active project', async (t) => {
  const fx = await createOrgFixture('hosted-active');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Hosted Active Project');
  await bindSession(fx, projectId);

  const MARKER = `ACTIVE-SENTENCE-${uuidv4().slice(0, 8)}`;
  const summary = `Moved the seed script behind a feature flag. ${MARKER}`;

  const before = await readBack(fx, projectId);
  providerCalls = 0;
  providerReply = llmReply({ current_status: summary });

  const res = await hostedUpdate(fx.apiKey, { summary });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(!parseRpc(res).error, `errored: ${JSON.stringify(parseRpc(res).error)}`);

  const after = await readBack(fx, projectId);
  assert.ok(contextMentions(after, MARKER), `nothing stored: ${JSON.stringify(after).slice(0, 600)}`);
  assert.notStrictEqual(after.last_updated, before.last_updated, 'last_updated did not move');
});

test('the REST /extraction path stores a delta for an already-bound session', async (t) => {
  const fx = await createOrgFixture('rest-extraction');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'REST Extraction Project');
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  const MARKER = `REST-SENTENCE-${uuidv4().slice(0, 8)}`;
  const line = `Rewrote the graph query as one owner-scoped CTE. ${MARKER}`;

  const before = await readBack(fx, projectId);
  providerCalls = 0;
  providerReply = llmReply({
    recent_decisions: [{ summary: line, decided_at: new Date().toISOString() }],
  });

  const res = await request(httpServer)
    .post('/api/v1/context/extraction')
    .set('x-api-key', fx.apiKey)
    .send({
      session_id: sessionId,
      tool: 'claude_code',
      project_id: projectId,
      chunks: [{ role: 'user', text: line }],
      session_context: { surface_type: 'cli', status: 'active' },
    });
  // 202 when the delta applied, 200 on the dry-run/no-op shape; both are
  // "accepted", and neither is evidence about what was stored.
  assert.ok([200, 202].includes(res.status), res.text);

  assert.ok(
    providerCalls > 0,
    'THE BUG: /extraction short-circuited on the session binding and never asked the model what to store'
  );

  const after = await readBack(fx, projectId);
  assert.ok(
    contextMentions(after, MARKER),
    `THE BUG: /extraction returned 200 and stored nothing. Stored: ${JSON.stringify(after).slice(0, 600)}`
  );
  assert.notStrictEqual(after.last_updated, before.last_updated, 'last_updated did not move');
});

// ---------------------------------------------------------------------------
// The no-ops that are genuine, and must stay no-ops. A fix to a silent-success
// bug that turns every no-op into a write is the same bug pointed the other way.
// ---------------------------------------------------------------------------

/**
 * A read, not a write, and here because the harness is. The parity pin in
 * tests/unit/mcp-dispatcher-parity.test.js asserts on source text, which is a
 * weak instrument; this drives the actual route.
 */
test('recall context with no project_id reads the active project', async (t) => {
  const fx = await createOrgFixture('recall-active');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Recall Active Project');
  await bindSession(fx, projectId);

  const res = await request(httpServer)
    .post('/mcp')
    .set(MCP_HEADERS)
    .set('x-api-key', fx.apiKey)
    .send(rpc('tools/call', { name: 'recall', arguments: { action: 'context' } }, 1));
  assert.strictEqual(res.status, 200, res.text);

  const payload = parseRpc(res);
  const text = payload.result?.content?.[0]?.text || '';
  assert.ok(
    !/project_id required/i.test(text) && !/project_id required/i.test(JSON.stringify(payload.error || {})),
    `recall({action:"context"}) still refuses the active-project fallback its own schema advertises: ${text || JSON.stringify(payload.error)}`
  );
  assert.ok(
    text.includes('Recall Active Project'),
    `expected the active project's brief, got: ${text.slice(0, 400)}`
  );
});

test('trivial chatter still stores nothing and never calls the model', async (t) => {
  const fx = await createOrgFixture('trivial');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Trivial Chatter Project');
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  const before = await readBack(fx, projectId);
  providerCalls = 0;
  providerReply = llmReply({ current_status: 'should never be asked for' });

  const res = await request(httpServer)
    .post('/api/v1/context/extraction')
    .set('x-api-key', fx.apiKey)
    .send({
      session_id: sessionId,
      tool: 'claude_code',
      project_id: projectId,
      chunks: [{ role: 'user', text: 'ok thanks' }],
      session_context: { surface_type: 'cli', status: 'active' },
    });
  assert.ok([200, 202].includes(res.status), res.text);
  assert.strictEqual(providerCalls, 0, 'trivial chatter must not spend a model call');

  const after = await readBack(fx, projectId);
  assert.ok(!contextMentions(after, 'should never be asked for'), 'trivial chatter wrote context');
  assert.strictEqual(after.last_updated, before.last_updated, 'trivial chatter moved last_updated');
});
