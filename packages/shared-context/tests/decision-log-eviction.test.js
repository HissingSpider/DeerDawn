'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { capDecisions, createContextObject, mergeContextObject } = require('../src/index.js');

/**
 * EVERY DECISION SURVIVED EXACTLY ONE WRITE.
 *
 * Eviction ranked by importance alone. Before #495 every structured-event floor
 * write was stamped `high`, so an established project holds a full log of
 * month-old `high` run-logs — and a new entry defaults to `normal`. The moment
 * the entry written in THIS call stopped being the protected one, it was the
 * lowest-ranked entry in the log, so the NEXT write evicted it. The caller was
 * told `stored: true` every time, and the log never turned over.
 *
 * The window is the same 14 days selectRecentDecisions bands by: outside it a
 * stamped `high` buys nothing, because that stamp was applied by a floor, not
 * by a person. The clock is pinned through `options.now` for the same reason it
 * is there — a rule with a window in it is otherwise a test with an expiry date.
 */

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n, hour = 9) => {
  const d = new Date(NOW - n * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const names = (list) => list.map((d) => d.summary);

/** A log as an established project has it: 20 entries the old floor stamped `high`. */
const legacyLog = () => Array.from({ length: 20 }, (_, i) => ({
  summary: `Growth run log ${i}: nothing to act on`,
  importance: 'high',
  decided_at: daysAgo(40 - i),
}));

/** What appendRecentDecision does: push, then cap protecting the new entry. */
const append = (log, summary, extra = {}) => capDecisions(
  [...log, { summary, importance: 'normal', decided_at: new Date(NOW).toISOString(), ...extra }],
  { keep: [summary], now: NOW },
);

test('five decisions written in a row into a log of legacy `high` entries all survive', () => {
  let log = legacyLog();
  for (let i = 1; i <= 5; i += 1) log = append(log, `DECISION ${i}`);
  assert.equal(log.length, 20);
  for (let i = 1; i <= 5; i += 1) {
    assert.ok(log.some((d) => d.summary === `DECISION ${i}`), `DECISION ${i} was evicted by a later write`);
  }
  // The five that went are the five oldest legacy entries, in order.
  assert.deepStrictEqual(
    names(log).slice(0, 3),
    ['Growth run log 5: nothing to act on', 'Growth run log 6: nothing to act on', 'Growth run log 7: nothing to act on'],
  );
});

test('a `low` decision recorded today outlives a log of month-old `high` entries', () => {
  const afterLow = append(legacyLog(), 'a low note from today', { importance: 'low' });
  // The next write must not treat it as the cheapest thing in the log.
  const afterNext = append(afterLow, 'the decision after it');
  assert.ok(afterNext.some((d) => d.summary === 'a low note from today'), 'today\'s entry was evicted by the next write');
});

/** The same log, but every entry is INSIDE the window: the state of every
 *  project that has been active in the two weeks since #495 deployed. */
const recentLegacyLog = () => Array.from({ length: 20 }, (_, i) => ({
  summary: `Growth run log ${i}: nothing to act on`,
  importance: 'high',
  decided_at: daysAgo(13 - i / 2),
}));

test('five decisions written in a row into a log of RECENT `high` entries all survive', () => {
  // The residual half of the same bug. Age banding alone rescues only projects
  // whose backlog has aged past the window; a project active this fortnight
  // holds twenty `high` entries INSIDE it, and a `normal` written today was
  // still the cheapest thing in the band.
  let log = recentLegacyLog();
  for (let i = 1; i <= 5; i += 1) log = append(log, `DECISION ${i}`);
  assert.equal(log.length, 20);
  for (let i = 1; i <= 5; i += 1) {
    assert.ok(log.some((d) => d.summary === `DECISION ${i}`), `DECISION ${i} was evicted by a later write`);
  }
  assert.deepStrictEqual(
    names(log).slice(0, 3),
    ['Growth run log 5: nothing to act on', 'Growth run log 6: nothing to act on', 'Growth run log 7: nothing to act on'],
    'the five entries that went should be the five oldest',
  );
});

test('a `low` saved today survives the next write into a log of recent `high` entries', () => {
  const afterLow = append(recentLegacyLog(), 'a low note from today', { importance: 'low' });
  const afterNext = append(afterLow, 'the decision after it');
  assert.ok(
    afterNext.some((d) => d.summary === 'a low note from today'),
    'an explicitly saved `low` vanished on the very next write while 19 older entries stayed',
  );
});

test('inside the window the stamp does not let an older entry outlive a newer one', () => {
  const recent = Array.from({ length: 20 }, (_, i) => ({
    summary: `recent high ${i}`,
    importance: 'high',
    decided_at: daysAgo(3, i % 24),
  }));
  recent[0] = { summary: 'oldest recent normal', importance: 'normal', decided_at: daysAgo(13) };
  recent[9] = { summary: 'newer recent normal', importance: 'normal', decided_at: daysAgo(1) };
  const capped = capDecisions([...recent, { summary: 'brand new', importance: 'normal', decided_at: new Date(NOW).toISOString() }], { keep: ['brand new'], now: NOW });
  assert.ok(!names(capped).includes('oldest recent normal'), 'the oldest entry in the band should have gone');
  assert.ok(names(capped).includes('newer recent normal'), 'a newer `normal` was evicted in favour of an older `high`');
});

test('a `critical` from three months ago keeps its seat', () => {
  const log = legacyLog();
  log[0] = { summary: 'never deploy on a Friday', importance: 'critical', decided_at: daysAgo(90) };
  const capped = append(log, 'todays decision');
  assert.ok(names(capped).includes('never deploy on a Friday'));
  assert.ok(!names(capped).includes('Growth run log 1: nothing to act on'), 'the oldest stale entry should have gone');
});

test('a resolved entry goes before anything live, however recent', () => {
  const log = legacyLog();
  log[19] = { summary: 'already resolved', importance: 'critical', decided_at: daysAgo(0), resolved: true };
  const capped = append(log, 'todays decision');
  assert.ok(!names(capped).includes('already resolved'));
  assert.ok(names(capped).includes('Growth run log 0: nothing to act on'), 'a live entry was evicted while a resolved one kept its seat');
});

test('a log that is entirely recent and entirely `high` falls back to the oldest', () => {
  const log = Array.from({ length: 20 }, (_, i) => ({
    summary: `recent high ${i}`,
    importance: 'high',
    decided_at: daysAgo(10 - i / 4),
  }));
  const capped = append(log, 'todays decision');
  assert.ok(!names(capped).includes('recent high 0'), 'the oldest recent entry should have gone');
  assert.ok(names(capped).includes('recent high 19'));
});

test('an entry with no parseable date counts as old, not as new', () => {
  const log = legacyLog();
  log[10] = { summary: 'undated legacy entry', importance: 'high' };
  const capped = append(log, 'todays decision');
  assert.ok(!names(capped).includes('undated legacy entry'));
});

test('the surviving list stays in stored order, which is what readers slice by', () => {
  const log = legacyLog();
  const capped = append(log, 'todays decision');
  const stamps = capped.map((d) => Date.parse(d.decided_at || 0));
  assert.deepStrictEqual(stamps, [...stamps].sort((a, b) => a - b), 'eviction reordered the log');
  assert.equal(capped[capped.length - 1].summary, 'todays decision');
});

test('the same rule applies through mergeContextObject, not only the append path', () => {
  const ctx = createContextObject({ project_name: 'Atlas', recent_decisions: legacyLog() });
  let merged = ctx;
  for (const summary of ['merge one', 'merge two', 'merge three']) {
    merged = mergeContextObject(merged, {
      recent_decisions: [{ summary, importance: 'normal', decided_at: new Date().toISOString() }],
    }, '');
  }
  const kept = merged.recent_decisions.filter((d) => d.summary.startsWith('merge')).map((d) => d.summary);
  assert.deepStrictEqual(kept, ['merge one', 'merge two', 'merge three']);
});

test('mergeContextObject keeps five sequential writes into a RECENT `high` log too', () => {
  const ctx = createContextObject({ project_name: 'Atlas', recent_decisions: recentLegacyLog() });
  let merged = ctx;
  const written = ['merge one', 'merge two', 'merge three', 'merge four', 'merge five'];
  for (const summary of written) {
    merged = mergeContextObject(merged, {
      recent_decisions: [{ summary, importance: 'normal', decided_at: new Date().toISOString() }],
    }, '');
  }
  assert.deepStrictEqual(
    merged.recent_decisions.filter((d) => d.summary.startsWith('merge')).map((d) => d.summary),
    written,
  );
});
