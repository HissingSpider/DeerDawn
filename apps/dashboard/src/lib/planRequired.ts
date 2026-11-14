/**
 * AN ACCOUNT THAT HAS TO CHOOSE A PLAN BEFORE IT CAN USE ANYTHING.
 *
 * Hosted pricing, 2026-11: whether a NEW hosted signup still gets the Free plan
 * is a switch on the API (HOSTED_FREE_TIER_FOR_NEW_SIGNUPS in
 * apps/api/src/config/plans.js), on by default. While it is off, a new account
 * is created with subscription_status 'plan_required': the API refuses its
 * product requests with error 'plan_required', and the dashboard sends it to
 * /select-plan, where the Free option is not offered.
 *
 * Existing accounts never carry this status — the switch only affects the
 * account being created — so everything here is inert for every account that
 * exists today.
 */

/** Mirrors PLAN_REQUIRED_STATUS in apps/api/src/config/plans.js (pinned by planRequired.test.ts). */
export const PLAN_REQUIRED_STATUS = 'plan_required';

export function isPlanRequired(subscriptionStatus: unknown): boolean {
  return subscriptionStatus === PLAN_REQUIRED_STATUS;
}

/** The page a plan_required account is sent to. */
export const CHOOSE_PLAN_PATH = '/select-plan';

/**
 * Pages a plan_required account may stay on: the plan picker and checkout
 * themselves, the billing pages that lead to them, and the account and security
 * pages (deleting an account must never depend on buying a plan).
 */
const ALLOWED_PREFIXES = ['/select-plan', '/checkout', '/settings/plan', '/settings/upgrade', '/security'];
/** /settings itself holds Delete account; its sub-pages are product pages. */
const ALLOWED_EXACT = ['/settings'];

/** Where to send this account, or null to leave it where it is. */
export function planRequiredRedirect(subscriptionStatus: unknown, pathname: string): string | null {
  if (!isPlanRequired(subscriptionStatus)) return null;
  const path = pathname || '/';
  if (ALLOWED_EXACT.includes(path)) return null;
  if (ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return null;
  return CHOOSE_PLAN_PATH;
}

/** The plan picker's subtitle for an account that has no plan yet. */
export const PLAN_REQUIRED_SUBTITLE = 'Choose a plan to start using DeerDawn. Your first brief is one checkout away.';
