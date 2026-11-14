// Journey BLOCKED 13: the decision log says "newest first" and listed oldest first.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { decisionsNewestFirst } from './decisionLogOrder';

test('the log is appended to, so stored order is oldest first; it is shown newest first', () => {
  const stored = [
    { summary: 'first', decided_at: '2026-09-01T00:00:00.000Z' },
    { summary: 'second', decided_at: '2026-09-10T00:00:00.000Z' },
    { summary: 'third', decided_at: '2026-09-20T00:00:00.000Z' },
  ];
  assert.deepStrictEqual(decisionsNewestFirst(stored).map((d) => d.summary), ['third', 'second', 'first']);
  assert.deepStrictEqual(stored.map((d) => d.summary), ['first', 'second', 'third'], 'the input is not reordered in place');
});

test('a tie, or no date, goes to the later write', () => {
  const same = '2026-09-10T00:00:00.000Z';
  assert.deepStrictEqual(
    decisionsNewestFirst([{ summary: 'a', decided_at: same }, { summary: 'b', decided_at: same }, { summary: 'c' }, { summary: 'd' }]).map((d) => d.summary),
    ['b', 'a', 'd', 'c'],
  );
});

test('the log the brief renders uses this order under the "newest first" heading', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/dashboard/brief/DecisionsLog.tsx'), 'utf8');
  assert.match(source, /newest first/);
  assert.match(source, /decisionsNewestFirst\(/);
});
