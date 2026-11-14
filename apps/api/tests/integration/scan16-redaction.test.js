/**
 * Scan 16 (2026-09-23), REDACTION — the stored/served half. The pattern-level
 * pins (corpus rows, timing, the three redactors agreeing) are in
 * tests/unit/scan16-redaction.test.js.
 *
 *   #1 HIGH  round 15 masked every upper-snake *_KEY whose value held a digit,
 *            so two board cards differing only in a non-secret constant were
 *            stored as ONE title and merged (PATCH 200, a card lost).
 *   #2 HIGH  nothing capped a free-text field, and a 40 KB description held the
 *            API for 15 seconds on a quadratic redaction pattern. The pattern
 *            is linear now AND the PATCH refuses an over-long value.
 *   #4 LOW   redactedPatchFields left out a list named in `refused` even when
 *            the entries the server KEPT were stored masked.
 *   #5 HIGH  an Azure connection string (AccountKey=<base64>) was stored and
 *            served verbatim.
 *
 * Run: bash scripts/run-db-test.sh node --test tests/integration/scan16-redaction.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);

const db = require('../../src/config/db');
const { generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const created = { orgs: new Set() };

test.after(async () => {
  for (const orgId of created.orgs) {
    for (const sql of [
      'DELETE FROM context_audit_logs WHERE owner_key = $1',
      'DELETE FROM context_graph_evidence WHERE owner_key = $1',
      'DELETE FROM context_graph_edges WHERE owner_key = $1',
      'DELETE FROM context_graph_nodes WHERE owner_key = $1',
      'DELETE FROM context_sessions WHERE owner_key = $1',
      'DELETE FROM context_projects WHERE owner_key = $1',
      'DELETE FROM workspace_members WHERE owner_key = $1',
    ]) await db.query(sql, [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
  }
  await new Promise((resolve) => httpServer.close(resolve));
  const { closeRedisConnections } = require('../../src/config/redis');
  await closeRedisConnections().catch(() => {});
  await db.pool.end().catch(() => {});
});


async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@scan16.test`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active'], orgId,
  );
  await db.query('INSERT INTO users (user_id, email, role, org_id) VALUES ($1, $2, $3, $4)', [userId, email, 'admin', orgId], orgId);
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${label} key`, userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    orgId,
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  created.orgs.add(orgId);
  return { label, orgId, userId, apiKey: key };
}

const rest = (method, path, person) => request(httpServer)[method](path).set('x-api-key', person.apiKey);

let rpcId = 1;
async function mcp(person, name, args = {}) {
  const res = await request(httpServer).post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('x-api-key', person.apiKey)
    .send({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
  let body = res.body;
  if (!body || !Object.keys(body).length) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  const text = (body?.result?.content || []).map((c) => c.text).join('\n') || body?.error?.message || '';
  return { isError: Boolean(body?.error || body?.result?.isError), text, raw: JSON.stringify(body) };
}

async function createProject(person, name) {
  const res = await rest('post', '/api/v1/context/projects', person).send({ project_name: `${name} ${uuidv4().slice(0, 6)}` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.project.project_id;
}

async function brief(person, projectId) {
  const res = await rest('get', `/api/v1/context/projects/${projectId}/inject?format=json`, person);
  return res.body.context || res.body;
}

const rnd = () => uuidv4().replace(/-/g, '');
const AZURE_KEY = () => require('crypto').randomBytes(64).toString('base64');

test('#1 two cards that differ only in a non-secret *_KEY value stay two cards', async () => {
  const person = await makePerson('board');
  const pid = await createProject(person, 'Routing keys');
  const titles = ['Set ROUTING_KEY=orders.created.v1 on the producer', 'Set ROUTING_KEY=orders.deleted.v1 on the producer'];
  const added = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ add_todos: titles.map((title) => ({ title })) });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.redacted, undefined, 'nothing secret was sent, so nothing may be reported masked');
  const decisions = [
    { summary: 'Use S3_OBJECT_KEY=exports/2026-09-23.csv for the nightly export' },
    { summary: 'Use S3_OBJECT_KEY=exports/2026-09-24.csv for the retry export' },
  ];
  const decided = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ recent_decisions: decisions });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));

  const ctx = await brief(person, pid);
  const cards = (ctx.todo_items || []).map((t) => t.title);
  for (const title of titles) assert.ok(cards.includes(title), `card lost or rewritten: ${JSON.stringify(cards)}`);
  const summaries = (ctx.recent_decisions || []).map((d) => d.summary || d);
  for (const { summary } of decisions) assert.ok(summaries.includes(summary), `decision rewritten: ${JSON.stringify(summaries)}`);
});

test('#2 an over-long description is refused with a reason, fast, and nothing is saved', async () => {
  const person = await makePerson('cap');
  const pid = await createProject(person, 'Long text');
  const ok = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ description: 'A short, real description.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const started = Date.now();
  const res = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ description: 'a'.repeat(40000) });
  const took = Date.now() - started;
  assert.equal(res.status, 400, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.error, 'field_too_long');
  assert.equal(res.body.field, 'description');
  assert.equal(res.body.max_length, 4000);
  assert.match(res.body.message, /limit is 4000/);
  assert.ok(took < 3000, `the refusal took ${took}ms`);
  assert.equal((await brief(person, pid)).description, 'A short, real description.');

  // Every free-text field, not only the description — a list entry too.
  const goal = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ goals: ['fine', 'b'.repeat(5000)] });
  assert.equal(goal.status, 400);
  assert.equal(goal.body.field, 'goals');

  // At the limit is fine.
  const edge = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ description: 'c'.repeat(4000) });
  assert.equal(edge.status, 200, JSON.stringify(edge.body).slice(0, 300));
});

test('#4 a partly-refused list whose kept entry was stored masked is in redacted_fields', async () => {
  const person = await makePerson('partial');
  const pid = await createProject(person, 'Partial');
  // A key every round masked, so this pins the reporting and nothing else.
  const key = `sk_live_${rnd().slice(0, 24)}9`;
  const res = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({
    goals: [`Rotate ${key} on the uploader`, 'connection check'],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok((res.body.refused || []).some((r) => r.field === 'goals'), `expected goals in refused: ${JSON.stringify(res.body.refused)}`);
  assert.equal(res.body.redacted, true);
  assert.deepEqual(res.body.redacted_fields, ['goals']);
  assert.ok(!JSON.stringify(res.body).includes(key.slice(8)), 'the reply echoed the key');

  // A wholly refused scalar is still left out: it was not stored at all.
  const refusedOnly = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ goals: ['connection check'] });
  assert.equal(refusedOnly.body.redacted, undefined);
});

test('#5 an Azure connection string is stored and served masked, the rest of it kept', async () => {
  const person = await makePerson('azure');
  const pid = await createProject(person, 'Azure uploads');
  const key = AZURE_KEY();
  const conn = `DefaultEndpointsProtocol=https;AccountName=acmeprod;AccountKey=${key};EndpointSuffix=core.windows.net`;
  const res = await rest('patch', `/api/v1/context/projects/${pid}/context`, person).send({ current_status: `Blob uploads use ${conn}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.redacted_fields, ['current_status']);
  const needle = key.slice(10, 50);
  const served = await brief(person, pid);
  assert.ok(!JSON.stringify(served).includes(needle), 'the brief served the key');
  assert.equal(served.current_status, 'Blob uploads use DefaultEndpointsProtocol=https;AccountName=acmeprod;AccountKey=[REDACTED];EndpointSuffix=core.windows.net');
  const row = await db.query('SELECT context FROM context_projects WHERE project_id = $1', [pid], 'org-system');
  assert.ok(!JSON.stringify(row.rows[0]).includes(needle), 'the row holds the key');
});

test('#6 hosted manage_tasks add reports what the board holds when masked titles collapse', async () => {
  const person = await makePerson('cards');
  const pid = await createProject(person, 'Cards');
  const s1 = `sk_live_${rnd().slice(0, 24)}1`;
  const s2 = `sk_live_${rnd().slice(0, 24)}2`;
  const r = await mcp(person, 'manage_tasks', {
    action: 'add',
    project_id: pid,
    todos: [`Rotate key ${s1} in billing`, `Rotate key ${s2} in billing`, 'Move CACHE_KEY=user:1234 to redis', 'Move CACHE_KEY=user:5678 to redis'],
  });
  assert.equal(r.isError, false, r.text);
  assert.ok(!r.text.includes(s1) && !r.text.includes(s2), `the reply quoted a key: ${r.text}`);
  const cards = ((await brief(person, pid)).todo_items || []).map((t) => t.title);
  assert.deepEqual(cards.sort(), ['Move CACHE_KEY=user:1234 to redis', 'Move CACHE_KEY=user:5678 to redis', 'Rotate key [REDACTED] in billing'].sort());
  // Three cards on the board, three announced — not four.
  const added = r.text.split('\n').find((line) => line.startsWith('Added to'));
  assert.equal((added.match(/→/g) || []).length, 3, r.text);
  assert.match(r.text, /Stored as one card: "Rotate key \[REDACTED\] in billing" is the same card as "Rotate key \[REDACTED\] in billing"/);
});
