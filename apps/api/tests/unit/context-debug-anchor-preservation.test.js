/**
 * Wave 0 keystone regression: replayable debug anchors must survive saves.
 *
 * record_debug_finding captures commit_ref/diff_ref so a stored finding is
 * replayable ("git-confirm it") rather than merely locatable. The API-local
 * normalizeDebuggingNotes rebuilt each note field-by-field and dropped those
 * anchors, and because normalizeContextForSchema -> buildIntegrityRepairPatch
 * reruns on EVERY update_context PATCH, an unrelated PATCH (e.g. current_task)
 * silently stripped the anchors off previously-saved notes. This guards that
 * the anchors are preserved. Pure (no DB).
 *
 * Run: node tests/unit/context-debug-anchor-preservation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeContextForSchema,
  buildIntegrityRepairPatch,
} = require('../../src/services/contextSyncService.js');
const { closeRedisConnections } = require('../../src/config/redis');

// Importing contextSyncService eagerly opens the shared Redis client; release it
// so this pure test exits cleanly (matches the sibling unit tests' teardown).
test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

const anchoredNote = {
  summary: 'Fixed the freshness drift detection',
  paths: ['packages/mcp-server/src/freshness.ts'],
  added_at: '2026-06-01T00:00:00.000Z',
  commit_ref: 'abc1234',
  diff_ref: 'https://github.com/HissingSpider/DeerDawn/pull/142',
};

test('normalizeContextForSchema preserves commit_ref/diff_ref on debugging notes', () => {
  const project = { project_name: 'DeerDawn', context: { debugging_notes: [{ ...anchoredNote }] } };
  const norm = normalizeContextForSchema(project);
  assert.equal(norm.debugging_notes.length, 1);
  assert.equal(norm.debugging_notes[0].commit_ref, 'abc1234', 'commit_ref preserved');
  assert.equal(norm.debugging_notes[0].diff_ref, anchoredNote.diff_ref, 'diff_ref preserved');
});

test('an unrelated PATCH (current_task) does NOT strip anchors off existing notes', () => {
  // Stored project already carries an anchored finding.
  const stored = {
    project_name: 'DeerDawn',
    context: { current_task: 'old task', debugging_notes: [{ ...anchoredNote }] },
  };
  // Simulate update_context shallow-merging an unrelated field, then the
  // integrity-repair pass that runs on every PATCH.
  const patched = { ...stored, context: { ...stored.context, current_task: 'new task' } };
  const repair = buildIntegrityRepairPatch(patched);
  // The effective context after the repair patch is applied must keep the anchors.
  const effective = { ...patched.context, ...repair };
  assert.equal(effective.debugging_notes[0].commit_ref, 'abc1234', 'commit_ref survives an unrelated PATCH');
  assert.equal(effective.debugging_notes[0].diff_ref, anchoredNote.diff_ref, 'diff_ref survives an unrelated PATCH');
});

test('notes without anchors gain no spurious anchor keys', () => {
  const project = {
    project_name: 'DeerDawn',
    context: { debugging_notes: [{ summary: 'plain note', paths: [], added_at: '2026-06-01T00:00:00.000Z' }] },
  };
  const note = normalizeContextForSchema(project).debugging_notes[0];
  assert.ok(!('commit_ref' in note), 'no spurious commit_ref');
  assert.ok(!('diff_ref' in note), 'no spurious diff_ref');
});

test('legacy string-form debugging notes still normalize without throwing', () => {
  const project = { project_name: 'DeerDawn', context: { debugging_notes: ['a freeform note'] } };
  let norm;
  assert.doesNotThrow(() => { norm = normalizeContextForSchema(project); });
  assert.equal(norm.debugging_notes[0].summary, 'a freeform note');
});
