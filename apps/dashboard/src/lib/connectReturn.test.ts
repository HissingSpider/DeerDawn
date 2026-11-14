/**
 * E-020 tests.
 *
 * The four cases below are not invented — they are the four `connect_step_returned`
 * events that existed when E-012 was adjudicated on 2026-09-04, replayed as
 * (awayMs, departedAfterMs) pairs. Three of them are the defect and one is the
 * real return, so a regression that reopens the window fails on real data rather
 * than on a fixture somebody chose to be convenient.
 *
 * Run: `tsx --test src/lib/connectReturn.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isRealReturn, MIN_AWAY_MS, RETURN_GRACE_MS } from './connectReturn';

/**
 * The observed E-012 population. `departedAfterMs` is the gap between
 * `onboarding_page_viewed` and the departure that preceded each return; for the
 * three churn rows the return itself landed 2-6s after the page view, so the
 * departure is bounded above by that and cannot have cleared a ten-second floor.
 */
const OBSERVED = [
  { who: '8ae2a5e7 (08-29, returned 6s after page view)', awayMs: 6_000, departedAfterMs: 0, real: false },
  { who: 'b9bb6cff #1 (08-31, returned 2s after page view)', awayMs: 2_000, departedAfterMs: 0, real: false },
  { who: 'b9bb6cff #2 (08-31, 642s away, after the copy)', awayMs: 642_000, departedAfterMs: 69_000, real: true },
  { who: 'a5094fd8 (09-02, returned 6s after page view)', awayMs: 6_000, departedAfterMs: 1_000, real: false },
];

test('the four observed E-012 events split 1 real / 3 churn', () => {
  for (const row of OBSERVED) {
    assert.equal(
      isRealReturn({ awayMs: row.awayMs, departedAfterMs: row.departedAfterMs }),
      row.real,
      row.who,
    );
  }
  assert.equal(OBSERVED.filter(r => isRealReturn(r)).length, 1);
});

test('the old rule — away length alone — would have counted all four', () => {
  // This is the assertion that makes the fix meaningful: every one of the three
  // churn rows clears the two-second bar the previous guard was built on.
  for (const row of OBSERVED) {
    assert.ok(row.awayMs >= MIN_AWAY_MS, `${row.who} clears the old guard`);
  }
});

test('a flicker is not a return, however late in the step it happens', () => {
  assert.equal(isRealReturn({ awayMs: 1_999, departedAfterMs: 300_000 }), false);
  assert.equal(isRealReturn({ awayMs: MIN_AWAY_MS, departedAfterMs: 300_000 }), true);
});

test('a departure inside the grace window is never a return, however long it lasts', () => {
  assert.equal(isRealReturn({ awayMs: 60 * 60_000, departedAfterMs: RETURN_GRACE_MS - 1 }), false);
  assert.equal(isRealReturn({ awayMs: 60 * 60_000, departedAfterMs: RETURN_GRACE_MS }), true);
});

test('an absence that cannot be placed in the timeline is dropped, not assumed good', () => {
  assert.equal(isRealReturn({ awayMs: null, departedAfterMs: 60_000 }), false);
  assert.equal(isRealReturn({ awayMs: 60_000, departedAfterMs: null }), false);
  assert.equal(isRealReturn({ awayMs: null, departedAfterMs: null }), false);
});

test('the grace window leaves room under the fastest real copy this step has seen', () => {
  // Fastest observed copy on the connect step: 24s after mount (a5094fd8,
  // 2026-09-02). Fastest copy -> consent -> approve traversal ever recorded:
  // 28s end to end (person 77aaac13, 2026-08-27). A window at or above either
  // would start dropping the very users this measures.
  assert.ok(RETURN_GRACE_MS < 24_000, 'grace window must sit under the fastest observed copy');
});

// ── The emitter actually uses the rule ───────────────────────────────────────

/**
 * Comment-blind: the block comments in onboarding.tsx discuss `isRealReturn` and
 * `seconds_since_mount` at length, so a naive regex over the raw source would
 * pass against code that had reverted to the old inline guard.
 */
function readSourceWithoutComments(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('the connect step emits through isRealReturn and stamps seconds_since_mount', () => {
  const source = readSourceWithoutComments('pages/onboarding.tsx');
  assert.match(source, /if\s*\(isRealReturn\(/, 'the emit must be gated on isRealReturn');
  assert.match(
    source,
    /const candidate = \{ awayMs, departedAfterMs \}/,
    'and it must be given both timings, not just the away length',
  );
  assert.match(source, /seconds_since_mount:/, 'the event must carry seconds_since_mount');
  // The inline `awayMs >= 2000` test is what E-020 replaces. If it comes back
  // next to the helper, the helper is decoration.
  assert.doesNotMatch(source, /awayMs\s*!==\s*null\s*&&\s*awayMs\s*>=\s*2000/);
});
