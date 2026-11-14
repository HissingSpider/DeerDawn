/**
 * Engine Waves 1 + 7: the decision/debug log must not silently lose findings at
 * the cap, and a pinned/critical finding must outlive trivial newer ones.
 *
 * Before the fix uniqueEntries kept the OLDEST maxItems, so a full log dropped
 * every new append while the tool still said "Recorded". Now it keeps the newest,
 * and pinned/important entries survive eviction first. Pure (no DB) — drives the
 * shared-context merge directly.
 *
 * Run: node tests/unit/context-log-eviction.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeContextObject } = require('../../../../packages/shared-context/src/index.js');

const iso = (mo, s) => `2026-${String(mo).padStart(2, '0')}-01T00:00:${String(s).padStart(2, '0')}.000Z`;

test('a newly-recorded finding past the cap is kept (oldest is evicted, not the new one)', () => {
  const old = Array.from({ length: 30 }, (_, i) => ({ summary: `old ${i}`, paths: [], added_at: iso(1, i) }));
  let ctx = mergeContextObject({ project_name: 'Eviction Test', debugging_notes: [] }, { debugging_notes: old });
  assert.equal(ctx.debugging_notes.length, 30);

  ctx = mergeContextObject(ctx, { debugging_notes: [{ summary: 'fresh finding', paths: [], added_at: iso(6, 0) }] });
  assert.equal(ctx.debugging_notes.length, 30, 'cap respected');
  assert.ok(ctx.debugging_notes.some((n) => n.summary === 'fresh finding'), 'the new finding survives the cap');
  assert.ok(!ctx.debugging_notes.some((n) => n.summary === 'old 0'), 'the oldest is evicted instead');
});

test('a pinned finding survives a flood of newer trivial findings', () => {
  let ctx = { project_name: 'Eviction Test', debugging_notes: [{ summary: 'pinned root-cause', paths: [], added_at: '2020-01-01T00:00:00.000Z', pinned: true }] };
  const flood = Array.from({ length: 35 }, (_, i) => ({ summary: `trivial ${i}`, paths: [], added_at: iso(6, i) }));
  ctx = mergeContextObject(ctx, { debugging_notes: flood });
  assert.equal(ctx.debugging_notes.length, 30, 'cap respected');
  assert.ok(ctx.debugging_notes.some((n) => n.summary === 'pinned root-cause'), 'pinned finding outlives the flood');
});

test('a critical finding outranks normal ones at the cap', () => {
  let ctx = { project_name: 'Eviction Test', debugging_notes: [{ summary: 'critical regression', paths: [], added_at: '2020-01-01T00:00:00.000Z', importance: 'critical' }] };
  const flood = Array.from({ length: 35 }, (_, i) => ({ summary: `note ${i}`, paths: [], added_at: iso(6, i) }));
  ctx = mergeContextObject(ctx, { debugging_notes: flood });
  assert.ok(ctx.debugging_notes.some((n) => n.summary === 'critical regression'), 'critical finding survives');
});
