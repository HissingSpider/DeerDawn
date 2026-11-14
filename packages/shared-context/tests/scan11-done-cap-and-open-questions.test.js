'use strict';

// Round-11 scan, the shared-context halves (used by BOTH dispatchers):
//   4. the Done-cap trim evicted a card and told no caller which one;
//   6. the conversational brief (hosted start_session, standard verbosity)
//      never rendered an open question, though start_session promises them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeContextObject, formatConversationalInjection, createContextObject } = require('../src/index.js');

function boardAtCap() {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const done = Array.from({ length: 100 }, (_, i) => ({
    id: `done-${i}`, title: `Finished ${i}`, phase: 'done',
    created_at: new Date(base + i * 60_000).toISOString(),
    completed_at: new Date(base + i * 60_000).toISOString(),
  }));
  return createContextObject({
    project_name: 'Cap',
    todo_items: [...done, { id: 'open-1', title: 'Open card', phase: 'backlog', created_at: new Date().toISOString() }],
  });
}

test('a merge that trims Done reports exactly which cards it evicted', () => {
  const outcome = {};
  const merged = mergeContextObject(boardAtCap(), { complete_todos: ['open-1'] }, '', { outcome });
  assert.deepStrictEqual(outcome.evicted_done, [{ id: 'done-0', title: 'Finished 0' }]);
  assert.deepStrictEqual(outcome.evicted_open, []);
  assert.ok(!merged.todo_items.some((c) => c.id === 'done-0'));
  assert.ok(merged.todo_items.some((c) => c.id === 'open-1' && c.phase === 'done'));
  assert.ok(merged.shipped.some((s) => s.summary === 'Open card'), 'the completion becomes a shipped entry');
});

test('a merge with no outcome option behaves exactly as before', () => {
  const merged = mergeContextObject(boardAtCap(), { complete_todos: ['open-1'] }, '');
  assert.strictEqual(merged.todo_items.filter((c) => c.phase === 'done').length, 100);
});

function briefFor(context, verbosity = 'standard') {
  return formatConversationalInjection(createContextObject({ project_name: 'Question Vis', ...context }), verbosity).body;
}

test('the standard conversational brief shows open questions, newest first, at most three', () => {
  const body = briefFor({
    current_task: 'Build the importer',
    open_questions: ['q one?', 'q two?', 'Should the importer run on a cron or a queue?', 'q four?'],
  });
  assert.match(body, /Open questions: q four\? \| Should the importer run on a cron or a queue\? \| q two\?/, body);
  assert.doesNotMatch(body, /q one\?/);
});

test('open questions never displace the current task, and light verbosity omits them', () => {
  const body = briefFor({ current_task: 'Build the importer', open_questions: ['x'.repeat(400)] });
  assert.match(body, /Current task: Build the importer/);
  assert.doesNotMatch(briefFor({ open_questions: ['Cron or queue?'] }, 'light'), /Open questions/);
});
