const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

/**
 * Scan 19: once a board held 300 OPEN cards, every manage_tasks add evicted the
 * oldest open card — not completed, not in shipped, not searchable — and the
 * reply said "Added … → backlog". Both dispatchers dropped the eviction the
 * service reported.
 *
 * Open work is now never deleted to make room: an add that would take open
 * cards past the limit is refused whole, with a message, and nothing is written
 * — on every path that reaches the board merge (MCP add, POST /events, PATCH
 * context). The extraction path saves the rest of its delta and names the
 * refused cards. The Done cap is unchanged.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/scan19-open-card-cap.test.js
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
    [orgId, `Open cap ${label}`, 'active'],
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
    [keyId, prefix, hash, `Open cap key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
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
  const projectName = `Open cap ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

async function readBoard(apiKey, projectId) {
  const res = await api(apiKey, 'get', `/api/v1/context/projects/${projectId}/inject?format=json`);
  assert.strictEqual(res.status, 200, `read-back failed: ${JSON.stringify(res.body)}`);
  return res.body.context.todo_items || [];
}


async function seedOpen(apiKey, projectId, count) {
  const res = await api(apiKey, 'patch', `/api/v1/context/projects/${projectId}/context`)
    .send({ add_todos: Array.from({ length: count }, (_, i) => `open ${i}`) });
  assert.strictEqual(res.status, 200, `seed failed: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  const board = await readBoard(apiKey, projectId);
  assert.strictEqual(board.filter((c) => c.phase !== 'done').length, count, 'seeded open count');
  return board;
}

async function toolCall(apiKey, args) {
  const body = parseRpc(await callTool(apiKey, 'manage_tasks', args));
  assert.ok(!body.error, `tools/call errored at the protocol level: ${JSON.stringify(body.error)}`);
  return body.result;
}

const openTitles = (board) => board.filter((c) => c.phase !== 'done').map((c) => c.title);

test('300 open cards + hosted add: refused with a message, no open card evicted, nothing written', async (t) => {
  const fixture = await createOrgFixture('full');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId } = await seedProject(fixture.apiKey);
  const before = await seedOpen(fixture.apiKey, projectId, 300);

  const result = await toolCall(fixture.apiKey, { action: 'add', project_id: projectId, todos: ['one more'] });
  const text = String(result?.content?.[0]?.text || '');
  assert.strictEqual(result.isError, true, `expected a refusal, got: ${text}`);
  assert.match(text, /300 open cards/);
  assert.match(text, /limit is 300/);
  assert.match(text, /Nothing was saved/);

  const after = await readBoard(fixture.apiKey, projectId);
  assert.deepStrictEqual(openTitles(after), openTitles(before), 'the open cards are exactly the ones that were there');
  assert.ok(openTitles(after).includes('open 0'), 'the OLDEST open card survives');
  assert.ok(!openTitles(after).includes('one more'));
});

test('299 open + hosted add of 2: the whole batch is refused', async (t) => {
  const fixture = await createOrgFixture('batch');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId } = await seedProject(fixture.apiKey);
  await seedOpen(fixture.apiKey, projectId, 299);

  const result = await toolCall(fixture.apiKey, { action: 'add', project_id: projectId, todos: ['first', 'second'] });
  assert.strictEqual(result.isError, true);
  assert.match(String(result.content[0].text), /these 2 cards were not added: "first", "second"/);
  const after = await readBoard(fixture.apiKey, projectId);
  assert.strictEqual(after.filter((c) => c.phase !== 'done').length, 299);

  // One still fits.
  const fits = await toolCall(fixture.apiKey, { action: 'add', project_id: projectId, todos: ['last slot'] });
  assert.ok(!fits.isError, String(fits.content[0].text));
  assert.strictEqual((await readBoard(fixture.apiKey, projectId)).filter((c) => c.phase !== 'done').length, 300);
});

test('POST /events and PATCH context refuse the same add with 409, and write nothing', async (t) => {
  const fixture = await createOrgFixture('rest');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId } = await seedProject(fixture.apiKey);
  const before = await seedOpen(fixture.apiKey, projectId, 300);

  const ev = await api(fixture.apiKey, 'post', '/api/v1/context/events').send({
    event_type: 'todo_added',
    project_id: projectId,
    summary: 'Added 1 card: via events',
    metadata: { todos: ['via events'] },
  });
  assert.strictEqual(ev.status, 409, JSON.stringify(ev.body));
  assert.strictEqual(ev.body.error, 'board_open_limit_reached');
  assert.match(ev.body.message, /limit is 300/);

  const patch = await api(fixture.apiKey, 'patch', `/api/v1/context/projects/${projectId}/context`)
    .send({ add_todos: ['via patch'], current_task: 'must not land either' });
  assert.strictEqual(patch.status, 409, JSON.stringify(patch.body));

  const after = await readBoard(fixture.apiKey, projectId);
  assert.deepStrictEqual(openTitles(after), openTitles(before));
  const ctx = await api(fixture.apiKey, 'get', `/api/v1/context/projects/${projectId}/inject?format=json`);
  assert.notStrictEqual(ctx.body.context.current_task, 'must not land either', 'a refused PATCH writes nothing at all');
});

test('the extraction path keeps the rest of its delta and names the refused cards', async (t) => {
  const fixture = await createOrgFixture('extract');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId, projectName } = await seedProject(fixture.apiKey);
  const before = await seedOpen(fixture.apiKey, projectId, 300);

  const res = await api(fixture.apiKey, 'post', '/api/v1/context/extraction').send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: projectId,
    chunks: [{ role: 'user', text: 'Filing a card on a full board.' }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.95,
      project_candidate: { project_id: projectId, project_name: projectName, score: 0.95 },
      delta: { add_todos: ['from extraction'], tech_stack: ['Rust'] },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });
  assert.ok(res.status === 200 || res.status === 202, `${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.deepStrictEqual((res.body.refused_cards || []).map((c) => c.title), ['from extraction']);
  assert.strictEqual(res.body.board_open_limit, 300);
  const after = await readBoard(fixture.apiKey, projectId);
  assert.deepStrictEqual(openTitles(after), openTitles(before), 'no open card evicted');
});

test('an add into a full Done column names the completion it pushed off (hosted)', async (t) => {
  const fixture = await createOrgFixture('donecap');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId } = await seedProject(fixture.apiKey);
  const seeded = await api(fixture.apiKey, 'patch', `/api/v1/context/projects/${projectId}/context`)
    .send({
      add_todos: Array.from({ length: 100 }, (_, i) => ({
        title: `finished ${i}`,
        phase: 'done',
        completed_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      })),
    });
  assert.strictEqual(seeded.status, 200, JSON.stringify(seeded.body).slice(0, 300));

  const result = await toolCall(fixture.apiKey, { action: 'add', project_id: projectId, phase: 'done', todos: ['finished today'] });
  const text = String(result.content[0].text);
  assert.ok(!result.isError, text);
  assert.match(text, /removed to make room: "finished 0"/);
  assert.deepStrictEqual(result.structuredContent.evicted, ['finished 0']);
});

// ── Scan 20 ───────────────────────────────────────────────────────────────────
//
// The extraction reply named the refused cards in refused_cards AND listed the
// same titles in extraction.delta.add_todos, the part of the reply the local
// dispatcher prints as "what was applied" — while the store held neither. And a
// Trail import dry run over a full board reported "N cards" as a success, then
// the real import refused.

test('scan 20: the extraction reply\'s applied delta does not list the cards the board refused', async (t) => {
  const fixture = await createOrgFixture('extract-reply');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const { projectId, projectName } = await seedProject(fixture.apiKey);
  await seedOpen(fixture.apiKey, projectId, 300);

  const res = await api(fixture.apiKey, 'post', '/api/v1/context/extraction').send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: projectId,
    chunks: [{ role: 'user', text: 'Filing cards on a full board.' }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.95,
      project_candidate: { project_id: projectId, project_name: projectName, score: 0.95 },
      delta: {
        add_todos: ['from extraction', { title: 'object card', phase: 'in_progress' }],
        tech_stack: ['Rust'],
      },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });
  assert.ok(res.status === 200 || res.status === 202, `${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.deepStrictEqual((res.body.refused_cards || []).map((c) => c.title).sort(), ['from extraction', 'object card']);
  const delta = res.body.extraction?.delta || {};
  const replied = JSON.stringify(delta.add_todos || []);
  for (const title of ['from extraction', 'object card']) {
    assert.ok(!replied.includes(title), `"${title}" is refused, so the applied delta must not list it: ${replied}`);
  }
  assert.deepStrictEqual(delta.tech_stack, ['Rust'], 'what WAS applied is still reported');
  const after = await readBoard(fixture.apiKey, projectId);
  assert.ok(!after.some((c) => c.title === 'from extraction' || c.title === 'object card'), 'the store holds neither');
});

test('scan 20: a Trail import dry run over a full board predicts the refusal the import gives', async (t) => {
  const fixture = await createOrgFixture('trail-dry');
  t.after(async () => {
    await cleanupOrgFixture(fixture);
    await closeRedisConnections().catch(() => {});
  });
  const source = await seedProject(fixture.apiKey);
  // Titles the target does not already hold: re-adding a title on the board is a
  // no-op, which would let the import through for the wrong reason.
  const seeded = await api(fixture.apiKey, 'patch', `/api/v1/context/projects/${source.projectId}/context`)
    .send({ add_todos: ['theirs 0', 'theirs 1', 'theirs 2'] });
  assert.strictEqual(seeded.status, 200, JSON.stringify(seeded.body).slice(0, 300));
  const exported = await api(fixture.apiKey, 'get', `/api/v1/context/projects/${source.projectId}/trail`);
  assert.strictEqual(exported.status, 200, String(exported.text).slice(0, 300));
  const trail = exported.text;

  const target = await seedProject(fixture.apiKey);
  const before = await seedOpen(fixture.apiKey, target.projectId, 300);

  const dry = await api(fixture.apiKey, 'post', '/api/v1/context/trail/import')
    .send({ trail, project_id: target.projectId, dry_run: true });
  const real = await api(fixture.apiKey, 'post', '/api/v1/context/trail/import')
    .send({ trail, project_id: target.projectId });
  assert.strictEqual(real.status, 409, `the real import refuses: ${real.status} ${JSON.stringify(real.body).slice(0, 300)}`);
  assert.strictEqual(dry.status, real.status, `the dry run answers what the import does: ${dry.status} ${JSON.stringify(dry.body).slice(0, 300)}`);
  assert.strictEqual(dry.body.error, real.body.error);
  assert.strictEqual(dry.body.error, 'board_open_limit_reached');
  assert.match(dry.body.message, /Dry run/);
  assert.match(dry.body.message, /Nothing was written/);

  // Over MCP too: an error, not "Dry run — nothing was written… 3 cards".
  const body = parseRpc(await callTool(fixture.apiKey, 'manage_memory', { action: 'import_trail', project_id: target.projectId, trail, dry_run: true }));
  assert.strictEqual(body.result?.isError, true, JSON.stringify(body).slice(0, 400));
  assert.match(String(body.result.content[0].text), /open card/);

  const after = await readBoard(fixture.apiKey, target.projectId);
  assert.deepStrictEqual(openTitles(after), openTitles(before), 'nothing was written');

  // Room on the board: the dry run still answers with the plan.
  const roomy = await seedProject(fixture.apiKey);
  const ok = await api(fixture.apiKey, 'post', '/api/v1/context/trail/import')
    .send({ trail, project_id: roomy.projectId, dry_run: true });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.strictEqual(ok.body.applied, false);
});
