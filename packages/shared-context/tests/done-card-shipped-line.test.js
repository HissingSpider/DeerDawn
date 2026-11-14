'use strict';

// JOURNEY SCAN ROUND 6, owner's decision: A DONE CARD WRITES "SHIPPED", NEVER
// "VERIFIED", AND THE LINE FOLLOWS THE CARD.
//
// A card moved to Done is a completion somebody reported, not one anybody
// checked. It lands in the SHIPPED slot at confidence 1, which every surface
// derives as trust "high" and the dashboard prints as "Verified". The line now
// says where it came from (from_card), so it can be labelled "Shipped" and so it
// can follow the card: moved back out of Done it goes, deleted it goes, renamed
// its text follows. A card the Done cap pushed off the board, and a shipped line
// nobody derived from a card, are not touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeContextObject,
  createContextObject,
  buildBriefSpine,
  formatBriefInjection,
  followBoardCardsInShipped,
} = require('../src/index.js');

const base = () => createContextObject({ project_name: 'Board line' });
const cardIdOf = (ctx, title) => ctx.todo_items.find((c) => c.title === title).id;
const lines = (ctx) => (ctx.shipped || []).map((s) => s.summary);

function withCardInDone(title = 'Ship the invoice job') {
  let ctx = mergeContextObject(base(), { add_todos: [{ title, phase: 'testing' }] }, '');
  ctx = mergeContextObject(ctx, { complete_todos: [title] }, '');
  return ctx;
}

test('a card moved to Done writes a shipped line that remembers the card', () => {
  const ctx = withCardInDone();
  assert.deepEqual(lines(ctx), ['Ship the invoice job']);
  assert.equal(ctx.shipped[0].card_id, cardIdOf(ctx, 'Ship the invoice job'), 'the line names the card it came from');
});

test('the brief says the line is from a card, and never calls it verified', () => {
  const ctx = withCardInDone();
  const spine = buildBriefSpine(ctx);
  assert.equal(spine.shipped.length, 1);
  assert.equal(spine.shipped[0].from_card, true, 'the spine marks the line as a Done card, so a surface can say "Shipped"');
  const text = formatBriefInjection(ctx, 'detailed').body;
  assert.match(text, /Ship the invoice job/);
  assert.doesNotMatch(text, /verified/i, 'the text brief does not say verified about a Done card');
});

test('a shipped line nobody derived from a card is not marked as one', () => {
  const ctx = mergeContextObject(base(), {
    shipped: [{ summary: 'Released 1.0.54', shipped_at: new Date().toISOString(), confidence: 1 }],
  }, '');
  assert.equal(buildBriefSpine(ctx).shipped[0].from_card, undefined);
});

test('moved back out of Done, the line goes with it', () => {
  let ctx = withCardInDone();
  ctx = mergeContextObject(ctx, { move_todos: [{ match: 'Ship the invoice job', phase: 'testing' }] }, '');
  assert.deepEqual(lines(ctx), [], 'a card that is not Done has not shipped');
  // Done again: a fresh line, once.
  ctx = mergeContextObject(ctx, { complete_todos: ['Ship the invoice job'] }, '');
  assert.deepEqual(lines(ctx), ['Ship the invoice job']);
});

test('a deleted card takes its line with it', () => {
  let ctx = withCardInDone();
  ctx = mergeContextObject(ctx, { remove_todos: ['Ship the invoice job'] }, '');
  assert.deepEqual(lines(ctx), []);
});

test('a renamed card renames its line', () => {
  const ctx = withCardInDone();
  const renamed = { ...ctx, todo_items: ctx.todo_items.map((c) => ({ ...c, title: 'Ship the invoice worker' })) };
  const followed = followBoardCardsInShipped(ctx.shipped, {
    before: ctx.todo_items,
    after: renamed.todo_items,
    evictedDoneIds: new Set(),
  });
  assert.equal(followed.changed, true);
  assert.deepEqual(followed.list.map((s) => s.summary), ['Ship the invoice worker']);
  assert.equal(followed.list[0].card_id, ctx.shipped[0].card_id);
});

test('other lines are left alone: an event line with the same words, and another card', () => {
  let ctx = mergeContextObject(base(), {
    shipped: [{ summary: 'Released 1.0.54', shipped_at: new Date().toISOString(), confidence: 1 }],
    add_todos: [{ title: 'Card A', phase: 'testing' }, { title: 'Card B', phase: 'testing' }],
  }, '');
  ctx = mergeContextObject(ctx, { complete_todos: ['Card A', 'Card B'] }, '');
  assert.deepEqual(lines(ctx).sort(), ['Card A', 'Card B', 'Released 1.0.54']);
  ctx = mergeContextObject(ctx, { move_todos: [{ match: 'Card A', phase: 'backlog' }] }, '');
  assert.deepEqual(lines(ctx).sort(), ['Card B', 'Released 1.0.54'], 'only Card A\'s line went');
});

test('a Done card the cap pushed off the board keeps its line: that is history, not a deletion', () => {
  const RECENT = Date.parse('2026-09-01T00:00:00.000Z');
  const done = Array.from({ length: 100 }, (_, i) => ({
    id: `old-${i}`, title: `Old ${i}`, phase: 'done',
    created_at: new Date(RECENT + i * 60_000).toISOString(),
    completed_at: new Date(RECENT + i * 60_000).toISOString(),
  }));
  let ctx = createContextObject({
    project_name: 'Full Done',
    todo_items: done,
    shipped: [{ summary: 'Old 0', shipped_at: new Date(RECENT).toISOString(), confidence: 1, card_id: 'old-0' }],
  });
  const outcome = {};
  ctx = mergeContextObject(ctx, { add_todos: [{ title: 'Fresh', phase: 'testing' }] }, '', { outcome });
  ctx = mergeContextObject(ctx, { complete_todos: ['Fresh'] }, '', { outcome });
  assert.ok(ctx.todo_items.every((c) => c.id !== 'old-0'), 'precondition: the oldest Done card was pushed off the board');
  assert.ok(lines(ctx).includes('Old 0'), 'its line stays');
  assert.ok(lines(ctx).includes('Fresh'));
});

test('a line whose card was never on this board is not touched (a Trail import, an old board)', () => {
  const ctx = mergeContextObject(base(), {
    shipped: [{ summary: 'Came with the import', shipped_at: new Date().toISOString(), confidence: 1, card_id: 'not-on-this-board' }],
    add_todos: [{ title: 'Unrelated', phase: 'backlog' }],
  }, '');
  assert.deepEqual(lines(ctx), ['Came with the import']);
});
