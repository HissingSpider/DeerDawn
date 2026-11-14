import { getSafeRedirectPath } from '@/lib/redirects';

/**
 * B-0 — signed-out entry into the billing pages.
 *
 * The first-revenue plan is founder emails carrying /checkout links, so every
 * recipient opens one signed out. Both billing surfaces (`/checkout` and
 * `/select-plan`) therefore have to hand that visitor to `/login` with enough
 * state that signing in returns them to the same offer instead of to `/`.
 *
 * `login.tsx` reads `?redirect_url` and passes it to ClerkAuthPage /
 * CredentialAuthPage, which both run it through `getSafeRedirectPath`
 * (same-origin relative paths only — see redirects.ts). The target is built
 * through that same guard here, so this cannot widen the contract on the way in.
 */

type IntentQuery = Record<string, string | string[] | undefined>;

// The billing intent that has to survive sign-in. Allowlisted rather than
// forwarding the whole query string: `?canceled=true` would otherwise make the
// round trip and park the returning visitor on checkout's "Checkout canceled"
// screen instead of the Stripe redirect.
const CHECKOUT_INTENT_PARAMS = ['plan', 'billing', 'campaign', 'referral_code', 'promo_code'] as const;

// Marks a target that has already been bounced through /login once. A Clerk
// session the API rejects makes both sides want to redirect — login sends an
// already-signed-in visitor to redirect_url, the billing page sends a failed
// /me back to login — so without a one-shot marker the two ping-pong forever.
const AUTH_RETRY_PARAM = 'auth_retry';

function firstValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

function intentParams(query: IntentQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of CHECKOUT_INTENT_PARAMS) {
    const value = firstValue(query[key]);
    if (value) params.set(key, value);
  }
  return params;
}

/** True once this page load has already been through the sign-in bounce. */
export function hasAttemptedSignIn(query: IntentQuery = {}): boolean {
  return firstValue(query[AUTH_RETRY_PARAM]) === '1';
}

/**
 * `/login?redirect_url=<current path + billing intent>` — where an
 * unauthenticated billing page sends the visitor.
 */
export function buildSignInRedirect(pathname: string, query: IntentQuery = {}): string {
  const params = intentParams(query);
  params.set(AUTH_RETRY_PARAM, '1');
  const target = getSafeRedirectPath(`${pathname}?${params.toString()}`);
  return `/login?redirect_url=${encodeURIComponent(target)}`;
}
