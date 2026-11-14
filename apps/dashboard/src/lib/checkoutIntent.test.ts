/**
 * B-0 regression test: the logged-out checkout dead-end.
 *
 * `/checkout` gated on `api.getCurrentUser()` and, on failure, rendered "Your
 * session expired… Retry checkout" with no sign-in link (Retry failed
 * identically); `/select-plan` bounced to a bare `/login`, so signing in landed
 * on `/` with the plan and cadence gone. Every founder email in the first-revenue
 * plan carries a `/checkout` link that its recipient opens signed out, so both
 * paths turned an intent-carrying link into an error page.
 *
 * The last block also asserts the two pages actually call this module. A unit
 * test of the URL builder alone would stay green if the pages stopped using it,
 * which is the exact failure being guarded against here.
 *
 * Run: `tsx --test src/lib/checkoutIntent.test.ts` (covered by `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildSignInRedirect, hasAttemptedSignIn } from './checkoutIntent';

const ORIGIN = 'http://app.invalid';

/** The decoded `redirect_url` a billing page hands to /login. */
function signInTarget(pathname: string, query: Record<string, string | string[] | undefined> = {}) {
  const href = buildSignInRedirect(pathname, query);
  const login = new URL(href, ORIGIN);
  assert.strictEqual(login.pathname, '/login', `${href} should point at the login page`);
  return new URL(login.searchParams.get('redirect_url') || '', ORIGIN);
}

function readPage(name: string) {
  return readFileSync(fileURLToPath(new URL(`../pages/${name}`, import.meta.url)), 'utf8');
}

test('carries the full billing intent back to checkout after sign-in', () => {
  const target = signInTarget('/checkout', {
    plan: 'developer_basic',
    billing: 'annual',
    campaign: 'founding_aug',
    referral_code: 'abc123',
    promo_code: 'FOUNDING',
  });

  assert.strictEqual(target.pathname, '/checkout');
  assert.strictEqual(target.searchParams.get('plan'), 'developer_basic');
  assert.strictEqual(target.searchParams.get('billing'), 'annual');
  assert.strictEqual(target.searchParams.get('campaign'), 'founding_aug');
  assert.strictEqual(target.searchParams.get('referral_code'), 'abc123');
  assert.strictEqual(target.searchParams.get('promo_code'), 'FOUNDING');
});

test('encodes redirect_url so the intent survives as one login param', () => {
  const href = buildSignInRedirect('/checkout', { plan: 'developer_basic', billing: 'annual' });
  // An unencoded target would split at its own '?'/'&' into sibling params on
  // /login, and login.tsx reads only redirect_url — the plan would be dropped.
  assert.ok(href.startsWith('/login?redirect_url=%2Fcheckout%3F'), href);
  assert.strictEqual(href.indexOf('&'), -1, `${href} leaked a raw separator into the login query`);
});

test('preserves intent from /select-plan too, including an explicit monthly opt-down', () => {
  const target = signInTarget('/select-plan', { billing: 'monthly', promo_code: 'FOUNDING' });

  assert.strictEqual(target.pathname, '/select-plan');
  assert.strictEqual(target.searchParams.get('billing'), 'monthly');
  assert.strictEqual(target.searchParams.get('promo_code'), 'FOUNDING');
});

test('drops params that would derail the return trip', () => {
  // `canceled=true` renders checkout's "Checkout canceled" screen. Forwarding
  // the whole query string would make a returning signed-in visitor land there
  // instead of on the Stripe redirect.
  const target = signInTarget('/checkout', { plan: 'developer_basic', canceled: 'true' });
  assert.strictEqual(target.searchParams.get('canceled'), null);
});

test('takes the first value when Next parses a repeated param as an array', () => {
  const target = signInTarget('/checkout', { plan: ['developer_basic', 'free'] });
  assert.strictEqual(target.searchParams.get('plan'), 'developer_basic');
});

test('marks the target so a rejected session cannot ping-pong with login', () => {
  // A Clerk session the API rejects makes both sides want to redirect: login
  // sends an already-signed-in visitor to redirect_url, the billing page sends a
  // failed /me back to login. The marker caps that at one bounce.
  assert.strictEqual(hasAttemptedSignIn({}), false);
  assert.strictEqual(hasAttemptedSignIn({ auth_retry: '1' }), true);

  const target = signInTarget('/checkout', { plan: 'developer_basic' });
  assert.strictEqual(hasAttemptedSignIn(Object.fromEntries(target.searchParams)), true);
});

test('never emits an off-origin redirect target', () => {
  for (const bad of ['//evil.tld', 'https://evil.tld/checkout', '/\\evil.tld', '/..//evil.tld']) {
    const target = signInTarget(bad);
    assert.strictEqual(target.origin, ORIGIN, `${bad} produced an off-origin target`);
    assert.strictEqual(target.pathname, '/', `${bad} should fall back to '/'`);
  }
});

test('both billing pages route unauthenticated visitors through the sign-in redirect', () => {
  for (const name of ['checkout.tsx', 'select-plan.tsx']) {
    const source = readPage(name);
    assert.match(source, /from '@\/lib\/checkoutIntent'/, `${name} should use the shared sign-in redirect`);
    assert.match(source, /buildSignInRedirect\(router\.pathname, router\.query\)/, `${name} should preserve path + query`);
    assert.doesNotMatch(source, /router\.replace\('\/login'\)/, `${name} still bounces to /login without the intent`);
  }
});

test('both billing pages default to the annual cadence', () => {
  // B-4: $96 collected once beats $10 against an unknown retention curve, so
  // annual is the default on every surface and only an explicit
  // `?billing=monthly` opts down.
  //
  // /checkout states that through resolveCheckoutCadence rather than inline.
  // The inline ternary could only ever answer 'monthly' or 'annual', and the
  // third answer is the one that costs money: an EXISTING subscriber whose URL
  // named no cadence must be sent NONE, because moving the billing interval
  // makes Stripe close the current period and charge the prorated difference at
  // once. lib/checkoutPlanChange.test.ts is the behavioural half of this guard.
  assert.match(readPage('checkout.tsx'), /resolveCheckoutCadence\(/);
  assert.doesNotMatch(
    readPage('checkout.tsx'),
    /router\.query\.billing === 'monthly' \? 'monthly' : 'annual'/,
    'the inline cadence cannot express "send no cadence" and must not come back',
  );
  assert.match(readPage('select-plan.tsx'), /useState<'monthly' \| 'annual'>\('annual'\)/);
  assert.match(readPage('select-plan.tsx'), /router\.query\.billing === 'monthly'\) setBilling\('monthly'\)/);
});
