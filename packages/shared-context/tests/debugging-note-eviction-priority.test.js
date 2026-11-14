'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeDebuggingNotes } = require('../src/index.js');

/**
 * THE CAP ATE THE PAIRS THE KEY HAD JUST WORKED TO KEEP APART.
 *
 * debuggingNoteKey decides, deliberately and case by case, that "port 8080" and
 * "port 3000" are two notes, that "returns 404" and "returns 403" are two
 * notes, that five "Migration 00NN fails" findings are five findings. The
 * eviction policy then asked a different question — look-alike with EVERY digit
 * stripped — and evicted the oldest member of the largest such group. Those
 * pairs are groups of two, so a pair the key had just kept apart was eaten
 * before any older unrelated singleton, and a set of five migration notes shrank
 * toward one over four unrelated writes.
 *
 * A group of two is not a flood. A flood is a scheduled agent writing the same
 * line over and over, so the cap now asks for THREE or more AND for them to
 * have been recorded as a run; anything else and the oldest note overall goes,
 * which is the ordinary answer.
 */

const START = Date.parse('2026-09-01T00:00:00.000Z');
const at = (hours) => new Date(START + hours * 3600e3).toISOString();
const summaries = (notes) => notes.map((n) => n.summary);

// 29 unrelated findings, oldest first, leaving exactly one free slot at the cap.
function fillTo(count, offsetHours = 0) {
  const words = ('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike '
    + 'november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu '
    + 'apple banana cherry damson').split(' ');
  return Array.from({ length: count }, (_, i) => ({
    summary: `Unique finding: the ${words[i]} worker misbehaves under sustained load`,
    added_at: at(offsetHours + i),
  }));
}

test('a PAIR the key keeps apart is not evicted ahead of an older singleton', () => {
  const pair = [
    { summary: 'apps/api listens on port 8080; the dashboard proxy expects it', added_at: at(100) },
    { summary: 'apps/api listens on port 3000; the dashboard proxy expects it', added_at: at(101) },
  ];
  const notes = normalizeDebuggingNotes([...fillTo(29), ...pair]);
  assert.strictEqual(notes.length, 30);
  assert.strictEqual(
    notes.filter((n) => /listens on port/.test(n.summary)).length,
    2,
    'THE BUG: the pair was the largest look-alike group, so half of it went first',
  );
  assert.ok(!/alpha/.test(summaries(notes).join(' ')), 'the oldest unrelated finding is what goes');
});

test('a status-code pair is a pair too', () => {
  const pair = [
    { summary: 'The export endpoint returns 404 for a shared project', added_at: at(100) },
    { summary: 'The export endpoint returns 403 for a shared project', added_at: at(101) },
  ];
  const notes = normalizeDebuggingNotes([...fillTo(29), ...pair]);
  assert.strictEqual(notes.filter((n) => /export endpoint returns/.test(n.summary)).length, 2);
});

test('five migration findings do not shrink to one over four unrelated writes', () => {
  const migrations = Array.from({ length: 5 }, (_, i) => ({
    summary: `Migration 00${40 + i} fails on a fresh database because of ordering`,
    added_at: at(60 + i),
  }));
  let notes = normalizeDebuggingNotes([...fillTo(25), ...migrations]);
  assert.strictEqual(notes.filter((n) => /^Migration/.test(n.summary)).length, 5);

  for (let j = 0; j < 4; j++) {
    notes = normalizeDebuggingNotes([...notes, {
      summary: `Newly found: the ${['queue', 'mailer', 'search', 'cache'][j]} worker drops its connection`,
      added_at: at(80 + j),
    }]);
  }
  const left = notes.filter((n) => /^Migration/.test(n.summary)).length;
  assert.ok(left >= 2, `THE BUG: five migration findings were eaten down to ${left}`);
  assert.strictEqual(notes.length, 30);
});

test('three findings spread over months are not a run, whatever they look like', () => {
  // The same shape recorded weeks apart is a person hitting the same class of
  // bug three times, not an agent logging three times. Migration numbers are
  // one of the cases debuggingNoteKey deliberately keeps apart, so all three
  // are really on the log and it is the cap alone deciding here.
  const spread = [
    { summary: 'Migration 0041 fails on a fresh database because of ordering', added_at: at(100) },
    { summary: 'Migration 0058 fails on a fresh database because of ordering', added_at: at(100 + 24 * 30) },
    { summary: 'Migration 0072 fails on a fresh database because of ordering', added_at: at(100 + 24 * 60) },
  ];
  const notes = normalizeDebuggingNotes([...fillTo(28), ...spread]);
  assert.strictEqual(notes.length, 30);
  assert.strictEqual(
    notes.filter((n) => /^Migration/.test(n.summary)).length,
    3,
    'three notes weeks apart are three findings, not one run',
  );
  assert.ok(!/alpha/.test(summaries(notes).join(' ')), 'the oldest unrelated note is what goes');
});

test('a real run IS still what goes: the round-7 flood holds', () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({
    summary: `Real finding: the ${['auth', 'billing', 'queue', 'search', 'export', 'mailer', 'webhooks', 'cache', 'uploads', 'reports'][i]} subsystem drops requests when its pool is exhausted`,
    added_at: at(i),
  }));
  let notes = normalizeDebuggingNotes(findings);
  for (let i = 0; i < 32; i++) {
    notes = normalizeDebuggingNotes([...notes, {
      summary: `Hourly probe: port ${9000 + i} answered, 0 regressions found`,
      added_at: new Date(Date.parse('2026-09-02T00:00:00.000Z') + i * 3600e3).toISOString(),
    }]);
  }
  assert.strictEqual(
    notes.filter((n) => n.summary.startsWith('Real finding')).length,
    10,
    'a genuine flood still displaces only its own kind',
  );
});

test('with nothing that looks alike at all, the oldest note goes', () => {
  const notes = normalizeDebuggingNotes(fillTo(30).concat({
    summary: 'Unique finding: the elderberry worker misbehaves under sustained load',
    added_at: at(200),
  }));
  assert.strictEqual(notes.length, 30);
  assert.ok(!/alpha/.test(summaries(notes).join(' ')));
  assert.ok(/elderberry/.test(summaries(notes).join(' ')));
});

test('a SLOW flood is still a flood: one look-alike note a week does not erase the real findings', () => {
  // The 48h window alone never calls this a run (no two of its notes are within
  // a week of each other), so each of its notes competed as an ordinary
  // singleton and the oldest notes overall, the real findings, left one per
  // write until none were left. Replayed one write at a time, as the API does.
  let log = normalizeDebuggingNotes(fillTo(28));
  for (let week = 0; week < 32; week += 1) {
    log = normalizeDebuggingNotes([...log, {
      summary: `Weekly probe: port 90${String(week).padStart(2, '0')} answered, nothing to report`,
      added_at: at(1000 + week * 24 * 7),
    }]);
  }
  const real = log.filter((n) => /^Unique finding/.test(n.summary)).length;
  const flood = log.filter((n) => /^Weekly probe/.test(n.summary)).length;
  assert.ok(real >= 24, `THE BUG: a weekly run-log left ${real} of 28 real findings`);
  assert.ok(flood <= 6, `the flood is held to its share of the log, not ${flood} notes`);
});

test('five findings of one family are still under the share that makes a flood', () => {
  const family = [41, 47, 52, 57, 63].map((n, i) => ({
    summary: `Migration 00${n} fails on a fresh database: column ordering`,
    added_at: at(200 + i * 24 * 9),
  }));
  let log = normalizeDebuggingNotes([...fillTo(20), ...family]);
  for (let i = 0; i < 12; i += 1) {
    log = normalizeDebuggingNotes([...log, {
      summary: `Later unrelated finding: the ${['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet', 'white', 'black', 'grey', 'pink', 'brown'][i]} queue stalls`,
      added_at: at(3000 + i),
    }]);
  }
  assert.strictEqual(log.filter((n) => /^Migration 00/.test(n.summary)).length, 5);
});
