const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

/**
 * What manage_tasks SAYS it did, against what the board actually holds (2026-09).
 *
 * Two hosted defects, one reply path:
 *
 *  - No write named the project it landed in. A hosted client has no cwd, so the
 *    project is resolved from the caller's history; "Added to in progress: X"
 *    reads as a confirmation while saying nothing about which board grew.
 *
 *  - The reply was built from the REQUEST. shared-context treats re-adding a
 *    title already on the board as a no-op, so asking to add a card that is
 *    already sitting in Done answered `Added to in progress: "..."` and added
 *    nothing. That is the failure this repo has paid for repeatedly: a write
 *    reporting success while the thing the user is looking at is unchanged.
 *
 * The one case that must keep working is re-adding an existing title WITH a
 * body — the documented way to set a card's body after the card exists.
 *
 * Needs the DB harness:
 *   bash scripts/run-db-test.sh node --test tests/integration/mcp-task-board-replies.test.js
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
    [orgId, `Board replies ${label}`, 'active'],
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
    [keyId, prefix, hash, `Board key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
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
  const projectName = `Board replies ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const created = await api(apiKey, 'post', '/api/v1/context/projects').send({ project_name: projectName });
  assert.strictEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const projectId = (created.body.project || {}).project_id || created.body.project_id;
  assert.ok(projectId, 'expected project_id');
  return { projectId, projectName };
}

function callTool(apiKey, name, args, id = 1) {
  return request(httpServer)
    .post('/mcp')
    .set(MCP_HEADERS)
    .set('x-api-key', apiKey)
    .send(rpc('tools/call', { name, arguments: args }, id));
}

async function tasks(apiKey, args) {
  const body = parseRpc(await callTool(apiKey, 'manage_tasks', args));
  assert.ok(!body.error, `tools/call errored: ${JSON.stringify(body.error)}`);
  return {
    text: String(body.result?.content?.[0]?.text || ''),
    data: body.result?.structuredContent || {},
  };
}

async function readBoard(apiKey, projectId) {
  const res = await api(apiKey, 'get', `/api/v1/context/projects/${projectId}/inject?format=json`);
  assert.strictEqual(res.status, 200, `read-back failed: ${JSON.stringify(res.body)}`);
  return res.body.context.todo_items || [];
}

test('add, move and complete each name the project they landed in', async (t) => {
  const fixture = await createOrgFixture('named');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId, projectName } = await seedProject(fixture.apiKey);

  const added = await tasks(fixture.apiKey, { action: 'add', project_id: projectId, todos: ['Fix login redirect'] });
  assert.ok(added.text.includes(projectName), `add must name the project: ${added.text}`);
  assert.strictEqual(added.data.project_name, projectName);

  const moved = await tasks(fixture.apiKey, { action: 'move', project_id: projectId, todos: ['Fix login redirect'], phase: 'in_progress' });
  assert.ok(moved.text.includes(projectName), `move must name the project: ${moved.text}`);

  const completed = await tasks(fixture.apiKey, { action: 'complete', project_id: projectId, todos: ['Fix login redirect'] });
  assert.ok(completed.text.includes(projectName), `complete must name the project: ${completed.text}`);
  // Defect 2 of this round: structuredContent lost every key after the first
  // undefined one, so `phase` and `project_id` never arrived beside `ambiguous`.
  assert.strictEqual(completed.data.phase, 'done');
  assert.strictEqual(completed.data.project_id, projectId);
});

test('re-adding a title that already exists says so, and says where it is', async (t) => {
  const fixture = await createOrgFixture('duplicate');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId } = await seedProject(fixture.apiKey);

  await tasks(fixture.apiKey, { action: 'add', project_id: projectId, todos: ['Fix login redirect'] });
  await tasks(fixture.apiKey, { action: 'complete', project_id: projectId, todos: ['Fix login redirect'] });

  const again = await tasks(fixture.apiKey, {
    action: 'add',
    project_id: projectId,
    todos: ['Fix login redirect'],
    phase: 'in_progress',
  });
  assert.ok(/already exists/i.test(again.text), `the reply must admit nothing was added: ${again.text}`);
  assert.ok(/done/i.test(again.text), `the reply must name the column it is in: ${again.text}`);
  assert.ok(!/^Added/m.test(again.text), `nothing was added, so nothing may claim it was: ${again.text}`);

  const board = await readBoard(fixture.apiKey, projectId);
  assert.strictEqual(board.length, 1, 'still one card');
  assert.strictEqual(board[0].phase, 'done', 'the card did not move, whatever the request asked for');
});

test('re-adding an existing title WITH a body still sets the body, and says so', async (t) => {
  const fixture = await createOrgFixture('body');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId } = await seedProject(fixture.apiKey);

  await tasks(fixture.apiKey, { action: 'add', project_id: projectId, todos: ['Spec the import path'] });
  const detailed = await tasks(fixture.apiKey, {
    action: 'add',
    project_id: projectId,
    cards: [{ title: 'Spec the import path', body: 'Merge plan, dry_run first, then the real write.' }],
  });
  assert.ok(/updated the body/i.test(detailed.text), `setting a body after the fact must be reported as such: ${detailed.text}`);

  const board = await readBoard(fixture.apiKey, projectId);
  assert.strictEqual(board.length, 1);
  assert.match(String(board[0].body || ''), /dry_run first/, 'the body actually landed');
});

test('a genuinely new card is still reported as added, with its column', async (t) => {
  const fixture = await createOrgFixture('fresh');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId, projectName } = await seedProject(fixture.apiKey);

  const added = await tasks(fixture.apiKey, {
    action: 'add',
    project_id: projectId,
    todos: ['Rotate the DEK'],
    phase: 'blocked',
  });
  assert.match(added.text, /Added/);
  assert.ok(added.text.includes('Rotate the DEK'));
  assert.ok(/blocked/i.test(added.text), `the column is named: ${added.text}`);
  assert.ok(added.text.includes(projectName));
  assert.deepStrictEqual(added.data.affected, ['Rotate the DEK']);
});
