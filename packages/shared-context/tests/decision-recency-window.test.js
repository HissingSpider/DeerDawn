'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  selectRecentDecisions,
  rankHotPaths,
  formatSectionInjection,
  formatCodeInjection,
} = require('../src/index.js');

/**
 * The brief led with stale run-logs.
 *
 * selectRecentDecisions ranked importance-first with no decay, and the
 * structured-event floors stamped `high` on nearly everything they wrote. So a
 * month-old `high` run-log outranked the `normal` decision made this morning,
 * and the three slots the brief has for decisions never turned over.
 *
 * Every test pins the clock through `options.now` — a ranking with a window in
 * it is otherwise a test that starts failing two weeks after it was written.
 */

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const daysAgo = (n, hour = 9) => {
  const d = new Date(NOW - n * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const names = (list) => list.map((d) => d.summary);

test('a month-old `high` entry no longer outranks a `normal` decision from this week', () => {
  const ranked = selectRecentDecisions([
    { summary: 'stale-high-runlog', importance: 'high', decided_at: daysAgo(30) },
    { summary: 'fresh-normal', importance: 'normal', decided_at: daysAgo(1) },
  ], 5, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['fresh-normal', 'stale-high-runlog']);
});

test('inside the window the order is by date: an older `high` does not jump a newer `normal`', () => {
  const ranked = selectRecentDecisions([
    { summary: 'high-five-days', importance: 'high', decided_at: daysAgo(5) },
    { summary: 'normal-two-days', importance: 'normal', decided_at: daysAgo(2) },
    { summary: 'low-one-day', importance: 'low', decided_at: daysAgo(1) },
  ], 5, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['low-one-day', 'normal-two-days', 'high-five-days']);
});

test('`high` is the tie-break between entries from the same day, and only that', () => {
  const ranked = selectRecentDecisions([
    { summary: 'normal-late', importance: 'normal', decided_at: daysAgo(3, 17) },
    { summary: 'high-early', importance: 'high', decided_at: daysAgo(3, 8) },
    { summary: 'normal-next-day', importance: 'normal', decided_at: daysAgo(2, 8) },
  ], 5, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['normal-next-day', 'high-early', 'normal-late']);
});

test('`critical` still leads regardless of age', () => {
  const ranked = selectRecentDecisions([
    { summary: 'fresh-normal', importance: 'normal', decided_at: daysAgo(0) },
    { summary: 'old-critical', importance: 'critical', decided_at: daysAgo(90) },
  ], 5, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['old-critical', 'fresh-normal']);
});

test('everything older than 14 days ranks after the window, and keeps importance order among itself', () => {
  const ranked = selectRecentDecisions([
    { summary: 'old-normal-newer', importance: 'normal', decided_at: daysAgo(20) },
    { summary: 'old-high-older', importance: 'high', decided_at: daysAgo(40) },
    { summary: 'in-window-low', importance: 'low', decided_at: daysAgo(13) },
  ], 5, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['in-window-low', 'old-high-older', 'old-normal-newer']);
});

test('a stamped-in date does not buy a place in the window', () => {
  // date_inferred means decided_at is when the entry was EXTRACTED, which is
  // always "just now". It must stay below genuinely dated entries.
  const ranked = selectRecentDecisions([
    { summary: 'undated-claim', importance: 'normal', decided_at: daysAgo(0), date_inferred: true },
    { summary: 'dated-last-week', importance: 'normal', decided_at: daysAgo(6) },
    { summary: 'dated-last-month', importance: 'normal', decided_at: daysAgo(35) },
  ], 5, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['dated-last-week', 'dated-last-month', 'undated-claim']);
});

test('rows with no importance at all (written before the field) rank as normal, not last', () => {
  const ranked = selectRecentDecisions([
    { summary: 'legacy-no-importance', decided_at: daysAgo(2) },
    { summary: 'high-older', importance: 'high', decided_at: daysAgo(4) },
  ], 5, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['legacy-no-importance', 'high-older']);
});

test('resolved entries and the count cap still apply', () => {
  const ranked = selectRecentDecisions([
    { summary: 'a', decided_at: daysAgo(1) },
    { summary: 'b', decided_at: daysAgo(2), resolved: true },
    { summary: 'c', decided_at: daysAgo(3) },
    { summary: 'd', decided_at: daysAgo(4) },
  ], 2, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['a', 'c']);
});

// ── the decisions section ────────────────────────────────────────────────────

const recent = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

test('the decisions section clips a 4,000-character summary instead of printing it', () => {
  const long = `We moved the queue to Redis streams. ${'evidence '.repeat(500)}TAIL-MARKER`;
  const out = formatSectionInjection({
    project_name: 'p',
    recent_decisions: [{ summary: long, decided_at: recent() }],
  }, ['decisions'], null);
  assert.doesNotMatch(out, /TAIL-MARKER/);
  const line = out.split('\n').find((l) => l.startsWith('  - '));
  assert.ok(line.length <= 250, `decision line was ${line.length} chars`);
  assert.match(line, /Redis streams/);
});

test('an over-long summary gives way to its stored headline', () => {
  const out = formatSectionInjection({
    project_name: 'p',
    recent_decisions: [{
      summary: `Preamble that is not the claim. ${'filler '.repeat(200)}`,
      headline: 'Queue moved to Redis streams',
      decided_at: recent(),
    }],
  }, ['decisions'], null);
  assert.match(out, /Queue moved to Redis streams/);
  assert.doesNotMatch(out, /Preamble that is not the claim/);
});

test('a summary that fits is printed whole even when a headline exists', () => {
  // The headline is for surfaces that cannot afford the summary. This one can.
  const out = formatSectionInjection({
    project_name: 'p',
    recent_decisions: [{
      summary: 'Use Postgres advisory locks for the seed job because Redis may be absent.',
      headline: 'Advisory locks for seed',
      decided_at: recent(),
    }],
  }, ['decisions'], null);
  assert.match(out, /because Redis may be absent/);
});

test('long reasoning is clipped too', () => {
  const out = formatSectionInjection({
    project_name: 'p',
    recent_decisions: [{
      summary: 'Short claim here.',
      reasoning: `${'why '.repeat(400)}REASON-TAIL`,
      decided_at: recent(),
    }],
  }, ['decisions'], null);
  assert.doesNotMatch(out, /REASON-TAIL/);
  assert.match(out, /because: why/);
});

// ── hot paths ────────────────────────────────────────────────────────────────

const paths = () => [
  ...Array.from({ length: 8 }, (_, i) => ({ label: `old-${i}`, path: `src/old-${i}.js`, purpose: '' })),
  { label: 'important-one', path: 'src/important.js', purpose: '', importance: 'high' },
  { label: 'pinned-one', path: 'src/pinned.js', purpose: '', pinned: true },
];

test('rankHotPaths puts pinned first, then importance, and leaves unhinted entries in stored order', () => {
  const ranked = rankHotPaths(paths()).map((p) => p.label);
  assert.deepStrictEqual(ranked.slice(0, 4), ['pinned-one', 'important-one', 'old-0', 'old-1']);
  // No hints anywhere: order is untouched (everything written before the hints).
  const plain = paths().slice(0, 8);
  assert.deepStrictEqual(rankHotPaths(plain), plain);
  assert.deepStrictEqual(rankHotPaths(undefined), []);
});

test('the hot_paths section renders a pinned path that sits past the first six', () => {
  const out = formatSectionInjection({ project_name: 'p', hot_paths: paths() }, ['hot_paths'], null);
  assert.match(out, /pinned-one/);
  assert.match(out, /important-one/);
});

test('the code brief renders the pinned path, not the oldest', () => {
  const out = formatCodeInjection({ project_name: 'p', current_task: 't', hot_paths: paths() }, 'detailed');
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  assert.match(text, /pinned-one/);
});

// ── criticals must not own every slot forever ────────────────────────────────

test('three old criticals do not leave "Recent decisions" with nothing recent', () => {
  const ranked = selectRecentDecisions([
    { summary: 'critical-a', importance: 'critical', decided_at: daysAgo(120) },
    { summary: 'critical-b', importance: 'critical', decided_at: daysAgo(100) },
    { summary: 'critical-c', importance: 'critical', decided_at: daysAgo(80) },
    { summary: 'decided-yesterday', importance: 'normal', decided_at: daysAgo(1) },
    { summary: 'decided-three-days-ago', importance: 'normal', decided_at: daysAgo(3) },
  ], 3, { now: NOW });

  assert.deepStrictEqual(
    names(ranked),
    ['critical-c', 'critical-b', 'decided-yesterday'],
    'the criticals keep leading, but the last slot goes back to the newest decision in the window',
  );
});

test('the traded slot is the last one, and only one is traded', () => {
  const ranked = selectRecentDecisions([
    { summary: 'critical-a', importance: 'critical', decided_at: daysAgo(120) },
    { summary: 'critical-b', importance: 'critical', decided_at: daysAgo(100) },
    { summary: 'fresh-a', importance: 'normal', decided_at: daysAgo(1) },
    { summary: 'fresh-b', importance: 'normal', decided_at: daysAgo(2) },
  ], 2, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['critical-b', 'fresh-a']);
});

test('with one slot the critical still keeps it', () => {
  const ranked = selectRecentDecisions([
    { summary: 'old-critical', importance: 'critical', decided_at: daysAgo(120) },
    { summary: 'decided-yesterday', importance: 'normal', decided_at: daysAgo(1) },
  ], 1, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['old-critical']);
});

test('nothing is traded when a recent decision is already in the slice', () => {
  const ranked = selectRecentDecisions([
    { summary: 'critical-a', importance: 'critical', decided_at: daysAgo(120) },
    { summary: 'critical-b', importance: 'critical', decided_at: daysAgo(100) },
    { summary: 'fresh-a', importance: 'normal', decided_at: daysAgo(1) },
  ], 3, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['critical-b', 'critical-a', 'fresh-a']);
});

test('nothing recent exists, so the criticals keep every slot', () => {
  const ranked = selectRecentDecisions([
    { summary: 'critical-a', importance: 'critical', decided_at: daysAgo(120) },
    { summary: 'critical-b', importance: 'critical', decided_at: daysAgo(100) },
    { summary: 'critical-c', importance: 'critical', decided_at: daysAgo(80) },
    { summary: 'old-normal', importance: 'normal', decided_at: daysAgo(40) },
  ], 3, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['critical-c', 'critical-b', 'critical-a']);
});

test('a date_inferred entry does not count as the recent one', () => {
  // Its decided_at is the moment it was extracted, so "recent" would be a lie.
  const ranked = selectRecentDecisions([
    { summary: 'critical-a', importance: 'critical', decided_at: daysAgo(120) },
    { summary: 'critical-b', importance: 'critical', decided_at: daysAgo(100) },
    { summary: 'critical-c', importance: 'critical', decided_at: daysAgo(80) },
    { summary: 'undated-claim', importance: 'normal', decided_at: daysAgo(0), date_inferred: true },
  ], 3, { now: NOW });
  assert.deepStrictEqual(names(ranked), ['critical-c', 'critical-b', 'critical-a']);
});
