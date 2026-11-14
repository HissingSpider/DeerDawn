'use strict';

/**
 * A board LISTING is bounded, and says so.
 *
 * Stripping card bodies was not enough to keep a listing inside the response
 * budget. A 282-card board still serialises to ~83KB of titles, and our own
 * sanitizeToolResult clamps that on the way out: arrays sliced to 100, and once
 * STRUCTURED_BUDGET_CHARS is spent the object walk breaks, dropping the summary
 * fields (`counts_by_phase`, `total_cards`, `open_cards`) that would have
 * revealed the loss. What survives reads as a complete board with a short Done
 * column, indistinguishable from a board that really is short.
 *
 * That cost a real session: a 158-card Backlog came back looking like 100, cards
 * written minutes earlier were absent from the view, and the missing rows were
 * diagnosed as a silently dropped WRITE. The write was fine. The read lied.
 *
 * It was then diagnosed a second time as CLIENT-side truncation, which is also
 * wrong, and that version shipped in this file's first commit. The "[output
 * truncated]" marker that pointed at a client is written by clampValue in
 * apps/api/src/services/mcpSafety.js. Ours. Both wrong answers came from
 * reasoning about a mechanism instead of reading the code that produces the
 * string.
 *
 * So these tests pin the invariant that makes a partial read safe: the counts
 * always describe STORAGE, the cards are capped, and every column that elided
 * anything admits it. `cards.length` is never the answer to "how many are there".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../src/index.js');

const NOW = '2026-09-06T10:00:00.000Z';

/**
 * A board with `n` backlog cards and `done` completed ones.
 *
 * Completion order is the REVERSE of creation order: done-0 was filed first and
 * completed last. So any listing that ranks Done by array position (creation)
 * instead of completed_at picks exactly the wrong cards, and the test says so.
 */
function contextWithCards(n, done = 0) {
  const todo_items = [];
  for (let i = 0; i < n; i += 1) {
    todo_items.push({ id: `card-${i}`, title: `Backlog card ${i}`, phase: 'backlog', created_at: NOW });
  }
  for (let i = 0; i < done; i += 1) {
    todo_items.push({
      id: `done-${i}`,
      title: `Done card ${i}`,
      phase: 'done',
      created_at: new Date(Date.UTC(2026, 7, 1, 10, i)).toISOString(),
      completed_at: new Date(Date.UTC(2026, 8, 1, 10, done - 1 - i)).toISOString(),
    });
  }
  return { project_name: 'Test Project', last_updated: NOW, todo_items };
}

const listingFor = (n, done = 0, options) =>
  sc.taskBoardSnapshotForListing(
    sc.buildTaskBoardSnapshot(contextWithCards(n, done), { project_name: 'Test Project' }),
    options,
  );

const columnOf = (listing, phase) => listing.board.find((c) => c.phase === phase);

test('counts_by_phase reports STORAGE, not the number of cards returned', () => {
  // The regression that started it all: a caller reading counts_by_phase got a
  // number consistent with the truncated view, so nothing about the response
  // looked wrong. The count and the card array have to disagree here — that
  // disagreement is the entire feature.
  const listing = listingFor(158);
  assert.equal(listing.counts_by_phase.backlog, 158, 'counts_by_phase must report all 158 stored cards');
  assert.ok(
    columnOf(listing, 'backlog').cards.length < 158,
    'a 158-card column must not return all 158 cards in a listing',
  );
});

test('total_cards and open_cards survive the bounding untouched', () => {
  const listing = listingFor(158, 100);
  assert.equal(listing.total_cards, 258);
  assert.equal(listing.open_cards, 158);
});

test('every column carries total, returned, and has_more', () => {
  const backlog = columnOf(listingFor(158), 'backlog');
  assert.equal(backlog.total, 158, 'total is the stored count');
  assert.equal(backlog.returned, backlog.cards.length, 'returned matches what was actually sent');
  assert.equal(backlog.has_more, true, 'a column that elided cards must admit it');
});

test('a column that fits is not marked as truncated', () => {
  // has_more is load-bearing for the caller's decision to go looking for more.
  // If it were true on a complete column, it would be ignored within a day.
  const backlog = columnOf(listingFor(3), 'backlog');
  assert.equal(backlog.total, 3);
  assert.equal(backlog.returned, 3);
  assert.equal(backlog.has_more, false);
  assert.equal(backlog.cards.length, 3);
});

test('Done returns the most RECENTLY COMPLETED cards, newest first — not the most recently created', () => {
  // Done is the column that grows without bound. Showing its head would pin the
  // listing to whatever was completed first and never move again; showing its
  // tail shows whatever was CREATED last, which is not the same thing. In this
  // fixture done-0 was created first and completed last.
  const done = columnOf(listingFor(0, 40), 'done');
  assert.equal(done.total, 40);
  assert.ok(done.has_more, 'a 40-card Done column is over the cap');
  const returnedIds = done.cards.map((c) => c.id);
  assert.deepEqual(
    returnedIds,
    Array.from({ length: 10 }, (_, i) => `done-${i}`),
    'the ten latest completions, newest first'
  );
  assert.ok(!returnedIds.includes('done-39'), 'the last-CREATED card was completed first and must be elided');
});

test('Done falls back to updated_at, then created_at, when completed_at is missing', () => {
  const context = {
    project_name: 'Test Project',
    last_updated: NOW,
    todo_items: [
      { id: 'stamped-old', title: 'Completed long ago', phase: 'done', created_at: NOW, completed_at: '2026-01-01T00:00:00.000Z' },
      { id: 'legacy-updated', title: 'Legacy, updated recently', phase: 'done', created_at: '2025-01-01T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z' },
      { id: 'legacy-created', title: 'Legacy, created mid-year', phase: 'done', created_at: '2026-06-01T00:00:00.000Z' },
    ],
  };
  const listing = sc.taskBoardSnapshotForListing(sc.buildTaskBoardSnapshot(context), { cards_per_phase: 3 });
  assert.deepEqual(columnOf(listing, 'done').cards.map((c) => c.id), ['legacy-updated', 'legacy-created', 'stamped-old']);
});

test('an open column returns its HEAD — the order the board is worked', () => {
  const backlog = columnOf(listingFor(158), 'backlog');
  assert.equal(backlog.cards[0].id, 'card-0', 'the first backlog card must lead the listing');
});

test('cards_per_phase overrides the cap on every column, Done included', () => {
  const listing = listingFor(158, 100, { cards_per_phase: 2 });
  assert.equal(columnOf(listing, 'backlog').cards.length, 2);
  assert.equal(columnOf(listing, 'done').cards.length, 2);
  assert.equal(columnOf(listing, 'backlog').total, 158, 'an explicit cap must not touch the stored count');
});

test('bodies are still replaced by has_body, never shipped in a listing', () => {
  // The original guarantee. Bounding the column must not have quietly restored
  // the body to the structured half, where nobody would notice it.
  const context = {
    project_name: 'Test Project',
    last_updated: NOW,
    todo_items: [{ id: 'c1', title: 'Card with detail', phase: 'backlog', body: 'a spec worth 2000 chars', created_at: NOW }],
  };
  const listing = sc.taskBoardSnapshotForListing(sc.buildTaskBoardSnapshot(context, { project_name: 'Test Project' }));
  const card = columnOf(listing, 'backlog').cards[0];
  assert.equal(card.body, undefined, 'a listing must never carry a card body');
  assert.equal(card.has_body, true, 'but it must say the body exists');
});

test('a bounded listing of a large board stays inside a sane response budget', () => {
  // The failure was a size failure, so pin the size. The real board that broke
  // this was 282 cards and ~83KB; anything in that range gets truncated by the
  // client no matter how good the shape is.
  const listing = listingFor(158, 100);
  const bytes = JSON.stringify(listing).length;
  assert.ok(bytes < 30000, `a bounded listing should stay well under the response limit, got ${bytes} bytes`);
});

test('a snapshot with no board is passed through rather than crashing', () => {
  assert.equal(sc.taskBoardSnapshotForListing(null), null);
  assert.deepEqual(sc.taskBoardSnapshotForListing({ project_name: 'x' }), { project_name: 'x' });
});

/**
 * cards_per_phase is a REQUEST, not a guarantee.
 *
 * Exposing the cap as a tool parameter is the obvious way to let a caller see
 * further down a 158-card column — and the obvious way to hand back the exact
 * unbounded response the cap was added to prevent. A caller asking for 50 on
 * every column would rebuild an 83KB payload and put the truncation, and the
 * dropped summary fields, straight back.
 *
 * So the request is clamped per column AND the whole listing is budgeted. What
 * makes silently returning fewer than asked honest is that `total` and
 * `has_more` keep telling the truth about what was withheld.
 */

test('an explicit cards_per_phase is honoured when the board is small enough', () => {
  const listing = listingFor(158, 100, { cards_per_phase: 40 });
  assert.equal(columnOf(listing, 'backlog').cards.length, 40);
  assert.equal(columnOf(listing, 'done').cards.length, 40);
});

test('cards_per_phase is clamped to 50 — a bigger ask cannot widen it', () => {
  const listing = listingFor(158, 100, { cards_per_phase: 5000 });
  assert.ok(
    columnOf(listing, 'backlog').cards.length <= 50,
    `asked for 5000, got ${columnOf(listing, 'backlog').cards.length}`,
  );
});

test('the TOTAL listing is budgeted, not just each column', () => {
  // Six columns at the per-phase maximum is a bigger payload than the one that
  // broke, so a per-phase clamp alone would not be a bound at all.
  const listing = listingFor(158, 100, { cards_per_phase: 50 });
  const returned = listing.board.reduce((n, c) => n + c.cards.length, 0);
  assert.ok(returned <= 120, `whole listing must stay inside the budget, got ${returned}`);
});

test('a request the budget lowers still reports the true totals', () => {
  // The failure this guards against is a shortened listing that looks complete.
  const listing = listingFor(158, 100, { cards_per_phase: 50 });
  const backlog = columnOf(listing, 'backlog');
  assert.equal(backlog.total, 158, 'total must survive the budget shrink');
  assert.equal(backlog.returned, backlog.cards.length);
  assert.equal(backlog.has_more, true);
  assert.equal(listing.counts_by_phase.backlog, 158);
});

test('a clamped request still fits the byte budget it exists to protect', () => {
  const listing = listingFor(158, 100, { cards_per_phase: 50 });
  const bytes = JSON.stringify(listing).length;
  assert.ok(bytes < 30000, `a maxed-out request must still fit, got ${bytes} bytes`);
});

test('cards_per_phase below 1 floors at 1 rather than emptying the board', () => {
  const listing = listingFor(158, 100, { cards_per_phase: 0 });
  assert.equal(columnOf(listing, 'backlog').cards.length, 1);
  assert.equal(columnOf(listing, 'backlog').total, 158);
});

test('a non-numeric cards_per_phase falls back to the defaults', () => {
  for (const junk of [undefined, null, NaN, 'lots', {}]) {
    const listing = listingFor(158, 100, { cards_per_phase: junk });
    assert.equal(
      columnOf(listing, 'backlog').cards.length, 20,
      `${String(junk)} should fall through to the default of 20`,
    );
    assert.equal(columnOf(listing, 'done').cards.length, 10);
  }
});

test('six large columns shrink the per-phase cap, and every column still tells the truth', () => {
  // The two-large-column case never exercises the budget: 50+50 is inside it.
  // A board that is large in EVERY column is what a per-phase-only clamp would
  // wave through, so this is the case that proves the total is what is bounded.
  const phases = ['backlog', 'blocked', 'in_progress', 'integration', 'testing', 'done'];
  const todo_items = [];
  for (const phase of phases) {
    for (let i = 0; i < 60; i += 1) {
      todo_items.push({
        id: `${phase}-${i}`,
        title: `${phase} card ${i}`,
        phase,
        created_at: NOW,
        completed_at: phase === 'done' ? NOW : null,
      });
    }
  }
  const listing = sc.taskBoardSnapshotForListing(
    sc.buildTaskBoardSnapshot({ project_name: 'T', last_updated: NOW, todo_items }, { project_name: 'T' }),
    { cards_per_phase: 50 },
  );
  const returned = listing.board.reduce((n, c) => n + c.cards.length, 0);
  assert.ok(returned <= 120, `six columns at 50 must be shrunk to the budget, got ${returned}`);
  assert.ok(
    listing.board.every((c) => c.returned < 50),
    'the per-phase cap should have been lowered below the request',
  );
  for (const column of listing.board) {
    assert.equal(column.total, 60, `${column.phase} must still report all 60 stored cards`);
    assert.equal(column.has_more, true, `${column.phase} withheld cards and must say so`);
    assert.equal(listing.counts_by_phase[column.phase], 60);
  }
});
