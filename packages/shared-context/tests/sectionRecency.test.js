'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatSectionInjection } = require('../src/index.js');

/**
 * Append-ordered logs must brief NEWEST-first.
 *
 * `SECTION_MAP.decisions` used to do `.slice(0, 3)` on recent_decisions, which is
 * stored in append order — so a project with twenty decisions briefed its first
 * three, permanently, and every new decision was invisible. The failure mode is
 * nasty because it looks exactly like a dropped write: you record a decision, you
 * read the brief, and it is not there.
 *
 * `shipped` already got this right (`slice(-6).reverse()`); decisions,
 * debugging_notes and landmines did not.
 */

const iso = (day) => `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`;

/** 20 entries, oldest first, so a front-slice returns only OLD-* items. */
const many = (prefix, extra = {}) =>
  Array.from({ length: 20 }, (_, i) => ({
    summary: `${i < 10 ? 'OLD' : 'NEW'}-${prefix}-${i}`,
    ...extra,
    ...(prefix === 'decision' ? { decided_at: iso(i + 1) } : {}),
  }));

const render = (ctx, sections) => formatSectionInjection(ctx, sections, null);

test('decisions brief the newest, not the first three ever recorded', () => {
  const out = render({ recent_decisions: many('decision') }, ['decisions']);
  assert.match(out, /NEW-decision/, 'newest decisions must appear');
  assert.doesNotMatch(out, /OLD-decision/, 'oldest decisions must not crowd out the newest');
});

test('decisions still let importance outrank recency', () => {
  // selectRecentDecisions ranks importance first — a critical decision from last
  // month should outrank routine ones from today.
  const out = render({
    recent_decisions: [
      { summary: 'CRITICAL-old', importance: 'critical', decided_at: iso(1) },
      { summary: 'normal-new-a', decided_at: iso(20) },
      { summary: 'normal-new-b', decided_at: iso(21) },
      { summary: 'normal-new-c', decided_at: iso(22) },
    ],
  }, ['decisions']);
  assert.match(out, /CRITICAL-old/);
});

test('decisions exclude resolved entries', () => {
  const out = render({
    recent_decisions: [
      { summary: 'still-open', decided_at: iso(1) },
      { summary: 'already-resolved', resolved: true, decided_at: iso(2) },
    ],
  }, ['decisions']);
  assert.match(out, /still-open/);
  assert.doesNotMatch(out, /already-resolved/);
});

test('debugging notes brief the newest findings', () => {
  const out = render({ debugging_notes: many('note') }, ['debugging_notes']);
  assert.match(out, /NEW-note/);
  assert.doesNotMatch(out, /OLD-note/);
});

test('landmines brief the newest', () => {
  const out = render({ landmines: many('mine') }, ['landmines']);
  assert.match(out, /NEW-mine/);
  assert.doesNotMatch(out, /OLD-mine/);
});

test('shipped keeps its already-correct newest-first behaviour', () => {
  // Regression guard on the one section that was right all along.
  const out = render({ shipped: many('ship') }, ['shipped']);
  assert.match(out, /NEW-ship/);
  assert.doesNotMatch(out, /OLD-ship/);
});

/**
 * The union merge APPENDS, so the newest goal, constraint and file are at the
 * tail — and these three sections took the head. With four goals stored, a
 * fifth added today never appeared in any brief, which reads exactly like a
 * dropped write. Same rule as open_questions and commands: newest first.
 */
test('goals show the ones added most recently, not the first four ever set', () => {
  const out = render({ goals: ['OLD-goal-1', 'OLD-goal-2', 'OLD-goal-3', 'OLD-goal-4', 'NEW-goal-today'] }, ['goals']);
  assert.match(out, /NEW-goal-today/, 'the goal added today must appear');
  assert.doesNotMatch(out, /OLD-goal-1/, 'the oldest goal crowded out the newest');
  assert.ok(out.indexOf('NEW-goal-today') < out.indexOf('OLD-goal-4'), 'goals must read newest first');
});

test('constraints show the ones added most recently', () => {
  const out = render({ recurring_context: ['OLD-rule-1', 'OLD-rule-2', 'OLD-rule-3', 'NEW-rule-today'] }, ['constraints']);
  assert.match(out, /NEW-rule-today/);
  assert.doesNotMatch(out, /OLD-rule-1/);
});

test('the files line shows the most recently recorded paths', () => {
  const files = Array.from({ length: 10 }, (_, i) => `${i < 2 ? 'OLD' : 'NEW'}-file-${i}`);
  const out = render({ file_structure_summary: files }, ['files']);
  assert.match(out, /NEW-file-9/);
  assert.doesNotMatch(out, /OLD-file-0/);
});

test('a short list is rendered whole, newest first', () => {
  const out = render({ goals: ['first goal', 'second goal'] }, ['goals']);
  assert.match(out, /first goal/);
  assert.match(out, /second goal/);
  assert.ok(out.indexOf('second goal') < out.indexOf('first goal'));
});

test('a short log is rendered whole regardless of ordering', () => {
  const out = render({
    recent_decisions: [{ summary: 'only-one', decided_at: iso(1) }],
  }, ['decisions']);
  assert.match(out, /only-one/);
});
