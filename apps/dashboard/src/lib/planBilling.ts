/**
 * WHAT THE PERSON PAYS, ON THE PLAN PAGE.
 *
 * /settings/plan showed the plan's name and its status and nothing else, so a
 * subscriber could not see their price, their cycle, their seats or when they
 * are next billed; after cancelling it still read "Pro, Status: Active".
 *
 * The owner's decision: the page shows price, monthly or yearly, seats, the
 * next renewal date and amount, the trial's end, and "ends on <date>" when a
 * cancellation is pending, every figure from the subscription's current state
 * as the webhook recorded it on the workspace row (GET /orgs/usage), never
 * from a Stripe call on page load. Prices come from planCopy.
 *
 * Journey r6 added the two facts the row did not keep, both written by the
 * Stripe webhook from its own read of the subscription: the PENDING
 * CANCELLATION (cancel_at_period_end, cancel_at) and the REAL PRICE (amount,
 * currency, interval). A cancelling subscription reads "Ends on <date>" and no
 * renewal; a subscriber who joined at $10 reads $10, not today's $12.
 *
 * What the row does not record is left out, never guessed:
 *   - the cycle of a trial with no price on record (its period is the trial on
 *     either cycle), so it shows its end and its seats, and no price;
 *   - the price of a subscription the webhook has not yet written a price for
 *     (every subscription until its next event): it reads as today's list
 *     price, exactly as it did before, until the next event records the real
 *     one.
 */
import {
  ANNUAL_LABEL,
  MONTHLY_LABEL,
  PRICE_ANNUAL,
  PRICE_MONTHLY,
  TEAM_PRICE_ANNUAL,
  TEAM_PRICE_MONTHLY,
  billingCycleOnRecord,
  isPerSeatPlan,
  money,
  teamPricePhrase,
  type BillingCycle,
} from './planCopy';
import {
  CHECK_OUT_AGAIN_LABEL,
  FIRST_PAYMENT_OWNER_LINE,
  FIRST_PAYMENT_TITLE,
  isFirstPaymentIncomplete,
  retryCheckoutHref,
} from './firstPayment';

/** The price Stripe bills, as the webhook recorded it (cents per seat). */
export interface RecordedPrice {
  unit_amount_cents: number;
  currency?: string | null;
  interval?: string | null;
  interval_count?: number | null;
}

export interface PlanBillingRecord {
  tier: string;
  status?: string | null;
  billing_period_start?: string | null;
  billing_period_end?: string | null;
  purchased_seats?: number | null;
  stripe_customer_id?: string | null;
  /** Stripe's pending cancellation; null or absent = not on record. */
  cancel_at_period_end?: boolean | null;
  cancel_at?: string | null;
  /** The real price; null or absent = not on record. */
  price?: RecordedPrice | null;
}

/** The status line on the plan page: Stripe's status in words. */
export function planStatusLabel(status: string): string {
  if (isFirstPaymentIncomplete(status)) return 'First payment did not go through';
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
}

/**
 * What the plan page says and offers for a workspace whose FIRST payment never
 * went through (Stripe: `incomplete`): check out again for the same plan, not
 * the billing portal. Null for any other workspace, and for one with no paid
 * plan to check out again. The page has no role to read, so the blurb says who
 * can act; the API refuses anybody else.
 */
export function planFirstPaymentCard(plan: PlanBillingRecord): {
  heading: string;
  blurb: string;
  actionLabel: string;
  href: string;
} | null {
  if (!isFirstPaymentIncomplete(plan.status) || !PAID_TIERS.has(plan.tier)) return null;
  return {
    heading: FIRST_PAYMENT_TITLE,
    blurb: `${FIRST_PAYMENT_OWNER_LINE} Only a workspace owner can do this.`,
    actionLabel: CHECK_OUT_AGAIN_LABEL,
    href: retryCheckoutHref({ plan: plan.tier, seats: plan.purchased_seats ?? null }),
  };
}

export interface PlanBillingFact {
  label: string;
  value: string;
}

const PAID_TIERS = new Set(['developer_basic', 'developer_pro']);

function date(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function priceFor(tier: string, cycle: BillingCycle): string {
  if (tier === 'developer_pro') return teamPricePhrase(cycle);
  return cycle === 'annual' ? ANNUAL_LABEL : MONTHLY_LABEL;
}

function priceMoney(cents: number, currency?: string | null): string {
  const amount = cents / 100;
  if (!currency || currency.toLowerCase() === 'usd') return money(amount);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${money(amount)} ${currency.toUpperCase()}`;
  }
}

function recordedInterval(price: RecordedPrice): { unit: 'month' | 'year' | null; count: number } {
  const count = Number.isInteger(price.interval_count) && Number(price.interval_count) > 0 ? Number(price.interval_count) : 1;
  const unit = price.interval === 'month' || price.interval === 'year' ? price.interval : null;
  return { unit, count };
}

/** "$10/mo", "$150 per seat billed yearly", ...: the recorded price in words. */
function recordedPriceValue(price: RecordedPrice, perSeat: boolean): string {
  const { unit, count } = recordedInterval(price);
  const each = priceMoney(price.unit_amount_cents, price.currency);
  if (unit === 'month' && count === 1) return perSeat ? `${each} per seat per month` : `${each}/mo`;
  if (unit === 'year' && count === 1) {
    return perSeat
      ? `${priceMoney(price.unit_amount_cents / 12, price.currency)} per seat per month, ${each} per seat billed yearly`
      : `${each}/year`;
  }
  const every = price.interval ? `${count > 1 ? `${count} ` : ''}${price.interval}${count > 1 ? 's' : ''}` : 'period';
  return `${each}${perSeat ? ' per seat' : ''} every ${every}`.replace(/every 1 /, 'every ');
}

function recordedBilled(price: RecordedPrice): string {
  const { unit, count } = recordedInterval(price);
  if (unit === 'month' && count === 1) return 'Monthly';
  if (unit === 'year' && count === 1) return 'Yearly';
  return price.interval ? `Every ${count > 1 ? `${count} ` : ''}${price.interval}${count > 1 ? 's' : ''}` : 'Every period';
}

function chargePerCycle(tier: string, cycle: BillingCycle): number {
  if (tier === 'developer_pro') return cycle === 'annual' ? TEAM_PRICE_ANNUAL : TEAM_PRICE_MONTHLY;
  return cycle === 'annual' ? PRICE_ANNUAL : PRICE_MONTHLY;
}

/**
 * The figures to print, in order. Empty for a workspace with no Stripe
 * subscription on record (Free, a comped plan): there is nothing it pays.
 */
export function planBillingFacts(plan: PlanBillingRecord | null | undefined, now: number = Date.now()): PlanBillingFact[] {
  if (!plan || !PAID_TIERS.has(plan.tier) || !plan.stripe_customer_id) return [];
  const facts: PlanBillingFact[] = [];
  const perSeat = isPerSeatPlan(plan.tier);
  const seats = Number.isInteger(plan.purchased_seats) && Number(plan.purchased_seats) > 0 ? Number(plan.purchased_seats) : null;
  const periodEnd = date(plan.billing_period_end);
  const price = plan.price && Number.isFinite(plan.price.unit_amount_cents) ? plan.price : null;

  // A PENDING CANCELLATION. Stripe keeps the subscription `active` until the day
  // it ends, so without this a cancelled workspace reads as paying for good.
  // `cancel_at` is when it ends; with only the flag, the period's end is.
  const cancelAtMs = plan.cancel_at ? Date.parse(plan.cancel_at) : NaN;
  const periodEndMs = plan.billing_period_end ? Date.parse(plan.billing_period_end) : NaN;
  const cancelling = plan.cancel_at_period_end === true || Number.isFinite(cancelAtMs);
  const endsOn = cancelling ? date(Number.isFinite(cancelAtMs) ? plan.cancel_at : plan.billing_period_end) : null;
  // It does not renew at all when it ends within the current period.
  const endsBeforeRenewal = cancelling && (plan.cancel_at_period_end === true || !Number.isFinite(periodEndMs) || cancelAtMs <= periodEndMs);

  if (plan.status === 'trialing') {
    if (periodEnd) facts.push({ label: 'Trial ends', value: periodEnd });
    if (price && !endsBeforeRenewal) facts.push({ label: 'Price after the trial', value: recordedPriceValue(price, perSeat) });
    if (perSeat && seats) facts.push({ label: 'Seats', value: String(seats) });
    if (endsOn) facts.push({ label: 'Cancellation', value: `Ends on ${endsOn}` });
    return facts;
  }

  const cycle = billingCycleOnRecord({
    subscription_status: plan.status,
    billing_period_start: plan.billing_period_start,
    billing_period_end: plan.billing_period_end,
  }, now);
  if (price) {
    // The price Stripe bills: whatever the subscription was sold at.
    facts.push({ label: 'Price', value: recordedPriceValue(price, perSeat) });
    facts.push({ label: 'Billed', value: recordedBilled(price) });
  } else if (cycle) {
    facts.push({ label: 'Price', value: priceFor(plan.tier, cycle) });
    facts.push({ label: 'Billed', value: cycle === 'annual' ? 'Yearly' : 'Monthly' });
  }
  if (perSeat && seats) facts.push({ label: 'Seats', value: String(seats) });
  if (endsOn) {
    facts.push({ label: 'Cancellation', value: `Ends on ${endsOn}` });
    if (!endsBeforeRenewal) {
      if (periodEnd) facts.push({ label: 'Current period ends', value: periodEnd });
    }
  } else if (periodEnd) {
    facts.push({ label: 'Current period ends', value: periodEnd });
  }
  // A subscription that will not renew has no renewal amount.
  if (!endsBeforeRenewal) {
    if (price && (!perSeat || seats)) {
      facts.push({ label: 'Renewal amount', value: priceMoney(price.unit_amount_cents * (perSeat ? seats! : 1), price.currency) });
    } else if (!price && cycle && (!perSeat || seats)) {
      facts.push({ label: 'Renewal amount', value: money(chargePerCycle(plan.tier, cycle) * (perSeat ? seats! : 1)) });
    }
  }
  return facts;
}
