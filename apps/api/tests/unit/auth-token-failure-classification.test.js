'use strict';

// Which auth failures are worth waking someone up for.
//
// Sentry went live on 2026-09-01 and by the next morning had raised two issues,
// both from _verifyClerk: one expired JWT and one truncated one. Neither is a
// defect — a token expiring is the session lifecycle, and a garbage bearer is a
// stale tab or a scanner. Reporting them is worse than not reporting: this is
// the same feed that exists to catch clerk_identity_sync_failed, the swallowed
// database failure that 401'd the only paying customer for about 19 days, and a
// feed full of expired tokens is a feed nobody reads.
//
// So the split has to be exact, and it has to fail toward reporting.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const AUTH_SRC = path.resolve(__dirname, '..', '..', 'src', 'middleware', 'auth.js');
const source = fs.readFileSync(AUTH_SRC, 'utf8');

// The classifier is module-private, so exercise it the way the file does:
// evaluate it in isolation rather than importing auth.js, which would build a
// Clerk client and a database pool just to test a pure function.
function loadClassifier() {
  const start = source.indexOf('const ROUTINE_CLERK_TOKEN_REASONS');
  const end = source.indexOf('class AuthAdapter');
  assert.ok(start > -1 && end > start, 'the classifier must sit above the class, at module scope');
  return new Function(`${source.slice(start, end)}; return isRoutineTokenFailure;`)();
}

const isRoutineTokenFailure = loadClassifier();

// Shaped like Clerk's TokenVerificationError: a plain Error carrying `reason`.
function clerkError(reason, message = 'token rejected') {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

test('an expired token is routine — this was DEERDAWN-API-4', () => {
  const err = clerkError('token-expired',
    'JWT is expired. Expiry date: Wed, 02 Sep 2026 17:44:01 GMT, Current date: Wed, 02 Sep 2026 19:26:32 GMT.');
  assert.strictEqual(isRoutineTokenFailure(err), true);
});

test('a truncated bearer is routine — this was DEERDAWN-API-3', () => {
  // decodeJwt throws a bare SyntaxError, with no reason code, before Clerk's
  // own error type is ever constructed.
  assert.strictEqual(isRoutineTokenFailure(new SyntaxError('Unexpected end of data')), true);
});

test('every rejected-credential reason is routine', () => {
  for (const reason of [
    'token-invalid',
    'token-invalid-algorithm',
    'token-invalid-authorized-parties',
    'token-invalid-signature',
    'token-not-active-yet',
    'token-iat-in-the-future',
    'token-type-mismatch',
    'token-verification-failed',
  ]) {
    assert.strictEqual(isRoutineTokenFailure(clerkError(reason)), true, `${reason} should not page anyone`);
  }
});

test('a signing-key failure is NOT routine — it means everyone is locked out', () => {
  for (const reason of [
    'jwk-failed-to-resolve',
    'jwk-remote-failed-to-load',
    'jwk-remote-invalid',
    'jwk-remote-missing',
    'jwk-local-missing',
    'jwk-kid-mismatch',
  ]) {
    assert.strictEqual(isRoutineTokenFailure(clerkError(reason)), false,
      `${reason} is an outage: no token can verify, so every user fails auth`);
  }
});

test('an unrecognised failure reports rather than hides', () => {
  // The direction matters more than any single case: a new Clerk failure mode
  // should arrive loudly and be demoted on purpose, never silently absorbed.
  assert.strictEqual(isRoutineTokenFailure(clerkError('some-future-reason')), false);
  assert.strictEqual(isRoutineTokenFailure(new Error('connect ETIMEDOUT')), false);
  assert.strictEqual(isRoutineTokenFailure(new TypeError('cannot read properties of undefined')), false);
  assert.strictEqual(isRoutineTokenFailure(undefined), false);
  assert.strictEqual(isRoutineTokenFailure(null), false);
});

test('a database failure during identity sync still reports', () => {
  // The case the whole reporting path was built for. It must not be reachable
  // by the routine branch even if it somehow carried a token reason: the
  // handler checks isSyncFailure first, and this asserts that ordering.
  const handler = source.slice(source.indexOf('async _verifyClerk('), source.indexOf('async _verifyLocal('));
  const routineCheck = handler.indexOf('isRoutineTokenFailure');
  const syncCheck = handler.indexOf('isSyncFailure');
  assert.ok(syncCheck > -1 && routineCheck > syncCheck,
    'isSyncFailure must be computed before the routine short-circuit, and the short-circuit must require !isSyncFailure');
  assert.ok(/!isSyncFailure\s*&&\s*isRoutineTokenFailure/.test(handler),
    'the quiet path must be closed to sync failures explicitly');
  assert.ok(/clerk_identity_sync_failed/.test(handler),
    'a swallowed database failure during sync must still be reported');
});

(async () => {
  console.log('=== Auth token failure classification ===\n');
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(`  ${error.stack || error.message}`);
      process.exitCode = 1;
    }
  }
})();
