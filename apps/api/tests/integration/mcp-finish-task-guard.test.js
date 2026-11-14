const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

/**
 * finish_task cleared open task state on nobody's say-so (2026-09).
 *
 * The hosted handler decided a task was finished by substring-matching the
 * brief's own status text for /(completed|done|shipped|closed)/. A status line
 * reading "Shipped PR 488; now verifying the deploy" therefore meant "this task
 * is over", and a bare manage_memory({action:"finish_task"}) — no complete_task,
 * no confirmation — emptied open_questions, the blocking issue and the command
 * log, then reported only the command count. "abandoned" and "disclosed" would
 * have done it too.
 *
 * The confirmation gate a few lines above only ran when complete_task was true,
 * so the one destructive path nobody asked for was also the one path that
 * skipped the gate. A gate a second route walks around is not a gate.
 *
 * Drives the REAL /mcp route over HTTP with real auth against a real database,
 * because the whole defect lives between the gate, the status sniff and the
 * write — none of which a source-text assertion can see.
 *
 * Needs the DB harness:
 *   bash scripts/run-db-test.sh node --test tests/integration/mcp-finish-task-guard.test.js
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

const QUESTIONS = [
  'Does the deploy need a migration first?',
  'Who owns the rollback if the Fly release fails?',
];
const COMMANDS = [{ label: 'test', run: 'npm test' }, { label: 'lint', run: 'npm run lint' }];
const TASK = 'Ship the hosted dispatcher fixes';
const BLOCKER = 'Waiting on the Fly deploy to pick up the new image';
// The exact shape that triggered it: a status that reports progress using the
// word "Shipped" while the task is plainly still open.
const STATUS = 'Shipped PR 488; now verifying the deploy';

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Finish task ${label}`, 'active'],
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
    [keyId, prefix, hash, `Finish key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
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
    .send({ project_name: `Finish task ${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
  assert.strictEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const projectId = (created.body.project || {}).project_id || created.body.project_id;
  assert.ok(projectId, 'expected project_id');

  const patched = await api(apiKey, 'patch', `/api/v1/context/projects/${projectId}/context`).send({
    current_task: TASK,
    current_status: STATUS,
    commands: COMMANDS,
    open_questions: QUESTIONS,
    blocking_issue: BLOCKER,
  });
  assert.strictEqual(patched.status, 200, `patch failed: ${JSON.stringify(patched.body)}`);
  return projectId;
}

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

async function finishTask(apiKey, args) {
  const res = await callTool(apiKey, 'manage_memory', { action: 'finish_task', ...args });
  return parseRpc(res);
}

test('a bare finish_task clears nothing, whatever the status line says', async (t) => {
  const fixture = await createOrgFixture('bare');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const projectId = await seedProject(fixture.apiKey);

  const body = await finishTask(fixture.apiKey, { project_id: projectId });
  assert.ok(!body.error, `tools/call errored: ${JSON.stringify(body.error)}`);
  const text = String(body.result?.content?.[0]?.text || '');

  const context = await readContext(fixture.apiKey, projectId);
  assert.deepStrictEqual(context.open_questions, QUESTIONS, 'an unconfirmed wrap-up must not empty the open questions');
  assert.strictEqual((context.commands || []).length, COMMANDS.length, 'the command log must survive');
  assert.strictEqual(context.blocking_issue, BLOCKER, 'the blocking issue must survive');
  assert.strictEqual(context.current_status, STATUS, 'the status must not be overwritten with "Completed: ..."');
  assert.notStrictEqual(context.task_progress, 'completed', 'nothing said this task was done');

  // A read-only wrap-up still has to be useful: say what a confirmed call would
  // destroy, and give the call that would do it.
  assert.match(text, /complete_task/);
  assert.match(text, /confirm_complete/);
  assert.ok(text.includes('2 open question'), `the report names the question count: ${text}`);
  assert.ok(/blocking issue/i.test(text), `the report names the blocking issue: ${text}`);
});

test('complete_task without confirm_complete is refused and writes nothing', async (t) => {
  const fixture = await createOrgFixture('unconfirmed');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const projectId = await seedProject(fixture.apiKey);

  const body = await finishTask(fixture.apiKey, { project_id: projectId, complete_task: true });
  const payload = JSON.stringify(body);
  assert.ok(/confirm_complete/.test(payload), `the refusal names the confirmation: ${payload}`);

  const context = await readContext(fixture.apiKey, projectId);
  assert.deepStrictEqual(context.open_questions, QUESTIONS);
  assert.strictEqual(context.blocking_issue, BLOCKER);
});

test('a confirmed completion clears the state AND names everything it cleared', async (t) => {
  const fixture = await createOrgFixture('confirmed');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const projectId = await seedProject(fixture.apiKey);

  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await finishTask(fixture.apiKey, { project_id: projectId });
  const body = await finishTask(fixture.apiKey, {
    project_id: projectId,
    complete_task: true,
    confirm_complete: true,
  });
  assert.ok(!body.error, `tools/call errored: ${JSON.stringify(body.error)}`);
  const text = String(body.result?.content?.[0]?.text || '');

  const context = await readContext(fixture.apiKey, projectId);
  assert.deepStrictEqual(context.open_questions, [], 'a confirmed completion does clear the questions');
  assert.strictEqual((context.commands || []).length, 0);
  assert.strictEqual(context.blocking_issue, '');
  assert.strictEqual(context.task_progress, 'completed');

  // The reply used to mention only the command log, so two questions and a
  // blocker went quietly. Everything destroyed gets named.
  assert.ok(text.includes('2 open question'), `the reply names the questions cleared: ${text}`);
  assert.ok(/blocking issue/i.test(text), `the reply names the blocker cleared: ${text}`);
  assert.ok(text.includes('2 command log'), `the reply names the commands cleared: ${text}`);
});
