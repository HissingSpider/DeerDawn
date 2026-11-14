import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  MAX_TRAIL_CHARS,
  MAX_TRAIL_BYTES_CEILING,
  describeTrailTooLarge,
  trailTooLarge,
} from './trailLimits';

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedContext = readFileSync(
  path.resolve(here, '../../../../packages/shared-context/src/index.js'),
  'utf8',
);
const trailsPage = readFileSync(path.resolve(here, '../pages/trails.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the mirrored cap is the one the API enforces', () => {
  // packages/shared-context is CommonJS and is not a dependency of this app, so
  // the number is mirrored and pinned here — the arrangement planCopy has with
  // plans.js. Underscore separators are how the source writes it.
  const match = /const MAX_TRAIL_CHARS = ([\d_]+);/.exec(sharedContext);
  assert.ok(match, 'shared-context no longer declares MAX_TRAIL_CHARS — re-point this mirror');
  assert.equal(
    Number(match[1].replace(/_/g, '')),
    MAX_TRAIL_CHARS,
    'the dashboard\'s trail cap has drifted from the one the import validates against',
  );
});

test('the page refuses at the API\'s number, not at 5 MB', () => {
  // The old guard was `file.size > 5 * 1024 * 1024`, which is 26x the real cap:
  // a 250 KB trail sailed past it and came back a raw Zod 400.
  assert.ok(
    !/5 \* 1024 \* 1024/.test(trailsPage),
    'the 5 MB guard is back; it is 26x what the import accepts',
  );
  assert.match(trailsPage, /trailTooLarge\(/, 'the page must measure against the shared cap');
});

test('size is judged in characters, with a byte ceiling only as a shortcut', () => {
  assert.equal(trailTooLarge(MAX_TRAIL_CHARS), false, 'exactly the cap is accepted, as z.string().max is');
  assert.equal(trailTooLarge(MAX_TRAIL_CHARS + 1), true);
  // Bytes are all the browser knows before reading, and UTF-8 spends up to four
  // per character — so a byte test alone would refuse a legitimate multi-byte
  // archive. The ceiling only skips reading what cannot fit under any encoding.
  assert.equal(MAX_TRAIL_BYTES_CEILING, MAX_TRAIL_CHARS * 4);
});

test('the refusal names the same number the server would', () => {
  const message = describeTrailTooLarge(250_000);
  assert.match(message, /250,000 characters/);
  assert.match(message, /200,000/);
  assert.ok(!/5 MB/.test(message), 'the message must not repeat the limit that was never real');
});
