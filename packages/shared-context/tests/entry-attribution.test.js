'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  createContextObject,
  mergeContextObject,
  normalizeDebuggingNotes,
} = require('../src/index.js');

/**
 * WHO SHIPPED IT, WHO FOUND THE LANDMINE.
 *
 * Decisions carry `contributed_by` and the whole team loop reads it: the
 * catch-up block names the colleague, team_context_received fires, the
 * contradiction pass compares two people rather than two sentences. Shipped
 * entries, landmines and debugging notes had no such field in their schemas —
 * so a stamp applied one layer up was parsed away here, silently, and a
 * teammate who shipped something or recorded a landmine through a tool stayed
 * invisible in everybody else's brief.
 *
 * The dedupe rule mirrors recent_decisions: whoever recorded a thing FIRST is
 * who learned it, so a later copy of the same summary never reassigns it.
 */

const AT = (hour) => `2026-09-20T${String(hour).padStart(2, '0')}:00:00.000Z`;
const SARAH = 'user-sarah';
const MARCUS = 'user-marcus';

const card = (title, phase) => ({
  id: `card-${title.toLowerCase().replace(/\s+/g, '-')}`,
  title,
  phase,
  created_at: AT(0),
});

test('contributed_by survives the shipped/landmine/note normalizers', () => {
  const context = createContextObject({
    project_name: 'Payments API',
    shipped: [{ summary: 'Shipped the share policy', shipped_at: AT(1), contributed_by: SARAH }],
    landmines: [{ summary: 'The graph join has no index', added_at: AT(1), contributed_by: SARAH }],
    debugging_notes: [{ summary: 'The consent redirect drops the code', added_at: AT(1), contributed_by: MARCUS }],
  });
  assert.strictEqual(context.shipped[0].contributed_by, SARAH, 'a shipped entry must keep its author');
  assert.strictEqual(context.landmines[0].contributed_by, SARAH, 'a landmine must keep its author');
  assert.strictEqual(context.debugging_notes[0].contributed_by, MARCUS, 'a debugging note must keep its author');
});

test('a re-recorded entry keeps its FIRST author, the way a decision does', () => {
  // Same summary, recorded again later by somebody else. The merge is not a
  // change of authorship.
  const context = createContextObject({
    project_name: 'Payments API',
    shipped: [
      { summary: 'Shipped the share policy', shipped_at: AT(1), contributed_by: SARAH },
      { summary: 'Shipped the share policy', shipped_at: AT(5), contributed_by: MARCUS },
    ],
    landmines: [
      { summary: 'The graph join has no index', added_at: AT(1), contributed_by: SARAH },
      { summary: 'The graph join has no index', added_at: AT(5), contributed_by: MARCUS },
    ],
  });
  assert.strictEqual(context.shipped.length, 1);
  assert.strictEqual(context.shipped[0].contributed_by, SARAH, 'the first writer keeps a shipped entry');
  assert.strictEqual(context.landmines.length, 1);
  assert.strictEqual(context.landmines[0].contributed_by, SARAH, 'the first writer keeps a landmine');

  // Notes collapse on debuggingNoteKey, which ignores dates and digits — so the
  // refreshed copy of an hourly note must not steal the original's author.
  const notes = normalizeDebuggingNotes([
    { summary: 'Growth run 2026-09-20 01:00 finished: 4 signups', added_at: AT(1), contributed_by: SARAH },
    { summary: 'Growth run 2026-09-20 05:00 finished: 9 signups', added_at: AT(5), contributed_by: MARCUS },
  ]);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].contributed_by, SARAH, 'the first writer keeps a debugging note');
});

test('an unattributed re-record does not erase an author that was already there', () => {
  const current = createContextObject({
    project_name: 'Payments API',
    shipped: [{ summary: 'Shipped the share policy', shipped_at: AT(1), contributed_by: SARAH }],
  });
  const merged = mergeContextObject(current, {
    shipped: [{ summary: 'Shipped the share policy', shipped_at: AT(5) }],
  }, 'update');
  assert.strictEqual(merged.shipped.length, 1);
  assert.strictEqual(merged.shipped[0].contributed_by, SARAH);
});

test('the landmine merge keeps the original author across an importance bump', () => {
  const current = createContextObject({
    project_name: 'Payments API',
    landmines: [{ summary: 'Rotating the master key orphans every DEK', added_at: AT(1), importance: 'high', contributed_by: SARAH }],
  });
  const merged = mergeContextObject(current, {
    landmines: [{ summary: 'Rotating the master key orphans every DEK', added_at: AT(6), importance: 'critical', contributed_by: MARCUS }],
  }, 'update');
  const entry = merged.landmines.find((l) => l.summary.startsWith('Rotating'));
  assert.strictEqual(entry.importance, 'critical', 'the sharper importance still wins');
  assert.strictEqual(entry.contributed_by, SARAH, 'but the person who found it is unchanged');
});

test('a debugging note merged in keeps the author it arrived with', () => {
  const current = createContextObject({ project_name: 'Payments API' });
  const merged = mergeContextObject(current, {
    debugging_notes: [{ summary: 'The consent redirect drops the code', added_at: AT(2), contributed_by: MARCUS }],
  }, 'update');
  assert.strictEqual(merged.debugging_notes[0].contributed_by, MARCUS);
});

test('a card moved to Done ships attributed to whoever moved it', () => {
  const current = createContextObject({
    project_name: 'Payments API',
    todo_items: [card('Wire the seat counter', 'in_progress')],
  });
  const merged = mergeContextObject(current, { complete_todos: ['Wire the seat counter'] }, 'update', {
    contributedBy: MARCUS,
  });
  const entry = (merged.shipped || []).find((s) => s.summary === 'Wire the seat counter');
  assert.ok(entry, 'moving a card to Done still records it as shipped');
  assert.strictEqual(entry.contributed_by, MARCUS, 'THE BUG: a teammate\'s completion reaches nobody\'s catch-up unattributed');
});

test('with nobody behind the write, the entry stays unattributed', () => {
  // An internal actor resolves to null, and a null must render as
  // "unattributed" rather than quietly looking like the reader's own.
  const current = createContextObject({
    project_name: 'Payments API',
    todo_items: [card('Wire the seat counter', 'in_progress')],
  });
  const merged = mergeContextObject(current, { complete_todos: ['Wire the seat counter'] }, 'update');
  const entry = (merged.shipped || []).find((s) => s.summary === 'Wire the seat counter');
  assert.ok(entry);
  assert.ok(!entry.contributed_by, 'no author must be invented');
});
