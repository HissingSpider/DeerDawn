'use strict';

// Round-12 scan: a card added straight into Done was stamped completed_at = NOW,
// whatever it carried. The Done cap keeps the most recently COMPLETED cards, so
// a Trail import of old finished work outranked the importer's real completions
// and evicted them. add_todos now honours a supplied completed_at for Done cards
// when it parses and is not in the future.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeContextObject, createContextObject } = require('../src/index.js');

const RECENT = Date.parse('2026-09-01T00:00:00.000Z');

function fullDone() {
  const done = Array.from({ length: 100 }, (_, i) => ({
    id: `mine-${i}`, title: `Mine ${i}`, phase: 'done',
    created_at: new Date(RECENT + i * 60_000).toISOString(),
    completed_at: new Date(RECENT + i * 60_000).toISOString(),
  }));
  return createContextObject({ project_name: 'Full Done', todo_items: done });
}

test('imported history carries its completion time, so it is what the Done cap drops', () => {
  const old = Date.parse('2025-01-01T00:00:00.000Z');
  const imported = Array.from({ length: 50 }, (_, i) => ({
    title: `Imported ${i}`, phase: 'done', completed_at: new Date(old + i * 60_000).toISOString(),
  }));
  const outcome = {};
  const merged = mergeContextObject(fullDone(), { add_todos: imported }, '', { outcome });
  const done = merged.todo_items.filter((c) => c.phase === 'done');
  assert.strictEqual(done.length, 100);
  assert.strictEqual(done.filter((c) => c.title.startsWith('Mine')).length, 100, 'every real completion is kept');
  assert.strictEqual(outcome.evicted_done.length, 50);
  assert.ok(outcome.evicted_done.every((c) => c.title.startsWith('Imported')), 'only imported history is evicted');
});

test('a supplied completed_at is stored on a Done card, normalised to ISO', () => {
  const merged = mergeContextObject(createContextObject({ project_name: 'P' }), {
    add_todos: [{ title: 'Shipped last year', phase: 'done', completed_at: '2025-03-04T05:06:07Z' }],
  }, '');
  assert.strictEqual(merged.todo_items[0].completed_at, '2025-03-04T05:06:07.000Z');
});

test('a future, unparseable, or non-Done completed_at is not honoured', () => {
  const before = Date.now();
  const merged = mergeContextObject(createContextObject({ project_name: 'P' }), {
    add_todos: [
      { title: 'Future', phase: 'done', completed_at: '2999-01-01T00:00:00Z' },
      { title: 'Garbage', phase: 'done', completed_at: 'last tuesday' },
      { title: 'Open', phase: 'backlog', completed_at: '2025-01-01T00:00:00Z' },
      { title: 'Plain', phase: 'done' },
    ],
  }, '');
  const byTitle = Object.fromEntries(merged.todo_items.map((c) => [c.title, c]));
  for (const title of ['Future', 'Garbage', 'Plain']) {
    const ms = Date.parse(byTitle[title].completed_at);
    assert.ok(ms >= before - 1000 && ms <= Date.now() + 1000, `${title} is stamped now, got ${byTitle[title].completed_at}`);
  }
  assert.strictEqual(byTitle.Open.completed_at, null, 'an open card has no completion');
});
