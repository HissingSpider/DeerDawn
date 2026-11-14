/**
 * Multi-agent coordination — holds, presence, staleness. Pure (no DB).
 *
 * These guard the four rules the design rests on, because every one of them is a
 * rule you only notice being broken in production, on someone else's machine,
 * while two agents quietly overwrite each other:
 *
 *   1. Advisory, never enforcing — nothing here blocks; partitioning always
 *      reports what it withheld.
 *   2. Derived, never declared — a peer that announced nothing still renders with
 *      a real scope.
 *   3. TTL on everything — a crashed agent's hold and a crashed agent's presence
 *      both expire on their own.
 *   4. Silent when solo — the renderers return null, not an empty heading.
 *
 * Run: node tests/unit/multi-agent-coordination.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextObject,
  mergeContextObject,
  ContextObjectSchema,
  holdState,
  isHeldByOther,
  partitionHeldCards,
  formatExcludedLine,
  formatPresenceBlock,
  formatStalenessBanner,
  isBriefStale,
  HOLD_TTL_MS,
  PRESENCE_WINDOW_SECONDS,
} = require('../../../../packages/shared-context/src/index.js');

const iso = (ms) => new Date(ms).toISOString();

// ── Holds ────────────────────────────────────────────────────────────────────

test('moving a card into In Progress records the holding session', () => {
  const ctx = createContextObject({ project_name: 'T' });
  const merged = mergeContextObject(ctx, { add_todos: [{ title: 'Ship it', phase: 'in_progress' }] }, 'src', { sessionId: 'agent-a' });
  const card = merged.todo_items[0];
  assert.equal(card.held_by, 'agent-a');
  assert.ok(card.held_at, 'a hold with no timestamp could never expire');
  assert.equal(holdState(card).held, true);
});

test('leaving In Progress releases the hold', () => {
  const ctx = createContextObject({ project_name: 'T' });
  const held = mergeContextObject(ctx, { add_todos: [{ title: 'Ship it', phase: 'in_progress' }] }, 'src', { sessionId: 'agent-a' });
  const done = mergeContextObject(held, { complete_todos: ['Ship it'] }, 'src', { sessionId: 'agent-a' });
  assert.equal(done.todo_items[0].held_by, null);
  assert.equal(holdState(done.todo_items[0]).held, false);
});

test('a hold is released even when the releasing merge knows no session', () => {
  // Otherwise a card could be held forever by an agent that never comes back and
  // whose successor happens to call through a path with no session id.
  const ctx = createContextObject({ project_name: 'T' });
  const held = mergeContextObject(ctx, { add_todos: [{ title: 'Ship it', phase: 'in_progress' }] }, 'src', { sessionId: 'agent-a' });
  const moved = mergeContextObject(held, { move_todos: [{ match: 'Ship it', phase: 'backlog' }] }, 'src');
  assert.equal(moved.todo_items[0].held_by, null);
});

test('merging without a session id holds nothing (back-compat)', () => {
  const ctx = createContextObject({ project_name: 'T' });
  const merged = mergeContextObject(ctx, { add_todos: [{ title: 'Ship it', phase: 'in_progress' }] }, 'src');
  assert.equal(merged.todo_items[0].held_by, null);
  assert.equal(holdState(merged.todo_items[0]).held, false);
});

test('context written before holds existed still validates', () => {
  const legacy = createContextObject({ project_name: 'T' });
  legacy.todo_items = [{ id: 't1', title: 'Old card', phase: 'in_progress', created_at: iso(Date.now()) }];
  const parsed = ContextObjectSchema.parse(legacy);
  assert.equal(parsed.todo_items[0].title, 'Old card');
  assert.equal(holdState(parsed.todo_items[0]).held, false);
});

test('a hold expires — a crashed agent releases its card by doing nothing', () => {
  const card = {
    id: 't1', title: 'Stuck', phase: 'in_progress',
    held_by: 'agent-gone', held_at: iso(Date.now() - HOLD_TTL_MS - 1000),
  };
  const state = holdState(card);
  assert.equal(state.held, false, 'an expired hold must not withhold work');
  assert.equal(state.expired, true);
});

test('a hold with an unreadable timestamp is treated as expired, not immortal', () => {
  const card = { id: 't1', title: 'Stuck', phase: 'in_progress', held_by: 'agent-x', held_at: 'not-a-date' };
  assert.equal(holdState(card).held, false);
  assert.equal(holdState(card).expired, true);
});

test('a hold left on a card outside In Progress does not withhold it', () => {
  const card = { id: 't1', title: 'Done thing', phase: 'done', held_by: 'agent-a', held_at: iso(Date.now()) };
  assert.equal(holdState(card).held, false);
  assert.equal(isHeldByOther(card, 'agent-b'), false);
});

test('your own hold never hides work from you', () => {
  const card = { id: 't1', title: 'Mine', phase: 'in_progress', held_by: 'agent-a', held_at: iso(Date.now()) };
  assert.equal(isHeldByOther(card, 'agent-a'), false);
  assert.equal(isHeldByOther(card, 'agent-b'), true);
});

// ── Partitioning always explains itself ──────────────────────────────────────

test('withheld cards are reported, never silently dropped', () => {
  const now = Date.now();
  const cards = [
    { id: '1', title: 'Free', phase: 'backlog' },
    { id: '2', title: 'Taken', phase: 'in_progress', held_by: 'agent-b', held_at: iso(now) },
  ];
  const { available, excluded } = partitionHeldCards(cards, 'agent-a', now);
  assert.deepEqual(available.map((c) => c.title), ['Free']);
  assert.equal(excluded.length, 1);
  // The caller must be able to SAY what it hid. A short list with no explanation
  // reads as "no work left" — the same failure as silent truncation.
  const line = formatExcludedLine(excluded);
  assert.match(line, /1 card hidden/);
  assert.match(line, /agent-b/);
});

test('nothing withheld produces no line at all', () => {
  const { excluded } = partitionHeldCards([{ id: '1', title: 'Free', phase: 'backlog' }], 'agent-a');
  assert.equal(formatExcludedLine(excluded), null);
});

// ── Presence ─────────────────────────────────────────────────────────────────

test('presence renders nothing when no peers are live (silent when solo)', () => {
  assert.equal(formatPresenceBlock([]), null);
  assert.equal(formatPresenceBlock(null), null);
});

test('a peer seen outside the window is not presence', () => {
  const stale = [{ session_id: 'agent-b', tool: 'cursor', last_seen_at: iso(Date.now() - (PRESENCE_WINDOW_SECONDS + 60) * 1000) }];
  assert.equal(formatPresenceBlock(stale), null, 'a long-dead session must not render as present');
});

test('presence names the peer, its tool, and its DERIVED scope', () => {
  const block = formatPresenceBlock([{
    session_id: 'agent-b',
    tool: 'cursor',
    last_seen_at: iso(Date.now() - 60 * 1000),
    held_cards: [{ title: 'publish surface' }],
    scope: ['apps/api/src/services/trail/index.js'],
  }]);
  assert.match(block, /1 other agent active/);
  assert.match(block, /Cursor/);
  assert.match(block, /publish surface/);
  assert.match(block, /trail/);
});

test('a peer that declared nothing still renders (derived, not declared)', () => {
  // The whole point: coordination that only works for agents who opt in would
  // report an empty project while three agents collide in it.
  const block = formatPresenceBlock([{ session_id: 'agent-b', tool: 'claude_code', last_seen_at: iso(Date.now() - 30 * 1000) }]);
  assert.ok(block, 'a peer with no scope must still be visible');
  assert.match(block, /agent-b/);
});

test('presence reports, it does not instruct', () => {
  const block = formatPresenceBlock([{ session_id: 'agent-b', tool: 'codex', last_seen_at: iso(Date.now()) }]);
  assert.doesNotMatch(block, /do not edit|must not|blocked|forbidden/i);
  assert.match(block, /advisory/i);
});

// ── Staleness ────────────────────────────────────────────────────────────────

test('a brief is stale only when the project moved after it', () => {
  const t0 = iso(Date.parse('2026-08-20T10:00:00Z'));
  const t1 = iso(Date.parse('2026-08-20T10:05:00Z'));
  assert.equal(isBriefStale(t0, t1), true);
  assert.equal(isBriefStale(t1, t0), false);
  assert.equal(isBriefStale(t0, t0), false);
});

test('a missing watermark never claims staleness', () => {
  // Silence beats a banner we cannot justify.
  assert.equal(isBriefStale(null, iso(Date.now())), false);
  assert.equal(isBriefStale(iso(Date.now()), null), false);
});

test('the staleness banner is null with nothing to report and caps what it lists', () => {
  assert.equal(formatStalenessBanner([]), null);
  const banner = formatStalenessBanner(['a', 'b', 'c', 'd', 'e'], { max: 2 });
  assert.match(banner, /5 changes since your brief/);
  assert.match(banner, /\+3 more/);
});
