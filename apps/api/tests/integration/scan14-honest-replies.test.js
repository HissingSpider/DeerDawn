/**
 * Scan 14 (2026-09-23), HONEST REPLIES — the API's half. Each test pins one
 * defect with the request that exposed it:
 *
 *   #1 MED   PATCH /:id/context answered with the in-memory project the service
 *            handed to saveProject, not the row saveProject wrote. Storage
 *            redaction happens on the way to the row, so the reply carried the
 *            task as SENT while the brief held it masked — and gave no sign the
 *            two differ. The local dispatcher compared its read-back with the
 *            literal task and reported "Current task NOT changed" over a write
 *            that had landed. The response now carries the STORED project and
 *            `redacted: true` + `redacted_fields` when redaction changed it.
 *   #2 MED   hosted finish_task with NO current task wrote the shipped item
 *            "Task completed in <project>" at confidence 1, which the next
 *            catch-up reported as finished work nobody did.
 *   #3 LOW   write replies quoted credentials the brief stores masked: the
 *            /extraction delta (printed by the local dispatcher as its reply),
 *            hosted manage_tasks add, and resolve_question (hosted + REST).
 *
 * The credential is a real-shaped GitHub PAT — a true positive under every
 * version of the redaction patterns, before or after the over-broad kebab-case
 * matches are narrowed.
 *
 * Run: bash scripts/run-db-test.sh node --test tests/integration/scan14-honest-replies.test.js
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

const GHP = `ghp_${uuidv4().replace(/-/g, '').slice(0, 36)}`;
const NEEDLE = GHP.slice(4);

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@scan14.test`;
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

// ── #1 ──────────────────────────────────────────────────────────────────────

test('#1 PATCH answers with the STORED value and flags that redaction changed it', async () => {
  const person = await makePerson('patch');
  const pid = await createProject(person, 'Patch');
  const task = `Rotate the leaked token ${GHP} today`;

  for (const path of [`/api/v1/context/${pid}/context`, `/api/v1/context/projects/${pid}/context`]) {
    const res = await rest('patch', path, person).send({ current_task: task, goals: [`Kill ${GHP}`] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!JSON.stringify(res.body).includes(NEEDLE), `${path} echoed the credential it stored masked`);
    assert.equal(res.body.project.context.current_task, 'Rotate the leaked token [REDACTED] today');
    assert.equal(res.body.redacted, true, `${path} gave no sign the stored value differs from the sent one`);
    assert.ok(res.body.redacted_fields.includes('current_task'));
    assert.ok(res.body.redacted_fields.includes('goals'));
  }
  // And the response is the row: a read returns exactly what the PATCH said.
  const stored = await brief(person, pid);
  assert.equal(stored.current_task, 'Rotate the leaked token [REDACTED] today');

  // Nothing to redact: no flag, and the value is returned as sent.
  const plain = await rest('patch', `/api/v1/context/${pid}/context`, person).send({ current_task: 'Ship the importer' });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.project.context.current_task, 'Ship the importer');
  assert.equal(plain.body.redacted, undefined);
  assert.equal(plain.body.redacted_fields, undefined);
});

// ── #2 ──────────────────────────────────────────────────────────────────────

test('#2 hosted finish_task with no current task records nothing as shipped', async () => {
  const person = await makePerson('finish');
  const pid = await createProject(person, 'Finish empty');

  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid });
  const r = await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid, complete_task: true, confirm_complete: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /No current task was set, so nothing was recorded as shipped\./);
  assert.doesNotMatch(r.text, /Task marked as completed/);
  const after = await brief(person, pid);
  assert.deepEqual(after.shipped || [], [], `an invented shipped item: ${JSON.stringify(after.shipped)}`);
  // The rest of the completion still ran, as before.
  assert.equal(after.task_progress, 'completed');

  // A real task still ships, once, under its own text.
  const pid2 = await createProject(person, 'Finish real');
  await rest('patch', `/api/v1/context/${pid2}/context`, person).send({ current_task: 'Ship the importer' });
  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid2 });
  const r2 = await mcp(person, 'manage_memory', { action: 'finish_task', project_id: pid2, complete_task: true, confirm_complete: true });
  assert.equal(r2.isError, false, r2.text);
  const after2 = await brief(person, pid2);
  assert.deepEqual((after2.shipped || []).map((s) => s.summary || s), ['Ship the importer']);
});

// ── #3 ──────────────────────────────────────────────────────────────────────

test('#3 /extraction relays the applied delta as stored', async () => {
  const person = await makePerson('extract');
  const pid = await createProject(person, 'Extract');
  const res = await rest('post', '/api/v1/context/extraction', person).send({
    session_id: `agent-${uuidv4()}`,
    tool: 'claude_code',
    project_id: pid,
    chunks: [{ role: 'user', text: 'Rotate the key, it leaked.' }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.95,
      should_create_project: false,
      needs_user_confirmation: false,
      delta: { goals: [`Local goal ${GHP}`], current_status: `blocked on ${GHP}` },
    },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.ok(!JSON.stringify(res.body).includes(NEEDLE), 'the /extraction reply echoed the credential');
  assert.deepEqual(res.body.extraction.delta.goals, ['Local goal [REDACTED]']);
});

test('#3 hosted manage_tasks add quotes the card as stored, and finds it on the board', async () => {
  const person = await makePerson('tasks');
  const pid = await createProject(person, 'Tasks');
  const r = await mcp(person, 'manage_tasks', { action: 'add', project_id: pid, todos: [`Delete ${GHP}`] });
  assert.equal(r.isError, false, r.text);
  assert.ok(!r.raw.includes(NEEDLE), `the add reply echoed the credential: ${r.text}`);
  assert.match(r.text, /Added to ".*": "Delete \[REDACTED\]"/);
  assert.doesNotMatch(r.text, /Not on the board after the write/);
});

test('#3 resolve_question never quotes the credential, and matches the stored question', async () => {
  const person = await makePerson('resolve');
  const pid = await createProject(person, 'Resolve');
  const question = `Is ${GHP} revoked yet?`;
  await rest('patch', `/api/v1/context/${pid}/context`, person).send({ open_questions: [question, 'Who owns the rollback?'] });
  assert.deepEqual((await brief(person, pid)).open_questions, ['Is [REDACTED] revoked yet?', 'Who owns the rollback?']);

  // Hosted: a miss quotes the question masked.
  const miss = await mcp(person, 'manage_memory', { action: 'resolve_question', project_id: pid, question: `Was ${GHP} ever in CI?`, answer: 'No' });
  assert.ok(!miss.raw.includes(NEEDLE), `the hosted miss echoed the credential: ${miss.text}`);
  assert.match(miss.text, /No open question matches "Was \[REDACTED\] ever in CI\?"/);

  // Hosted: the question pasted back with the key in clear resolves the one the
  // brief holds masked.
  const hit = await mcp(person, 'manage_memory', { action: 'resolve_question', project_id: pid, question, answer: `Yes, ${GHP} revoked` });
  assert.ok(!hit.raw.includes(NEEDLE), `the hosted reply echoed the credential: ${hit.text}`);
  assert.match(hit.text, /Resolved: "Is \[REDACTED\] revoked yet\?"/);
  assert.deepEqual((await brief(person, pid)).open_questions, ['Who owns the rollback?']);

  // REST: the same, on the route the local dispatcher calls.
  await rest('patch', `/api/v1/context/${pid}/context`, person).send({ open_questions: [question, 'Who owns the rollback?'] });
  const restMiss = await rest('post', `/api/v1/context/projects/${pid}/questions/resolve`, person).send({ question: `Was ${GHP} ever in CI?`, answer: 'No' });
  assert.equal(restMiss.status, 404);
  assert.ok(!JSON.stringify(restMiss.body).includes(NEEDLE), 'the REST miss echoed the credential');
  const restHit = await rest('post', `/api/v1/context/projects/${pid}/questions/resolve`, person).send({ question, answer: `Yes, ${GHP} revoked` });
  assert.equal(restHit.status, 200, JSON.stringify(restHit.body));
  assert.ok(!JSON.stringify(restHit.body).includes(NEEDLE), 'the REST reply echoed the credential');
  assert.equal(restHit.body.resolved, 'Is [REDACTED] revoked yet?');
});
