/**
 * TWO REFUSALS OF A PLAN OR SEAT CHANGE WHOSE WAY THROUGH IS STRIPE'S BILLING
 * PAGE.
 *
 * POST /billing/checkout answers both with 402, its own `error`, a sentence and
 * `billing_portal: true` (apps/api/src/routes/shared/billing.js):
 *
 *   payment_confirmation_required  the bank has to confirm the payment
 *                                  (3-D Secure). It used to read "update your
 *                                  card", which is not the reason and cannot be
 *                                  fixed that way; the billing page is where
 *                                  confirmation works.
 *   payment_overdue                a payment on the subscription is overdue, so
 *                                  the change is refused before anything is
 *                                  sent to Stripe.
 *
 * Only a workspace owner can reach either (the route refuses everyone else
 * first), and only an owner can open the billing page, so a page that shows
 * the refusal may offer the link. The server's sentence is shown when it sent
 * one; these are the same words, for an answer that arrives without it.
 *
 * Pure so the copy can be tested without React or a network.
 */

export const BANK_CONFIRMATION_LINE = 'Your bank needs to confirm this payment, so nothing was changed. '
  + 'Make this change from the billing page instead, where your bank can confirm it.';

export const PAYMENT_OVERDUE_LINE = 'A payment on this subscription is overdue, so nothing was changed. '
  + 'Update billing to restore access, then try again.';

export const OPEN_BILLING_PAGE_LABEL = 'Open the billing page';

export type BillingPageRefusalCode = 'payment_confirmation_required' | 'payment_overdue';

export interface BillingPageRefusal {
  code: BillingPageRefusalCode;
  message: string;
}

const FALLBACK: Record<BillingPageRefusalCode, string> = {
  payment_confirmation_required: BANK_CONFIRMATION_LINE,
  payment_overdue: PAYMENT_OVERDUE_LINE,
};

/**
 * The refusal a failed POST /billing/checkout carries, or null for any other
 * failure (a declined card, a refused tier, an outage), which keeps whatever
 * the page already said about it.
 *
 * Duck-typed like isWorkspaceInactiveError: it reads `status`, `code` and the
 * parsed body in `data`, so it works on ApiError and on anything shaped like it.
 */
export function billingPageRefusal(error: unknown): BillingPageRefusal | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; code?: unknown; data?: Record<string, unknown> | null };
  if (Number(candidate.status) !== 402) return null;
  const data = candidate.data && typeof candidate.data === 'object' ? candidate.data : null;
  const raw = typeof candidate.code === 'string' && candidate.code
    ? candidate.code
    : typeof data?.error === 'string' ? data.error : '';
  if (raw !== 'payment_confirmation_required' && raw !== 'payment_overdue') return null;
  const code = raw as BillingPageRefusalCode;
  const said = typeof data?.message === 'string' ? data.message.trim() : '';
  return { code, message: said || FALLBACK[code] };
}
