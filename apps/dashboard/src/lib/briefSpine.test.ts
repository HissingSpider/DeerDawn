/**
 * deriveBriefSpine — the four slots the brief page renders.
 *
 * Written after two SHIPPED cards rendered in production as a provenance badge
 * with NO title and NO date (project "Aurora Launch Review", 2026-08-27).
 *
 * The cause was a type that lied. `ProjectContextJson.shipped` was declared
 * `Array<BriefItem | string>` — "already a BriefItem" — so `shippedToItem` could
 * get away with `{ ...s, index }`. But the STORED shape is ShippedEntrySchema:
 * `{ summary, shipped_at }`, with no `text` and no `decided_at`. The spread
 * copied neither into the fields the renderer reads, and TypeScript was happy
 * because the declared type said the work was already done.
 *
 * So these fixtures deliberately use the REAL stored shape rather than the
 * convenient one. A test built from `{ text }` objects would have passed
 * against the broken code, which is precisely how this shipped.
 */
import test from 'node:test';
import assert from 'node:assert';
import { deriveBriefSpine, type ProjectContextJson } from './api';

const SHIPPED_AT = '2026-08-26T10:00:00.000Z';
const DECIDED_AT = '2026-08-27T09:30:00.000Z';
const ADDED_AT = '2026-08-25T08:00:00.000Z';

/** Exactly what the API stores — summary + shipped_at, no `text`. */
const context = {
  shipped: [{ summary: 'Portfolio tab shipped', shipped_at: SHIPPED_AT, confidence: 1 }],
  recent_decisions: [{ summary: 'Removed the project cap', decided_at: DECIDED_AT }],
  open_questions: ['How long before a surface goes amber?'],
  landmines: [{ summary: 'graph nodes are unique per owner', added_at: ADDED_AT }],
} as unknown as ProjectContextJson;

test('a stored shipped entry renders its summary as the line text', () => {
  const { shipped } = deriveBriefSpine(context);
  assert.strictEqual(shipped.length, 1);
  assert.strictEqual(shipped[0].text, 'Portfolio tab shipped',
    'summary must be translated to text — a blank card claims something shipped and refuses to say what');
});

test('every slot carries a date the line can actually render', () => {
  const spine = deriveBriefSpine(context);
  // BriefLine reads decided_at || shipped_at || added_at. Each slot must supply
  // at least one of them, or the line renders with no date.
  const dateOf = (i: { decided_at?: string; shipped_at?: string; added_at?: string }) =>
    i.decided_at || i.shipped_at || i.added_at;
  assert.strictEqual(dateOf(spine.shipped[0]), SHIPPED_AT, 'shipped lost its date');
  assert.strictEqual(dateOf(spine.decided[0]), DECIDED_AT, 'decided lost its date');
  assert.strictEqual(dateOf(spine.landmine[0]), ADDED_AT, 'landmine lost its date');
});

test('no slot ever emits an item with empty text', () => {
  // A blank card is worse than a missing one. shipped was the one slot that did
  // not filter, which is why the broken mapping was VISIBLE rather than silent.
  const messy = {
    shipped: [{ shipped_at: SHIPPED_AT }, { summary: '', shipped_at: SHIPPED_AT }, { summary: 'Real one', shipped_at: SHIPPED_AT }],
    recent_decisions: [{ summary: '', decided_at: DECIDED_AT }],
    landmines: [{ summary: '', added_at: ADDED_AT }],
    open_questions: ['', '   '],
  } as unknown as ProjectContextJson;
  const spine = deriveBriefSpine(messy);
  for (const [name, items] of Object.entries(spine)) {
    for (const item of items) {
      assert.ok(item.text && item.text.trim(), `${name} emitted an item with no text`);
    }
  }
  assert.deepStrictEqual(spine.shipped.map((i) => i.text), ['Real one']);
});

test('the other three slots are unchanged', () => {
  const spine = deriveBriefSpine(context);
  assert.deepStrictEqual(spine.decided.map((i) => i.text), ['Removed the project cap']);
  assert.deepStrictEqual(spine.open.map((i) => i.text), ['How long before a surface goes amber?']);
  assert.deepStrictEqual(spine.landmine.map((i) => i.text), ['graph nodes are unique per owner']);
});

test('legacy bare-string entries still work in every slot', () => {
  const legacy = {
    shipped: ['Old string entry'],
    recent_decisions: ['Old decision'],
    landmines: ['Old landmine'],
    open_questions: ['Old question'],
  } as unknown as ProjectContextJson;
  const spine = deriveBriefSpine(legacy);
  assert.deepStrictEqual(spine.shipped.map((i) => i.text), ['Old string entry']);
  assert.deepStrictEqual(spine.decided.map((i) => i.text), ['Old decision']);
  assert.deepStrictEqual(spine.landmine.map((i) => i.text), ['Old landmine']);
  assert.deepStrictEqual(spine.open.map((i) => i.text), ['Old question']);
});
