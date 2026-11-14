'use strict';

/**
 * A card can hold a BODY.
 *
 * The board stored titles only, so every spec detail either became an unreadable
 * 800-character title or was lost. On a board where the title IS the body, a
 * wrong file path is the whole card — four shipped that way — and listing the
 * live board came to overrun the MCP response limit purely because titles were
 * carrying prose.
 *
 * These tests pin the two halves that make a body safe to add: it must never
 * break a context written before it existed, and it must never appear in a
 * LISTING — a body is something you open, not something you scan past.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../src/index.js');

const NOW = '2026-08-29T10:00:00.000Z';
const baseContext = (overrides = {}) => ({
  project_name: 'Test Project',
  last_updated: NOW,
  ...overrides,
});

test('a card written before bodies existed still validates, unchanged', () => {
  // The whole reason body is optional rather than defaulted. Every context JSONB
  // in the database predates this field; if the parse rejected them, the only
  // way to satisfy the schema would be to destroy the user's cards.
  const legacy = baseContext({
    todo_items: [{ id: 'card-1', title: 'Legacy card', created_at: NOW }],
  });
  const parsed = sc.ContextObjectSchema.parse(legacy);
  assert.equal(parsed.todo_items[0].title, 'Legacy card');
  assert.equal(parsed.todo_items[0].phase, 'backlog');
  // Not `undefined` — absent. A body key materialising on every legacy card
  // would rewrite every stored context on first read.
  assert.ok(!('body' in parsed.todo_items[0]), 'a legacy card gained a body key');
});

test('an over-long body is clipped, never rejected', () => {
  const merged = sc.mergeContextObject(baseContext(), {
    add_todos: [{ title: 'Specced', body: 'x'.repeat(sc.MAX_TODO_BODY_CHARS + 500) }],
  }, 'test');
  const card = merged.todo_items.find((t) => t.title === 'Specced');
  assert.equal(card.body.length, sc.MAX_TODO_BODY_CHARS);
  assert.ok(card.body.endsWith('…'), 'a clipped body should say it was clipped');
  // And the clipped result must survive the schema it was clipped for.
  assert.ok(sc.ContextObjectSchema.parse(merged));
  assert.equal(sc.taskCardBodyWasClipped('x'.repeat(sc.MAX_TODO_BODY_CHARS + 1)), true);
  assert.equal(sc.taskCardBodyWasClipped('short'), false);
});

test('a bare title still means a bare title', () => {
  // todos: string[] is the published contract — every CLAUDE.md on disk, every
  // existing caller, and the dashboard's own PATCH send it.
  const merged = sc.mergeContextObject(baseContext(), { add_todos: ['Plain card'] }, 'test');
  const card = merged.todo_items.find((t) => t.title === 'Plain card');
  assert.equal(card.phase, 'backlog');
  assert.equal(card.body, undefined);
});

test('normalizeTaskCardInputs accepts both forms and treats phase as a fallback', () => {
  const cards = sc.normalizeTaskCardInputs(
    ['bare', { title: 'structured', body: ' detail ' }, { title: 'own column', phase: 'testing' }, '', null],
    'in_progress'
  );
  assert.deepEqual(cards, [
    { title: 'bare', phase: 'in_progress' },
    { title: 'structured', body: 'detail', phase: 'in_progress' },
    { title: 'own column', phase: 'testing' },
  ]);
});

test('a body can be written after the card exists', () => {
  // The normal case: a card is filed, then specced. Without this a body could
  // only ever be set at creation, which is the moment you know least.
  let ctx = sc.mergeContextObject(baseContext(), { add_todos: ['Split the sync store'] }, 'test');
  const created = ctx.todo_items.find((t) => t.title === 'Split the sync store');
  ctx = sc.mergeContextObject(ctx, {
    add_todos: [{ title: 'Split the sync store', body: 'Start with apps/api/src/store/contextSyncStore.js' }],
  }, 'test');
  const cards = ctx.todo_items.filter((t) => t.title === 'Split the sync store');
  assert.equal(cards.length, 1, 're-adding a title must not duplicate the card');
  assert.equal(cards[0].id, created.id, 'the card kept its identity');
  assert.match(cards[0].body, /contextSyncStore\.js/);
});

test('a re-add without a body leaves the existing body alone', () => {
  let ctx = sc.mergeContextObject(baseContext(), {
    add_todos: [{ title: 'Keep me', body: 'the detail' }],
  }, 'test');
  ctx = sc.mergeContextObject(ctx, { add_todos: ['Keep me'] }, 'test');
  assert.equal(ctx.todo_items.find((t) => t.title === 'Keep me').body, 'the detail');
});

test('a listing marks a body and never prints one', () => {
  const ctx = sc.mergeContextObject(baseContext(), {
    add_todos: [
      { title: 'Has detail', body: 'SECRET-SPEC-TEXT spanning a paragraph' },
      'No detail',
    ],
  }, 'test');

  const brief = sc.formatSectionInjection(ctx, ['todos']);
  assert.match(brief, /Has detail\s*\+body/);
  assert.ok(!/SECRET-SPEC-TEXT/.test(brief), 'the brief inlined a card body');

  const cli = sc.formatTaskBoardText(sc.buildTaskBoardSnapshot(ctx, { project_name: 'P' }));
  assert.match(cli, /Has detail \+body/);
  assert.ok(!/SECRET-SPEC-TEXT/.test(cli), 'the CLI view inlined a card body');
  assert.ok(!/No detail \+body/.test(cli), 'a card with no body was marked as having one');
});

test('the listing payload swaps bodies for a flag', () => {
  // An MCP result ships structuredContent next to its text. Dropping bodies from
  // the text while shipping them in the structured half blows the same budget,
  // just where nobody reads it.
  const ctx = sc.mergeContextObject(baseContext(), {
    add_todos: [{ title: 'Has detail', body: 'SECRET-SPEC-TEXT' }, 'No detail'],
  }, 'test');
  const listing = sc.taskBoardSnapshotForListing(sc.buildTaskBoardSnapshot(ctx, { project_name: 'P' }));
  assert.ok(!JSON.stringify(listing).includes('SECRET-SPEC-TEXT'), 'a body rode along in structuredContent');
  const cards = listing.board.flatMap((column) => column.cards);
  assert.equal(cards.find((c) => c.title === 'Has detail').has_body, true);
  assert.equal(cards.find((c) => c.title === 'No detail').has_body, undefined);
});

test('opening a card prints its body, and keeps its line breaks', () => {
  const ctx = sc.mergeContextObject(baseContext(), {
    add_todos: [{
      title: 'Thread the body through',
      phase: 'in_progress',
      body: 'Files:\n- apps/api/src/routes/mcp.js\n- packages/mcp-server/src/tools/context-sync.ts',
    }],
  }, 'test');

  const detail = sc.formatTaskCardDetail(ctx, ['Thread the body']);
  assert.match(detail, /Thread the body through/);
  assert.match(detail, /In Progress/);
  // The line breaks are the readable part of a spec; the brief formatter
  // collapses them on purpose, and this renderer must not.
  assert.match(detail, /\n {2}- apps\/api\/src\/routes\/mcp\.js\n/);
  assert.match(detail, /- packages\/mcp-server\/src\/tools\/context-sync\.ts/);
});

test('opening resolves by id first, and says so when nothing matched', () => {
  const ctx = sc.mergeContextObject(baseContext(), {
    add_todos: [{ title: 'Card one', body: 'first body' }, { title: 'Card two', body: 'second body' }],
  }, 'test');
  const target = ctx.todo_items.find((t) => t.title === 'Card two');

  const byId = sc.formatTaskCardDetail(ctx, [target.id]);
  assert.match(byId, /second body/);
  assert.ok(!/first body/.test(byId), 'an id resolved more than its own card');

  assert.match(sc.formatTaskCardDetail(ctx, ['nothing like this']), /No card matched/);
  assert.match(sc.formatTaskCardDetail(ctx, []), /No cards named/);
});

test('a card with no body says how to give it one', () => {
  const ctx = sc.mergeContextObject(baseContext(), { add_todos: ['Bare card'] }, 'test');
  assert.match(sc.formatTaskCardDetail(ctx, ['Bare card']), /no body/);
});
