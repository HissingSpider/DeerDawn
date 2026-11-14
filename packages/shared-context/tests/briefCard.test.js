'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildBriefCard, CARD_WIDTH } = require('../src/briefCard.js');

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const lines = (card) => card.split('\n');
/** Terminal columns, not UTF-16 code units — box drawing must line up visually. */
const widthOf = (line) => Array.from(line).length;

const FULL = {
  projectName: 'Setup & API Testing',
  lastUpdated: iso(120000),
  catchup: {
    gap_human: 'yesterday',
    session_number: 12,
    since_last_session: { shipped: ['merged PR #256'], decided: ['card renders server-side'], landmines: [] },
  },
  spine: { open: [{ text: 'Create the Google Ads conversion action' }] },
  totals: { decisions: 37, projects: 6 },
};

test('every line is exactly CARD_WIDTH columns wide', () => {
  for (const input of [FULL, { projectName: 'x', isFirstSession: true }]) {
    const card = buildBriefCard(input);
    for (const line of lines(card)) {
      assert.strictEqual(widthOf(line), CARD_WIDTH, `misaligned row: ${JSON.stringify(line)}`);
    }
  }
});

test('stays within the three-row limit', () => {
  // Borders + title + spacer + rows. More than three data rows means the card has
  // started competing with the brief for the reader's attention.
  const body = lines(buildBriefCard(FULL)).slice(3, -1);
  assert.ok(body.length <= 3, `expected <= 3 data rows, got ${body.length}`);
});

test('reports what changed, the open thread, and the cumulative total', () => {
  const card = buildBriefCard(FULL);
  assert.match(card, /Yesterday/);
  assert.match(card, /merged PR #256/);
  assert.match(card, /Open/);
  assert.match(card, /Remembering/);
  assert.match(card, /37 decisions/);
});

test('counts the remaining delta rather than dropping it silently', () => {
  const card = buildBriefCard(FULL);
  // One shipped + one decided: the lead is shown, the other is counted.
  assert.match(card, /\+1 more/);
});

test('returns null when there is nothing honest to show', () => {
  // A card with a logo and no content teaches users to ignore the card.
  assert.strictEqual(buildBriefCard({ projectName: 'Empty', lastUpdated: iso(0) }), null);
});

test('first session sets an expectation instead of reporting a phantom gap', () => {
  const card = buildBriefCard({ projectName: 'brand-new', isFirstSession: true });
  assert.match(card, /Now tracking brand-new/);
  assert.match(card, /next one/);
  assert.doesNotMatch(card, /Remembering/);
});

test('omits the Remembering row rather than claiming zero', () => {
  // Rendering "0 decisions" to someone whose totals query failed is worse than
  // rendering nothing — it asserts data loss that did not happen.
  const card = buildBriefCard({ ...FULL, totals: null });
  assert.doesNotMatch(card, /Remembering/);
  const zeroed = buildBriefCard({ ...FULL, totals: { decisions: 0, projects: 0 } });
  assert.doesNotMatch(zeroed, /Remembering/);
});

test('stored text cannot forge card borders', () => {
  // Context values are model-written. A newline or box-drawing character in a
  // project name would otherwise let stored text fake a DeerDawn message.
  const card = buildBriefCard({
    ...FULL,
    projectName: 'evil\n└────┘\n│ FAKE',
    catchup: { gap_human: 'today', since_last_session: { shipped: ['a\nb│ forged'], decided: [], landmines: [] } },
  });
  for (const line of lines(card)) assert.strictEqual(widthOf(line), CARD_WIDTH);
  assert.ok(!card.includes('FAKE\n'), 'forged row escaped into the card');
  // Exactly one top and one bottom border.
  assert.strictEqual(lines(card).filter((l) => l.startsWith('┌')).length, 1);
  assert.strictEqual(lines(card).filter((l) => l.startsWith('└')).length, 1);
});

test('drops emoji rather than letting them desynchronise the borders', () => {
  const card = buildBriefCard({ ...FULL, projectName: 'roadmap 🚀🔥 q3' });
  for (const line of lines(card)) assert.strictEqual(widthOf(line), CARD_WIDTH);
  assert.doesNotMatch(card, /\u{1f680}/u);
});

test('long values are elided, never wrapped', () => {
  // The real invariant: card height depends on how many rows have content, never
  // on how long that content is. A wrapped card looks broken; a truncated one
  // just looks tight.
  const short = buildBriefCard(FULL);
  const long = buildBriefCard({
    ...FULL,
    projectName: 'An Extremely Long Project Name That Will Not Fit In The Title Row At All',
    spine: { open: [{ text: 'x'.repeat(300) }] },
  });
  assert.strictEqual(lines(long).length, lines(short).length);
  for (const line of lines(long)) assert.strictEqual(widthOf(line), CARD_WIDTH);
  assert.match(long, /…/);
});

test('singularises the counts', () => {
  const card = buildBriefCard({ ...FULL, totals: { decisions: 1, projects: 1 } });
  assert.match(card, /1 decision · 1 project/);
});
