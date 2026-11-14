'use strict';

/**
 * Board cap regression (2026-08-26).
 *
 * mergeContextObject trims the board. The intent, stated in its own comment,
 * was "trim oldest DONE cards first so the live columns never get evicted by a
 * backlog of completed cards." The implementation did the exact opposite:
 * `active` was concatenated FIRST, so `[...active, ...done].slice(-100)` dropped
 * from the FRONT — evicting the oldest OPEN cards and preserving every Done card.
 *
 * Two limits now govern this, and they are the single source of truth for both
 * the trim and the schema bound (they drifted apart once, and the trim then
 * produced boards the schema rejected):
 *   MAX_TODO_ITEMS    = 300  — what a board can store at all
 *   MAX_DONE_RETAINED = 100  — the Done column's own ceiling
 *
 * Observed on the DeerDawn board itself at 73 done + 27 active: adding 3 cards
 * silently deleted the 3 oldest backlog cards. They were not marked complete
 * and surfaced nowhere. Silent loss of the user's open work is the worst
 * failure mode this product has, so it is pinned here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeContextObject, resolveTaskCard } = require('../src');

const DONE = 'done';
// Mirrors MAX_DONE_RETAINED in src/index.js. The trim and the schema bound drifted
// apart once already; keeping the number named here makes a future drift loud.
const MAX_DONE = 100;

// Stamped oldest-first so "oldest" in the assertions is unambiguous.
function stamp(i) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

function board(doneCount, activeCount) {
  return [
    ...Array.from({ length: doneCount }, (_, i) => ({
      id: `d${i}`, title: `done ${i}`, phase: DONE,
      created_at: stamp(i), updated_at: stamp(i), completed_at: stamp(i),
    })),
    ...Array.from({ length: activeCount }, (_, i) => ({
      id: `a${i}`, title: `active ${i}`, phase: 'backlog',
      created_at: stamp(doneCount + i), updated_at: stamp(doneCount + i), completed_at: null,
    })),
  ];
}

function merge(todoItems, delta) {
  return mergeContextObject(
    { project_name: 'DeerDawn', todo_items: todoItems },
    delta || {},
    'test'
  );
}

test('adding a card never evicts an open card', () => {
  // The exact shape that lost real work: the board was already at the cap.
  const merged = merge(board(73, 27), {
    add_todos: ['brand new card 1', 'brand new card 2', 'brand new card 3'],
  });
  const items = merged.todo_items;
  const active = items.filter((t) => t.phase !== DONE);

  assert.equal(active.length, 30, 'all 27 existing open cards plus the 3 new ones survive');
  assert.ok(active.some((t) => t.id === 'a0'), 'the OLDEST open card must not be the one dropped');
  // 73 done + 30 open = 103. Under the old bound this board could not exist,
  // and the 3 oldest open cards were destroyed to force it under 100.
  assert.equal(items.length, 103, 'every card is still there');
  assert.ok(items.length <= 300, 'the storage bound still holds');
});

test('when the board must be trimmed, it is paid for out of the oldest DONE cards', () => {
  const merged = merge(board(140, 27), { add_todos: ['new one'] });
  const items = merged.todo_items;
  const done = items.filter((t) => t.phase === DONE);

  assert.ok(!done.some((t) => t.id === 'd0'), 'the oldest completed card is trimmed first');
  assert.ok(done.some((t) => t.id === 'd139'), 'the newest completed card is kept');
  assert.equal(items.filter((t) => t.phase !== DONE).length, 28, 'open cards are untouched');
});

test('a board past the old 100 limit keeps every open card', () => {
  // The residual that used to exist: >100 OPEN cards silently lost the oldest.
  // Open work now has real room, so all 150 survive intact.
  const merged = merge(board(40, 150), {});
  const items = merged.todo_items;

  assert.equal(items.filter((t) => t.phase !== DONE).length, 150, 'every open card is retained');
  assert.ok(items.some((t) => t.id === 'a0'), 'including the oldest open card');
  assert.equal(items.filter((t) => t.phase === DONE).length, 40, 'Done is untouched — there was room');
});

test('Done shrinks to zero before a single open card is cut', () => {
  // Open work alone overflows the cap. Done must yield ENTIRELY first; it must
  // never hold a slot an open card needs.
  const merged = merge(board(100, 320), {});
  const items = merged.todo_items;

  assert.equal(items.filter((t) => t.phase === DONE).length, 0, 'Done yields completely');
  assert.equal(items.length, 300, 'the storage bound still holds');
  assert.equal(items.filter((t) => t.phase !== DONE).length, 300, 'every remaining slot is open work');
});

test('Done is capped on its own so history cannot crowd out open work', () => {
  const merged = merge(board(180, 20), {});
  const items = merged.todo_items;

  assert.equal(items.filter((t) => t.phase === DONE).length, 100, 'Done is held at its own ceiling');
  assert.ok(!items.some((t) => t.id === 'd0'), 'the oldest completed card is trimmed');
  assert.ok(items.some((t) => t.id === 'd179'), 'the newest completed card is kept');
  assert.equal(items.filter((t) => t.phase !== DONE).length, 20, 'open cards are untouched');
});

test("today's real board shape loses nothing at all", () => {
  // 73 done + 27 open was the live DeerDawn board when the bug was found.
  // Restoring the 9 destroyed cards must now be a no-op for everything else.
  const merged = merge(board(73, 27), {
    add_todos: Array.from({ length: 9 }, (_, i) => `restored card ${i}`),
  });
  const items = merged.todo_items;

  assert.equal(items.filter((t) => t.phase === DONE).length, 73, 'no completed card is dropped');
  assert.equal(items.filter((t) => t.phase !== DONE).length, 36, 'all 27 open plus all 9 restored');
  assert.ok(items.some((t) => t.id === 'a0') && items.some((t) => t.id === 'd0'), 'nothing is evicted');
});

test('a board under the cap is left completely alone', () => {
  const merged = merge(board(10, 5), {});
  assert.equal(merged.todo_items.length, 15);
});

/**
 * Second regression, 2026-08-29: the trim ranked Done by ARRAY POSITION.
 *
 * The fixtures above all stamp created_at and completed_at in the same order, so
 * "the tail of the array" and "the newest completion" were the same card and the
 * bug could not show. A real board breaks that assumption constantly: a card
 * created in July and completed today sits near the FRONT of todo_items, so the
 * moment it was marked done it was the first thing trimmed — while genuinely
 * older completions that happened to be created later survived.
 *
 * Observed on the live DeerDawn board at done = 100: three cards were completed
 * in one call, all three vanished from EVERY phase, and the Done column was
 * byte-identical before and after. Nothing was evicted — the incoming completion
 * was the casualty, and the write reported success.
 */

// An old open card sitting at the FRONT of the array (created before every card
// currently in Done), plus a full Done column created after it.
function agedBoard(doneCount) {
  return [
    {
      id: 'old-open', title: 'opened in July, finished today', phase: 'backlog',
      created_at: stamp(0), updated_at: stamp(0), completed_at: null,
    },
    ...Array.from({ length: doneCount }, (_, i) => ({
      id: `d${i}`, title: `done ${i}`, phase: DONE,
      created_at: stamp(i + 1), updated_at: stamp(i + 1), completed_at: stamp(i + 1),
    })),
  ];
}

test('completing a card while Done is at the cap does not destroy that card', () => {
  const merged = merge(agedBoard(MAX_DONE), { complete_todos: ['opened in July, finished today'] });
  const done = merged.todo_items.filter((t) => t.phase === DONE);

  // The exact failure: the card left Backlog, never arrived in Done, and existed
  // in no phase at all.
  assert.ok(
    merged.todo_items.some((t) => t.id === 'old-open'),
    'the card just completed must still exist somewhere on the board'
  );
  assert.ok(done.some((t) => t.id === 'old-open'), 'and it must be in Done');
  assert.equal(done.length, MAX_DONE, 'Done stays at its ceiling');
});

test('the card evicted to make room is the oldest COMPLETION, not the oldest row', () => {
  const merged = merge(agedBoard(MAX_DONE), { complete_todos: ['opened in July, finished today'] });
  const done = merged.todo_items.filter((t) => t.phase === DONE);

  assert.ok(!done.some((t) => t.id === 'd0'), 'the oldest completed card yields the slot');
  assert.ok(done.some((t) => t.id === `d${MAX_DONE - 1}`), 'the newest pre-existing completion is kept');
});

test('completion order beats creation order when they disagree', () => {
  // b is created LAST but completed FIRST; a is created FIRST but completed LAST.
  // Ranked by array position the wrong one is dropped.
  const items = [
    { id: 'a', title: 'a', phase: DONE, created_at: stamp(0), updated_at: stamp(0), completed_at: stamp(500) },
    ...Array.from({ length: MAX_DONE - 1 }, (_, i) => ({
      id: `m${i}`, title: `m ${i}`, phase: DONE,
      created_at: stamp(i + 1), updated_at: stamp(i + 1), completed_at: stamp(i + 100),
    })),
    { id: 'b', title: 'b', phase: DONE, created_at: stamp(999), updated_at: stamp(999), completed_at: stamp(1) },
  ];
  const done = merge(items, {}).todo_items.filter((t) => t.phase === DONE);

  assert.equal(done.length, MAX_DONE);
  assert.ok(done.some((t) => t.id === 'a'), 'created first but completed last — kept');
  assert.ok(!done.some((t) => t.id === 'b'), 'created last but completed first — trimmed');
});

test('retaining a card does not reshuffle the Done column around it', () => {
  const merged = merge(agedBoard(MAX_DONE), { complete_todos: ['opened in July, finished today'] });
  const doneIds = merged.todo_items.filter((t) => t.phase === DONE).map((t) => t.id);
  const survivors = doneIds.filter((id) => id !== 'old-open');

  // d0 was dropped, so what remains is d1..d99 in their original order.
  assert.deepEqual(
    survivors,
    Array.from({ length: MAX_DONE - 1 }, (_, i) => `d${i + 1}`),
    'surviving cards keep their existing order'
  );
});

test('cards with no usable timestamps still survive a trim intact', () => {
  // Pre-board rows can carry a null completed_at. They must not crash the sort
  // or be silently preferred over real completions.
  const items = [
    { id: 'nostamp', title: 'no stamps', phase: DONE, created_at: stamp(0), updated_at: null, completed_at: null },
    ...Array.from({ length: MAX_DONE }, (_, i) => ({
      id: `d${i}`, title: `done ${i}`, phase: DONE,
      created_at: stamp(i + 1), updated_at: stamp(i + 1), completed_at: stamp(i + 1),
    })),
  ];
  const done = merge(items, {}).todo_items.filter((t) => t.phase === DONE);

  assert.equal(done.length, MAX_DONE, 'trimmed to the ceiling, not crashed');
  assert.ok(!done.some((t) => t.id === 'nostamp'), 'an undated row ranks oldest and yields first');
});

/**
 * remove_todos was a fuzzy hard delete (2026-08-29).
 *
 * It reused matchCard, whose fallback is a bidirectional substring match, so ONE
 * directive destroyed every card whose title merely CONTAINED the query — and
 * the tool reported removing the query string, not the cards. Since
 * fuzzyMatch(title, '') is true for every title, a single empty string wiped the
 * whole board. There is no context version table, so none of it came back.
 *
 * Move and complete can fan out and still be recovered by moving the card back.
 * Removal cannot, so it resolves precisely: id, then exact title, then fuzzy —
 * and fuzzy only when it lands on exactly one card.
 */
function namedBoard() {
  return [
    { id: 'c1', title: 'Fix the auth redirect', phase: 'backlog', created_at: stamp(1), updated_at: stamp(1), completed_at: null },
    { id: 'c2', title: 'Rewrite auth middleware', phase: 'backlog', created_at: stamp(2), updated_at: stamp(2), completed_at: null },
    { id: 'c3', title: 'Ship auth docs', phase: DONE, created_at: stamp(3), updated_at: stamp(3), completed_at: stamp(3) },
    { id: 'c4', title: 'Unrelated card', phase: 'backlog', created_at: stamp(4), updated_at: stamp(4), completed_at: null },
  ];
}

test('an ambiguous removal query deletes NOTHING', () => {
  const merged = merge(namedBoard(), { remove_todos: ['auth'] });
  assert.equal(merged.todo_items.length, 4, '"auth" matches three cards, so it must delete none of them');
});

test('an empty removal query does not wipe the board', () => {
  // fuzzyMatch(title, '') is true for every title.
  const merged = merge(namedBoard(), { remove_todos: [''] });
  assert.equal(merged.todo_items.length, 4);
  const spaces = merge(namedBoard(), { remove_todos: ['   '] });
  assert.equal(spaces.todo_items.length, 4, 'whitespace is not a match-everything wildcard either');
});

test('an exact title removes exactly that card', () => {
  const merged = merge(namedBoard(), { remove_todos: ['Ship auth docs'] });
  const ids = merged.todo_items.map((t) => t.id);
  assert.deepEqual(ids, ['c1', 'c2', 'c4'], 'only the exactly-named card goes');
});

test('a card id removes exactly that card, even when its title is ambiguous', () => {
  const merged = merge(namedBoard(), { remove_todos: ['c2'] });
  assert.deepEqual(merged.todo_items.map((t) => t.id), ['c1', 'c3', 'c4']);
});

test('an unambiguous fuzzy query still works', () => {
  // Precision must not cost the ordinary case: one match is still one match.
  const merged = merge(namedBoard(), { remove_todos: ['Unrelated'] });
  assert.deepEqual(merged.todo_items.map((t) => t.id), ['c1', 'c2', 'c3']);
});

test('removal reaches completed cards too, but only precisely', () => {
  // c3 is in Done. It must be removable by its exact title and not by 'auth'.
  const byTitle = merge(namedBoard(), { remove_todos: ['Ship auth docs'] });
  assert.ok(!byTitle.todo_items.some((t) => t.id === 'c3'), 'a done card is removable');
  const byFuzzy = merge(namedBoard(), { remove_todos: ['auth'] });
  assert.ok(byFuzzy.todo_items.some((t) => t.id === 'c3'), 'but not by an ambiguous query');
});

/**
 * move/complete fanned out the same way until 2026-09.
 *
 * "Move and complete can be recovered by moving the card back" was the reason
 * they kept matchCard — but nobody knows WHICH cards to move back when one
 * "auth" re-columned three of them and the tool reported one. They now share
 * remove's rule through resolveTaskCard: exactly one card, or nothing.
 */
test('an ambiguous move query moves NOTHING', () => {
  const merged = merge(namedBoard(), { move_todos: [{ match: 'auth', phase: 'testing' }] });
  assert.deepEqual(
    merged.todo_items.map((t) => [t.id, t.phase]),
    namedBoard().map((t) => [t.id, t.phase]),
    '"auth" matches three cards, so none of them may move'
  );
});

test('an ambiguous complete query completes NOTHING', () => {
  const merged = merge(namedBoard(), { complete_todos: ['auth'] });
  const done = merged.todo_items.filter((t) => t.phase === DONE).map((t) => t.id);
  assert.deepEqual(done, ['c3'], 'only the card that was already done is in Done');
});

test('move and complete by id or exact title touch exactly one card', () => {
  const moved = merge(namedBoard(), { move_todos: [{ match: 'c2', phase: 'in_progress' }] });
  assert.deepEqual(moved.todo_items.filter((t) => t.phase === 'in_progress').map((t) => t.id), ['c2']);

  const completed = merge(namedBoard(), { complete_todos: ['Fix the auth redirect'] });
  assert.deepEqual(completed.todo_items.filter((t) => t.phase === DONE).map((t) => t.id).sort(), ['c1', 'c3']);

  const fuzzyOne = merge(namedBoard(), { complete_todos: ['Unrelated'] });
  assert.ok(fuzzyOne.todo_items.find((t) => t.id === 'c4').phase === DONE, 'a unique fuzzy match still completes');
});

test('two cards with the same title are ambiguous by title, resolvable by id', () => {
  const board = [
    ...namedBoard(),
    { id: 'c5', title: 'Unrelated card', phase: 'backlog', created_at: stamp(5), updated_at: stamp(5), completed_at: null },
  ];
  const byTitle = resolveTaskCard(board, 'unrelated card');
  assert.equal(byTitle.status, 'ambiguous');
  assert.deepEqual(byTitle.candidates.map((c) => c.id), ['c4', 'c5']);
  assert.equal(resolveTaskCard(board, 'c5').card.id, 'c5');
  assert.equal(resolveTaskCard(board, '').status, 'unmatched');
  assert.equal(resolveTaskCard(board, 'nothing like it').status, 'unmatched');
});

/**
 * The same fuzzy fan-out lived in three more removal fields (2026-08-29).
 *
 * resolved_questions, completed_goals and resolved_landmines each did
 * `list.filter(x => !queries.some(q => fuzzyMatch(x, q)))`. fuzzyMatch is
 * bidirectional substring, so one query removed everything it appeared in — and
 * since fuzzyMatch(x, '') is true for every x, a single empty string emptied the
 * whole list. These are reached by EXTRACTION, which explicitly asks the model
 * for fuzzy text, so an LLM paraphrase was enough to trigger them.
 *
 * They now share one rule with remove_todos: exact text first, fuzzy only when
 * it lands on exactly one, blanks rejected.
 */
const QUESTIONS = [
  'How should I authenticate with GitHub',
  'What is causing the CI auth failure',
  'Unrelated question',
];

function mergeQuestions(delta) {
  return mergeContextObject({ project_name: 'x', open_questions: QUESTIONS }, delta, 'test');
}

test('an ambiguous resolved_question removes nothing', () => {
  assert.equal(mergeQuestions({ resolved_questions: ['auth'] }).open_questions.length, 3);
});

test('a blank resolved_question does not empty the list', () => {
  assert.equal(mergeQuestions({ resolved_questions: [''] }).open_questions.length, 3);
  assert.equal(mergeQuestions({ resolved_questions: ['  '] }).open_questions.length, 3);
});

test('an exact resolved_question removes exactly that one', () => {
  const out = mergeQuestions({ resolved_questions: ['Unrelated question'] });
  assert.deepEqual(out.open_questions, QUESTIONS.slice(0, 2));
});

test('an unambiguous fuzzy resolved_question still works', () => {
  // Precision must not cost the ordinary case.
  const out = mergeQuestions({ resolved_questions: ['Unrelated'] });
  assert.equal(out.open_questions.length, 2);
  assert.ok(!out.open_questions.includes('Unrelated question'));
});

test('completed_goals and resolved_landmines follow the same rule', () => {
  const goals = mergeContextObject(
    { project_name: 'x', goals: ['Ship auth', 'Ship auth docs', 'Something else'] },
    { completed_goals: ['auth'] },
    'test'
  );
  assert.equal(goals.goals.length, 3, 'an ambiguous goal query removes nothing');

  const wiped = mergeContextObject(
    { project_name: 'x', goals: ['Ship auth', 'Something else'] },
    { completed_goals: [''] },
    'test'
  );
  assert.equal(wiped.goals.length, 2, 'a blank goal query does not empty the list');

  const landmines = mergeContextObject(
    {
      project_name: 'x',
      // added_at is required by LandmineEntrySchema; without it normalizeLandmines
      // drops the entry and the assertion below passes for the wrong reason.
      landmines: [
        { summary: 'auth token expires', added_at: stamp(1) },
        { summary: 'auth cookie drops', added_at: stamp(2) },
      ],
    },
    { resolved_landmines: ['auth'] },
    'test'
  );
  assert.equal(landmines.landmines.length, 2, 'an ambiguous landmine query removes nothing');
});

/**
 * The precision fix left one silent no-op behind (2026-08-29).
 *
 * Requiring the exact-match branch to be unanimous meant a stored case variant
 * made an item unresolvable FOREVER, without saying so. uniqueStrings dedupes
 * with a case-sensitive Set, so 'Ship auth' and 'ship auth' both persist, and an
 * extraction naming either removed NEITHER — the same "reported success while
 * doing nothing" this whole line of work exists to end.
 *
 * Exact hits all share the same normalized text, so they are never ambiguous
 * about WHICH item was meant. Take the first, as resolveQuestion already does
 * server-side. remove_todos keeps the stricter rule on purpose: its cards have
 * ids, so two same-titled cards are two different things.
 */
test('a case variant does not make an item permanently unresolvable', () => {
  const stored = ['Ship auth', 'ship auth', 'Something else'];
  const survives = mergeContextObject({ project_name: 'x', open_questions: stored }, {}, 'test');
  assert.deepEqual(survives.open_questions, stored, 'both variants really do coexist');

  const out = mergeContextObject(
    { project_name: 'x', open_questions: stored },
    { resolved_questions: ['Ship auth'] },
    'test'
  );
  assert.equal(out.open_questions.length, 2, 'exactly one row leaves — not zero, not both');
  assert.ok(out.open_questions.includes('Something else'), 'and the unrelated question is untouched');
});

test('duplicate exactness does not license a fuzzy fan-out', () => {
  // The first exact hit wins, but 'auth' is not exact against anything here, so
  // it stays ambiguous and removes nothing. The relaxation must not leak sideways.
  const out = mergeContextObject(
    { project_name: 'x', open_questions: ['Ship auth', 'ship auth', 'Rewrite auth docs'] },
    { resolved_questions: ['auth'] },
    'test'
  );
  assert.equal(out.open_questions.length, 3);
});

test('goals and landmines resolve a duplicate the same way', () => {
  const goals = mergeContextObject(
    { project_name: 'x', goals: ['Ship auth', 'ship auth', 'Something else'] },
    { completed_goals: ['ship auth'] },
    'test'
  );
  assert.equal(goals.goals.length, 2, 'one goal row leaves');

  const landmines = mergeContextObject(
    {
      project_name: 'x',
      landmines: [
        { summary: 'Auth token expires', added_at: stamp(1) },
        { summary: 'auth token expires', added_at: stamp(2) },
        { summary: 'unrelated trap', added_at: stamp(3) },
      ],
    },
    { resolved_landmines: ['Auth token expires'] },
    'test'
  );
  assert.equal(landmines.landmines.length, 2, 'one landmine row leaves');
  assert.ok(
    landmines.landmines.some((l) => l.summary === 'unrelated trap'),
    'and the unrelated landmine survives'
  );
});
