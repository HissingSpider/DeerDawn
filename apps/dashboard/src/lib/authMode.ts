/**
 * Which sign-in UI the dashboard renders: Clerk's hosted flow, or the local
 * email/password fallback (CredentialAuthPage).
 *
 * This used to be `Boolean(key) && NODE_ENV === 'production'`, which meant Clerk
 * was UNREACHABLE outside production no matter what you configured. That is why
 * the Google OAuth path could not be exercised locally, and why an
 * already-signed-in dead end in the Google button (fixed 2026-08-27, #361)
 * could only be found by a user hitting it in production. A path you cannot run
 * is a path you cannot test.
 *
 * So the NODE_ENV check is now an explicit opt-in instead of a hard block:
 *
 *   - Production: Clerk, whenever a publishable key is set. Unchanged.
 *   - Anywhere else: the credential fallback by DEFAULT, so `make up` still
 *     works with no Clerk account and no key — that was the point of the
 *     fallback and it stays the default.
 *   - Anywhere else, WITH `NEXT_PUBLIC_AUTH_MODE=clerk` and a key: real Clerk,
 *     so OAuth can be clicked through locally before it ships.
 *
 * Use a Clerk DEVELOPMENT instance key (`pk_test_…`) locally. Dev instances
 * allow localhost origins and ship with Clerk's shared Google credentials, so
 * "Continue with Google" works without registering your own Google OAuth app.
 * A `pk_live_…` key will not work against localhost.
 */
export function isClerkHostedAuthEnabled() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return false;
  if (process.env.NODE_ENV === 'production') return true;
  return process.env.NEXT_PUBLIC_AUTH_MODE === 'clerk';
}
