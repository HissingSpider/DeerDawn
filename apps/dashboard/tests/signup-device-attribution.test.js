const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const POSTHOG = read('src', 'lib', 'posthog.ts');
const APP = read('src', 'pages', '_app.tsx');
const DEVICE = read('src', 'lib', 'device.ts');

// Context — measured 2026-08-23 in PostHog over the 45 days to that date.
//
// Of 48 real accounts (is_test = false), 10 carried NO device_type, NO
// utm_source and NO person-level initial_device_type. Every one of the 10 was
// signup_method='google' — i.e. 10 of 19 Google signups, 21% of all signups.
//
// Cause, documented in MarketingAuthForm's own comment: `unsafeMetadata` is a
// SignUp parameter. SignIn.authenticateWithRedirect drops it silently, and
// Clerk's sign-in -> sign-up transfer (clicking "Continue with Google" on the
// login tab without an account) does not carry it to the user.created webhook
// that emits account_created.
//
// This matters because the open ad decision is whether to bid desktop-only:
// 71% of ATTRIBUTABLE accounts are mobile, and that figure is computed off only
// 79% of accounts.

test('phIdentify forwards $set_once person properties', () => {
  assert.match(
    POSTHOG,
    /export function phIdentify\(\s*distinctId: string,\s*props\?: Record<string, unknown>,\s*setOnceProps\?: Record<string, unknown>,?\s*\)/,
    'phIdentify must accept a third $set_once argument',
  );
  assert.match(
    POSTHOG,
    /instance\.identify\(distinctId, props, setOnceProps\)/,
    'the $set_once argument must reach posthog-js identify()',
  );
});

test('the dashboard recovers device_type at identify time', () => {
  assert.match(APP, /from '@\/lib\/device'/, '_app must import the device helper');
  assert.match(
    APP,
    /initial_device_type: device/,
    '_app must supply initial_device_type when identifying',
  );
});

test('device recovery is $set_once, so the server-side value always wins', () => {
  // The webhook is authoritative for the 38 accounts that DO carry device.
  // Writing $set here would let a later desktop visit overwrite a genuine
  // mobile signup, silently corrupting the exact number the ad decision rests
  // on. It must be the THIRD (set-once) argument, never folded into the second.
  const start = APP.indexOf('phIdentify(');
  assert.ok(start > -1, 'expected a phIdentify(...) call in _app');

  // Walk the call and split its arguments on top-level commas only, so nested
  // object/ternary commas do not fool the position check.
  let depth = 0;
  const args = [];
  let current = '';
  for (let i = APP.indexOf('(', start) + 1; i < APP.length; i += 1) {
    const ch = APP[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' && depth === 0) break;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current);
  const trimmed = args.map((a) => a.trim()).filter((a) => a.length > 0);

  assert.equal(trimmed.length, 3, `phIdentify must be called with 3 arguments, got ${trimmed.length}`);
  assert.ok(
    !trimmed[1].includes('initial_device_type'),
    'initial_device_type must NOT be in the $set (second) argument — that would overwrite the webhook value',
  );
  assert.ok(
    trimmed[2].includes('initial_device_type'),
    'initial_device_type must be in the $set_once (third) argument',
  );
});

test('the device helper classifies the three buckets the funnel is sliced by', () => {
  for (const bucket of ['mobile', 'tablet', 'desktop']) {
    assert.ok(DEVICE.includes(`'${bucket}'`), `device.ts must be able to return ${bucket}`);
  }
});

test('register_once is not mistaken for a person-property write', () => {
  // registerSourceProperties uses register_once, which sets SUPER-properties on
  // browser-sent events. account_created is server-sent, so it never receives
  // them — which is why this gap survived despite initial_device_type appearing
  // in that function. Keep the distinction visible in the source.
  assert.match(POSTHOG, /register_once\(/, 'super-property registration still expected');
  assert.match(
    POSTHOG,
    /register_once` in registerSourceProperties\(\) does NOT cover this/,
    'the reason register_once is insufficient must stay documented',
  );
});
