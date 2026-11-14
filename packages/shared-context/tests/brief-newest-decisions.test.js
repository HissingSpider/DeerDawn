'use strict';

// JOURNEY R4 — WHAT THE BRIEF SHOWS: the newest three decisions, plus anything
// pinned. It showed ONE, chosen by importance, so the newest could be absent:
// a project that decided something every day kept briefing a months-old
// "important" decision as its "Recent decisions".
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectBriefDecisions, formatCodeInjection, formatConversationalInjection } = require('../src/index.js');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const at = (days) => new Date(NOW - days * 86400000).toISOString();

const DECISIONS = [
  { summary: 'Decided Postgres is the only datastore.', decided_at: at(40), importance: 'high' },
  { summary: 'Decided exports are CSV first.', decided_at: at(30), importance: 'normal' },
  { summary: 'Decided retries stop after three attempts.', decided_at: at(20), importance: 'critical' },
  { summary: 'Decided the old importer is retired.', decided_at: at(3), importance: 'normal', resolved: true },
  { summary: 'Decided to cap exports at 10k rows.', decided_at: at(2), importance: 'normal' },
  { summary: 'Decided the button lives on the invoices page.', decided_at: at(1), importance: 'normal', reasoning: 'people look there' },
  { summary: 'Decided to email a receipt after each export.', decided_at: at(0.5), importance: 'low' },
];

const context = (over = {}) => ({
  project_name: 'Invoices',
  current_task: 'Ship the export',
  current_status: 'Export half done',
  description: 'Invoicing for freelancers',
  recurring_context: ['Never run exports on the primary'],
  tech_stack: ['Node', 'Postgres'],
  recent_decisions: DECISIONS,
  ...over,
});

test('the newest three, newest first, then the pinned ones, newest first; resolved never', () => {
  assert.deepEqual(selectBriefDecisions(DECISIONS).map((d) => d.summary), [
    'Decided to email a receipt after each export.',
    'Decided the button lives on the invoices page.',
    'Decided to cap exports at 10k rows.',
    'Decided retries stop after three attempts.',
    'Decided Postgres is the only datastore.',
  ]);
});

test('a tie on decided_at goes to the later entry in the log', () => {
  const same = at(1);
  const picked = selectBriefDecisions([
    { summary: 'A', decided_at: same }, { summary: 'B', decided_at: same },
    { summary: 'C', decided_at: same }, { summary: 'D', decided_at: same },
  ]);
  assert.deepEqual(picked.map((d) => d.summary), ['D', 'C', 'B']);
});

for (const [name, format] of [['code', formatCodeInjection], ['conversational', formatConversationalInjection]]) {
  test(`${name} brief: the line shows them, and the newest is never absent`, () => {
    const payload = format(context(), 'standard', null, { now: NOW });
    const line = payload.body.split('\n').find((l) => l.startsWith('Recent decisions:'));
    assert.equal(
      line,
      'Recent decisions: Decided to email a receipt after each export. | Decided the button lives on the invoices page. (because: people look there) | Decided to cap exports at 10k rows. | Decided retries stop after three attempts. ⚠ critical | Decided Postgres is the only datastore. ★ important',
    );
  });

  test(`${name} brief: showing more decisions pushes no other section out`, () => {
    const one = format(context({ recent_decisions: [DECISIONS[2]] }), 'standard', null, { now: NOW });
    const many = format(context(), 'standard', null, { now: NOW });
    assert.deepEqual(many._meta.chosenSections, one._meta.chosenSections);
    assert.deepEqual(many._meta.droppedSections, one._meta.droppedSections);
    const rest = (p) => p.body.split('\n').filter((l) => !l.startsWith('Recent decisions:'));
    assert.deepEqual(rest(many), rest(one), 'every other line is the same');
  });

  test(`${name} brief, light: the caller's tight-token mode keeps its single line`, () => {
    const payload = format(context(), 'light', null, { now: NOW });
    const line = payload.body.split('\n').find((l) => l.startsWith('Recent decisions:'));
    assert.equal(line, 'Recent decisions: Decided retries stop after three attempts. ⚠ critical');
  });
}

test('each decision is cut the way the single line cut it: 80 on its own, 64 beside its reasoning', () => {
  const long = 'Decided to move settlement reconciliation into its own worker pool with a dedicated connection budget and a kill switch.';
  const payload = formatCodeInjection(context({ recent_decisions: [
    { summary: long, decided_at: at(1) },
    { summary: long.replace('settlement', 'refund'), decided_at: at(2), reasoning: 'the finance team asked for a switch they can flip' },
  ] }), 'standard', null, { now: NOW });
  const line = payload.body.split('\n').find((l) => l.startsWith('Recent decisions:'));
  const [first, second] = line.slice('Recent decisions: '.length).split(' | ');
  assert.ok(first.endsWith('...') && first.length <= 112, first);
  assert.match(second, /^Decided to move refund .{1,80}\.\.\. \(because: /, second);
});
