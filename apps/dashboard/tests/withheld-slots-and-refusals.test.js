/**
 * The surfaces PR #480 did not reach.
 *
 * #480 taught BriefView's page-level empty state and TaskBoard that a withheld
 * section is not an empty one. Two smaller surfaces on the same screen still
 * disappeared silently:
 *
 *   BriefSlot      `if (!items.length) return null` — a withheld slot vanished
 *                  from the 2x2 grid, so a teammate saw three cards and assumed
 *                  the fourth had never been written.
 *   "Full decision history" — the disclosure row rendered only when decisions
 *                  existed, so a withheld decision log read as "no decisions
 *                  have ever been recorded here".
 *
 * And a refused write ("this section is read-only for you") was shown with the
 * same words as a dropped connection, so the honest answer looked like a glitch
 * worth retrying.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const readCode = (...parts) => read(...parts)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\{\/\*)/.test(line))
  .join('\n');

test('a withheld slot renders as withheld instead of omitting itself', () => {
  const slot = readCode('src', 'components', 'dashboard', 'brief', 'BriefSlot.tsx');
  assert.doesNotMatch(slot, /if \(!items\.length\) return null;/,
    'an empty slot and a withheld slot are different facts and cannot share one branch');
  assert.match(slot, /withheld \? <WithheldSlot/);
  assert.match(slot, /Not shared with you/);
});

test('BriefView tells each slot whether its own section was withheld', () => {
  const view = readCode('src', 'components', 'dashboard', 'brief', 'BriefView.tsx');
  assert.match(view, /SLOT_SECTION/);
  assert.match(view, /withheld=\{slotWithheld\(slot\)\}/);
  // A project whose slots are all withheld must not fall through to the
  // "doesn't have brief content yet" panel.
  assert.match(view, /spine\[s\]\.length > 0 \|\| slotWithheld\(s\)/);
  // The decision-history row explains itself rather than vanishing.
  assert.match(view, /isSectionWithheld\(context, 'recent_decisions'\)/);
});

test('a refused write names the section instead of reading as a dropped connection', () => {
  for (const file of [
    ['src', 'components', 'dashboard', 'brief', 'TaskBoard.tsx'],
    ['src', 'components', 'dashboard', 'brief', 'BriefWorkspace.tsx'],
    ['src', 'components', 'dashboard', 'ContextNetwork.tsx'],
  ]) {
    const src = readCode(...file);
    assert.match(src, /writeRefusalMessage\(err\)/, `${file.join('/')} must map share_write_forbidden`);
  }

  const network = readCode('src', 'components', 'dashboard', 'ContextNetwork.tsx');
  assert.doesNotMatch(network, /\} catch \{ setDeleting\(false\); \}/,
    'a swallowed catch left the panel looking like the click never happened');
});
