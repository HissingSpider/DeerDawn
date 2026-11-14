/**
 * The Memory page's Evidence row may not call its lines conversation excerpts.
 *
 * It said "N conversation excerpts" because that is what the rows held: the
 * first 400 characters of what the person and the assistant said. Since the
 * journey scan's round 3 (2026-09-28) the graph stores no conversation text; each
 * evidence row carries a line the product writes (apps/api/src/services/
 * graphEvidenceLine.js), and the row's own tool and date are shown beside it. A
 * label promising excerpts of the conversation would now describe something the
 * product no longer keeps.
 *
 * Run: node --test tests/evidence-label-contract.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'memory.tsx'), 'utf8');

test('the Evidence row counts sources, not conversation excerpts', () => {
  const start = page.indexOf('label="Evidence"');
  const row = page.slice(start, page.indexOf('</DisclosureRow>', start));
  assert.ok(row.startsWith('label="Evidence"'), 'premise: the Memory page still has its Evidence row');
  assert.ok(!/excerpt|quote|conversation/i.test(row.split('>')[0]), `the row's label calls the lines conversation text: ${row.split('>')[0]}`);
  assert.match(row, /'source' : 'sources'/, 'the count is of sources, singular for one');
  assert.match(row, /\{item\.excerpt\}/, 'and each line is still shown');
});

test('nothing on the Memory page calls the evidence conversation excerpts', () => {
  assert.ok(!/conversation excerpts?/i.test(page), 'the Memory page still says "conversation excerpts"');
});
