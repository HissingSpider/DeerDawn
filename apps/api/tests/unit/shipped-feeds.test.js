/**
 * SHIPPED slot feeds. The Shipped column used to fill only from structured
 * task_completed/feature_shipped events, so it was almost always empty while
 * Decided filled up from every conversation. Two feeds now populate it:
 *
 *   1. The extractor proposes completions as `completed_work` strings, which
 *      sanitizeLlmOutput rewrites into shipped[] entries at confidence 0.5 so they
 *      surface as INFERRED — never self-certified. A model-authored `shipped` is
 *      always dropped.
 *   2. Moving a board card into the Done column appends to shipped[] at
 *      confidence 1 (VERIFIED), the same trust as a structured completion event.
 *
 * Pure (no DB / no OpenAI). Run: node tests/unit/shipped-feeds.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextObject,
  mergeContextObject,
  buildBriefSpine,
} = require('../../../../packages/shared-context/src/index.js');
const { sanitizeLlmOutput } = require('../../src/services/extractionService.js');

const trustOf = (spine, text) => spine.shipped.find((s) => s.text === text)?.trust;

test('extractor completed_work becomes an INFERRED shipped entry', () => {
  const out = sanitizeLlmOutput({
    delta: { completed_work: ['Fixed the GOOGLE_ADS_CUSTOMER_ID in Fly secrets'] },
  });
  assert.equal(out.delta.completed_work, undefined, 'completed_work is consumed, not passed through');
  assert.equal(out.delta.shipped.length, 1);
  assert.equal(out.delta.shipped[0].confidence, 0.5, 'stamped in the INFERRED band');

  const merged = mergeContextObject(createContextObject({ project_name: 'T' }), out.delta, 'test');
  const spine = buildBriefSpine(merged);
  assert.equal(trustOf(spine, 'Fixed the GOOGLE_ADS_CUSTOMER_ID in Fly secrets'), 'inferred');
});

test('a model-authored shipped[] is dropped (never self-certifies as VERIFIED)', () => {
  const out = sanitizeLlmOutput({
    delta: {
      shipped: [{ summary: 'I totally shipped this', shipped_at: new Date().toISOString(), confidence: 1 }],
    },
  });
  assert.equal(out.delta.shipped, undefined, 'model-authored shipped is stripped');
});

test('vague completed_work entries are filtered out', () => {
  const out = sanitizeLlmOutput({ delta: { completed_work: ['did stuff', ''] } });
  assert.equal(out.delta.shipped, undefined);
});

test('moving a board card to Done appends a VERIFIED shipped entry', () => {
  const now = new Date().toISOString();
  const ctx = createContextObject({ project_name: 'T' });
  ctx.todo_items = [
    { id: 'a', title: 'Already-done card', phase: 'done', created_at: now, completed_at: now },
    { id: 'b', title: 'Wire funnel event', phase: 'in_progress', created_at: now },
  ];

  const merged = mergeContextObject(ctx, { complete_todos: ['Wire funnel event'] }, 'test');
  const spine = buildBriefSpine(merged);

  // Only the freshly-completed card ships; the pre-existing done card does not re-ship.
  assert.equal(merged.shipped.length, 1);
  assert.equal(trustOf(spine, 'Wire funnel event'), 'high');
  assert.equal(spine.shipped.find((s) => s.text === 'Already-done card'), undefined);
});

test('a card added straight into Done ships once and does not re-ship on the next merge', () => {
  const ctx = createContextObject({ project_name: 'T' });
  const merged = mergeContextObject(ctx, { add_todos: [{ title: 'Hotfix deployed', phase: 'done' }] }, 'test');
  assert.equal(merged.shipped.length, 1);
  assert.equal(merged.shipped[0].confidence, 1);

  // A subsequent unrelated merge must not re-ship the already-done card.
  const again = mergeContextObject(merged, { current_status: 'still going' }, 'test');
  assert.equal(again.shipped.length, 1);
});
