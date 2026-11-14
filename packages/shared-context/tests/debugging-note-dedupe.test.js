'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeDebuggingNotes, mergeContextObject, createContextObject } = require('../src/index.js');

/**
 * Hourly notes that differ only by a date or a count must not pile up.
 *
 * The dedupe key was the verbatim summary. A scheduled agent filing the same
 * sentence with a new timestamp every hour was therefore filing a NEW note every
 * hour, and the log (cap 30) filled with copies that evicted every real finding
 * — after which search, `recall paths` and the brief all returned the run-log.
 */

const at = (hour) => `2026-09-04T${String(hour).padStart(2, '0')}:00:00.000Z`;

test('notes differing only by date and digits collapse to the latest one', () => {
  const notes = Array.from({ length: 24 }, (_, hour) => ({
    summary: `Growth run 2026-09-04 ${String(hour).padStart(2, '0')}:00 finished: ${hour + 3} signups, nothing to act on`,
    added_at: at(hour),
  }));
  const out = normalizeDebuggingNotes(notes);
  assert.strictEqual(out.length, 1);
  assert.match(out[0].summary, /23:00 finished: 26 signups/, 'the LATEST copy is the one kept');
});

test('a real finding is not evicted by a day of run-logs', () => {
  const real = { summary: 'The consent redirect drops the code query parameter', added_at: '2026-09-01T10:00:00.000Z' };
  const runs = Array.from({ length: 40 }, (_, i) => ({
    summary: `Hourly check ${i}: queue depth ${i * 7}, all green`,
    added_at: new Date(Date.parse('2026-09-02T00:00:00.000Z') + i * 3600e3).toISOString(),
  }));
  const out = normalizeDebuggingNotes([real, ...runs]);
  assert.ok(out.some((n) => n.summary === real.summary), 'the real finding survives');
  assert.strictEqual(out.length, 2);
});

test('a refreshed note moves to the tail, where every reader looks for the newest', () => {
  const out = normalizeDebuggingNotes([
    { summary: 'Nightly journey run 1: all steps passed', added_at: at(1) },
    { summary: 'Stripe webhook retries are not idempotent', added_at: at(2) },
    { summary: 'Nightly journey run 2: all steps passed', added_at: at(3) },
  ]);
  assert.deepStrictEqual(out.map((n) => n.summary), [
    'Stripe webhook retries are not idempotent',
    'Nightly journey run 2: all steps passed',
  ]);
});

test('different findings stay different, and short numeric notes keep their own identity', () => {
  const out = normalizeDebuggingNotes([
    { summary: 'Login loop: bootstrap reads any 401 as expiry', added_at: at(1) },
    { summary: 'Signup loop: Clerk transfer drops unsafeMetadata', added_at: at(2) },
    // Nothing is left of these once the digits go, so the verbatim key stands.
    { summary: 'PR #486', added_at: at(3) },
    { summary: 'PR #487', added_at: at(4) },
  ]);
  assert.strictEqual(out.length, 4);
});

test('a number that NAMES something keeps the notes apart', () => {
  // The dedupe key stripped every digit run, so two findings about different
  // migrations, runtimes or ports collapsed into one and record_finding still
  // answered "recorded". A count is noise; an identifier is the finding.
  const out = normalizeDebuggingNotes([
    { summary: 'Migration 0042 fails on prod: column owner_user_id missing', added_at: at(1) },
    { summary: 'Migration 0057 fails on prod: column owner_user_id missing', added_at: at(2) },
    { summary: 'Tests hang on Node 18 unless DISABLE_REDIS is set', added_at: at(3) },
    { summary: 'Tests hang on Node 22 unless DISABLE_REDIS is set', added_at: at(4) },
    { summary: 'apps/api listens on port 8080; the dashboard proxy expects it', added_at: at(5) },
    { summary: 'apps/api listens on port 3001; the dashboard proxy expects it', added_at: at(6) },
    // A release NUMBER was here, asserted distinct, and it is not: two notes
    // identical except for "v542"/"v543" are one recurring note about
    // successive deploys, which is how a deploy watcher files them every hour.
    // It moved to the counts side of the table in debugging-note-flood.test.js;
    // an HTTP status, which is a name, took its place.
    { summary: 'The export endpoint returns 404 for a shared project', added_at: at(7) },
    { summary: 'The export endpoint returns 403 for a shared project', added_at: at(8) },
  ]);
  assert.strictEqual(out.length, 8);
});

test('a pin survives being replaced by an unpinned copy', () => {
  const out = normalizeDebuggingNotes([
    { summary: 'Deploy check 1: migrations must run before the API boots', added_at: at(1), pinned: true },
    { summary: 'Deploy check 2: migrations must run before the API boots', added_at: at(2) },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].pinned, true);
  assert.match(out[0].summary, /check 2/);
});

test('the merge path collapses them too (rows already stored + a new hourly note)', () => {
  const base = createContextObject({ project_id: 'p', project_name: 'p' });
  const first = mergeContextObject(base, { debugging_notes: [{ summary: 'Hourly digest 09:00 sent to 14 people', added_at: at(9) }] }, 's');
  const second = mergeContextObject(first, { debugging_notes: [{ summary: 'Hourly digest 10:00 sent to 15 people', added_at: at(10) }] }, 's');
  assert.deepStrictEqual(second.debugging_notes.map((n) => n.summary), ['Hourly digest 10:00 sent to 15 people']);
});
