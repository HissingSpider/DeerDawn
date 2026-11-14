'use strict';

/**
 * Scan 19: at 300 open cards, every add evicted the oldest OPEN card.
 *
 * MAX_TODO_ITEMS is 300. Once a board held 300 open cards, the trim made room
 * for each new card by deleting the oldest open one — not completed, not in
 * shipped, not searchable — and every caller answered "Added … → backlog". The
 * trim's own comment calls silent loss of open work the worst failure mode this
 * product has.
 *
 * The merge now refuses the cards it would have OPENED past the limit, as a
 * batch, and says so through `outcome`. It never deletes open work to fit more.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeContextObject } = require('../src');

const LIMIT = 300;
const stamp = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

function board(openCount, doneCount = 0) {
  return [
    ...Array.from({ length: doneCount }, (_, i) => ({
      id: `d${i}`, title: `done ${i}`, phase: 'done',
      created_at: stamp(i), updated_at: stamp(i), completed_at: stamp(i),
    })),
    ...Array.from({ length: openCount }, (_, i) => ({
      id: `a${i}`, title: `open ${i}`, phase: 'backlog',
      created_at: stamp(doneCount + i), updated_at: stamp(doneCount + i), completed_at: null,
    })),
  ];
}

function merge(todoItems, delta, outcome) {
  return mergeContextObject({ project_name: 'P', todo_items: todoItems }, delta, 'test', outcome ? { outcome } : {});
}

const openOf = (items) => items.filter((t) => t.phase !== 'done');

test('300 open + add: the add is refused and no open card is evicted', () => {
  const outcome = {};
  const merged = merge(board(LIMIT), { add_todos: ['one more'] }, outcome);
  const open = openOf(merged.todo_items);
  assert.equal(open.length, LIMIT, 'the board keeps exactly its 300 open cards');
  assert.ok(open.some((t) => t.id === 'a0'), 'the OLDEST open card is still there');
  assert.ok(!open.some((t) => t.title === 'one more'), 'the new card was not added');
  assert.deepEqual(outcome.refused_open.map((c) => c.title), ['one more']);
  assert.equal(outcome.open_count, LIMIT);
  assert.equal(outcome.open_limit, LIMIT);
  assert.ok(!outcome.evicted_open || outcome.evicted_open.length === 0, 'nothing reported evicted, because nothing was');
});

test('299 open + add 2: the whole batch is refused, not half of it', () => {
  const outcome = {};
  const merged = merge(board(LIMIT - 1), { add_todos: ['first', 'second'] }, outcome);
  const open = openOf(merged.todo_items);
  assert.equal(open.length, LIMIT - 1, 'nothing added, nothing lost');
  assert.ok(open.some((t) => t.id === 'a0'));
  assert.deepEqual(outcome.refused_open.map((c) => c.title), ['first', 'second']);
});

test('299 open + add 1 still fits', () => {
  const outcome = {};
  const merged = merge(board(LIMIT - 1), { add_todos: ['last slot'] }, outcome);
  assert.equal(openOf(merged.todo_items).length, LIMIT);
  assert.equal(outcome.refused_open, undefined);
});

test('adds straight into Done do not count against the open-card limit', () => {
  const outcome = {};
  const merged = merge(board(LIMIT - 1), { add_todos: [{ title: 'finished thing', phase: 'done' }] }, outcome);
  assert.ok(merged.todo_items.some((t) => t.title === 'finished thing' && t.phase === 'done'));
  assert.equal(openOf(merged.todo_items).length, LIMIT - 1);
  assert.equal(outcome.refused_open, undefined);
});

test('the Done cap still evicts the oldest completion, and still reports it', () => {
  const outcome = {};
  const merged = merge(board(10, 100), { add_todos: [{ title: 'new done', phase: 'done' }] }, outcome);
  assert.equal(merged.todo_items.filter((t) => t.phase === 'done').length, 100);
  assert.deepEqual(outcome.evicted_done.map((c) => c.id), ['d0']);
  assert.equal(outcome.refused_open, undefined);
});

test('without an outcome the refusal is still applied — open work is never the casualty', () => {
  const merged = merge(board(LIMIT), { add_todos: ['quiet caller'] });
  assert.ok(merged.todo_items.some((t) => t.id === 'a0'));
  assert.equal(openOf(merged.todo_items).length, LIMIT);
});
