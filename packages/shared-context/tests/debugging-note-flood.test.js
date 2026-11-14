'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeDebuggingNotes, debuggingNoteKey } = require('../src/index.js');

/**
 * A flood of look-alike notes must not be able to empty the log.
 *
 * Two layers, tested separately here because they fail separately.
 *
 * KEY: a number belongs to a note's identity only when it NAMES the thing the
 * note is about. The identifier list grew to include `#`, `v`, `pr`, `issue`,
 * `error`, `status` and `code`, which is exactly how a scheduled agent numbers
 * its own logs — so "Hourly scan #41" and "#42" were two findings again and the
 * dedupe stopped applying to the case it was written for.
 *
 * CAP: the key can never be perfect. When it misses, ranking the log by recency
 * hands the whole list to whatever wrote last — 32 numbered run-logs evicted 30
 * distinct findings, one per write, every reply saying "Recorded". So the note
 * that goes at the cap is the oldest member of the LARGEST group of look-alikes.
 */

const at = (hour) => `2026-09-04T${String(hour).padStart(2, '0')}:00:00.000Z`;
const sameKey = (a, b) => debuggingNoteKey({ summary: a }) === debuggingNoteKey({ summary: b });

// Every row of the table in the comment above debuggingNoteKey, both ways.
const NAMES_A_THING = [
  ['Migration 0042 fails on prod: column owner_user_id missing', 'Migration 0057 fails on prod: column owner_user_id missing'],
  ['apps/api listens on port 8080; the dashboard proxy expects it', 'apps/api listens on port 3001; the dashboard proxy expects it'],
  ['Tests hang on Node 18 unless DISABLE_REDIS is set', 'Tests hang on Node 22 unless DISABLE_REDIS is set'],
  ['Tests hang on node v18 unless DISABLE_REDIS is set', 'Tests hang on node v22 unless DISABLE_REDIS is set'],
  ['Postgres 16 plans the evidence join as a sequential scan', 'Postgres 14 plans the evidence join as a sequential scan'],
  ['The export endpoint returns 404 for a shared project', 'The export endpoint returns 403 for a shared project'],
  ['The Fly proxy answers status 502 while the machine boots', 'The Fly proxy answers status 503 while the machine boots'],
  ['The upload path fails with error 413 on a large trail', 'The upload path fails with error 500 on a large trail'],
];

const COUNTS_SOMETHING = [
  ['Hourly scan #41 at 14:00: 0 regressions found', 'Hourly scan #42 at 15:00: 0 regressions found'],
  ['Growth run 2026-09-04: 5 signups, 2 activations', 'Growth run 2026-09-05: 7 signups, 1 activations'],
  ['Nightly journey E2E: status 200 on 14 of 14 pages', 'Nightly journey E2E: status 200 on 13 of 14 pages'],
  ['Scheduled check: error 3 times in the last hour', 'Scheduled check: error 9 times in the last hour'],
  ['Deploy v542 healthy, p95 310ms', 'Deploy v543 healthy, p95 290ms'],
  ['Fly release v542 is the first with the encryption key set', 'Fly release v543 is the first with the encryption key set'],
  ['Cron tick: issue 0 open, queue depth 12', 'Cron tick: issue 4 open, queue depth 40'],
  ['Health probe: http 200 in 120ms', 'Health probe: http 200 in 95ms'],
  ['Daily review: PR 512 merged, 3 open', 'Daily review: PR 513 merged, 2 open'],
  ['Daily review: PR #512 merged, 3 open', 'Daily review: PR #513 merged, 2 open'],
  ['Import attempt 4 timed out against the staging API', 'Import attempt 7 timed out against the staging API'],
];

for (const [left, right] of NAMES_A_THING) {
  test(`the number names a thing, so the notes stay apart: ${left.slice(0, 44)}`, () => {
    assert.strictEqual(sameKey(left, right), false, `${left}\n${right}`);
  });
}

for (const [left, right] of COUNTS_SOMETHING) {
  test(`the number counts something, so the notes are one note: ${left.slice(0, 44)}`, () => {
    assert.strictEqual(sameKey(left, right), true, `${left}\n${right}`);
  });
}

test('a run-log that gets a distinct key anyway displaces its own kind, not the findings', () => {
  // Deliberately keyed APART: each of these carries a port number, so the key
  // does its job and every one of them is its own note. The cap is what has to
  // hold the line now, and ranking by recency is what would not.
  const findings = Array.from({ length: 10 }, (_, i) => ({
    summary: `Real finding: the ${['auth', 'billing', 'queue', 'search', 'export', 'mailer', 'webhooks', 'cache', 'uploads', 'reports'][i]} subsystem drops requests when its pool is exhausted`,
    added_at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 3600e3).toISOString(),
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
    'every distinct finding survives a flood of look-alikes',
  );
  assert.ok(notes.length <= 30);
});

test('with no look-alikes to displace, the oldest note is still the one that goes', () => {
  const notes = normalizeDebuggingNotes(
    Array.from({ length: 31 }, (_, i) => ({
      summary: `Distinct finding number ${i} about the ${String.fromCharCode(97 + i)} subsystem that shares no wording with the others`,
      added_at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 3600e3).toISOString(),
    })),
  );
  assert.strictEqual(notes.length, 30);
  assert.ok(!notes.some((n) => / number 0 /.test(n.summary)), 'the oldest went');
  assert.ok(notes.some((n) => / number 30 /.test(n.summary)), 'the newest stayed');
});

test('a pinned note outlives the flood and the cap', () => {
  const pinned = { summary: 'Pinned: the encryption master key must be backed up before any write', added_at: at(0), pinned: true };
  let notes = normalizeDebuggingNotes([pinned]);
  for (let i = 0; i < 40; i++) {
    notes = normalizeDebuggingNotes([...notes, {
      summary: `Hourly probe: port ${9000 + i} answered, 0 regressions found`,
      added_at: new Date(Date.parse('2026-09-02T00:00:00.000Z') + i * 3600e3).toISOString(),
    }]);
  }
  assert.ok(notes.some((n) => n.pinned && n.summary === pinned.summary));
});
