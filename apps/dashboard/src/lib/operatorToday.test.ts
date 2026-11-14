/**
 * The behavioural half of /admin/today's contract — the decision functions run
 * against real inputs. The structural half (which surfaces carry colour, which
 * gate the page sits behind) is in tests/admin-today-contract.test.js.
 *
 * Run: tsx --test src/lib/operatorToday.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPERATOR_WINDOWS,
  clockTime,
  displayName,
  overflowLabel,
  relativeTime,
  summarySentence,
} from './operatorToday';

const AT = (iso: string) => Date.parse(iso);
const NOW = AT('2026-08-29T18:00:00Z');

// ── The sentence ─────────────────────────────────────────────────────────────

test('the singular case reads as English', () => {
  // At current volume ONE is the common answer, so the singular path is the hot
  // path, not the edge case. "1 people got 1 briefs" is the fastest way to make
  // a page look like it is guessing.
  assert.equal(
    summarySentence({ people_count: 1, briefs_count: 1, first_timers: 1 }, 'today'),
    "1 person got 1 brief today. 1 was somebody's first ever.",
  );
});

test('plurals agree at every count', () => {
  assert.equal(
    summarySentence({ people_count: 3, briefs_count: 7, first_timers: 2 }, 'today'),
    "3 people got 7 briefs today. 2 were somebody's first ever.",
  );
  assert.equal(
    summarySentence({ people_count: 2, briefs_count: 2, first_timers: 0 }, 'in the last 7 days'),
    '2 people got 2 briefs in the last 7 days. None were a first.',
  );
});

test('zero is stated plainly, not as an empty sentence', () => {
  // An empty day is a real answer and the page must say so out loud — silence
  // reads as a broken query.
  assert.equal(
    summarySentence({ people_count: 0, briefs_count: 0, first_timers: 0 }, 'today'),
    'Nobody got a brief today.',
  );
  assert.equal(
    summarySentence({ people_count: 0, briefs_count: 0, first_timers: 0 }, 'in the last 30 days'),
    'Nobody got a brief in the last 30 days.',
  );
});

test('the sentence names no rate or percentage', () => {
  for (const people of [0, 1, 5]) {
    const sentence = summarySentence(
      { people_count: people, briefs_count: people * 2, first_timers: 1 },
      'today',
    );
    assert.ok(!/%|percent|rate/i.test(sentence), `invented a rate: ${sentence}`);
  }
});

// ── Recency ──────────────────────────────────────────────────────────────────

test('relative time reads at every scale', () => {
  assert.equal(relativeTime('2026-08-29T18:00:00Z', NOW), 'just now');
  assert.equal(relativeTime('2026-08-29T17:56:00Z', NOW), '4m ago');
  assert.equal(relativeTime('2026-08-29T15:00:00Z', NOW), '3h ago');
  assert.equal(relativeTime('2026-08-27T18:00:00Z', NOW), '2d ago');
});

test('a future timestamp never renders as negative', () => {
  // The API host and the browser do not share a clock. A row stamped a few
  // seconds ahead must read "just now", not "-1m ago".
  assert.equal(relativeTime('2026-08-29T18:00:30Z', NOW), 'just now');
  assert.equal(relativeTime('2026-08-29T18:05:00Z', NOW), 'just now');
});

test('an unparseable or missing timestamp renders as an em dash, not Invalid Date', () => {
  assert.equal(relativeTime(null, NOW), '—');
  assert.equal(relativeTime(undefined, NOW), '—');
  assert.equal(relativeTime('not a date', NOW), '—');
  assert.equal(clockTime(null), '');
  assert.equal(clockTime('not a date'), '');
});

test('relative time is a pure function of the clock passed in', () => {
  // No Date.now() inside — otherwise two rows on one render can disagree.
  const a = relativeTime('2026-08-29T17:00:00Z', NOW);
  const b = relativeTime('2026-08-29T17:00:00Z', NOW);
  assert.equal(a, b);
  assert.notEqual(relativeTime('2026-08-29T17:00:00Z', AT('2026-08-29T20:00:00Z')), a);
});

// ── Row rendering ────────────────────────────────────────────────────────────

test('overflow shows nothing when there is nothing extra', () => {
  assert.equal(overflowLabel(0), null);
  assert.equal(overflowLabel(1), null);
  assert.equal(overflowLabel(2), '+1 other');
  assert.equal(overflowLabel(4), '+3 others');
});

test('an unresolved person is named as unknown, never guessed or blank', () => {
  // The row genuinely carries no user. Inventing a name would be worse than the
  // gap, and rendering empty would read as a layout bug.
  assert.equal(displayName({ email: null }), 'Unidentified account');
  assert.equal(displayName({ email: 'alice@realcustomer.io' }), 'alice@realcustomer.io');
});

// ── Windows ──────────────────────────────────────────────────────────────────

test('every window has a phrase the sentence can use verbatim', () => {
  assert.ok(OPERATOR_WINDOWS.length > 0);
  for (const w of OPERATOR_WINDOWS) {
    assert.ok(w.days >= 1, `${w.label} must be at least a day`);
    const sentence = summarySentence(
      { people_count: 0, briefs_count: 0, first_timers: 0 },
      w.phrase,
    );
    assert.ok(sentence.endsWith('.'), `window phrase "${w.phrase}" does not end a sentence`);
    assert.ok(!sentence.includes('  '), 'phrase produced a double space');
  }
});

test('windows stay inside the server-side clamp of 31 days', () => {
  // MAX_WINDOW_DAYS in apps/api/src/services/operatorToday.js. A window the
  // server silently narrows would label the page with a range it did not read.
  for (const w of OPERATOR_WINDOWS) {
    assert.ok(w.days <= 31, `${w.label} exceeds the server clamp`);
  }
});
