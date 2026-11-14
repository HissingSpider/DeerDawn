/**
 * Current-time injection (P1 of universal life-context).
 *
 * Web/IDE assistants don't know what time it is. DeerDawn now stamps a "Now:" line
 * into every injection — server computes the timestamp fresh per request, the client
 * passes its IANA timezone. This guards: the line renders with local time, a bad tz
 * falls back to UTC without throwing, and no timestamp means no line (no noise).
 * Pure (no DB).
 *
 * Run: node tests/unit/injection-now-line.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatConversationalInjection,
  formatCodeInjection,
  formatMapInjection,
} = require('../../../../packages/shared-context/src/index.js');

const NOW = '2026-06-09T16:05:00.000Z';

test('conversational injection renders local wall-clock + timezone', () => {
  const { body } = formatConversationalInjection(
    { project_name: 'X', current_task: 'ship P1' }, 'standard', null,
    { now: NOW, tz: 'America/Los_Angeles' },
  );
  assert.match(body, /Now: .*(PDT|PST).*\(America\/Los_Angeles\)/, 'shows local time + tz');
  // The Now line must lead (priority 0.5, above current_task).
  assert.ok(body.indexOf('Now:') < body.indexOf('Current task:'), 'Now line comes first');
});

test('code injection also carries the Now line', () => {
  const { body } = formatCodeInjection(
    { project_name: 'X', current_task: 'ship P1' }, 'standard', null,
    { now: NOW, tz: 'UTC' },
  );
  assert.match(body, /Now: /, 'code surface gets the time too');
});

test('map injection prepends the Now line after the header', () => {
  const map = formatMapInjection(
    [{ project_id: 'p1', project_name: 'X', context: { project_name: 'X' }, updated_at: NOW }],
    null,
    { now: NOW, tz: 'America/Los_Angeles' },
  );
  const lines = map.split('\n');
  assert.match(lines[0], /^\[DeerDawn/, 'header first');
  assert.match(lines[1], /^Now: /, 'time second');
});

test('an unknown timezone falls back to UTC without throwing', () => {
  let body;
  assert.doesNotThrow(() => {
    body = formatConversationalInjection({ project_name: 'X' }, 'standard', null,
      { now: NOW, tz: 'Not/AZone' }).body;
  });
  assert.match(body, /Now: 2026-06-09 16:05 UTC/, 'UTC fallback on bad tz');
});

test('no timestamp means no Now line (no noise)', () => {
  const { body } = formatConversationalInjection(
    { project_name: 'X', current_task: 't' }, 'standard', null, {},
  );
  assert.doesNotMatch(body, /Now:/);
});

test('an invalid now ISO renders no Now line', () => {
  const { body } = formatConversationalInjection(
    { project_name: 'X', current_task: 't' }, 'standard', null, { now: 'garbage', tz: 'UTC' },
  );
  assert.doesNotMatch(body, /Now:/);
});
