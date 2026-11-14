/**
 * JOURNEY R4, M1 — finish_task's confirmation printed what the share hides.
 *
 * Round 4 made finish_task's confirmation clear only what its review showed
 * (BLOCKED 22). On the HOSTED dispatcher the confirmation planned from the
 * stored row, while the review had recorded the caller's own, share-filtered
 * view. So for a teammate on a shared project whose share withholds the open
 * questions and the blocker, every hidden item counted as "added after the
 * review", and the reply quoted them:
 *   Left as they were (added after the review, so not shown in it): the open
 *   question "ZEBRA-QUESTION-…"; the blocking issue "ZEBRA-BLOCKER-…".
 * Text the share hides, and a false account of when it was added. The digests
 * of those hidden items were then recorded as this connection's review.
 *
 * Wanted: the reply never carries text from a section the caller cannot view;
 * such sections are named BY SECTION, as `main` names them ("Left as they were
 * (not shared for editing with you): …"); "added after the review" is said only
 * of items the caller can view; no digest of a hidden item is recorded.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r4-finish-task-hidden-sections.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const store = require('../../src/store/contextSyncStore');
const workspace = require('../../src/services/workspaceService');
const { hashPassword, generateApiKey, generateToken } = require('../../src/utils/security');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makeOrgUser(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active', 5],
  );
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  return { label, orgId, userId, email, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin', email }) };
}

/** A hosted connector for `person` in `ws`, write-scoped whatever their role. */
async function hostedKey(person, ws) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_client_id, oauth_client_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [`key-${uuidv4()}`, prefix, hash, `${person.label} connector`, person.userId, ws, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write'], `https://claude.ai/${uuidv4()}`, 'Claude'],
  );
  return key;
}

async function cleanup(people, ws) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
    await q(`DELETE FROM ${table} WHERE owner_key = $1`, [ws]).catch(() => {});
  }
  await q('DELETE FROM context_task_reviews WHERE owner_key = $1', [ws]).catch(() => {});
  await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [ws]).catch(() => {});
  await q('DELETE FROM context_project_share_sections WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [ws]).catch(() => {});
  await q('DELETE FROM context_project_shares WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [ws]).catch(() => {});
  await q('DELETE FROM context_session_loads WHERE owner_key = $1', [ws]).catch(() => {});
  await q('DELETE FROM context_sessions WHERE owner_key = $1', [ws]).catch(() => {});
  await q('DELETE FROM context_projects WHERE owner_key = $1', [ws]).catch(() => {});
  await q('DELETE FROM workspace_members WHERE owner_key = $1', [ws]).catch(() => {});
  for (const person of people) {
    await q('DELETE FROM product_events WHERE org_id = $1 OR user_id = $2', [person.orgId, person.userId]).catch(() => {});
    await q('DELETE FROM api_keys WHERE owner_id = $1', [person.userId]).catch(() => {});
    await q('DELETE FROM users WHERE user_id = $1', [person.userId]).catch(() => {});
    await q('DELETE FROM organizations WHERE org_id = $1', [person.orgId]).catch(() => {});
  }
}

async function hosted(key, name, args, path = '/mcp') {
  const res = await request(httpServer).post(path)
    .set({ Accept: 'application/json, text/event-stream' })
    .set('X-Api-Key', key)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return {
    text: (body.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || JSON.stringify(body.error || {}),
    raw: JSON.stringify(body),
    isError: body.result?.isError === true || Boolean(body.error),
  };
}

const dashboard = (person, ws, method, path) => request(httpServer)[method](path)
  .set('Authorization', `Bearer ${person.jwt}`).set('x-deerdawn-workspace', ws);

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** A team, and a project the owner makes in the dashboard (shared), holding a hidden question and blocker. */
async function setup(tag, { sections } = {}) {
  const owner = await makeOrgUser(`owner-${tag}`);
  const member = await makeOrgUser(`member-${tag}`);
  const viewer = await makeOrgUser(`viewer-${tag}`);
  const ws = owner.orgId;
  await workspace.addMember(ws, owner.userId, { role: 'owner' });
  await workspace.addMember(ws, member.userId, { role: 'member' });
  await workspace.addMember(ws, viewer.userId, { role: 'viewer' });
  const created = await dashboard(owner, ws, 'post', '/api/v1/context/projects').send({ project_name: `Payroll ${tag} ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201, created.text);
  const projectId = created.body.project.project_id;
  assert.equal(created.body.project.visibility, 'shared', 'made in the dashboard, so shared');
  if (sections) {
    const shared = await dashboard(owner, ws, 'patch', `/api/v1/teams/projects/${projectId}/sharing`).send({ visibility: 'shared', sections });
    assert.equal(shared.status, 200, shared.text);
  }
  const mark = uuidv4().slice(0, 8);
  const marks = {
    question: `ZEBRA-QUESTION-${mark} should we drop the vendor before the audit?`,
    blocker: `ZEBRA-BLOCKER-${mark} legal has not cleared the layoffs list`,
  };
  const patched = await dashboard(owner, ws, 'patch', `/api/v1/context/projects/${projectId}/context`).send({
    current_task: 'Close the payroll migration',
    open_questions: [marks.question],
    blocking_issue: marks.blocker,
  });
  assert.ok(patched.status < 300, patched.text);
  return { owner, member, viewer, ws, projectId, marks, people: [owner, member, viewer] };
}

async function assertNothingLeaked(fx, where, replies) {
  for (const reply of replies) {
    for (const text of Object.values(fx.marks)) {
      assert.ok(!reply.raw.includes(text.slice(0, 20)), `THE BUG (${where}): the reply quotes text the share hides:\n${reply.text}`);
    }
  }
  const reviews = await q('SELECT reviewed::text AS reviewed FROM context_task_reviews WHERE owner_key = $1 AND project_id = $2', [fx.ws, fx.projectId]);
  for (const row of reviews.rows) {
    for (const text of Object.values(fx.marks)) {
      assert.ok(!row.reviewed.includes(sha(text)), `THE BUG (${where}): a digest of a hidden item was recorded as this connection's review`);
    }
  }
  const stored = (await store.getProject(fx.ws, fx.projectId)).context;
  assert.deepEqual(stored.open_questions, [fx.marks.question], `${where}: the hidden question is intact`);
  assert.equal(stored.blocking_issue, fx.marks.blocker, `${where}: the hidden blocker is intact`);
}

for (const path of ['/mcp', '/mcp/claude']) {
  test(`M1 (${path}): a member's confirmation on a default share quotes nothing hidden and names the sections, as main does`, async () => {
    const fx = await setup(`m1${path.length}`);
    try {
      const key = await hostedKey(fx.member, fx.ws);
      const review = await hosted(key, 'manage_memory', { action: 'finish_task', project_id: fx.projectId }, path);
      const done = await hosted(key, 'manage_memory', { action: 'finish_task', project_id: fx.projectId, complete_task: true, confirm_complete: true }, path);
      assert.equal(done.isError, false, done.text);
      await assertNothingLeaked(fx, `member ${path}`, [review, done]);
      assert.ok(!/added after the review/.test(done.text), `nothing hidden is "added after the review":\n${done.text}`);
      assert.match(done.text, /^Left as they were \(not shared for editing with you\): command log, open questions, blocker, shipped list\.$/m, done.text);
    } finally {
      await cleanup(fx.people, fx.ws);
    }
  });
}

test('M1: a viewer holding a write-scoped key quotes nothing hidden either', async () => {
  const fx = await setup('viewer');
  try {
    const key = await hostedKey(fx.viewer, fx.ws);
    const review = await hosted(key, 'manage_memory', { action: 'finish_task', project_id: fx.projectId });
    const done = await hosted(key, 'manage_memory', { action: 'finish_task', project_id: fx.projectId, complete_task: true, confirm_complete: true });
    await assertNothingLeaked(fx, 'viewer', [review, done]);
  } finally {
    await cleanup(fx.people, fx.ws);
  }
});

test('M1: a share that narrows sections explicitly: a question the member may read but not edit is not quoted as "added after the review"', async () => {
  const fx = await setup('narrow', {
    sections: [
      { section_key: 'current_task', can_view: true, can_edit: true },
      { section_key: 'current_status', can_view: true, can_edit: true },
      { section_key: 'task_progress', can_view: true, can_edit: true },
      { section_key: 'open_questions', can_view: true, can_edit: false },
    ],
  });
  try {
    const key = await hostedKey(fx.member, fx.ws);
    const review = await hosted(key, 'manage_memory', { action: 'finish_task', project_id: fx.projectId });
    assert.ok(review.text.includes(fx.marks.question), 'the member may read this question, so the review shows it');
    // The owner adds one more question the member may read, after the review.
    const later = `Later question ${uuidv4().slice(0, 6)}?`;
    await dashboard(fx.owner, fx.ws, 'patch', `/api/v1/context/projects/${fx.projectId}/context`).send({ open_questions: [fx.marks.question, later] });
    const done = await hosted(key, 'manage_memory', { action: 'finish_task', project_id: fx.projectId, complete_task: true, confirm_complete: true });
    assert.equal(done.isError, false, done.text);
    for (const reply of [review, done]) assert.ok(!reply.raw.includes(fx.marks.blocker.slice(0, 20)), `the hidden blocker is quoted:\n${reply.text}`);
    assert.ok(!/added after the review/.test(done.text), `a section the member may not edit is named, not quoted:\n${done.text}`);
    assert.match(done.text, /Left as they were \(not shared for editing with you\): [^\n]*open questions[^\n]*blocker/, done.text);
    const stored = (await store.getProject(fx.ws, fx.projectId)).context;
    assert.deepEqual(stored.open_questions, [fx.marks.question, later]);
    assert.equal(stored.blocking_issue, fx.marks.blocker);
  } finally {
    await cleanup(fx.people, fx.ws);
  }
});

test('the owner, who reads everything, still clears what the review showed and is told what came after', async () => {
  const fx = await setup('owner');
  try {
    const key = await hostedKey(fx.owner, fx.ws);
    const review = await hosted(key, 'manage_memory', { action: 'finish_task', project_id: fx.projectId });
    assert.ok(review.text.includes(fx.marks.question));
    const later = `Later question ${uuidv4().slice(0, 6)}?`;
    await dashboard(fx.owner, fx.ws, 'patch', `/api/v1/context/projects/${fx.projectId}/context`).send({ open_questions: [fx.marks.question, later] });
    const done = await hosted(key, 'manage_memory', { action: 'finish_task', project_id: fx.projectId, complete_task: true, confirm_complete: true });
    assert.match(done.text, /Cleared: 1 open question, the blocking issue\./, done.text);
    assert.ok(done.text.includes(`Left as they were (added after the review, so not shown in it): the open question "${later}".`), done.text);
    const stored = (await store.getProject(fx.ws, fx.projectId)).context;
    assert.deepEqual(stored.open_questions, [later]);
    assert.equal(stored.blocking_issue || '', '');
  } finally {
    await cleanup(fx.people, fx.ws);
  }
});
