/**
 * POST /api/v1/context/projects/:id/questions/resolve
 *
 * Retiring ONE open question is the only non-destructive alternative to
 * cleanup_context (finish_task), which also clears the task, the command log and
 * the task steps. These tests pin the two properties that make it usable as that
 * alternative: it resolves exactly one question or none at all, and it touches
 * nothing else in the brief.
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');

// One server for the whole file — see tests/layer3-context-sync.test.js for why
// passing the bare `app` to supertest is flaky under per-request listen/close.
const httpServer = app.listen(0);

const db = require('../src/config/db');
const { closeRedisConnections } = require('../src/config/redis');

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
const auth = (req) => req.set('X-Api-Key', API_KEY);
const BASE = '/api/v1/context';

// A brief with everything a resolve must NOT disturb: a task, task steps, a
// command log, and four questions — two of which share the word "auth" so the
// fuzzy path has something genuinely ambiguous to refuse.
const QUESTIONS = [
  'How should I authenticate with GitHub?',
  'Which auth provider should the dashboard use?',
  'What is causing the CI install step to fail?',
  'Should trails be public by default?',
];
const COMMANDS = [
  { label: 'test', run: 'npm test' },
  { label: 'lint', run: 'npm run lint' },
];
const TASK = 'Let a single open question be resolved';

async function seedProject(name) {
  const created = await auth(request(httpServer).post(`${BASE}/projects`))
    .send({ project_name: `${name} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
  assert.strictEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const projectId = (created.body.project || {}).project_id || created.body.project_id;
  assert.ok(projectId, 'expected project_id');

  const patched = await auth(request(httpServer).patch(`${BASE}/projects/${projectId}/context`))
    .send({
      current_task: TASK,
      task_steps: [
        { name: 'read the route', status: 'done' },
        { name: 'fix the fan-out', status: 'in_progress' },
      ],
      commands: COMMANDS,
      open_questions: QUESTIONS,
      goals: ['ship the narrow resolve path'],
    });
  assert.strictEqual(patched.status, 200, `patch failed: ${JSON.stringify(patched.body)}`);
  return projectId;
}

// Re-read straight from storage, so every assertion about persistence is about
// what was actually saved rather than what the write path echoed back.
async function readContext(projectId) {
  const res = await auth(request(httpServer).get(`${BASE}/projects/${projectId}/inject?format=json`));
  assert.strictEqual(res.status, 200, `read-back failed: ${JSON.stringify(res.body)}`);
  return res.body.context;
}

const resolve = (projectId, question, answer) =>
  auth(request(httpServer).post(`${BASE}/projects/${projectId}/questions/resolve`)).send({ question, answer });

test('questions/resolve — resolves one question, never a fan-out', async (t) => {
  const created = [];

  t.after(async () => {
    for (const id of created) {
      await auth(request(httpServer).delete(`${BASE}/projects/${id}`)).catch(() => {});
    }
    await closeRedisConnections();
    await db.pool.end();
    await new Promise((resolve_) => httpServer.close(resolve_));
  });

  const project = async (name) => {
    const id = await seedProject(name);
    created.push(id);
    return id;
  };

  // ─── The core guarantee ───────────────────────────────────────────────────

  await t.test('an exact match resolves that question and leaves the rest of the brief untouched', async () => {
    const projectId = await project('resolve-exact');
    const target = 'What is causing the CI install step to fail?';

    const res = await resolve(projectId, target, 'A billing block on Actions, fixed 08-24.');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.resolved, target);

    const ctx = res.body.project.context;
    // The one question is gone...
    assert.ok(!ctx.open_questions.includes(target), 'resolved question should be removed');
    // ...and the other three are all still there, in order.
    assert.deepStrictEqual(
      ctx.open_questions,
      QUESTIONS.filter((q) => q !== target),
      'no other question may be removed'
    );
    // Nothing else attached to the task may be disturbed — this is the whole
    // difference between this endpoint and finish_task.
    assert.strictEqual(ctx.current_task, TASK, 'current_task must survive');
    assert.deepStrictEqual(
      (ctx.commands || []).map((c) => c.label).sort(),
      ['lint', 'test'],
      'command log must survive'
    );
    assert.ok((ctx.task_steps || []).length >= 2, 'task_steps must survive');
    assert.ok((ctx.goals || []).includes('ship the narrow resolve path'), 'goals must survive');

    // The answer is recorded as a decision, against the question it answered.
    const decision = (ctx.recent_decisions || []).find((d) => d.reasoning === target);
    assert.ok(decision, 'expected a decision recorded for the resolved question');
    assert.match(decision.summary, /billing block/i);

    // And it is durable, not just in the response body.
    const persisted = await readContext(projectId);
    assert.ok(persisted, 'expected to re-read the project');
    assert.ok(!persisted.open_questions.includes(target), 'removal must persist');
    assert.strictEqual(persisted.open_questions.length, QUESTIONS.length - 1);
    assert.strictEqual(persisted.current_task, TASK, 'current_task must persist');
  });

  // ─── Ambiguity refuses, and refuses completely ────────────────────────────

  await t.test('an ambiguous query resolves NOTHING and returns the candidates', async () => {
    const projectId = await project('resolve-ambiguous');

    // "auth" appears in two different questions.
    const res = await resolve(projectId, 'auth', 'Use Clerk.');
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'question_ambiguous');
    assert.strictEqual(res.body.candidates.length, 2, 'expected both auth questions back');
    assert.ok(res.body.candidates.every((c) => /auth/i.test(c)));

    // Nothing was removed, and no decision was invented.
    const ctx = await readContext(projectId);
    assert.deepStrictEqual(ctx.open_questions, QUESTIONS, 'an ambiguous query must remove nothing');
    assert.ok(
      !(ctx.recent_decisions || []).some((d) => /Use Clerk/.test(d.summary || '')),
      'a refused resolve must not record a decision'
    );
  });

  // ─── The wipe that whitespace used to cause ───────────────────────────────

  await t.test('a whitespace-only question is rejected and wipes nothing', async () => {
    const projectId = await project('resolve-blank');

    const res = await resolve(projectId, '   ', 'anything');
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));

    const ctx = await readContext(projectId);
    assert.deepStrictEqual(ctx.open_questions, QUESTIONS, 'a blank query must not empty the list');
  });

  // ─── A miss is a miss, not a silent success ───────────────────────────────

  await t.test('a query that matches nothing returns 404 and records no decision', async () => {
    const projectId = await project('resolve-miss');

    const res = await resolve(projectId, 'Should we migrate to Kubernetes?', 'No.');
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'question_not_found');

    const ctx = await readContext(projectId);
    assert.deepStrictEqual(ctx.open_questions, QUESTIONS);
    assert.ok(
      !(ctx.recent_decisions || []).some((d) => /Kubernetes/i.test(d.reasoning || '')),
      'a missed resolve must not record a decision'
    );
  });

  // ─── Fuzzy still works when it points at exactly one ──────────────────────

  await t.test('an unambiguous partial match still resolves', async () => {
    const projectId = await project('resolve-fuzzy');

    const res = await resolve(projectId, 'trails be public', 'Yes, opt-in per project.');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.resolved, 'Should trails be public by default?');

    const ctx = res.body.project.context;
    assert.strictEqual(ctx.open_questions.length, QUESTIONS.length - 1);
    assert.ok(!ctx.open_questions.includes('Should trails be public by default?'));
    assert.strictEqual(ctx.current_task, TASK);
  });

  // ─── Resolving twice does not cascade ─────────────────────────────────────

  await t.test('resolving each question in turn drains the list one at a time', async () => {
    const projectId = await project('resolve-serial');

    let remaining = QUESTIONS.length;
    for (const q of QUESTIONS) {
      const res = await resolve(projectId, q, `answer for ${q}`);
      assert.strictEqual(res.status, 200, `resolving "${q}" failed: ${JSON.stringify(res.body)}`);
      remaining -= 1;
      assert.strictEqual(
        res.body.project.context.open_questions.length,
        remaining,
        `expected exactly one question removed per call (at "${q}")`
      );
    }
    const ctx = await readContext(projectId);
    assert.deepStrictEqual(ctx.open_questions, [], 'all questions resolved, one call each');
    assert.strictEqual(ctx.current_task, TASK, 'draining every question must not clear the task');
  });

  // ─── 404 on an unknown project ────────────────────────────────────────────

  await t.test('an unknown project returns 404, not a 500', async () => {
    const res = await resolve('project_00000000-0000-4000-8000-000000000000', 'anything', 'answer');
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
  });
});
