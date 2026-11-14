/**
 * SCAN 36 (merge). A task longer than 80 characters outlived the brief.
 *
 * A graph node's title is its text clipped to 80 characters plus "...", and
 * cleanupCompletedGraphNodes found the node of a task the brief had moved on
 * from by a substring test between that clipped title and the full old task.
 * Past 80 characters it can pass in neither direction, so every long task
 * stayed an OPEN task node forever. When the model mirrored a decision into
 * current_task (it does, often, for a one-line update), an untyped resolve of
 * that decision by its full text was then refused as ambiguous with the stale
 * task (round 28's openNonDecisionsNamed guard) — long after the task was gone
 * from the brief. The old node is now also found by the key it was filed under.
 *
 * The extraction is supplied, not asked of a live model, so the pins do not
 * depend on what the model says this time.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan36-merge-fixes.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');

const q = (sql, params) => db.query(sql, params, 'org-system');
const tag = () => uuidv4().slice(0, 6);

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active', 5],
  );
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return { orgId, userId, email, jwt, key, actor: { type: 'user', id: userId, org_id: orgId, workspace_key: orgId } };
}

async function newProject(person, name) {
  const created = await request(httpServer).post('/api/v1/context/projects')
    .set('Authorization', `Bearer ${person.jwt}`).set('x-deerdawn-workspace', person.orgId)
    .send({ project_name: `${name} ${tag()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

async function mcpCall(person, name, args, path = '/mcp') {
  const r = await request(httpServer).post(path).set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${person.key}`).set('x-deerdawn-workspace', person.orgId)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  return (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
}

// What a live model returns for a one-line update, often: the words as the
// decision AND as the current task.
const update = (person, projectId, summary) => service.recordExplicitUpdate(person.actor, {
  project_id: projectId,
  tool: 'claude_code',
  session_id: `sess-${uuidv4()}`,
  summary,
  extraction: {
    match_decision: 'matched_existing',
    confidence: 0.95,
    project_candidate: { project_id: projectId },
    delta: { current_task: summary, recent_decisions: [{ summary, importance: 'normal' }] },
    should_create_project: false,
    needs_user_confirmation: false,
  },
});

const taskNodes = async (ownerKey, projectId) => (await q(
  `SELECT title, canonical_key, metadata->>'status' AS status FROM context_graph_nodes
    WHERE owner_key = $1 AND project_id = $2 AND node_type = 'task'`,
  [ownerKey, projectId],
)).rows;

// recordExplicitUpdate does not await cleanupCompletedGraphNodes: it is fired
// and forgotten after the graph write, so the old task's node is retired a
// moment AFTER the update returns. Reading once, immediately, raced it: a fast
// machine finished the cleanup first, a loaded CI runner did not, and both of
// these tests failed on GitHub while passing every time locally. Poll until the
// expected state appears (or a generous deadline passes, so a real regression
// still fails, with the last state seen in the message).
async function eventually(read, done, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await read();
  }
  return last;
}

for (const length of ['long', 'short']) {
  test(`a ${length} task the brief moved on from leaves no open task node behind`, async () => {
    const S = await makePerson(`s36m${length}`);
    const A = await newProject(S, 'A');
    const t = tag();
    const X = length === 'long'
      ? `Route every outbound webhook ${t} through the shared delivery queue in staging only.`
      : `Queue webhooks ${t} in staging`;
    const Y = length === 'long'
      ? `Route every outbound webhook ${t} through the shared delivery queue in production too.`
      : `Queue webhooks ${t} in production`;
    if (length === 'long') assert.ok(X.length > 80 && Y.length > 80, 'precondition: past the 80-character title clip');
    await update(S, A, X);
    assert.equal((await store.getProject(S.orgId, A)).context.current_task, X, 'precondition: the task was set');
    assert.equal((await taskNodes(S.orgId, A)).length, 1, 'precondition: the task has a node');
    await update(S, A, Y);
    assert.equal((await store.getProject(S.orgId, A)).context.current_task, Y, 'precondition: the brief moved on');
    const expected = [`task:${require('../../src/services/contextGraphService').normalizeKey(Y)}`];
    const nodes = await eventually(
      () => taskNodes(S.orgId, A),
      (rows) => JSON.stringify(rows.map((n) => n.canonical_key)) === JSON.stringify(expected),
    );
    assert.deepEqual(
      nodes.map((n) => n.canonical_key),
      expected,
      `only the current task stays a task node: ${JSON.stringify(nodes)}`,
    );
  });
}

for (const path of ['/mcp', '/mcp/claude']) {
  test(`(${path}) an untyped resolve of a decision by its full words is not refused over a task the brief already left`, async () => {
    const S = await makePerson('s36mres');
    const A = await newProject(S, 'A');
    const t = tag();
    const X = `Route every outbound webhook ${t} through the shared delivery queue in staging only.`;
    const Y = `Route every outbound webhook ${t} through the shared delivery queue in production too.`;
    await update(S, A, X);
    await update(S, A, Y);
    // The premise is a task the brief ALREADY left, i.e. the fire-and-forget
    // cleanup has retired X's node. Resolving before it lands races it the same
    // way the two tests above did (reproduced by delaying the cleanup 500ms).
    const expected = [`task:${require('../../src/services/contextGraphService').normalizeKey(Y)}`];
    const settled = await eventually(
      () => taskNodes(S.orgId, A),
      (rows) => JSON.stringify(rows.map((n) => n.canonical_key)) === JSON.stringify(expected),
    );
    assert.deepEqual(settled.map((n) => n.canonical_key), expected, `precondition: X's task node retired: ${JSON.stringify(settled)}`);
    const reply = await mcpCall(S, 'manage_memory', { action: 'resolve', title: X, project_id: A }, path);
    assert.match(reply, /Marked resolved/, reply);
    assert.doesNotMatch(reply, /open entries/, reply);
    const decisions = (await store.getProject(S.orgId, A)).context.recent_decisions || [];
    assert.equal(decisions.find((d) => d.summary === X)?.resolved, true, JSON.stringify(decisions));
    assert.notEqual(decisions.find((d) => d.summary === Y)?.resolved, true, JSON.stringify(decisions));
  });
}
