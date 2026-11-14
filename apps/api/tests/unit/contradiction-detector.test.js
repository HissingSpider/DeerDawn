'use strict';

/**
 * Contradiction detection — and, mostly, its silences.
 *
 * A missed contradiction costs nothing: the brief is as it was. A false one
 * costs attention and, repeated, the reader's trust in every other line. So most
 * of what follows asserts that the detector stays QUIET, which is the property
 * that actually decides whether this feature is worth having.
 */

const assert = require('assert');
const {
  detectContradictions,
  renderContradictions,
  isNegated,
} = require('../../src/services/contradictionDetector');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const AUG = '2026-08-28T10:00:00.000Z';
const SEP = '2026-09-01T10:00:00.000Z';
const JAN = '2026-01-01T10:00:00.000Z';
const decision = (summary, contributed_by, decided_at = AUG) => ({ summary, contributed_by, decided_at });

const RETRY = 'Retry the payments webhook on a 429 response';
const NEVER_RETRY = 'Never retry the payments webhook on a 429 response';

test('two people, same subject, opposite stance', () => {
  const found = detectContradictions([
    decision(RETRY, 'sarah', AUG),
    decision(NEVER_RETRY, 'marcus', SEP),
  ]);
  assert.strictEqual(found.length, 1);
  // Newest first — the entry that moved the position is what the reader needs
  // to see against what already stood.
  assert.strictEqual(found[0].entries[0].contributed_by, 'marcus');
  assert.strictEqual(found[0].entries[1].contributed_by, 'sarah');
});

test('one person changing their mind is not a disagreement', () => {
  // It needs no intervention: there is nobody to reconcile with.
  assert.deepStrictEqual(detectContradictions([
    decision(RETRY, 'sarah', AUG),
    decision(NEVER_RETRY, 'sarah', SEP),
  ]), []);
});

test('two people agreeing stays silent', () => {
  // High subject overlap with the SAME polarity is agreement, and it is the
  // common case — a detector that fired here would fire constantly.
  assert.deepStrictEqual(detectContradictions([
    decision('Move the Redis cache TTL to 30 seconds', 'sarah', AUG),
    decision('Redis cache TTL should move to 30 seconds', 'marcus', SEP),
  ]), []);
});

test('unrelated subjects stay silent even when one negates', () => {
  // Polarity alone is not evidence of anything.
  assert.deepStrictEqual(detectContradictions([
    decision('Move the Redis cache TTL to 30 seconds', 'sarah', AUG),
    decision('Never deploy on a Friday afternoon', 'marcus', SEP),
  ]), []);
});

test('opposite positions months apart are a project changing course', () => {
  // That is the system working, not a disagreement to flag.
  assert.deepStrictEqual(detectContradictions([
    decision(RETRY, 'sarah', JAN),
    decision(NEVER_RETRY, 'marcus', SEP),
  ]), []);
});

test('unattributed decisions can never contradict', () => {
  // Without an author there is no disagreement to report and nobody to ask.
  assert.deepStrictEqual(detectContradictions([
    decision(RETRY, null, AUG),
    decision(NEVER_RETRY, null, SEP),
  ]), []);
  assert.deepStrictEqual(detectContradictions([
    decision(RETRY, 'sarah', AUG),
    decision(NEVER_RETRY, null, SEP),
  ]), []);
});

test('a resolved decision is out of the running', () => {
  const found = detectContradictions([
    { ...decision(RETRY, 'sarah', AUG), resolved: true },
    decision(NEVER_RETRY, 'marcus', SEP),
  ]);
  assert.deepStrictEqual(found, []);
});

test('short strings do not contradict on token-count artefacts', () => {
  // Two very short summaries can score a high Jaccard on almost nothing.
  assert.deepStrictEqual(detectContradictions([
    decision('Ship it', 'sarah', AUG),
    decision('Do not ship', 'marcus', SEP),
  ]), []);
});

test('a solo workspace gets nothing back', () => {
  const solo = Array.from({ length: 20 }, (_, i) =>
    decision(`Decision number ${i} about the payments webhook retry policy`, 'sarah', AUG));
  assert.deepStrictEqual(detectContradictions(solo), []);
});

test('malformed input never throws', () => {
  // This runs inside a brief. A detector that throws takes the brief with it.
  for (const input of [null, undefined, [], [null], [{}], [{ summary: 'x' }], 'nonsense', 42]) {
    assert.doesNotThrow(() => detectContradictions(input));
  }
});

test('negation is matched on words, not substrings', () => {
  assert.strictEqual(isNegated('never retry'), true);
  assert.strictEqual(isNegated('cannot proceed'), true);
  // 'canonical' contains 'can' and 'no'; neither may register as a negation.
  assert.strictEqual(isNegated('use the canonical key'), false);
  assert.strictEqual(isNegated('note the nothing case'), false);
});

test('the rendered block names both people and resolves nothing', () => {
  const found = detectContradictions([
    decision(RETRY, 'sarah', AUG),
    decision(NEVER_RETRY, 'marcus', SEP),
  ]);
  const text = renderContradictions(found, new Map([
    ['sarah', 'sarah@acme.com'],
    ['marcus', 'marcus@acme.com'],
  ]));
  assert.ok(text.includes('sarah@acme.com'), 'both authors are named');
  assert.ok(text.includes('marcus@acme.com'));
  // Present, never resolve: two engineers disagreeing is information, and an
  // automatic winner throws it away.
  assert.ok(/Nothing has been changed or removed/.test(text), 'must state that nothing was resolved');
  assert.ok(!/should|correct|wrong|winner/i.test(text), 'must not adjudicate');
});

test('rendering nothing renders nothing', () => {
  assert.strictEqual(renderContradictions([], new Map()), null);
  assert.strictEqual(renderContradictions(null, new Map()), null);
});

test('an unresolvable id still renders as something', () => {
  const found = detectContradictions([
    decision(RETRY, 'user-1', AUG),
    decision(NEVER_RETRY, 'user-2', SEP),
  ]);
  const text = renderContradictions(found, new Map());
  assert.ok(text.includes('user-1') && text.includes('user-2'), 'falls back to the id, never to blank');
});

(async () => {
  console.log('=== Contradiction detection ===\n');
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(`  ${error.stack || error.message}`);
      process.exitCode = 1;
    }
  }
})();
