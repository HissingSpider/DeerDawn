/**
 * A WORKSPACE WHOSE FIRST PAYMENT NEVER WENT THROUGH.
 *
 * Stripe reports the subscription as `incomplete`: nothing was ever collected.
 * The workspace is locked like an unpaid one, but the way out is different (the
 * owner's answer, 2026-09-29): check out again for the same plan, not the
 * billing portal. Every surface that describes such a workspace says so in these
 * words and offers the same link, so the Team page, the plan page, the fallback
 * banner and the refused-load screen cannot disagree.
 */

export const FIRST_PAYMENT_TITLE = 'The first payment did not go through';
/** For an owner, who can act. */
export const FIRST_PAYMENT_OWNER_LINE = 'Check out again to finish setting up this subscription.';
/** For everybody else: who can act. */
export const FIRST_PAYMENT_NOT_OWNER_LINE = 'Only a workspace owner can check out again.';
export const CHECK_OUT_AGAIN_LABEL = 'Check out again';

export interface RetryCheckout {
  plan: string;
  seats: number | null;
}

/** Is this subscription status the first payment that never went through? */
export function isFirstPaymentIncomplete(status: unknown): boolean {
  return status === 'incomplete';
}

/** What the API named to check out again (`retry_checkout`), or null when it named none. */
export function parseRetryCheckout(value: unknown): RetryCheckout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { plan, seats } = value as { plan?: unknown; seats?: unknown };
  if (typeof plan !== 'string' || !plan) return null;
  const n = Number(seats);
  return { plan, seats: Number.isFinite(n) && n > 0 ? Math.floor(n) : null };
}

/** Where a workspace whose first payment failed checks out again, for the same plan. */
export function retryCheckoutHref(retry: RetryCheckout): string {
  const query = new URLSearchParams({ plan: retry.plan });
  if (retry.seats) query.set('seats', String(retry.seats));
  return `/checkout?${query.toString()}`;
}

/** "The first payment did not go through. <who can act>." as one sentence for a panel. */
export function firstPaymentSentence(mayCheckOut: boolean): string {
  return `${FIRST_PAYMENT_TITLE}. ${mayCheckOut ? FIRST_PAYMENT_OWNER_LINE : FIRST_PAYMENT_NOT_OWNER_LINE}`;
}
