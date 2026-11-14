'use strict';

// A REFUSAL IS NOT A MYSTERY, SO IT MUST NOT BE REPORTED AS ONE.
//
// Setting a task whose text the server declines used to answer "the write
// returned without error but the brief still reads differently" — which is what
// you say when you do not know what happened. The server knew exactly what
// happened: it had refused the field. A caller told only that the brief reads
// differently retries the same words forever.
//
// Paired with tests/unit/explicit-write-chatter-filter.test.js, which pins the
// other half: the refused value no longer erases the task that was there.
//
// Drives the real dispatcher with the service layer stubbed.

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../src/services/contextSyncService');

let stored = {};
let refused = [];
service.resolveActiveProject = async () => ({ project_id: 'proj-1', project_name: 'Aurora' });
const applyPatch = async (actor, projectId, delta) => {
  if (!refused.length) stored = { ...stored, ...delta };
  return { project_id: projectId, project_name: 'Aurora', context: { ...stored }, ...(refused.length ? { refused } : {}) };
};
service.updateProjectContext = applyPatch;
service.getProject = async (actor, projectId) => ({
  project_id: projectId,
  project_name: 'Aurora',
  context: { ...stored },
});
service.recordExplicitUpdate = async (actor, input) => ({
  project: { project_id: input.project_id, project_name: 'Aurora', context: { ...stored } },
  stored: true,
  redacted: false,
});

const { dispatchTool } = require('../../src/routes/mcp');

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1', scopes: ['context:read', 'context:write'] };
const textOf = (result) => result.content.map((c) => c.text).join('\n');
const setTask = (task) => dispatchTool('update_context', { project_id: 'proj-1', task }, ACTOR, 'claude_web');
// The SAME call with a summary riding along. One argument more, and the whole
// reply used to change shape.
const setTaskWithSummary = (task) => dispatchTool(
  'update_context',
  { project_id: 'proj-1', task, summary: 'Decision: the deploy pipeline gates on a smoke test before promoting a build.' },
  ACTOR,
  'claude_web',
);

beforeEach(() => {
  stored = { current_task: 'Ship the teams invite flow' };
  refused = [];
  service.updateProjectContext = applyPatch;
});

test('a refused task is reported with the reason and the task that still stands', async () => {
  refused = [{ field: 'current_task', reason: 'it reads as connection-test chatter rather than project context' }];
  const text = textOf(await setTask('auth check OK'));

  assert.match(text, /NOT changed/);
  assert.match(text, /connection-test chatter/, 'THE BUG: a refusal was reported as an unexplained mismatch');
  assert.match(text, /Ship the teams invite flow/, 'the caller is told what the brief still reads');
  assert.doesNotMatch(text, /returned without error/, 'that sentence is for an unexplained mismatch, not a refusal');
});

test('an unexplained mismatch still reads as an unexplained mismatch', async () => {
  service.updateProjectContext = async (actor, projectId) => ({
    project_id: projectId, project_name: 'Aurora', context: { current_task: 'something else entirely' },
  });
  const text = textOf(await setTask('cut the 2.0.2 submission'));
  assert.match(text, /NOT changed/);
  assert.match(text, /returned without error/);
});

test('a task the server accepts still reports plainly', async () => {
  const text = textOf(await setTask('Add a smoke test for the billing webhook'));
  assert.match(text, /Current task set for "Aurora": "Add a smoke test for the billing webhook"\./);
});

// THE SAME REFUSAL, WITH A SUMMARY RIDING ALONG.
//
// The refusal was printed on the task-only branch alone. Send a summary in the
// same call and the reply read "Context updated for Aurora" and stopped there —
// a plain success over a task that was never written, which is the shape of
// every silent-failure bug this file exists to close.
test('a refused task is still reported when a summary rides along', async () => {
  refused = [{ field: 'current_task', reason: 'it reads as connection-test chatter rather than project context' }];
  const text = textOf(await setTaskWithSummary('auth check OK'));

  assert.match(text, /Context updated/, 'the summary really did land, and still says so');
  assert.match(text, /Current task NOT changed/, 'THE BUG: a refused task was silent behind a successful summary');
  assert.match(text, /connection-test chatter/, 'and it says why');
  assert.match(text, /Ship the teams invite flow/, 'and what the brief still reads');
});

test('an unexplained mismatch alongside a summary is reported too', async () => {
  service.updateProjectContext = async (actor, projectId) => ({
    project_id: projectId, project_name: 'Aurora', context: { current_task: 'something else entirely' },
  });
  const text = textOf(await setTaskWithSummary('cut the 2.0.2 submission'));
  assert.match(text, /Current task NOT changed/);
  assert.match(text, /returned without error/);
});

test('a task that lands alongside a summary still reads as a plain success', async () => {
  const text = textOf(await setTaskWithSummary('Add a smoke test for the billing webhook'));
  assert.match(text, /Context updated/);
  assert.match(text, /Current task → "Add a smoke test for the billing webhook"/);
  assert.doesNotMatch(text, /NOT changed/);
});
