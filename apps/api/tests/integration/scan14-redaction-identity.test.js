/**
 * ROUND-14 SCAN: STORAGE-TIME REDACTION REWROTE ORDINARY TEXT AND IDENTITIES.
 *
 * Round 13 made the store run the secret redactor over every string it saves
 * (store.redactForStorage) and over graph canonical keys. Two patterns matched
 * plain text: `sk-` with no left boundary (inside "task-", "risk-", "disk-"), and
 * AUTH_HEADER's bare-whitespace separator ("authorization middleware"). So:
 *
 *   1. canonical keys: "Task queue retry worker" -> `service:ta[REDACTED]`, one
 *      key for every "Task ..." service; distinct entities merged on the unique
 *      index, across projects (a member's PERSONAL task landed in the node owned
 *      by the team's SHARED project), and a relation naming them was dropped
 *      while the call answered 200.
 *   2. text: a card titled "Fix authorization middleware ordering" was stored as
 *      "Fix authorization [REDACTED] ordering" — the add reply said it was not
 *      on the board, a re-add duplicated it, completing it by title found
 *      nothing; re-stating the same task wiped next_action.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/scan14-redaction-identity.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');
const db = require('../../src/config/db');
const svc = require('../../src/services/contextSyncService');
const workspace = require('../../src/services/workspaceService');
const { generateApiKey, generateToken, hashPassword } = require('../../src/utils/security');

const httpServer = app.listen(0);
test.after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  try { await require('../../src/config/redis').closeRedisConnections?.(); } catch { /* ignore */ }
  await db.pool.end().catch(() => {});
});

async function mintKey(userId, orgId) {
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'scan14 key', userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    'org-system',
  );
  return key;
}

async function makePerson(label, plan = 'developer_pro') {
  const orgId = `org-${uuidv4()}`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
    orgId,
  );
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@scan14.test`;
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  return { orgId, userId, email, apiKey: await mintKey(userId, orgId), jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin' }) };
}

const asKey = (method, path, key) => request(httpServer)[method](path).set('Authorization', `Bearer ${key}`);
function asSession(method, path, person, workspaceKey) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (workspaceKey) r = r.set('x-deerdawn-workspace', workspaceKey);
  return r;
}
async function mcp(person, name, args) {
  const res = await request(httpServer).post('/mcp')
    .set({ Accept: 'application/json, text/event-stream' })
    .set('X-Api-Key', person.apiKey)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let payload = res.body && Object.keys(res.body).length ? res.body : null;
  if (!payload) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    payload = JSON.parse(line ? line.slice(6) : res.text);
  }
  return payload.result?.content?.map((c) => c.text).join('\n') || payload.error?.message || '';
}
const serviceNodes = async (ownerKey, nodeType = 'service') => (await db.query(
  'SELECT canonical_key, title, summary FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2 ORDER BY created_at',
  [ownerKey, nodeType], 'org-system',
)).rows;
const newProject = async (p, name) => (await asKey('post', '/api/v1/context/projects', p.apiKey)
  .send({ project_name: `${name}-${uuidv4().slice(0, 5)}` })).body.project.project_id;

test('two distinct "Task ..." / kebab services stay two nodes under their own keys', async () => {
  const p = await makePerson('s14-keys');
  const titles = ['Task queue retry worker', 'Task scheduler cron runner', 'task-runner-queue-worker', 'disk-usage-monitor-agent-v2'];
  for (const title of titles) {
    const r = await asKey('post', '/api/v1/context/workspace/entities', p.apiKey)
      .send({ entities: [{ title, entity_type: 'service', summary: `${title} handles one concern of the pipeline.` }] });
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const rows = await serviceNodes(p.orgId);
  assert.equal(rows.length, titles.length, `one node per service: ${JSON.stringify(rows)}`);
  assert.ok(rows.every((row) => !/redacted/i.test(row.canonical_key) && !/REDACTED/.test(row.title)), JSON.stringify(rows));
  assert.ok(rows.some((row) => row.canonical_key === 'service:task-queue-retry-worker'));
});

test('three distinct kebab services in ONE batch are three nodes (upsert said 3, stored 2)', async () => {
  const p = await makePerson('s14-batch');
  const P = await newProject(p, 'batch');
  const entities = [
    { entity_type: 'service', title: 'task-runner-queue-worker', summary: 'Consumes the Redis job queue and runs each queued import job with retries', scope: 'project', project_id: P },
    { entity_type: 'service', title: 'task-scheduler-cron-worker', summary: 'Fires the nightly cron schedule and enqueues billing reconciliation jobs', scope: 'project', project_id: P },
    { entity_type: 'service', title: 'disk-usage-monitor-agent', summary: 'Reports per-volume disk usage to Prometheus every minute from each node', scope: 'project', project_id: P },
  ];
  const r = await asKey('post', '/api/v1/context/workspace/entities', p.apiKey).send({ entities });
  assert.ok(r.status < 300, JSON.stringify(r.body).slice(0, 300));
  const rows = await serviceNodes(p.orgId);
  assert.deepEqual(rows.map((row) => row.canonical_key).sort(), [
    'service:disk-usage-monitor-agent', 'service:task-runner-queue-worker', 'service:task-scheduler-cron-worker',
  ]);
});

test('a relation between two entities written in the same batch is stored', async () => {
  const p = await makePerson('s14-rel');
  const r = await asKey('post', '/api/v1/context/workspace/entities', p.apiKey).send({
    entities: [
      { title: 'Billing export pipeline', entity_type: 'service', summary: 'Nightly export of invoices to the warehouse.' },
      { title: 'Risk scoring model service', entity_type: 'service', summary: 'Scores accounts before export.' },
    ],
    relations: [{ from_canonical_key: 'service:billing-export-pipeline', to_canonical_key: 'service:risk-scoring-model-service', relation_type: 'depends_on' }],
  });
  assert.ok(r.status < 300, JSON.stringify(r.body).slice(0, 300));
  const edges = (await db.query('SELECT count(*)::int AS c FROM context_graph_edges WHERE owner_key = $1', [p.orgId], 'org-system')).rows[0].c;
  assert.equal(edges, 1, 'the relation was silently dropped');
});

test('titles that differ only in a GENUINE secret stay distinct, and nothing secret is stored in the key', async () => {
  const p = await makePerson('s14-secret-keys');
  const keyA = `sk-proj-${'A1b2C3d4'.repeat(4)}`;
  const keyB = `sk-proj-${'Z9y8X7w6'.repeat(4)}`;
  for (const secret of [keyA, keyB]) {
    const r = await asKey('post', '/api/v1/context/workspace/entities', p.apiKey)
      .send({ entities: [{ title: `Rotate ${secret} for billing`, entity_type: 'service', summary: 'Key rotation for the billing account.' }] });
    assert.ok(r.status < 300, JSON.stringify(r.body).slice(0, 300));
  }
  const rows = await serviceNodes(p.orgId);
  assert.equal(rows.length, 2, `two different secrets must not merge into one node: ${JSON.stringify(rows)}`);
  const dump = JSON.stringify(rows);
  for (const secret of [keyA, keyB]) {
    assert.ok(!dump.includes(secret) && !dump.includes(secret.toLowerCase()), 'the secret reached the stored row');
  }
  assert.ok(rows.every((row) => /^service:redacted-[0-9a-f]{32}$/.test(row.canonical_key)), dump);
  // Re-sending the same one finds the same node rather than adding a third.
  await asKey('post', '/api/v1/context/workspace/entities', p.apiKey)
    .send({ entities: [{ title: `Rotate ${keyA} for billing`, entity_type: 'service', summary: 'Key rotation for the billing account.' }] });
  assert.equal((await serviceNodes(p.orgId)).length, 2, 'a re-send must land on its own node');
});

test('a member\'s PERSONAL task does not land in the node of the team\'s SHARED project', async () => {
  const owner = await makePerson('s14-owner');
  const member = await makePerson('s14-member', 'free');
  const invite = await workspace.createInvite(owner.orgId, member.email, { role: 'member', invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: member.userId, email: member.email });
  assert.equal(accepted.ok, true, accepted.reason);
  const mk = async (who, name) => (await asSession('post', '/api/v1/context/projects', who, owner.orgId)
    .send({ project_name: `${name}-${uuidv4().slice(0, 5)}` })).body.project.project_id;
  const S = await mk(owner, 'shared');
  const P = await mk(member, 'personal');
  await db.query('UPDATE context_projects SET visibility = CASE WHEN project_id = $1 THEN \'shared\' ELSE \'personal\' END WHERE project_id = ANY($2)', [S, [S, P]], 'org-system');
  const actor = (who) => ({ type: 'user', id: who.userId, org_id: who.orgId, workspace_key: owner.orgId });
  const upd = (who, projectId, task) => svc.recordExplicitUpdate(actor(who), {
    project_id: projectId, tool: 'claude_code', session_id: `sess-${uuidv4()}`,
    summary: `Working on: ${task}`,
    extraction: { match_decision: 'matched', confidence: 0.95, project_id: projectId, delta: { current_task: task } },
  });
  await upd(owner, S, 'Task board cleanup and dedupe pass');
  await upd(member, P, 'Task pricing for the Acme renewal, floor is 90k');
  const graph = await asSession('get', `/api/v1/context/graph/projects/${S}`, owner, owner.orgId);
  assert.equal(graph.status, 200);
  assert.ok(!/Acme renewal/.test(JSON.stringify(graph.body)), 'the owner reads the member\'s PERSONAL task through the shared project\'s graph');
  const rows = (await db.query('SELECT project_id, canonical_key FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'task\'', [owner.orgId], 'org-system')).rows;
  assert.ok(rows.every((row) => !/redacted/i.test(row.canonical_key)), JSON.stringify(rows));
});

test('a card titled in plain English (and a kebab one) survives add / re-add / complete', async () => {
  const p = await makePerson('s14-cards');
  const P = await newProject(p, 'cards');
  for (const title of ['Fix authorization middleware ordering', 'Split the task-scheduler-service-worker']) {
    const a1 = await mcp(p, 'manage_tasks', { action: 'add', project_id: P, todos: [title] });
    assert.ok(!/Not on the board/.test(a1), `add reply: ${a1}`);
    assert.ok(a1.includes(`"${title}"`), `add reply: ${a1}`);
    const a2 = await mcp(p, 'manage_tasks', { action: 'add', project_id: P, todos: [title] });
    assert.match(a2, /already exists/, `re-add reply: ${a2}`);
    const c = await mcp(p, 'manage_tasks', { action: 'complete', project_id: P, todos: [title] });
    assert.ok(!/No matching card/.test(c), `complete reply: ${c}`);
  }
  const proj = await svc.getProject({ type: 'user', id: p.userId, org_id: p.orgId }, P);
  const cards = [...(proj.context.todo_items || []), ...(proj.context.completed_todos || [])].map((t) => `${t.phase}:${t.title}`);
  assert.deepEqual(cards.filter((t) => /authorization|task-scheduler/.test(t)).sort(), [
    'done:Fix authorization middleware ordering',
    'done:Split the task-scheduler-service-worker',
  ], JSON.stringify(cards));
});

test('re-stating the SAME task keeps next_action, and the stored task is the text sent', async () => {
  const p = await makePerson('s14-next');
  const P = await newProject(p, 'next');
  for (const task of ['Review authorization handling in the export route', 'Refactor the task-scheduler-service-worker']) {
    let r = await asKey('patch', `/api/v1/context/projects/${P}/context`, p.apiKey).send({ current_task: task, next_action: 'Read routes/export.js first' });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    r = await asKey('patch', `/api/v1/context/projects/${P}/context`, p.apiKey).send({ current_task: task });
    assert.equal(r.status, 200);
    const proj = await svc.getProject({ type: 'user', id: p.userId, org_id: p.orgId }, P);
    assert.equal(proj.context.current_task, task);
    assert.equal(proj.context.next_action, 'Read routes/export.js first', 'the same task re-stated wiped the next step');
  }
});

test('a task carrying a GENUINE secret: stored masked, and re-stating it still keeps next_action', async () => {
  const p = await makePerson('s14-next-secret');
  const P = await newProject(p, 'next-secret');
  const secret = `sk-proj-${'Q1w2E3r4'.repeat(4)}`;
  const task = `Rotate ${secret} in the billing worker`;
  await asKey('patch', `/api/v1/context/projects/${P}/context`, p.apiKey).send({ current_task: task, next_action: 'Revoke the old key first' });
  await asKey('patch', `/api/v1/context/projects/${P}/context`, p.apiKey).send({ current_task: task });
  const proj = await svc.getProject({ type: 'user', id: p.userId, org_id: p.orgId }, P);
  assert.equal(proj.context.current_task, 'Rotate [REDACTED] in the billing worker');
  assert.equal(proj.context.next_action, 'Revoke the old key first', 'the redacted compare read the same task as a new one');
  const row = (await db.query('SELECT context::text AS t FROM context_projects WHERE project_id = $1', [P], 'org-system')).rows[0].t;
  assert.ok(!row.includes(secret), 'the secret reached the stored context');
});

test('ordinary DB / design / identifier text is stored verbatim through every write path', async () => {
  const p = await makePerson('s14-verbatim');
  const P = await newProject(p, 'verbatim');
  const GOAL = 'Migrate to flask-sqlalchemy-async-sessions by Q4';
  const STATUS = 'Partition key: tenant_id; primary key = (org_id, user_id); cache_key: user:123; hotkey=ctrl+shift+k';
  const TASK = 'Ship the risk-assessment-framework-v2';
  const r = await asKey('patch', `/api/v1/context/projects/${P}/context`, p.apiKey)
    .send({ current_task: TASK, current_status: STATUS, goals: [GOAL] });
  assert.equal(r.status, 200);
  const proj = await svc.getProject({ type: 'user', id: p.userId, org_id: p.orgId }, P);
  assert.equal(proj.context.current_task, TASK);
  assert.equal(proj.context.current_status, STATUS);
  assert.ok((proj.context.goals || []).includes(GOAL), JSON.stringify(proj.context.goals));
  const row = (await db.query('SELECT context::text AS t FROM context_projects WHERE project_id = $1', [P], 'org-system')).rows[0].t;
  assert.ok(!row.includes('[REDACTED]'), 'ordinary text was masked at rest');
});
