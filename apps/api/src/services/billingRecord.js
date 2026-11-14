'use strict';

/**
 * WHAT A STRIPE SUBSCRIPTION SAYS ABOUT ITS OWN PRICE AND ITS END, in the shape
 * the workspace row records it (journey r6, billing).
 *
 * Two facts the plan page needs and the row did not keep:
 *
 *  - a PENDING CANCELLATION: `cancel_at_period_end`, and `cancel_at` (when it
 *    ends). A subscription set to end still says `active` until the day it does,
 *    so without these a cancelled workspace read as "Pro, Status: Active" for a
 *    month, and a person could not tell that it would stop.
 *  - the REAL PRICE: unit amount, currency and interval of the price the
 *    subscription is billed at. The page used to print today's list price for
 *    everybody, so a subscriber who joined at $10 was shown $12.
 *
 * Read from a subscription DeerDawn already has (the webhook's one read, or the
 * answer to a write the person just made): this module makes no Stripe call.
 *
 * WHAT IT WILL NOT SAY. A field the subscription does not carry is `undefined`,
 * which the writer reads as "leave the row alone" — never as "no cancellation"
 * or "free". A price with no unit amount (a metered or tiered price) records no
 * price rather than a zero.
 */
const { getAllPricePlanMappings } = require('../config/plans');

/**
 * The line item that carries the plan: the one whose price maps to a plan, else
 * the first item that has a price. (An unrecognised price is still what Stripe
 * bills.)
 */
function planItemOf(subscription) {
  const items = subscription?.items?.data || [];
  const mapping = getAllPricePlanMappings();
  return items.find((item) => item?.price?.id && mapping[item.price.id])
    || items.find((item) => item?.price)
    || null;
}

/**
 * @returns {{
 *   cancelAtPeriodEnd: boolean|undefined,
 *   cancelAt: Date|null|undefined,
 *   price: { unitAmountCents: number, currency: string|null, interval: string|null, intervalCount: number }|undefined,
 * }}
 */
function billingRecordOf(subscription) {
  const record = { cancelAtPeriodEnd: undefined, cancelAt: undefined, price: undefined };
  if (!subscription || typeof subscription !== 'object') return record;

  // The two cancellation fields are one fact: when the flag is present, so is
  // the answer to "and when" (null when nothing is scheduled).
  if (typeof subscription.cancel_at_period_end === 'boolean') {
    record.cancelAtPeriodEnd = subscription.cancel_at_period_end;
    const at = Number(subscription.cancel_at);
    record.cancelAt = Number.isFinite(at) && at > 0 ? new Date(at * 1000) : null;
  } else if (subscription.cancel_at !== undefined) {
    const at = Number(subscription.cancel_at);
    record.cancelAt = Number.isFinite(at) && at > 0 ? new Date(at * 1000) : null;
  }

  const price = planItemOf(subscription)?.price;
  const amount = Number(price?.unit_amount);
  if (price && price.unit_amount !== null && price.unit_amount !== undefined && Number.isFinite(amount) && amount >= 0) {
    const count = Number(price.recurring?.interval_count);
    record.price = {
      unitAmountCents: Math.round(amount),
      currency: typeof price.currency === 'string' ? price.currency.toLowerCase() : null,
      interval: typeof price.recurring?.interval === 'string' ? price.recurring.interval : null,
      intervalCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 1,
    };
  }
  return record;
}

/**
 * The columns a record writes, as { column: value } (only the ones it knows),
 * for reconcileSubscriptionState and the cancel-at-period-end route.
 */
function recordColumns(record) {
  const columns = {};
  if (!record) return columns;
  if (record.cancelAtPeriodEnd !== undefined) columns.cancel_at_period_end = record.cancelAtPeriodEnd;
  if (record.cancelAt !== undefined) columns.cancel_at = record.cancelAt;
  if (record.price) {
    columns.price_unit_amount_cents = record.price.unitAmountCents;
    columns.price_currency = record.price.currency;
    columns.price_interval = record.price.interval;
    columns.price_interval_count = record.price.intervalCount;
  }
  return columns;
}

module.exports = { billingRecordOf, recordColumns, planItemOf };
