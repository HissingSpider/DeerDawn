/**
 * Near-duplicate entries: trailing punctuation must not create a second card.
 *
 * Observed in production 2026-08-28: the SHIPPED slot showed
 *   "OAuth review suite passed."
 *   "OAuth review suite passed"
 * as two separate entries. appendShipped DOES dedupe, but it compared with
 * normalizeText, which lowercases and collapses whitespace and stops there — so
 * a trailing full stop made the two strings unequal and both were stored.
 * Models vary that punctuation freely between sessions.
 *
 * dedupeKey is deliberately NOT a change to normalizeText: that function also
 * builds canonical graph keys (canonicalWorkspaceKey) and search haystacks, and
 * loosening it would silently re-identify existing graph nodes.
 */
const test = require('node:test');
const assert = require('node:assert');
const { dedupeKey, normalizeText } = require('../../src/services/contextQualityGuards');

test('trailing punctuation does not make two entries out of one', () => {
  const bare = 'OAuth review suite passed';
  for (const variant of [`${bare}.`, `${bare}!`, `${bare} `, `${bare}. `, `${bare};`, `${bare},`]) {
    assert.strictEqual(dedupeKey(variant), dedupeKey(bare), `"${variant}" should dedupe against the bare form`);
  }
});

test('the case this fixes really was broken under normalizeText', () => {
  // Pins the reason dedupeKey exists, so nobody "simplifies" it back.
  assert.notStrictEqual(
    normalizeText('OAuth review suite passed.'),
    normalizeText('OAuth review suite passed'),
    'if these ever become equal, normalizeText changed and this guard needs revisiting',
  );
});

test('internal punctuation still distinguishes entries', () => {
  // Only TERMINAL punctuation is noise. A comma in the middle changes meaning.
  assert.notStrictEqual(dedupeKey('Ship v1, then v2'), dedupeKey('Ship v1 then v2'));
  assert.notStrictEqual(dedupeKey('Fixed auth'), dedupeKey('Fixed authz'));
});

test('case and whitespace are still normalized, as before', () => {
  assert.strictEqual(dedupeKey('  Shipped   The  Thing.  '), dedupeKey('shipped the thing'));
});

test('empty and punctuation-only input collapse to an empty key', () => {
  // appendShipped treats an empty key as "nothing to store".
  for (const input of ['', '   ', '...', undefined, null]) {
    assert.strictEqual(dedupeKey(input), '');
  }
});
