/**
 * PostHog issue 01a0822c (first seen 2026-09-08, on /onboarding) — the same
 * "hard navigate to the same URL" invariant already fixed for marketing (see
 * apps/marketing/tests/router-recovery.test.ts), now covered here too. This
 * suite covers only the pure message match (no DOM, no window) — see
 * routerRecovery.ts for why a real reload is used instead of Next's own
 * `location.href = url` fallback.
 */
import test from 'node:test';
import assert from 'node:assert';
import { isHardNavigateSameUrlInvariant } from './routerRecovery';

test('matches the exact Next.js invariant message, URL and location included', () => {
  assert.strictEqual(
    isHardNavigateSameUrlInvariant(
      'Invariant: attempted to hard navigate to the same URL /onboarding https://app.deerdawn.com/onboarding',
    ),
    true,
  );
});

test('matches regardless of which URL is embedded in the message', () => {
  assert.strictEqual(
    isHardNavigateSameUrlInvariant(
      'Invariant: attempted to hard navigate to the same URL /select-plan https://app.deerdawn.com/select-plan',
    ),
    true,
  );
});

test('does not match unrelated errors', () => {
  assert.strictEqual(isHardNavigateSameUrlInvariant('TypeError: fetch failed'), false);
  assert.strictEqual(isHardNavigateSameUrlInvariant('Loading chunk 344 failed.'), false);
});

test('handles missing or non-string messages without throwing', () => {
  assert.strictEqual(isHardNavigateSameUrlInvariant(undefined), false);
  assert.strictEqual(isHardNavigateSameUrlInvariant(null), false);
  assert.strictEqual(isHardNavigateSameUrlInvariant(''), false);
});
