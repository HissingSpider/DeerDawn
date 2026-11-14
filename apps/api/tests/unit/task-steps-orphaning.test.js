process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

/**
 * Changing the task left its sub-steps behind, and they rendered as board cards
 * (2026-08-29).
 *
 * task_steps are the DERIVED sub-steps of one specific current_task, and
 * buildTaskBoard folds them into the board as cards. But task_steps was absent
 * from the PATCHABLE list, so nothing except extraction could ever write it —
 * meaning a direct task change (itself only possible since the current_task fix
 * earlier the same day) left the old steps in place describing work nobody asked
 * for. Five such phantom cards were live on the DeerDawn board, sub-steps of a
 * task that had been replaced.
 *
 * The only way to clear them was finish_task, which also discards the open
 * questions and command log attached to the task — the same all-or-nothing trap
 * that made the task field itself go stale.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');
const db = require('../../src/config/db');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('../helpers/runtimeAvailability');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
const auth = (req) => req.set('X-Api-Key', API_KEY);

async function makeProject(name) {
  const res = await auth(request(httpServer).post('/api/v1/context/projects')).send({ project_name: name });
  return res.body?.project_id || res.body?.project?.project_id;
}

const STEPS = [
  { name: 'Implement Today tab changes', status: 'todo' },
  { name: 'Implement Portfolio tab changes', status: 'todo' },
];

test('task steps', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'task steps')) return;
  if (!await ensureDatabaseAvailable(t, db, 'task steps')) return;

  await t.test('task_steps can be written directly, not only by extraction', async () => {
    const id = await makeProject(`Steps Direct ${uuidv4().slice(0, 8)}`);
    assert.ok(id, 'project created');

    const res = await auth(request(httpServer).patch(`/api/v1/context/projects/${id}/context`))
      .send({ current_task: 'Ship the steps fix', task_steps: STEPS });
    assert.ok(res.status >= 200 && res.status < 300, `got ${res.status}: ${JSON.stringify(res.body)}`);

    const read = await auth(request(httpServer).get(`/api/v1/context/projects/${id}/inject?format=json`));
    assert.equal(read.body.context.task_steps.length, 2, 'steps were stored');
  });

  await t.test('changing the task clears steps that belonged to the old one', async () => {
    const id = await makeProject(`Steps Orphan ${uuidv4().slice(0, 8)}`);
    await auth(request(httpServer).patch(`/api/v1/context/projects/${id}/context`))
      .send({ current_task: 'Commit the spec docs', task_steps: STEPS });

    await auth(request(httpServer).patch(`/api/v1/context/projects/${id}/context`))
      .send({ current_task: 'Something else entirely' });

    const read = await auth(request(httpServer).get(`/api/v1/context/projects/${id}/inject?format=json`));
    assert.deepEqual(
      read.body.context.task_steps,
      [],
      'steps of the replaced task must not survive it — they render as board cards'
    );
  });

  await t.test('an explicit task_steps in the same request wins', async () => {
    const id = await makeProject(`Steps Explicit ${uuidv4().slice(0, 8)}`);
    await auth(request(httpServer).patch(`/api/v1/context/projects/${id}/context`))
      .send({ current_task: 'First task', task_steps: STEPS });

    await auth(request(httpServer).patch(`/api/v1/context/projects/${id}/context`))
      .send({ current_task: 'Second task', task_steps: [{ name: 'A fresh step', status: 'todo' }] });

    const read = await auth(request(httpServer).get(`/api/v1/context/projects/${id}/inject?format=json`));
    assert.equal(read.body.context.task_steps.length, 1);
    assert.equal(read.body.context.task_steps[0].name, 'A fresh step');
  });

  await t.test('re-sending the SAME task leaves its steps alone', async () => {
    // Clearing on every task write would destroy steps on an idempotent update.
    const id = await makeProject(`Steps Same ${uuidv4().slice(0, 8)}`);
    await auth(request(httpServer).patch(`/api/v1/context/projects/${id}/context`))
      .send({ current_task: 'Unchanged task', task_steps: STEPS });

    await auth(request(httpServer).patch(`/api/v1/context/projects/${id}/context`))
      .send({ current_task: 'Unchanged task' });

    const read = await auth(request(httpServer).get(`/api/v1/context/projects/${id}/inject?format=json`));
    assert.equal(read.body.context.task_steps.length, 2, 'an unchanged task keeps its steps');
  });
});
