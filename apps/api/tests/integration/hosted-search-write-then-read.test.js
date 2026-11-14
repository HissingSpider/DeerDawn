const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

// Hosted search could not find what had just been saved.
//
// `recall(action:"search")` on the hosted connectors searched six fields — task,
// status, description, decision SUMMARIES, goals, questions. Everything else a
// session writes through `manage_memory` and `manage_tasks` (a debugging finding,
// a landmine, a shipped entry, a hot path, a board card, a graph entity, the
// REASONING of a decision) was unsearchable, so the write reported success and
// the read said "No matches found." — which reads exactly like a dropped write.
//
// And what it did search, it searched badly: the tokeniser replaced every
// non-alphanumeric with a space and dropped tokens under three characters, so
// `$12` and `A-2` were not searchable at all and `E-007` was searched as `007`.
// Those are the identifiers people actually type into a memory search.
//
// Every test here is WRITE-THEN-READ over real HTTP against a real database: the
// marker goes in through the API and has to come back out through hosted
// `recall`. A test that asserted on the write's response alone is how the
// silent-success family of bugs kept shipping.
//
// Needs the DB harness: bash scripts/run-db-test.sh node --test tests/integration/hosted-search-write-then-read.test.js

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
  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Search ${label}`, 'active'],
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
    [`key-${uuidv4()}`, prefix, hash, `Search key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
    orgId
  );
  return { orgId, userId, apiKey: key };
}

async function cleanupOrgFixture({ orgId }) {
  for (const table of ['context_graph_nodes', 'context_projects']) {
    await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [orgId], orgId).catch(() => {});
  }
  for (const table of ['product_events', 'api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

async function createProject(fx, name) {
  const res = await request(httpServer)
    .post('/api/v1/context/projects')
    .set('x-api-key', fx.apiKey)
    .send({ project_name: name, description: `${name} description`, goals: [] });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.project?.project_id || res.body.project_id;
}

async function patchContext(fx, projectId, body) {
  const res = await request(httpServer)
    .patch(`/api/v1/context/projects/${projectId}/context`)
    .set('x-api-key', fx.apiKey)
    .send(body);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
}

async function hosted(fx, name, args, pathname = '/mcp') {
  const res = await request(httpServer)
    .post(pathname)
    .set(MCP_HEADERS)
    .set('x-api-key', fx.apiKey)
    .send(rpc('tools/call', { name, arguments: args }, 7));
  assert.strictEqual(res.status, 200, res.text);
  const payload = parseRpc(res);
  assert.ok(!payload.error, `${name} errored: ${JSON.stringify(payload.error)}`);
  assert.ok(!payload.result?.isError, `${name} returned isError: ${JSON.stringify(payload.result)}`);
  return payload.result;
}

async function hostedSearch(fx, query, extra = {}, pathname = '/mcp') {
  const result = await hosted(fx, 'recall', { action: 'search', query, ...extra }, pathname);
  return {
    text: (result.content || []).map((c) => c.text).join('\n'),
    results: result.structuredContent?.results || [],
  };
}

test('a finding saved through hosted manage_memory is found by hosted recall, by its identifier', async (t) => {
  const fx = await createOrgFixture('finding');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx, 'Funnel Experiments');

  // The marker sits ~600 characters into the note, the way a real write-up
  // buries the experiment id after the narrative.
  const summary = `${'The consent screen drops the code parameter on redirect. '.repeat(10)}`
    + 'Tracked as experiment E-007 in the growth ledger. '
    + `${'Follow-up notes that come after the identifier. '.repeat(6)}`;
  await hosted(fx, 'manage_memory', { action: 'record_finding', project_id: projectId, summary, paths: ['apps/marketing/src/pages/oauth/consent.tsx'] });

  for (const pathname of ['/mcp', '/mcp/claude']) {
    const found = await hostedSearch(fx, 'E-007', {}, pathname);
    assert.ok(found.results.length > 0, `${pathname}: THE BUG — saved a finding, searched its id, got: ${found.text}`);
    const hit = found.results[0];
    assert.strictEqual(hit.project_id, projectId);
    assert.match(hit.field, /^debug\[/);
    // Centred on the match, not cut from the start of the entry.
    assert.match(hit.snippet, /E-007/, `snippet does not contain the match: ${hit.snippet}`);
    assert.ok(hit.snippet.length <= 170, `snippet was ${hit.snippet.length} chars`);
  }

  // `E-007` must not degrade to `007`.
  await patchContext(fx, projectId, { open_questions: ['Did ticket OPS-1007 ever get closed?'] });
  const again = await hostedSearch(fx, 'E-007');
  assert.ok(again.results.every((r) => !/OPS-1007/.test(r.snippet)), 'E-007 matched a bare 007');
});

test('`$12` and `A-2` are searchable, including inside a decision\'s reasoning', async (t) => {
  const fx = await createOrgFixture('symbols');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx, 'Pricing Work');
  await patchContext(fx, projectId, {
    recent_decisions: [{
      summary: 'Pro displays the new price while billing stays put',
      reasoning: 'The page shows $12 but Stripe still charges the legacy amount until the repoint.',
      decided_at: new Date().toISOString(),
    }],
    landmines: [{ summary: 'Outreach email A-2 was never sent; do not count it as a touch.', added_at: new Date().toISOString() }],
  });

  const price = await hostedSearch(fx, '$12');
  assert.ok(price.results.some((r) => /^decision\[/.test(r.field) && /\$12/.test(r.snippet)), `$12 not found: ${price.text}`);

  const email = await hostedSearch(fx, 'A-2');
  assert.ok(email.results.some((r) => /^landmine\[/.test(r.field) && /A-2/.test(r.snippet)), `A-2 not found: ${email.text}`);
});

test('shipped entries, hot paths, board cards and graph entities are all reachable', async (t) => {
  const fx = await createOrgFixture('coverage');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx, 'Coverage Project');

  await patchContext(fx, projectId, {
    shipped: [{ summary: 'Shipped the quokkaship release train', shipped_at: new Date().toISOString() }],
    add_todos: [{ title: 'Repoint the wombatcard price id', body: 'Keep the legacy id mapped.' }],
  });
  await hosted(fx, 'manage_memory', {
    action: 'record_paths',
    project_id: projectId,
    items: [{ label: 'numbatpath dispatcher', path: 'apps/api/src/routes/mcp.js', purpose: 'hosted tool dispatch' }],
  });
  await hosted(fx, 'manage_memory', {
    action: 'upsert_entities',
    project_id: projectId,
    entities: [{ title: 'Bilbyqueue worker', entity_type: 'service', summary: 'Drains the extraction queue.', scope: 'project', project_id: projectId }],
  });

  for (const [query, field] of [
    ['quokkaship', /^shipped\[/],
    ['wombatcard', /^todo\[/],
    ['numbatpath', /^hotpath\[/],
    ['bilbyqueue', /^entity:/],
  ]) {
    const found = await hostedSearch(fx, query);
    assert.ok(
      found.results.some((r) => field.test(r.field) && r.project_id === projectId),
      `"${query}" should be found in ${field}: ${found.text}`
    );
  }
});

test('the requested project leads, and REST search answers from the same builder', async (t) => {
  const fx = await createOrgFixture('boost');
  t.after(() => cleanupOrgFixture(fx));
  const older = await createProject(fx, 'Older Project');
  const newer = await createProject(fx, 'Newer Project');
  const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await patchContext(fx, older, { recent_decisions: [{ summary: 'Adopt the echidnaflag rollout', decided_at: lastMonth }] });
  await patchContext(fx, newer, { recent_decisions: [{ summary: 'Adopt the echidnaflag rollout everywhere', decided_at: new Date().toISOString() }] });

  const boosted = await hostedSearch(fx, 'echidnaflag', { project_id: older });
  assert.strictEqual(boosted.results.length, 2, boosted.text);
  assert.strictEqual(boosted.results[0].project_id, older, 'the requested project leads despite being older');
  assert.ok(boosted.results[0].score > boosted.results[1].score, 'and its score says why');

  const rest = await request(httpServer)
    .post('/api/v1/context/search')
    .set('x-api-key', fx.apiKey)
    .send({ query: 'echidnaflag', project_id: older });
  assert.strictEqual(rest.status, 200, JSON.stringify(rest.body));
  assert.deepStrictEqual(
    rest.body.results.map((r) => [r.project_id, r.field, r.snippet, r.score]),
    boosted.results.map((r) => [r.project_id, r.field, r.snippet, r.score]),
    'one builder, two callers'
  );

  // A project_id that resolves to nothing changes nothing and confirms nothing.
  const unknown = await hostedSearch(fx, 'echidnaflag', { project_id: `proj-${uuidv4()}` }).catch((err) => ({ error: err }));
  if (!unknown.error) assert.strictEqual(unknown.results.length, 2);
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
