const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

/**
 * The hosted half of "let an agent resolve one open question" (2026-08-29).
 *
 * POST /projects/:id/questions/resolve was hardened first and nothing could
 * reach it. From an agent session the only lever on open_questions was
 * manage_memory(action:"finish_task"), which patches commands, open_questions
 * and blocking_issue to empty WHOLESALE — so stale questions accumulated in live
 * briefs because the only tool pointed at them was a wrecking ball.
 *
 * This drives the REAL /mcp route — the transport Claude.ai, ChatGPT and Cursor
 * use, and how most people connect — over HTTP with real auth against a real
 * database. Source-text parity assertions (tests/unit/mcp-dispatcher-parity.test.js)
 * can prove the action exists on both dispatchers; only this can prove the hosted
 * one is actually wired end to end, through the scope map, the catalog's
 * additionalProperties:false argument validation, and dispatch.
 *
 * Needs the DB harness:
 *   bash scripts/run-db-test.sh node --test tests/integration/mcp-resolve-question.test.js
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

// Two of these share the word "auth", so the fuzzy path has something genuinely
// ambiguous to refuse rather than a hypothetical.
const QUESTIONS = [
  'How should I authenticate with GitHub?',
  'Which auth provider should the dashboard use?',
  'What is causing the CI install step to fail?',
  'Should trails be public by default?',
];
const COMMANDS = [{ label: 'test', run: 'npm test' }, { label: 'lint', run: 'npm run lint' }];
const TASK = 'Let an agent session resolve one open question';

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Resolve question ${label}`, 'active'],
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
    [keyId, prefix, hash, `Resolve key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
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
    .send({ project_name: `Resolve question ${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
  assert.strictEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const projectId = (created.body.project || {}).project_id || created.body.project_id;
  assert.ok(projectId, 'expected project_id');

  const patched = await api(apiKey, 'patch', `/api/v1/context/projects/${projectId}/context`).send({
    current_task: TASK,
    task_steps: [{ name: 'ship the API half', status: 'done' }, { name: 'reach it from a session', status: 'in_progress' }],
    commands: COMMANDS,
    open_questions: QUESTIONS,
  });
  assert.strictEqual(patched.status, 200, `patch failed: ${JSON.stringify(patched.body)}`);
  return projectId;
}

// Read straight back from storage, so every assertion about persistence is about
// what was saved rather than what the write path echoed back.
async function readContext(apiKey, projectId) {
  const res = await api(apiKey, 'get', `/api/v1/context/projects/${projectId}/inject?format=json`);
  assert.strictEqual(res.status, 200, `read-back failed: ${JSON.stringify(res.body)}`);
  return res.body.context;
}

function callTool(apiKey, name, args, id = 1) {
  return request(httpServer)
    .post('/mcp')
    .set(MCP_HEADERS)
    .set('x-api-key', apiKey)
    .send(rpc('tools/call', { name, arguments: args }, id));
}

async function resolveQuestion(apiKey, args) {
  const res = await callTool(apiKey, 'manage_memory', { action: 'resolve_question', ...args });
  const body = parseRpc(res);
  assert.ok(!body.error, `tools/call errored: ${JSON.stringify(body.error)}`);
  return String(body.result?.content?.[0]?.text || '');
}

test('hosted manage_memory resolves ONE question and disturbs nothing else', async (t) => {
  const fixture = await createOrgFixture('one');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const projectId = await seedProject(fixture.apiKey);

  const text = await resolveQuestion(fixture.apiKey, {
    project_id: projectId,
    question: 'Should trails be public by default?',
    answer: 'No — publishing runs a redaction gate first.',
  });
  assert.match(text, /Resolved: "Should trails be public by default\?"/);

  const context = await readContext(fixture.apiKey, projectId);
  assert.deepStrictEqual(
    context.open_questions,
    QUESTIONS.filter((q) => q !== 'Should trails be public by default?'),
    'exactly one question removed, and the others in their original order'
  );
  // The whole point of the narrow path: finish_task would have emptied all three.
  assert.strictEqual(context.current_task, TASK, 'the task must survive');
  assert.strictEqual((context.commands || []).length, COMMANDS.length, 'the command log must survive');
  assert.strictEqual((context.task_steps || []).length, 2, 'the task steps must survive');
  assert.ok(
    (context.recent_decisions || []).some((d) => String(d.summary || '').includes('redaction gate')),
    'the answer is recorded as a decision'
  );
});

test('hosted manage_memory refuses an ambiguous question and NAMES the candidates', async (t) => {
  const fixture = await createOrgFixture('ambiguous');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const projectId = await seedProject(fixture.apiKey);

  // "auth" is a substring of two different questions. Resolving the closest guess
  // would silently retire the wrong one; a bare "ambiguous" would leave the
  // caller with no way to become unambiguous. So the candidates travel with it.
  const text = await resolveQuestion(fixture.apiKey, {
    project_id: projectId,
    question: 'auth',
    answer: 'Clerk',
  });
  assert.match(text, /nothing was resolved/);
  assert.ok(text.includes('How should I authenticate with GitHub?'), 'first candidate is named in full');
  assert.ok(text.includes('Which auth provider should the dashboard use?'), 'second candidate is named in full');

  const context = await readContext(fixture.apiKey, projectId);
  assert.deepStrictEqual(context.open_questions, QUESTIONS, 'an ambiguous query resolves nothing at all');
  assert.ok(
    !(context.recent_decisions || []).some((d) => String(d.summary || '').includes('Clerk')),
    'a refused resolve must not record a decision it did not make'
  );
});

test('hosted manage_memory reports a miss with the questions that ARE open', async (t) => {
  const fixture = await createOrgFixture('miss');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const projectId = await seedProject(fixture.apiKey);

  const text = await resolveQuestion(fixture.apiKey, {
    project_id: projectId,
    question: 'Which colour should the logo be?',
    answer: 'Black',
  });
  assert.match(text, /No open question matches/);
  assert.ok(text.includes('What is causing the CI install step to fail?'), 'the miss lists what is actually open');

  const context = await readContext(fixture.apiKey, projectId);
  assert.deepStrictEqual(context.open_questions, QUESTIONS, 'a miss changes nothing');
});

test('resolve_question is a distinct action: resolve takes the question out of the brief, resolve_question also records the answer', async (t) => {
  const fixture = await createOrgFixture('distinct');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const projectId = await seedProject(fixture.apiKey);

  // Writing open_questions MIRRORS each one into the workspace graph as a
  // `question` entity, so action:"resolve" (mark_resolved) finds them by title.
  // It used to flip the graph node and answer "Marked resolved" while the brief
  // still listed the question as open: the success that was not one (journey
  // r4, BLOCKED 13; the owner's decision was to fix it). It now takes the
  // question out of the brief too, and records no answer: it was given none.
  const target = 'What is causing the CI install step to fail?';
  const res = await callTool(fixture.apiKey, 'manage_memory', {
    action: 'resolve',
    project_id: projectId,
    title: target,
  });
  const body = parseRpc(res);
  assert.ok(!body.error, `tools/call errored: ${JSON.stringify(body.error)}`);
  assert.match(String(body.result?.content?.[0]?.text || ''), /Marked resolved/);

  const afterEntityResolve = await readContext(fixture.apiKey, projectId);
  assert.deepStrictEqual(
    afterEntityResolve.open_questions,
    QUESTIONS.filter((q) => q !== target),
    'action:"resolve" took the question out of the brief, as its reply says',
  );
  const decisionsBefore = (afterEntityResolve.recent_decisions || []).length;

  // The question action is the one that records an answer as a decision.
  const other = 'Should trails be public by default?';
  const text = await resolveQuestion(fixture.apiKey, {
    project_id: projectId,
    question: other,
    answer: 'Private by default.',
  });
  assert.match(text, /Resolved:/);
  const afterQuestionResolve = await readContext(fixture.apiKey, projectId);
  assert.deepStrictEqual(
    afterQuestionResolve.open_questions,
    QUESTIONS.filter((q) => q !== target && q !== other),
    'resolve_question removes it from the brief',
  );
  assert.equal((afterQuestionResolve.recent_decisions || []).length, decisionsBefore + 1, 'and records the answer');
});
