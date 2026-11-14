import test from 'node:test';
import assert from 'node:assert';
import { relativeTime, shortTime } from './relativeTime';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('relativeTime always reads correctly with " ago" after it', () => {
  // The bug this file exists for: "just now" + " ago" = "just now ago", on the
  // most recently touched project — the one the resume card actually shows.
  for (const iso of [ago(5_000), ago(90_000), ago(3 * 3600_000), ago(4 * 86400_000), ago(200 * 86400_000)]) {
    const phrase = `last touched ${relativeTime(NOW, iso)} ago`;
    assert.ok(!/just now ago|now ago/.test(phrase), `ungrammatical: "${phrase}"`);
    assert.ok(!/^last touched  ago$/.test(phrase), `empty value: "${phrase}"`);
  }
  assert.strictEqual(relativeTime(NOW, ago(5_000)), 'moments');
  assert.strictEqual(relativeTime(NOW, ago(90_000)), '2m');
  assert.strictEqual(relativeTime(NOW, ago(3 * 3600_000)), '3h');
  assert.strictEqual(relativeTime(NOW, ago(4 * 86400_000)), '4d');
  assert.strictEqual(relativeTime(NOW, ago(200 * 86400_000)), '7mo');
});

test('shortTime is the standalone spelling, for columns with no "ago"', () => {
  assert.strictEqual(shortTime(NOW, ago(5_000)), 'now', 'a bare column reads "now", not "moments"');
  assert.strictEqual(shortTime(NOW, ago(3 * 3600_000)), '3h', 'everything else is unchanged');
});

test('pre-mount and missing values never render as text', () => {
  // `now` is null until the mount effect runs; rendering "never" then would
  // flash a false claim before the real value arrives.
  assert.strictEqual(relativeTime(null, ago(1000)), '');
  assert.strictEqual(relativeTime(NOW, null), 'never');
  assert.strictEqual(relativeTime(NOW, 'not-a-date'), 'never');
});
