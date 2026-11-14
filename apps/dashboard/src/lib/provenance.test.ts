import test from 'node:test';
import assert from 'node:assert';
import { provenanceLabel, provenanceTitle } from './provenance';
import { deriveBriefSpine } from './api';

test('a line from a Done card is labelled Shipped, never Verified', () => {
  assert.strictEqual(provenanceLabel('high', true), 'Shipped');
  assert.ok(!/verified/i.test(provenanceLabel('high', true)));
  assert.match(provenanceTitle('high', true), /not that anyone checked/);
  assert.ok(!/^verified/i.test(provenanceTitle('high', true)));
});

test('every other line keeps the label it had', () => {
  assert.strictEqual(provenanceLabel('high'), 'Verified');
  assert.strictEqual(provenanceLabel('high', false), 'Verified');
  assert.strictEqual(provenanceLabel('inferred'), 'Inferred');
  assert.strictEqual(provenanceLabel('unverified'), 'Unverified');
});

test('the dashboard marks a shipped entry that names a card, from the stored row', () => {
  const spine = deriveBriefSpine({
    project_id: 'p', project_name: 'P',
    shipped: [
      { summary: 'Ship the queue', shipped_at: '2026-09-30T00:00:00.000Z', confidence: 1, card_id: 'todo-1' },
      { summary: 'Released 1.0.54', shipped_at: '2026-09-30T00:00:00.000Z', confidence: 1 },
    ],
  } as never);
  assert.strictEqual(spine.shipped[0].from_card, true);
  assert.strictEqual(spine.shipped[1].from_card, undefined);
  assert.strictEqual(spine.shipped[0].trust, 'high', 'still ranked with the confirmed lines');
});
