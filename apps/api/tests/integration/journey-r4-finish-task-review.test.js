/**
 * JOURNEY R4 (BLOCKED 22) — finish_task CLEARED WHAT NOBODY HAD SEEN.
 *
 * finish_task is two calls: the wrap-up review names the open questions, the
 * blocking issue and the command log and says "Completing this task would clear
 * ..."; the confirmation (complete_task + confirm_complete) clears them. It
 * cleared them AS THEY STOOD AT THE CONFIRMATION, so a question added in
 * between — by the person, or by another tool — was cleared without anybody
 * having seen it.
 *
 * The owner's decision: the confirmation clears exactly the items the review
 * showed; anything added since stays, and the reply says what stayed.
 *
 * And the owner's second decision: a confirmation with no review on record for
 * this connection and project is REFUSED and clears nothing (it used to clear
 * everything open at that moment).
 *
 * PARITY: packages/mcp-server/tests/finish-task-review.test.ts pins the same on
 * the local dispatcher; the rule is shared-context taskReview.js.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r4-finish-task-review.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const store = require('../../src/store/contextSyncStore');
const { hashPassword, generateApiKey } = require('../../src/utils/security');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `${label}-${uuidv4().slice(0, 8)}@e2e.test`, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  return { label, orgId, userId };
}

/** A hosted connector (oauth client on the key) or, with `local`, a plain key. */
async function addKey(person, { local = false } = {}) {
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_client_id, oauth_client_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      `key-${uuidv4()}`, prefix, hash, local ? 'local' : 'connector', person.userId, person.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write'],
      local ? null : `https://claude.ai/${uuidv4()}`, local ? null : 'Claude',
    ],
    person.orgId,
  );
  return { apiKey: key };
}

async function cleanup(people) {
  for (const person of people) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await q(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId]).catch(() => {});
    }
    await q('DELETE FROM context_task_reviews WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_session_loads WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await q('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId]).catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
}

async function call(connection, name, args = {}) {
  const res = await request(httpServer)
    .post('/mcp')
    .set({ Accept: 'application/json, text/event-stream' })
    .set('X-Api-Key', connection.apiKey)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return {
    text: (body.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || JSON.stringify(body.error || body),
    isError: body.result?.isError === true || Boolean(body.error),
    data: body.result?.structuredContent,
  };
}

/** Another tool (a local key over REST) changing the brief between the two calls. */
function rest(key, method, path, body) {
  return request(httpServer)[method](path).set('X-Api-Key', key.apiKey).send(body);
}

const TASK = 'Ship the invoice export';
const Q1 = 'Does the export need a migration first?';
const Q2 = 'Who owns the rollback if the release fails?';
const Q_LATE = 'Should archived invoices be exported too?';
const BLOCKER = 'Waiting on the payments team to approve the schema';

async function setup(tag) {
  const person = await makePerson(tag);
  const conn = await addKey(person);
  const other = await addKey(person, { local: true });
  const created = await call(conn, 'manage_projects', { action: 'create', project_name: `Finish ${tag} ${uuidv4().slice(0, 6)}` });
  assert.equal(created.isError, false, created.text);
  const projectId = created.data.project_id;
  const seeded = await rest(other, 'patch', `/api/v1/context/projects/${projectId}/context`, {
    current_task: TASK,
    open_questions: [Q1, Q2],
    blocking_issue: BLOCKER,
    commands: [{ label: 'test', run: 'npm test' }],
  });
  assert.ok(seeded.status < 300, seeded.text);
  return { person, conn, other, projectId };
}

const context = async (fx) => (await store.getProject(fx.person.orgId, fx.projectId)).context;
const confirm = (fx) => call(fx.conn, 'manage_memory', { action: 'finish_task', complete_task: true, confirm_complete: true });

test('BLOCKED 22: a question added between the review and the confirmation stays, and the reply says so', async () => {
  const fx = await setup('late');
  try {
    const review = await call(fx.conn, 'manage_memory', { action: 'finish_task' });
    assert.match(review.text, /Nothing was cleared\. Completing this task would clear 2 open questions, the blocking issue, 1 command log entry\./, review.text);

    // Another tool files a question after the review.
    const late = await rest(fx.other, 'post', '/api/v1/context/extraction', {
      session_id: `agent-${uuidv4().slice(0, 8)}`, tool: 'claude_code', project_id: fx.projectId, explicit: true,
      chunks: [{ role: 'assistant', text: `Open question: ${Q_LATE}` }],
    });
    assert.ok(late.status < 300, late.text);
    assert.deepEqual((await context(fx)).open_questions, [Q1, Q2, Q_LATE]);

    const done = await confirm(fx);
    assert.equal(done.isError, false, done.text);
    const after = await context(fx);
    assert.deepEqual(after.open_questions, [Q_LATE], `THE BUG: the question nobody reviewed was cleared: ${JSON.stringify(after.open_questions)}`);
    assert.equal(after.blocking_issue || '', '', 'the blocker the review showed is cleared');
    assert.deepEqual(after.commands || [], [], 'the command the review counted is cleared');
    assert.equal(after.task_progress, 'completed');
    assert.equal(done.text, [
      `Cleanup complete for ${(await store.getProject(fx.person.orgId, fx.projectId)).project_name}.`,
      `Task remains recorded as completed: "${TASK}".`,
      'Cleared: 2 open questions, the blocking issue, 1 command log entry.',
      `Left as they were (added after the review, so not shown in it): the open question "${Q_LATE}".`,
    ].join('\n'));

    // The reply showed it, so a second confirmation clears it.
    const again = await confirm(fx);
    assert.match(again.text, /Cleared: 1 open question\./, again.text);
    assert.deepEqual((await context(fx)).open_questions, []);
  } finally {
    await cleanup([fx.person]);
  }
});

test('BLOCKED 22: a blocker changed and a command added after the review stay too', async () => {
  const fx = await setup('changed');
  try {
    await call(fx.conn, 'manage_memory', { action: 'finish_task' });
    const changed = await rest(fx.other, 'patch', `/api/v1/context/projects/${fx.projectId}/context`, {
      blocking_issue: 'Waiting on legal to sign off the export format',
      commands: [{ label: 'test', run: 'npm test' }, { label: 'export', run: 'npm run export' }],
    });
    assert.ok(changed.status < 300, changed.text);
    const done = await confirm(fx);
    const after = await context(fx);
    assert.deepEqual(after.open_questions, [], 'both reviewed questions go');
    assert.equal(after.blocking_issue, 'Waiting on legal to sign off the export format', 'THE BUG: a blocker nobody reviewed was cleared');
    assert.deepEqual(after.commands.map((c) => c.label), ['export'], 'the reviewed command goes, the new one stays');
    assert.match(done.text, /Cleared: 2 open questions, 1 command log entry\./, done.text);
    assert.match(done.text, /Left as they were \(added after the review, so not shown in it\): the blocking issue "Waiting on legal to sign off the export format"; 1 command log entry\./, done.text);
  } finally {
    await cleanup([fx.person]);
  }
});

test('BLOCKED 22, the race: a question filed WHILE the confirmation runs is never cleared', async () => {
  const fx = await setup('race');
  try {
    for (let round = 0; round < 6; round += 1) {
      // Re-arm: the reviewed questions are back, and this round's review shows them.
      await rest(fx.other, 'patch', `/api/v1/context/projects/${fx.projectId}/context`, { current_task: `${TASK} ${round}`, open_questions: [Q1, Q2] });
      await call(fx.conn, 'manage_memory', { action: 'finish_task' });
      const racing = `Race question ${round}: does the export need a feature flag?`;
      const [done, filed] = await Promise.all([
        confirm(fx),
        rest(fx.other, 'post', '/api/v1/context/extraction', {
          session_id: `agent-${uuidv4().slice(0, 8)}`, tool: 'claude_code', project_id: fx.projectId, explicit: true,
          chunks: [{ role: 'assistant', text: `Open question: ${racing}` }],
        }),
      ]);
      assert.equal(done.isError, false, done.text);
      assert.ok(filed.status < 300, filed.text);
      const after = await context(fx);
      assert.ok(after.open_questions.includes(racing), `round ${round}: THE BUG: a question filed during the confirmation was cleared (${JSON.stringify(after.open_questions)}; reply: ${done.text})`);
      assert.ok(!after.open_questions.includes(Q1) && !after.open_questions.includes(Q2), `round ${round}: the reviewed questions go (${JSON.stringify(after.open_questions)})`);
      // Clean slate for the next round.
      await rest(fx.other, 'patch', `/api/v1/context/projects/${fx.projectId}/context`, { open_questions: [] });
    }
  } finally {
    await cleanup([fx.person]);
  }
});

const REFUSED = 'Nothing was cleared: this task has not been reviewed here. Call manage_memory with action "finish_task" and without confirm_complete to review what completing it would clear, then confirm with complete_task=true and confirm_complete=true.';

test('a confirmation with no review on record for this connection and project is refused and clears nothing', async () => {
  const fx = await setup('noreview');
  try {
    const confirmHere = () => call(fx.conn, 'manage_memory', { action: 'finish_task', project_id: fx.projectId, complete_task: true, confirm_complete: true });
    const intact = async (why) => {
      const now = await context(fx);
      assert.deepEqual(now.open_questions, [Q1, Q2], `THE BUG (${why}): cleared with no review on record`);
      assert.equal(now.blocking_issue, BLOCKER, why);
      assert.notEqual(now.task_progress, 'completed', why);
    };

    // No review at all.
    let done = await confirmHere();
    assert.equal(done.isError, true, done.text);
    assert.ok(done.text.includes(REFUSED), done.text);
    await intact('no review');

    // A review on ANOTHER connection is not this connection's review.
    const elsewhere = await addKey(fx.person);
    await call(elsewhere, 'manage_memory', { action: 'finish_task', project_id: fx.projectId });
    done = await confirmHere();
    assert.ok(done.isError && done.text.includes(REFUSED), done.text);
    await intact('review on another connection');

    // A review of ANOTHER project on this connection is no review of this one.
    const otherProject = await call(fx.conn, 'manage_projects', { action: 'create', project_name: `Other ${uuidv4().slice(0, 6)}` });
    await call(fx.conn, 'manage_memory', { action: 'finish_task', project_id: otherProject.data.project_id });
    done = await confirmHere();
    assert.ok(done.isError && done.text.includes(REFUSED), done.text);
    await intact('review of another project');

    // With the review, it goes through; a second confirmation has nothing reviewed left.
    await call(fx.conn, 'manage_memory', { action: 'finish_task', project_id: fx.projectId });
    done = await confirmHere();
    assert.equal(done.isError, false, done.text);
    assert.match(done.text, /Cleared: 2 open questions, the blocking issue, 1 command log entry\./, done.text);
    const again = await confirmHere();
    assert.ok(again.isError && again.text.includes(REFUSED), again.text);
  } finally {
    await cleanup([fx.person]);
  }
});

test('the review is remembered as digests only: no question text is stored beside the brief', async () => {
  const fx = await setup('digest');
  try {
    await call(fx.conn, 'manage_memory', { action: 'finish_task' });
    const rows = await q('SELECT reviewed::text AS reviewed FROM context_task_reviews WHERE owner_key = $1 AND project_id = $2', [fx.person.orgId, fx.projectId]);
    assert.equal(rows.rows.length, 1);
    const stored = rows.rows[0].reviewed;
    for (const text of [Q1, Q2, BLOCKER, 'npm test']) assert.ok(!stored.includes(text), `plaintext in the review row: ${text}`);
    const reviewed = JSON.parse(stored);
    assert.equal(reviewed.questions.length, 2);
    assert.match(reviewed.blocker, /^[0-9a-f]{64}$/);
  } finally {
    await cleanup([fx.person]);
  }
});
