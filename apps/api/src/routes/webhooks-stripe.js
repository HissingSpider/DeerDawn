const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { stripe, WEBHOOK_READ_OPTIONS } = require('../services/stripeService');
const env = require('../config/env');
const { requireBillingEnabled } = require('../config/selfHosted');
const { redis } = require('../config/redis');
const { PLANS, getAllPricePlanMappings, normalizePlanId, getPlanOrder, PRICE_MAP_ENV_VARS } = require('../config/plans');
const { recordSubscriptionEvent } = require('../services/retentionLedger');
const { sendEmail } = require('../services/email/resendClient');
// Required as a module object (not destructured) so tests can stub recordProductEvent.
const productEvents = require('../services/productEventsService');
// What a subscription says about its price and its end, the notices owed to the
// workspace's owner after a write, and who paid (journey r6, billing). Required
// as module objects so tests can stub them.
const { billingRecordOf, recordColumns } = require('../services/billingRecord');
const billingNotices = require('../services/billingNoticeService');
const billingOwner = require('../services/billingOwnerService');

// Monthly recurring cents for a plan tier — 0 for free/lifetime (no recurring MRR).
// `seats` multiplies for per-seat plans: a three-seat Team is $45/mo of MRR, not
// $15. Callers that cannot know the count pass nothing and get one seat's worth —
// an under-count, never an invention.
function planMrrCents(planId, seats = null) {
  const plan = PLANS[normalizePlanId(planId)];
  if (!plan) return 0;
  const quantity = Number.isFinite(seats) && seats > 0 ? seats : 1;
  return Math.round((plan.price || 0) * 100) * quantity;
}

// Mirror subscription changes into product analytics, attributed to the
// workspace's founding member like purchase_completed, so the whole revenue
// history joins to the person who bought.
async function emitSubscriptionLifecycle(changes, stripeEvent) {
  for (const change of changes) {
    const buyer = await db.query(
      'SELECT user_id FROM users WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1',
      [change.org_id],
      'org-system'
    ).catch(() => ({ rows: [] }));
    const userId = buyer.rows[0]?.user_id || null;
    await productEvents.recordProductEvent(
      userId ? { type: 'user', id: userId, org_id: change.org_id } : { org_id: change.org_id },
      {
        event_name: 'subscription_lifecycle',
        source: 'api',
        surface: 'stripe_webhook',
        metadata: {
          event_type: change.event_type,
          plan_tier: change.plan_tier || null,
          mrr_cents: Number.isFinite(change.mrr_cents) ? change.mrr_cents : null,
          ...(change.billing_reason ? { billing_reason: change.billing_reason } : {}),
          ...(Number.isFinite(change.seats) ? { seats: change.seats, prior_seats: change.prior_seats } : {}),
          stripe_event_type: stripeEvent.type,
          stripe_event_id: stripeEvent.id,
        },
      }
    );
  }
}

// Billing period as it was actually sold. createCheckoutSession stamps
// billingCycle into the session metadata; lifetime (mode 'payment') has no
// cycle at all, and null means the metadata was missing rather than monthly.
function checkoutBillingPeriod(session) {
  if (session?.mode === 'payment') return 'one_time';
  const cycle = session?.metadata?.billingCycle;
  return cycle === 'annual' || cycle === 'monthly' ? cycle : null;
}

const priceToPlan = getAllPricePlanMappings();
const validOrgIdPattern = /^org-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Stripe API >= 2025-03 (basil) moved current_period_start/end from the
// Subscription object onto each SubscriptionItem. Read the item-level value
// first and fall back to the legacy subscription-level field, returning null
// (not NaN) when absent — `new Date(undefined * 1000)` produced the
// "0NaN-NaN-NaN…" timestamps that made every subscription webhook fail.
function getPeriod(sub, field) {
  const v = sub?.items?.data?.[0]?.[field] ?? sub?.[field];
  return Number.isFinite(v) ? v : null;
}

function periodDate(sub, field) {
  const v = getPeriod(sub, field);
  return v === null ? null : new Date(v * 1000);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The operator alert for a failed subscription charge. Mirrors the lead alert
// in routes/leads.js: to John, reply-to the customer so chasing is one
// keystroke, every value escaped because customer emails are attacker-typed.
function buildPastDueAlert({ orgId, customerEmail, planTier, seats, amountDueCents, attempt, nextAttemptAt, invoiceUrl }) {
  const rows = Object.entries({
    Customer: customerEmail,
    Plan: planTier ? `${planTier}${seats ? ` (${seats} seats)` : ''}` : null,
    'Amount due': amountDueCents == null ? null : `$${(amountDueCents / 100).toFixed(2)}`,
    Attempt: attempt,
    'Next retry': nextAttemptAt ? nextAttemptAt.toISOString().slice(0, 10) : 'none scheduled — this was the last',
    Org: orgId,
  }).filter(([, v]) => v != null);

  return {
    to: process.env.BILLING_ALERT_TO || process.env.LEAD_ALERT_TO || process.env.RESEND_REPLY_TO || 'john@deerdawn.com',
    ...(customerEmail ? { replyTo: customerEmail } : {}),
    subject: `Payment failed: ${customerEmail || orgId}${attempt ? ` (attempt ${attempt})` : ''}`,
    html: `<p>A subscription charge failed and the account is now past_due — their briefs are blocked until a charge succeeds.</p><ul>${
      rows.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join('')
    }</ul>${invoiceUrl ? `<p><a href="${escapeHtml(invoiceUrl)}">Invoice in Stripe</a></p>` : ''}<p>Reply to this email to reach them directly.</p>`,
  };
}


/**
 * How many seats this subscription is actually being billed for.
 *
 * Read from the SUBSCRIPTION, never from the checkout session's metadata. The
 * metadata is a snapshot of what was chosen at purchase, and the quantity moves
 * afterwards — adjustable_quantity at checkout, the customer portal later, a
 * proration mid-cycle. A cap sourced from the snapshot would drift away from
 * what the customer is paying within one billing change, in whichever direction
 * happened to be wrong.
 *
 * Only the item whose price maps to a plan counts; an overage or add-on line has
 * its own quantity and is not a seat. Returns null when it cannot tell, and null
 * means "fall back to the plan's own limit" rather than "no seats" — guessing
 * zero would lock a paying team out of their own workspace.
 */
function getSeatsFromSubscription(subscription) {
  for (const item of subscription?.items?.data || []) {
    const priceId = item?.price?.id;
    if (!priceId || !priceToPlan[priceId]) continue;
    const quantity = Number(item.quantity);
    if (Number.isFinite(quantity) && quantity > 0) return Math.floor(quantity);
  }
  return null;
}

/** The plan a subscription's line items map to, or null. Says nothing and
 *  logs nothing — for the paths that only need to COMPARE two subscriptions. */
function mapPlanFromSubscription(subscription) {
  for (const item of subscription?.items?.data || []) {
    const mappedPlanId = priceToPlan[item?.price?.id];
    if (mappedPlanId) return normalizePlanId(mappedPlanId);
  }
  return null;
}

/**
 * What this subscription looked like BEFORE the change the event reports — the
 * plan and seat count, read from the event's own `previous_attributes`.
 *
 * WHY NOT THE ORG ROW. The updated handler decided "did the plan change?" by
 * comparing the event against organizations.plan_tier. But POST
 * /billing/checkout writes plan_tier and purchased_seats through the moment an
 * in-place upgrade succeeds (so the buyer is not told they are still on the old
 * plan), which is BEFORE this webhook arrives. By the time it does, the row
 * already says Team, the event says Team, nothing appears to have changed — and
 * the one path every Pro-to-Team upgrade takes recorded no plan_changed and no
 * seats_changed at all. The revenue ledger simply never saw an upgrade.
 *
 * Stripe says what changed, per event, independent of who wrote what to our
 * database first: previous_attributes carries the OLD value of every field the
 * update touched. `items` holds the previous line items when a price or quantity
 * moved; older single-item payloads also mirror them as top-level `plan` /
 * `quantity`. A field that is absent did not change in this event, and null is
 * returned for it so the caller can fall back to the org row — which is still
 * the right answer for the case this cannot see, an event that arrives after the
 * one that made the change was lost.
 */
function priorStateFromEvent(event) {
  const prev = event?.data?.previous_attributes;
  if (!prev || typeof prev !== 'object') return { planId: null, seats: null };
  const prevItems = Array.isArray(prev.items?.data) ? prev.items.data : [];

  let planId = mapPlanFromSubscription({ items: { data: prevItems } });
  if (!planId && prev.plan?.id && priceToPlan[prev.plan.id]) {
    planId = normalizePlanId(priceToPlan[prev.plan.id]);
  }

  let seats = getSeatsFromSubscription({ items: { data: prevItems } });
  if (seats === null) {
    const quantity = Number(prev.quantity);
    if (Number.isFinite(quantity) && quantity > 0) seats = Math.floor(quantity);
  }
  return { planId, seats };
}

/**
 * The subscription an invoice bills, across both payload shapes.
 *
 * Stripe API 2025-03 ("basil") removed invoice.subscription and moved it to
 * invoice.parent.subscription_details.subscription. The payload shape follows
 * the WEBHOOK ENDPOINT's API version, not the SDK's, so which one arrives
 * changes the day the endpoint is upgraded in the Stripe dashboard — with no
 * deploy on our side. Reading only the old field made invoice.payment_failed a
 * silent no-op from that day: no past_due, no ledger row, no operator alert,
 * and a 200 telling Stripe all was well. Same move as getPeriod above.
 */
function invoiceSubscriptionId(invoice) {
  const ref = invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription ?? null;
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id || null;
}

/** Every price id on a subscription's line items. */
function priceIdsOf(subscription) {
  return (subscription?.items?.data || []).map((i) => i?.price?.id).filter(Boolean);
}

/**
 * ONE ORG ROW, POSSIBLY TWO SUBSCRIPTIONS.
 *
 * `organizations` stores a single stripe_subscription_id, so every reconcile
 * below is written against "the" subscription. A Stripe customer can carry two
 * live ones — that is what the /billing/checkout double-billing bug produced,
 * and what a plan change made by hand in the Stripe dashboard produces at any
 * time — and the row then remembers whichever wrote last.
 *
 * The failure that costs money is the cancellation. customer.subscription.deleted
 * set the org to free and cleared its seats without asking whether the customer
 * had another live subscription: cancel the Team you bought by mistake and the
 * Pro you have been paying for since March silently becomes Free. They keep
 * paying, they lose access, and nothing errors.
 *
 * So: which subscription an event belongs to is now an explicit question, asked
 * before anything is written, rather than something the WHERE clause answers by
 * accident.
 */
//
// "Live" here means SOMEBODY IS PAYING FOR IT, OR STRIPE IS STILL TRYING TO MAKE
// THEM. That is narrower than "not cancelled", and the difference is two
// statuses this set used to include:
//
//   incomplete — the FIRST payment never succeeded. Nothing has ever been
//                collected; Stripe expires it by itself after 23 hours.
//   unpaid     — every retry failed and Stripe stopped attempting invoices. It
//                is kept open only so it can be revived by hand.
//
// Counting either as live let an abandoned checkout be ADOPTED as the surviving
// subscription when the real one was cancelled: the org kept a paid plan that
// no card was being charged for, and the ledger recorded a plan change instead
// of the churn that had actually happened. past_due stays — Stripe is still
// retrying the charge, so it is still a billing relationship.
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Would asking Stripe again plausibly give a different answer?
 *
 * Connection failures, rate limits and Stripe-side 5xx are retryable; a bad
 * request, a revoked key or a missing permission is not, and answering those
 * with a 5xx would make Stripe redeliver for three days an event that can never
 * succeed. An error with no recognisable shape counts as transient: a webhook
 * retried once too often costs nothing, a decision taken on no information can
 * cost a customer their plan.
 */
function isRetryableStripeError(err) {
  const type = err?.type || err?.rawType || '';
  if (['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError', 'api_error', 'rate_limit_error'].includes(type)) return true;
  const status = Number(err?.statusCode);
  if (Number.isFinite(status) && status > 0) return status >= 500 || status === 429;
  if (['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError', 'invalid_request_error'].includes(type)) return false;
  return true;
}

/** The error that makes the handler answer 5xx, so the event is stored as
 *  'failed' (which upsertStripeEvent lets a redelivery reclaim) and not as
 *  'processed'. */
function retryLater(err, what) {
  return new Error(`Stripe is unavailable (${what}): ${err?.message || 'unknown error'} — not handled, awaiting redelivery`);
}

/** What Stripe said when it refused for good, for the owner's alert. */
function refusalReason(err) {
  const type = err?.type || err?.rawType || 'error';
  const status = Number(err?.statusCode);
  return `${type}${Number.isFinite(status) && status > 0 ? ` (${status})` : ''}: ${err?.message || 'no message'}`;
}

// The webhook's reads: bounded, and not retried by the SDK (stripeService.js,
// WEBHOOK_READ_OPTIONS; the literal is the same numbers, for a stripeService
// that does not export them, as test doubles do not). A fresh copy per call.
function readOptions() {
  return { ...(WEBHOOK_READ_OPTIONS || { timeout: 5_000, maxNetworkRetries: 0 }) };
}

function customerIdOf(sub) {
  return typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id || null;
}

// The org row's billing state: everything a subscription write can change, so
// two reads of it can be compared (see billingState below).
const ORG_BILLING_COLUMNS = 'org_id, plan_tier, purchased_seats, stripe_subscription_id, stripe_customer_id, subscription_status, billing_period_end';

/** The org this subscription belongs to: by its id, else by its customer.
 *  `lock` takes the row for the rest of the caller's transaction. */
async function findOrgForSubscription(client, subscriptionId, customerId, { lock = false } = {}) {
  const forUpdate = lock ? ' FOR UPDATE' : '';
  if (subscriptionId) {
    const byId = await client.query(
      `SELECT ${ORG_BILLING_COLUMNS} FROM organizations WHERE stripe_subscription_id = $1 LIMIT 1${forUpdate}`,
      [subscriptionId]
    );
    if (byId.rows[0]) return byId.rows[0];
  }
  if (!customerId) return null;
  const byCustomer = await client.query(
    `SELECT ${ORG_BILLING_COLUMNS} FROM organizations WHERE stripe_customer_id = $1 LIMIT 1${forUpdate}`,
    [customerId]
  );
  return byCustomer.rows[0] || null;
}

/**
 * Every OTHER live subscription in a list, best plan first.
 *
 * "Best" is the higher plan order, then the more recent — a customer paying for
 * both Pro and Team is entitled to Team, and guessing downward would take away
 * access somebody is being charged for.
 */
function liveBestFirst(subscriptions, excludeSubscriptionId = null) {
  return (subscriptions || [])
    .filter((sub) => sub?.id && sub.id !== excludeSubscriptionId && LIVE_SUBSCRIPTION_STATUSES.has(sub.status))
    .sort((a, b) => (
      getPlanOrder(mapPlanFromSubscription(b) || 'free') - getPlanOrder(mapPlanFromSubscription(a) || 'free')
      || (b.created || 0) - (a.created || 0)
    ));
}

/**
 * Every subscription on a customer as Stripe has them now: the deleted event's
 * one read, which answers both "what is this subscription now?" and "is the
 * customer still paying for another?".
 *
 * A TRANSIENT Stripe failure throws, and the webhook answers 5xx. This used to
 * answer "no other subscription" on every failure so that "a Stripe outage could
 * not become a failed webhook" — but the caller then drops the org to free, and
 * the event is recorded as processed. One connection blip while a duplicate
 * subscription was being cancelled took paid access from a customer still being
 * charged, permanently, because a processed event is never looked at again. A
 * failed webhook is the cheap outcome: Stripe redelivers for days. A failure a
 * retry cannot fix (a revoked key, a refused request) answers `unreadable` with
 * its reason, and the webhook handles that as its own case (see
 * REFUSED_READ_ALERT_AFTER_SECONDS).
 */
async function customerSubscriptions(customerId) {
  if (!customerId || typeof stripe?.subscriptions?.list !== 'function') {
    return { subscriptions: [], unreadable: true, reason: customerId ? 'Stripe is not configured' : 'the event names no customer' };
  }
  try {
    const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 }, readOptions());
    return { subscriptions: list?.data || [] };
  } catch (err) {
    if (isRetryableStripeError(err)) throw retryLater(err, 'listing the customer\'s subscriptions');
    console.warn('[STRIPE] could not list the customer\'s subscriptions:', err.message);
    return { subscriptions: [], unreadable: true, reason: refusalReason(err) };
  }
}

/**
 * Is the subscription the org row names still a live billing relationship?
 * `{ live }`, or `{ live: false, unreadable: true, reason }` when Stripe refuses
 * for good.
 */
async function isSubscriptionLive(subscriptionId) {
  if (!subscriptionId || typeof stripe?.subscriptions?.retrieve !== 'function') return { live: false };
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, readOptions());
    return { live: LIVE_SUBSCRIPTION_STATUSES.has(sub?.status) };
  } catch (err) {
    // resource_missing means it is genuinely gone.
    if (err?.code === 'resource_missing') return { live: false };
    // A TRANSIENT failure is not an answer, so it must not be recorded as one.
    // This used to return true ("assume live"), the caller then DROPPED the
    // event, and the webhook marked it processed: if the recorded subscription
    // was in fact dead, the update for the live one was discarded for good and
    // the org never recovered. Throwing makes the webhook answer 5xx, the event
    // is stored as failed, and Stripe redelivers it when the question can
    // actually be answered.
    if (isRetryableStripeError(err)) throw retryLater(err, 'checking the recorded subscription');
    // A failure a retry cannot fix used to answer "assume live" and the event
    // was dropped. It is now the webhook's refused-read case, like every other
    // read (see REFUSED_READ_ALERT_AFTER_SECONDS): nothing is adopted either way.
    console.warn('[STRIPE] could not check the recorded subscription:', err.message);
    return { live: false, unreadable: true, reason: refusalReason(err) };
  }
}

/**
 * The subscription as Stripe has it NOW — not as an event remembered it.
 *
 * Stripe does not deliver events in order and redelivers anything answered with
 * a 5xx, so a customer.subscription.updated can arrive AFTER the
 * customer.subscription.deleted for the same subscription, still saying
 * `active`. Deleted clears the org's stripe_subscription_id, the stale update
 * then reaches the org through its customer id, and its payload used to be
 * written straight onto it: a cancelled subscription's plan, `active`, for good,
 * because a dead subscription sends nothing later to correct it.
 *
 * Returns `{ subscription }` (null when Stripe no longer has it), or
 * `{ subscription: null, unreadable: true, reason }` for a failure a retry
 * cannot fix.
 * A TRANSIENT failure throws, for the reason isSubscriptionLive gives: not an
 * answer, so not something to act on — the webhook answers 5xx and Stripe asks
 * again.
 */
async function currentSubscription(subscriptionId) {
  if (!subscriptionId || typeof stripe?.subscriptions?.retrieve !== 'function') {
    return { subscription: null, unreadable: true, reason: subscriptionId ? 'Stripe is not configured' : 'no subscription id' };
  }
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, readOptions());
    return { subscription: sub || null };
  } catch (err) {
    if (err?.code === 'resource_missing') return { subscription: null };
    if (isRetryableStripeError(err)) throw retryLater(err, 'reading the subscription\'s current state');
    console.warn(`[STRIPE] could not read subscription ${subscriptionId}:`, err.message);
    return { subscription: null, unreadable: true, reason: refusalReason(err) };
  }
}

async function invalidateOrgCache(orgId) {
  if (!orgId) return;
  await redis.del(`org:${orgId}`).catch(() => {});
}

async function upsertStripeEvent(client, eventId, type) {
  const result = await client.query(
    `INSERT INTO stripe_events (event_id, type, status)
     VALUES ($1, $2, 'processing')
     ON CONFLICT (event_id) DO UPDATE SET status = 'processing'
       WHERE stripe_events.status = 'failed'
     RETURNING event_id`,
    [eventId, type]
  );
  return result.rowCount > 0;
}

async function markStripeEvent(client, eventId, status, error = null) {
  await client.query(
    `UPDATE stripe_events
     SET status = $2,
         processed_at = NOW(),
         error = $3
     WHERE event_id = $1`,
    [eventId, status, error]
  );
}

async function reconcileSubscriptionState(client, { orgId = null, subscriptionId = null, customerId = null, planId = null, status = null, currentPeriodStart = null, currentPeriodEnd = null, clearPending = false, lifetimeActivatedAt = null, clearSubscription = false, clearBillingWindow = false, seats = null, clearSeats = false, trialStartedAt = null, billingRecord = null }) {
  const updates = [];
  const values = [];
  let idx = 1;

  if (customerId) {
    updates.push(`stripe_customer_id = $${idx++}`);
    values.push(customerId);
  }
  if (subscriptionId) {
    updates.push(`stripe_subscription_id = $${idx++}`);
    values.push(subscriptionId);
  }
  if (planId) {
    updates.push(`plan = $${idx++}`);
    values.push(planId);
    updates.push(`plan_tier = $${idx++}`);
    values.push(planId);
  }
  // Seats follow the subscription. NULL is meaningful and different from zero:
  // it means "no purchased count on record", and entitlements then fall back to
  // the plan's own included_seats rather than treating the team as capped at
  // nothing.
  if (Number.isFinite(seats) && seats > 0) {
    updates.push(`purchased_seats = $${idx++}`);
    values.push(seats);
  } else if (clearSeats) {
    updates.push('purchased_seats = NULL');
  }
  // Bug 13 fix: truthy check would silently skip status='' (unlikely but
  // possible with unexpected Stripe event shapes). Use explicit null check.
  if (status != null) {
    updates.push(`subscription_status = $${idx++}`);
    values.push(status);
  }
  if (currentPeriodStart) {
    updates.push(`billing_period_start = $${idx++}`);
    values.push(currentPeriodStart);
  }
  if (currentPeriodEnd) {
    updates.push(`billing_period_end = $${idx++}`);
    values.push(currentPeriodEnd);
  }
  if (lifetimeActivatedAt) {
    updates.push(`lifetime_activated_at = $${idx++}`);
    values.push(lifetimeActivatedAt);
  }
  // ONE TEAM TRIAL PER WORKSPACE: the first time Stripe confirms one is kept, and
  // no later write moves or clears it (not a plan change, not churn).
  if (trialStartedAt) {
    updates.push(`team_trial_started_at = COALESCE(team_trial_started_at, $${idx++})`);
    values.push(trialStartedAt);
  }
  // The pending cancellation and the price Stripe bills, as Stripe's answer said
  // them (billingRecord.js): only the fields it carried, so an absent field is
  // "leave the row alone" and never "no cancellation".
  for (const [column, value] of Object.entries(recordColumns(billingRecord))) {
    updates.push(`${column} = $${idx++}`);
    values.push(value);
  }
  if (clearSubscription) {
    updates.push('stripe_subscription_id = NULL');
    // No subscription, no price and nothing pending.
    updates.push('cancel_at_period_end = NULL', 'cancel_at = NULL', 'price_unit_amount_cents = NULL',
      'price_currency = NULL', 'price_interval = NULL', 'price_interval_count = NULL');
  }
  if (clearBillingWindow) {
    updates.push('billing_period_start = NULL');
    updates.push('billing_period_end = NULL');
  }
  if (clearPending) {
    updates.push('pending_plan = NULL');
  }

  if (updates.length === 0) return null;

  let whereClause;
  if (orgId) {
    whereClause = `org_id = $${idx++}`;
    values.push(orgId);
  } else if (subscriptionId && customerId) {
    // Match by subscription OR customer: if the checkout.session.completed
    // event that stamps stripe_subscription_id was ever missed (webhook
    // outage, the pre-fix NaN crash), the org would otherwise be orphaned —
    // every later subscription.updated matches zero rows and silently 200s.
    // Customer fallback self-heals: the first update event re-links the org.
    whereClause = `(stripe_subscription_id = $${idx} OR (stripe_subscription_id IS NULL AND stripe_customer_id = $${idx + 1}))`;
    idx += 2;
    values.push(subscriptionId, customerId);
  } else if (subscriptionId) {
    whereClause = `stripe_subscription_id = $${idx++}`;
    values.push(subscriptionId);
  } else {
    throw new Error('orgId or subscriptionId required');
  }

  const result = await client.query(
    `UPDATE organizations
     SET ${updates.join(', ')}
     WHERE ${whereClause}
     RETURNING org_id`,
    values
  );
  return result.rows[0]?.org_id || orgId || null;
}

/**
 * Record on the org the live subscription its Stripe customer is ALREADY paying
 * for, when the org row does not name one. For POST /billing/checkout, which
 * must ask this before it opens a checkout: a late or failed
 * checkout.session.completed (or a refund, which clears the id) leaves the row
 * saying "no subscription" while Stripe is still charging for one, and a
 * checkout opened on that answer is a second subscription.
 *
 * The write is the webhook's own reconcile, with the same fields the survivor
 * adoption in customer.subscription.deleted writes, so the org lands in exactly
 * the state the missing webhook would have left it in. No ledger row: the event
 * that was late still arrives and records the purchase itself.
 *
 * Every Stripe failure THROWS, retryable or not. This is not a webhook that can
 * be redelivered; the caller's only safe answer to "could not tell" is to not
 * open a checkout.
 */
async function adoptLiveSubscription(client, { orgId, customerId, seen = null }) {
  if (!orgId || !customerId) return null;
  if (typeof stripe?.subscriptions?.list !== 'function') {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.');
  }
  const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
  const listed = Array.isArray(list?.data) ? list.data : [];

  // WHAT THIS ONE LIST ALREADY SHOWS, USED (no second read):
  //
  //  - ONE TEAM TRIAL PER WORKSPACE. A subscription of this customer that Stripe
  //    says trialed (live, ended, or cancelled) is the workspace's trial, even
  //    when the webhook that would have recorded it was late or never arrived:
  //    it is recorded here, so the checkout that follows charges from the start.
  //  - `seen` (an out-parameter, when the caller passes one) receives the ids of
  //    subscriptions Stripe reports as `incomplete`: a caller checking out AGAIN
  //    for an unfinished purchase ends them first (see POST /billing/checkout).
  //    They are never adopted: nothing has been collected on them
  //    (LIVE_SUBSCRIPTION_STATUSES), and they carry no trial.
  const trialStartedAt = listed
    .map((sub) => teamTrialStartOf(sub, mapPlanFromSubscription(sub)))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())[0] || null;
  if (trialStartedAt) {
    await client.query(
      'UPDATE organizations SET team_trial_started_at = COALESCE(team_trial_started_at, $2) WHERE org_id = $1',
      [orgId, trialStartedAt]
    );
    await invalidateOrgCache(orgId);
  }
  if (seen) seen.incompleteIds = listed.filter((sub) => sub?.status === 'incomplete' && sub.id).map((sub) => sub.id);

  const [live] = liveBestFirst(listed);
  if (!live) return null;

  // The webhooks' own mapping: an unrecognised price writes no plan.
  const { unrecognisedPriceIds, ...state } = subscriptionState(live);
  await reconcileSubscriptionState(client, { orgId, customerId, ...state, clearPending: true });
  await invalidateOrgCache(orgId);
  if (unrecognisedPriceIds) {
    alertUnrecognisedPrice({
      orgId, customerId, subscriptionId: live.id, status: live.status, priceIds: unrecognisedPriceIds, planKept: undefined, source: 'adopted by POST /billing/checkout',
    }).catch((e) => console.warn('[BILLING] unrecognised price alert failed:', e.message));
  }
  return { subscriptionId: live.id, planId: state.planId, status: live.status, seats: state.seats };
}

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE'S WORD IS FINAL. THE EVENT IS ONLY A SIGNAL.
//
// The owner's decision (2026-09-28): every subscription and invoice event
// re-reads the subscription from Stripe and writes what Stripe says NOW. The
// payload is never the source of plan, seats, status or period.
//
// It replaces a rule that grew one case at a time. Stripe does not deliver in
// order and redelivers anything answered with a 5xx, so every handler that wrote
// what its event remembered could be handed an old memory: an update for a
// cancelled subscription restored paid access (round 1), a late checkout put
// back the plan the session sold (round 2), an older update put back the plan
// and seats a customer had left while Stripe billed the new ones, and a late
// failed-payment event locked a workspace that had paid (round 3). Each got its
// own "ask Stripe when X"; X was always too narrow. Now the question is asked
// every time, in one place — readStripeFacts — and every handler below takes
// its facts from the answer.
//
// THE READ HAPPENS BEFORE THE TRANSACTION OPENS. With every event reading
// Stripe, a read inside the transaction holds a pooled connection idle for as
// long as Stripe takes: twelve webhooks against a five-second Stripe once held
// the whole pool of ten, and every other request queued behind them. So an
// event is handled in two steps. First, with no connection held, the org row
// the event concerns is looked up and Stripe is read against it. Then one short
// transaction claims the event, locks that row, and writes. If the row changed
// in between (another event, or the plan page, wrote it), the answer may be
// older than that write, so the event reads Stripe again; after MAX_ATTEMPTS it
// answers 5xx and Stripe redelivers.
//
// What each read can say, and what follows:
//   the subscription            -> written as Stripe has it (subscriptionState),
//                                  onto the workspace it belongs to (its own
//                                  customer's) — unless it has ENDED, which
//                                  customer.subscription.deleted settles
//   ...on a price the map does  -> the same, except the plan (and seats): left
//      not know                    as the workspace has them, and the operator
//                                  is alerted (subscriptionState)
//   a transient failure         -> 5xx, nothing written, Stripe redelivers
//   refused for good            -> 5xx, nothing written, the event left for
//                                  Stripe to redeliver, never closed; the owner
//                                  is alerted once, from 24 hours after the
//                                  event (REFUSED_READ_ALERT_AFTER_SECONDS)
//   gone from Stripe            -> what each handler did before this rule:
//                                  customer.subscription.deleted settles it
// ─────────────────────────────────────────────────────────────────────────────

/** The events whose facts come from Stripe. */
const STRIPE_IS_THE_SOURCE = new Set([
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
]);

// A subscription that has ENDED in Stripe. Its line items still map to a paid
// plan, and Stripe spells the status `canceled`, which the entitlement check
// does not read as inactive: writing the pair onto a workspace is paid access
// that nobody pays for. What a workspace is left with when its subscription
// ends (a surviving subscription, or Free) is customer.subscription.deleted's to
// settle, as it already was for a late checkout and for adoption.
const ENDED_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);

// Nothing is owed. A failed charge on a subscription Stripe reports like this
// has since been paid.
const PAID_UP_STATUSES = new Set(['active', 'trialing']);

// Reads of Stripe one event may make when the workspace keeps changing under it.
const MAX_ATTEMPTS = 3;

/**
 * What the org row records for a subscription: THE mapping from a Stripe
 * subscription to a workspace's billing fields. Plan by the price map, seats
 * from the plan's line item, Stripe's status, the item's period. Every handler
 * writes through it.
 *
 * A PRICE THE MAP DOES NOT KNOW GRANTS NOTHING AND TAKES NOTHING, WHATEVER THE
 * STATUS. (The owner's decisions, 2026-09-28 and 2026-09-29.) It happens after
 * a new price is created in Stripe and before its env var is set, and to anyone
 * on an old price that has no slot. This used to answer 'free', and with every
 * event re-reading Stripe that was written on every renewal too: the customer
 * kept paying and lost their plan. `planId` is null, so the plan is not written:
 * a workspace on a paid plan keeps it, and one with none (a first purchase, an
 * adoption) is granted nothing until the price is mapped. The seat line is only
 * recognisable by a mapped price, so seats are kept too. Status, period and
 * subscription id are Stripe's, as for any subscription, and the STATUS ALONE
 * decides whether the workspace is locked, exactly as on a recognised price.
 *
 * That holds for unpaid, incomplete and paused as well. Those used to write
 * 'free': a Team whose retries ran out became Free, and stayed Free after the
 * customer paid the open invoice, because every later event kept the plan it
 * found. Which of them LOCKS the workspace is the
 * status's alone (the owner's decision, 2026-09-29): unpaid and incomplete lock
 * (entitlementService INACTIVE_STATUSES); paused keeps access. `unrecognisedPriceIds` tells the caller to alert the operator.
 *
 * An ENDED subscription (canceled, incomplete_expired) keeps its old path:
 * every handler settles that first, and one that gets here anyway is 'free'.
 * A payload written because the subscription is gone from Stripe (`fromEvent`)
 * keeps the plan too, and alerts nobody: Stripe reports nothing to alert about.
 */
/**
 * When the Team trial on this subscription started, or null when it has none.
 *
 * Read from the SUBSCRIPTION Stripe returned (never from a checkout click, and
 * never from a payload it did not confirm): a purchase is counted only when
 * granted. Stripe keeps `trial_start` on a subscription after the trial ends or
 * converts, so a workspace whose trial has since become a paid subscription, or
 * been cancelled, still has had one. Only a plan that trials counts (plans.js
 * trial_days); a trial on a price the map does not know is not attributed.
 */
function teamTrialStartOf(sub, planId) {
  if (!planId || !(Number(PLANS[planId]?.trial_days) > 0)) return null;
  const startedAt = Number(sub?.trial_start);
  if (Number.isFinite(startedAt) && startedAt > 0) return new Date(startedAt * 1000);
  if (sub?.status === 'trialing') {
    const from = Number(sub.start_date) || Number(sub.created);
    return Number.isFinite(from) && from > 0 ? new Date(from * 1000) : new Date();
  }
  return null;
}

function subscriptionState(sub, { fromEvent = false } = {}) {
  let planId = mapPlanFromSubscription(sub);
  let unrecognisedPriceIds = null;
  if (!planId) {
    const priceIds = priceIdsOf(sub);
    if (ENDED_SUBSCRIPTION_STATUSES.has(sub.status)) {
      planId = 'free';
      console.error(`[STRIPE] Unknown price ID(s) on ended subscription ${sub.id} (${sub.status}): ${priceIds.join(', ')} — defaulting to free`);
    } else {
      if (!fromEvent) unrecognisedPriceIds = priceIds;
      console.error(`[STRIPE] Unknown price ID(s) on subscription ${sub.id} (${sub.status}): ${priceIds.join(', ') || '(no line items)'} — the workspace's plan is left as it is`);
    }
  }
  return {
    subscriptionId: sub.id,
    planId,
    status: sub.status,
    currentPeriodStart: periodDate(sub, 'current_period_start'),
    currentPeriodEnd: periodDate(sub, 'current_period_end'),
    seats: getSeatsFromSubscription(sub),
    trialStartedAt: teamTrialStartOf(sub, planId),
    billingRecord: billingRecordOf(sub),
    unrecognisedPriceIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE UNRECOGNISED-PRICE ALERT. Sent after commit and best-effort, like the
// past_due alert: it never rolls back or 500s the webhook. A price with no slot
// is seen on EVERY event for every subscription on it (a renewal alone is an
// invoice and an update), so it is sent at most once a day per price: the claim
// below is the guard. A send that fails gives its claim back, so the next event
// tries again.
// ─────────────────────────────────────────────────────────────────────────────

const ALERT_REPEAT_AFTER = '1 day';
let alertLogReady = null;

function ensureAlertLog() {
  if (!alertLogReady) {
    alertLogReady = db.query(
      `CREATE TABLE IF NOT EXISTS billing_alert_sends (
         alert_key TEXT PRIMARY KEY,
         sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      [],
      'org-system'
    ).catch((err) => {
      alertLogReady = null;
      throw err;
    });
  }
  return alertLogReady;
}

/** True when this caller may send the alert `key` now (none sent within a day). */
async function claimDailyAlert(key) {
  await ensureAlertLog();
  const res = await db.query(
    `INSERT INTO billing_alert_sends (alert_key, sent_at)
     VALUES ($1, NOW())
     ON CONFLICT (alert_key) DO UPDATE SET sent_at = NOW()
       WHERE billing_alert_sends.sent_at < NOW() - $2::interval
     RETURNING alert_key`,
    [key, ALERT_REPEAT_AFTER],
    'org-system'
  );
  return res.rows.length > 0;
}

/** True when this caller may send the alert `key`, which is sent once, ever:
 *  the claim is kept for good once the send is confirmed. */
async function claimAlertOnce(key) {
  await ensureAlertLog();
  const res = await db.query(
    `INSERT INTO billing_alert_sends (alert_key, sent_at)
     VALUES ($1, NOW())
     ON CONFLICT (alert_key) DO NOTHING
     RETURNING alert_key`,
    [key],
    'org-system'
  );
  return res.rows.length > 0;
}

async function releaseDailyAlert(key) {
  await db.query('DELETE FROM billing_alert_sends WHERE alert_key = $1', [key], 'org-system');
}

function buildUnrecognisedPriceAlert({ orgId, customerId, subscriptionId, status, priceIds, planKept, source, nothingWritten = false, workspaceNotCreated = false }) {
  let kept = 'kept whatever plan it already had (none is granted from this price)';
  if (planKept !== undefined) {
    kept = planKept && normalizePlanId(planKept) !== 'free'
      ? `kept its ${PLANS[normalizePlanId(planKept)]?.publicName || planKept} plan`
      : 'was granted nothing (it has no paid plan on record)';
  }
  const rows = Object.entries({
    'Price id': priceIds.length ? priceIds.join(', ') : '(the subscription has no line items)',
    Subscription: `${subscriptionId} (${status})`,
    Workspace: orgId,
    Customer: customerId,
    Event: source,
  }).filter(([, v]) => v != null);
  const envRows = PRICE_MAP_ENV_VARS.map((name) => {
    const value = process.env[name];
    return value ? `${name} = ${value} (${priceToPlan[value] || 'not mapped'})` : `${name} (not set)`;
  });
  return {
    to: process.env.BILLING_ALERT_TO || process.env.LEAD_ALERT_TO || process.env.RESEND_REPLY_TO || 'john@deerdawn.com',
    subject: `Unrecognised Stripe price: ${priceIds.join(', ') || subscriptionId}`,
    html: '<p>Stripe reports a live subscription on a price DeerDawn\'s price map does not know. '
      + (workspaceNotCreated
        // A paid checkout for a NEW team workspace (createWorkspaceAtCheckout).
        ? 'A customer paid to create a team workspace on it, and no workspace was created: the event is left failed, so Stripe redelivers it, and it applies (creating the workspace) once the price is mapped. '
        : `The workspace ${escapeHtml(kept)}; `)
      + (workspaceNotCreated ? '' : nothingWritten
        // A plan or seat change asked for on the plan page (POST /billing/checkout).
        ? 'nothing was written: the change the owner asked for was not made, and they were sent to the billing portal instead. '
        : 'status, period and subscription id were written from Stripe. ')
      + 'Seat changes and new purchases on this price are not applied until it is mapped.</p>'
      + `<ul>${rows.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join('')}</ul>`
      + '<p>The price map is built from these environment variables on the API (set the one this price belongs to, then deploy; the next event for the subscription writes its plan):</p>'
      + `<ul>${envRows.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
      + '<p>At most one alert per price per day.</p>',
  };
}

async function alertUnrecognisedPrice(info) {
  const keys = (info.priceIds.length ? info.priceIds : [`(none):${info.subscriptionId}`]).map((p) => `unrecognised_price:${p}`);
  const claimed = [];
  for (const key of keys) {
    if (await claimDailyAlert(key)) claimed.push(key);
  }
  if (claimed.length === 0) return false;
  let result;
  try {
    result = await sendEmail({ ...buildUnrecognisedPriceAlert(info), emailType: 'unrecognised_price_alert' });
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  if (result?.ok === false) {
    for (const key of claimed) await releaseDailyAlert(key).catch(() => {});
    console.warn('[BILLING] unrecognised price alert was not sent:', result.error || result.status || 'unknown');
    return false;
  }
  return true;
}

/**
 * Is this subscription filed under the customer we expect? A subscription is
 * applied only to its own customer's workspace. An id missing on either side
 * proves nothing and is not a mismatch.
 */
function belongsToCustomer(sub, customerId) {
  const actual = customerIdOf(sub);
  return !actual || !customerId || actual === customerId;
}

/** A checkout that sells a subscription and names everything needed to apply it. */
function isSubscriptionCheckout(session) {
  const orgId = session?.metadata?.orgId;
  return session?.mode !== 'payment'
    && Boolean(orgId && validOrgIdPattern.test(orgId) && PLANS[normalizePlanId(session.metadata?.tierId)])
    && Boolean(session.customer)
    && Boolean(session.subscription);
}

/** The workspace an event concerns, as the handlers below resolve it. */
async function findOrgForEvent(client, event, { lock = false } = {}) {
  const object = event?.data?.object || {};
  if (event.type === 'checkout.session.completed') {
    const orgId = object.metadata?.orgId;
    if (!orgId || !validOrgIdPattern.test(orgId)) return null;
    const result = await client.query(
      `SELECT ${ORG_BILLING_COLUMNS} FROM organizations WHERE org_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [orgId]
    );
    return result.rows[0] || null;
  }
  if (event.type.startsWith('invoice.')) {
    return findOrgForSubscription(client, invoiceSubscriptionId(object), customerIdOf(object), { lock });
  }
  return findOrgForSubscription(client, object.id, customerIdOf(object), { lock });
}

/** The billing state Stripe was read against; if it differs at write time, read again. */
function billingState(org) {
  if (!org) return 'none';
  const seats = org.purchased_seats === null || org.purchased_seats === undefined ? null : Number(org.purchased_seats);
  const periodEnd = org.billing_period_end ? new Date(org.billing_period_end).getTime() : null;
  return JSON.stringify([
    org.org_id, org.stripe_subscription_id || null, org.stripe_customer_id || null,
    org.plan_tier || null, seats, org.subscription_status || null, periodEnd,
  ]);
}

/**
 * THE READ. What Stripe says now about the subscription an event concerns, taken
 * with no database connection held, against the org row `org` as it was just
 * read. One read of the subscription per event; a handler branch never reads
 * Stripe itself.
 *
 *   now           { subscription } | { subscription: null } (gone)
 *                 | { subscription: null, unreadable: true, reason } (refused
 *                 for good)
 *   recordedLive  updated: is the subscription the org is billed on, when it is
 *                 a different one, still live? (read first, as before: when it
 *                 is, or it cannot be read for good, the event's own
 *                 subscription is not read)
 *   recorded      checkout: the org's other subscription, when the purchase is
 *                 live, for the "two live subscriptions" rule
 *   siblings      deleted: the customer's other live subscriptions, best first
 *
 * A transient failure throws, and the webhook answers 5xx without writing.
 */
async function readStripeFacts(event, org) {
  const object = event?.data?.object || {};
  const facts = { now: null, recordedLive: null, recorded: null, siblings: [] };
  // A subscription no workspace records yet, whose event carries a new-workspace
  // claim: read it (createWorkspaceAtCheckout decides from what Stripe says).
  if (await readNewWorkspaceFacts(event, org, facts)) return facts;

  if (event.type === 'checkout.session.completed') {
    if (!isSubscriptionCheckout(object)) return facts;
    facts.now = await currentSubscription(object.subscription);
    const sub = facts.now.subscription;
    const recordedId = org?.stripe_subscription_id || null;
    if (sub && LIVE_SUBSCRIPTION_STATUSES.has(sub.status) && recordedId && recordedId !== object.subscription) {
      facts.recorded = { id: recordedId, ...(await currentSubscription(recordedId)) };
    }
    return facts;
  }

  if (event.type === 'customer.subscription.updated') {
    if (!org?.org_id) return facts;
    const recordedId = org.stripe_subscription_id || null;
    if (recordedId && recordedId !== object.id) {
      facts.recordedLive = { id: recordedId, ...(await isSubscriptionLive(recordedId)) };
      if (facts.recordedLive.live || facts.recordedLive.unreadable) return facts;
    }
    facts.now = await currentSubscription(object.id);
    return facts;
  }

  if (event.type === 'customer.subscription.deleted') {
    if (!org?.org_id) return facts;
    // A secondary subscription ending touches nothing: nothing to read.
    if (org.stripe_subscription_id && org.stripe_subscription_id !== object.id) return facts;
    const listed = await customerSubscriptions(customerIdOf(object));
    const own = listed.subscriptions.find((s) => s?.id === object.id) || null;
    facts.now = own
      ? { subscription: own }
      : { subscription: null, ...(listed.unreadable ? { unreadable: true, reason: listed.reason } : {}) };
    facts.siblings = liveBestFirst(listed.subscriptions, object.id);
    return facts;
  }

  if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.payment_failed') {
    // An invoice for a subscription no workspace records (by its id or its
    // customer) has nothing to write, so it asks Stripe nothing and answers as
    // it did before this rule, whatever Stripe would have said.
    if (!org?.org_id) return facts;
    const subscriptionId = invoiceSubscriptionId(object);
    if (subscriptionId) facts.now = await currentSubscription(subscriptionId);
    return facts;
  }

  return facts;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHEN STRIPE REFUSES A READ FOR GOOD: ALERT THE OWNER, NEVER CLOSE THE EVENT.
// (The owner's decision, 2026-09-29, as revised the same day.)
//
// A revoked or restricted key, a permission the key lacks, a malformed id: a
// retry gives the same answer until somebody fixes the key. Each handler used
// to keep its behaviour from before "Stripe's word is final" there, from the
// event's payload: a late invoice.payment_failed could lock a paid workspace,
// an update wrote a payload that might be months old, and a deleted settled to
// Free without asking whether the customer paid for anything else.
//
// Now nothing is ever written from an event whose subscription Stripe will not
// show, and the event is never closed unapplied: every delivery answers 5xx,
// writes nothing and leaves the event `failed`, so Stripe keeps redelivering it
// for as long as it will (about three days in live mode), and the first
// delivery after the key can read it again applies it, like any event.
//
// (A first version closed the event with a 200 after 24 hours. That left a
// purchase refused past the window on Free until the next renewal, and a
// cancellation refused past it with paid access for good: the redelivery of a
// closed event is a duplicate, and nothing later corrects either.)
//
// THE OWNER IS ALERTED ONCE PER EVENT, 24 HOURS FROM ITS OWN `created` (which
// Stripe keeps across redeliveries): the first refused delivery at or after
// that time sends it. An event first delivered later than that alerts on that
// first delivery; one with no usable `created` cannot be timed, so it alerts on
// its first refused delivery. The once-only claim is a row in
// billing_alert_sends (the unrecognised-price alert's table), so it survives a
// restart, and it is given back when the send fails, is skipped or throws, so
// the next delivery tries again: an alert is never lost to a failed send.
//
// "The subscription is gone from Stripe" is NOT this case: Stripe has answered,
// and customer.subscription.deleted settles a subscription that has gone.
// ─────────────────────────────────────────────────────────────────────────────

const REFUSED_READ_ALERT_AFTER_SECONDS = 24 * 60 * 60;

/**
 * The read Stripe refused for good, if any: `{ subscriptionId, reason }`. Every
 * read readStripeFacts makes is here — the event's own subscription (or, for
 * deleted, its customer's list), and the org's other subscription when the
 * event had to ask after it.
 */
function refusedRead(event, facts) {
  if (!facts) return null;
  const object = event?.data?.object || {};
  if (facts.recordedLive?.unreadable) return { subscriptionId: facts.recordedLive.id, reason: facts.recordedLive.reason };
  if (facts.recorded?.unreadable) return { subscriptionId: facts.recorded.id, reason: facts.recorded.reason };
  if (facts.now?.unreadable) {
    let subscriptionId = object.id || null;
    if (event.type === 'checkout.session.completed') subscriptionId = object.subscription || null;
    if (event.type.startsWith('invoice.')) subscriptionId = invoiceSubscriptionId(object);
    return { subscriptionId, reason: facts.now.reason || 'Stripe refused the read' };
  }
  return null;
}

/** When a refusal of this event is reported to the owner; null when the event
 *  carries no usable `created` (then at once). */
function refusedReadAlertAt(event) {
  const created = Number(event?.created);
  if (!Number.isFinite(created) || created <= 0) return null;
  return new Date((created + REFUSED_READ_ALERT_AFTER_SECONDS) * 1000);
}

function buildRefusedReadAlert({ event, subscriptionId, orgId, reason }) {
  const created = Number.isFinite(Number(event?.created)) && Number(event.created) > 0
    ? new Date(Number(event.created) * 1000).toISOString()
    : null;
  const rows = Object.entries({
    Event: `${event.type} (${event.id})`,
    'Event created': created || '(the event carries no creation time)',
    Subscription: subscriptionId || '(none named)',
    Workspace: orgId || '(no workspace found for this event)',
    Reason: reason,
  }).filter(([, v]) => v != null);
  return {
    to: process.env.BILLING_ALERT_TO || process.env.LEAD_ALERT_TO || process.env.RESEND_REPLY_TO || 'john@deerdawn.com',
    subject: `Stripe event not applied yet: ${event.type} (${event.id})`,
    html: '<p>Stripe refuses to let DeerDawn read the subscription this event is about, for a reason a retry does not fix, '
      + 'so the event has not been applied: nothing was written to the workspace. '
      + 'Every delivery is answered with an error, so Stripe keeps redelivering it (in live mode, for up to three days from when the event was created), '
      + 'and the first delivery after the API\'s Stripe key can read the subscription applies it.</p>'
      + `<ul>${rows.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join('')}</ul>`
      + '<p>Check that the API\'s Stripe key can read this subscription. If Stripe has stopped redelivering by the time it can, '
      + 'resend the event from the Stripe dashboard.</p>'
      + '<p>One alert per event.</p>',
  };
}

/**
 * Tell the owner, once per event, that a refused read is holding it. After the
 * answer, best-effort: never the reason a delivery fails or succeeds. The claim
 * is taken before the send and given back unless the send is confirmed, so a
 * failed, skipped or throwing send is tried again on the next delivery.
 */
function alertRefusedRead({ event, subscriptionId, orgId, reason }) {
  const key = `stripe_event_not_applied:${event.id}`;
  (async () => {
    if (!(await claimAlertOnce(key))) return;
    let result;
    try {
      result = await sendEmail({ ...buildRefusedReadAlert({ event, subscriptionId, orgId, reason }), emailType: 'stripe_event_not_applied_alert' });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result?.ok !== true) {
      await releaseDailyAlert(key).catch(() => {});
      const why = result?.skipped ? `skipped: ${result.reason || 'unknown'}` : (result?.error || result?.status || 'unknown');
      console.warn(`[BILLING] refused-read alert for ${event.type} ${event.id} was NOT sent (${why}); the next delivery tries again`);
      return;
    }
    console.error(`[STRIPE] ${event.type} ${event.id}: owner alerted that Stripe refuses subscription ${subscriptionId || '(none named)'} (${reason})`);
  })().catch((err) => console.warn(`[BILLING] refused-read alert for ${event.id} could not be claimed (${err.message}); the next delivery tries again`));
}

/** Has this event already been handled? Answered before Stripe is read, so a
 *  redelivery of a handled event costs no Stripe call and cannot fail on one. */
async function alreadyProcessed(eventId) {
  const result = await db.query('SELECT status FROM stripe_events WHERE event_id = $1', [eventId], 'org-system');
  return result?.rows?.[0]?.status === 'processed';
}

/**
 * Answer 5xx and record the event as failed, so Stripe's redelivery may reclaim
 * it. Never over a PROCESSED row: a duplicate that fails (say, while Stripe is
 * down) must not reopen an event that was handled, or the next redelivery would
 * handle it a second time — a second alert, a second purchase event.
 */
async function failWebhook(event, err) {
  try {
    await db.query(
      `INSERT INTO stripe_events (event_id, type, status, processed_at, error)
       VALUES ($1, $2, 'failed', NOW(), $3)
       ON CONFLICT (event_id)
       DO UPDATE SET status = 'failed', processed_at = NOW(), error = EXCLUDED.error
         WHERE stripe_events.status <> 'processed'`,
      [event.id, event.type, err.message],
      'org-system'
    );
  } catch { /* ignore audit log failure */ }
  console.error('Webhook processing failed:', err.message);
  return { status: 500, body: { error: 'internal_error' } };
}

const systemQueries = { query: (text, params) => db.query(text, params, 'org-system') };

// Self-hosted: there is no Stripe account behind this install, so nothing may
// arrive here that could change a workspace's plan.
router.post('/', requireBillingEnabled, express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook Signature Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const outcome = await handleEvent(event, attempt);
    if (outcome !== READ_AGAIN) return res.status(outcome.status).json(outcome.body);
  }
  return undefined; // not reached: the last attempt never answers READ_AGAIN
});

// ─────────────────────────────────────────────────────────────────────────────
// DISPUTES. A DISPUTE LOCK IS ITS OWN LOCK.
//
// It used to be `organizations.is_locked = TRUE`: the owner's own emergency
// lockdown switch (PATCH /orgs/settings). So the owner could clear a lock put
// there by the card issuer's dispute, and nothing ever lifted it when the
// dispute was won: charge.dispute.closed was ignored.
//
// Now the lock is `organizations.dispute_lock_ids`, the ids of the disputes that
// hold the workspace, and nothing an owner can send reaches it:
//
//   charge.dispute.funds_withdrawn  adds the dispute's id (money is gone).
//   charge.dispute.closed           won or warning_closed: removes THAT dispute's
//                                   id, so the workspace unlocks when none is
//                                   left. lost: the id stays, and so does the
//                                   lock (added if the withdrawal was missed).
//                                   Any other status changes nothing.
//
// A LOST DISPUTE IS LIFTED BY DEERDAWN BY HAND (docs/RUNBOOK.md, "Disputes"):
//   UPDATE organizations SET dispute_lock_ids = '{}', dispute_locked_at = NULL
//    WHERE org_id = '<org>';
// (or array_remove(dispute_lock_ids, '<dp_...>') to lift one of several).
//
// STRIPE IS READ BEFORE THE TRANSACTION OPENS, like every subscription event:
// the charge (a dispute names its charge, not its customer) and the dispute as
// it is NOW, so a withdrawal that arrives late for a dispute already won locks
// nothing. A read Stripe refuses is never closed: 5xx, nothing written,
// redeliverable, and the owner is alerted once from 24 hours after the event.
// ─────────────────────────────────────────────────────────────────────────────

const DISPUTE_EVENTS = new Set(['charge.dispute.funds_withdrawn', 'charge.dispute.closed']);
// Resolved in DeerDawn's favour: the lock for that dispute lifts by itself.
const DISPUTE_LIFTED_STATUSES = new Set(['won', 'warning_closed']);

/**
 * What Stripe says now about the dispute an event names: `{ customerId,
 * status }`. Called with no database connection held. Throws on any failure
 * (the caller answers 5xx); `status` falls back to the event's own when Stripe
 * no longer has the dispute.
 */
async function readDisputeFacts(event) {
  const dispute = event?.data?.object || {};
  const facts = { customerId: null, status: dispute.status || null };
  if (!dispute.charge) return facts;
  const charge = await stripe.charges.retrieve(dispute.charge, readOptions());
  facts.customerId = customerIdOf(charge);
  if (dispute.id && typeof stripe.disputes?.retrieve === 'function') {
    try {
      const now = await stripe.disputes.retrieve(dispute.id, readOptions());
      if (now?.status) facts.status = now.status;
    } catch (err) {
      if (err?.code !== 'resource_missing') throw err;
    }
  }
  return facts;
}

/** handleEvent's answer when the workspace changed under its Stripe read. */
const READ_AGAIN = Symbol('read Stripe again');

// A TEAM WORKSPACE IS CREATED WHEN ITS TEAM SUBSCRIPTION IS CONFIRMED (journey r6).
//
// A checkout that names a workspace which does not exist yet (POST /billing/checkout
// with newWorkspaceName) has no organizations row to grant a plan to. Its claim (the
// key, the name, the founder) rides in the checkout session's metadata AND in the
// subscription's (subscription_data.metadata), so it reaches whichever event first
// shows the subscription live: the checkout completing, or, for a card that needed
// extra confirmation (incomplete, then active minutes later), the subscription
// update or the paid invoice that reports it.
//
// The workspace is created, in that event's own transaction, only when Stripe shows
// the subscription live now, on a mapped plan, under the claim's customer (the same
// conditions the checkout case uses to grant a plan). Any other outcome creates
// nothing, so an abandoned or unpaid checkout leaves no workspace behind. It is
// idempotent: the key is fixed by the claim, so a redelivery, or a later event for
// the same checkout, finds the workspace and changes nothing.

/** The new-workspace claim an event carries, or null. */
function newWorkspaceClaim(event) {
  const object = event?.data?.object || {};
  let metadata = null;
  let subscriptionId = null;
  let customerId = null;
  if (event.type === 'checkout.session.completed') {
    if (!isSubscriptionCheckout(object)) return null;
    metadata = object.metadata;
    subscriptionId = typeof object.subscription === 'string' ? object.subscription : object.subscription?.id;
    customerId = customerIdOf(object);
  } else if (event.type === 'customer.subscription.updated') {
    metadata = object.metadata;
    subscriptionId = object.id;
    customerId = customerIdOf(object);
  } else if (event.type === 'invoice.payment_succeeded') {
    metadata = object.subscription_details?.metadata || object.parent?.subscription_details?.metadata;
    subscriptionId = invoiceSubscriptionId(object);
    customerId = customerIdOf(object);
  } else {
    return null;
  }
  const orgId = metadata?.orgId;
  const name = typeof metadata?.newWorkspaceName === 'string' ? metadata.newWorkspaceName.trim() : '';
  const founderUserId = typeof metadata?.founderUserId === 'string' ? metadata.founderUserId : '';
  if (!orgId || !validOrgIdPattern.test(orgId) || !name || !founderUserId || !subscriptionId || !customerId) return null;
  return { orgId, name, founderUserId, subscriptionId, customerId };
}

/** Called from readStripeFacts for an event no workspace records yet: read the
 *  subscription it names, with no connection held, when it carries a claim. */
async function readNewWorkspaceFacts(event, org, facts) {
  if (org?.org_id || event.type === 'checkout.session.completed') return null;
  const claim = newWorkspaceClaim(event);
  if (!claim) return null;
  facts.now = await currentSubscription(claim.subscriptionId);
  return facts;
}

/** A purchase is counted ONCE per subscription, whichever event grants it first.
 *  The late path (a workspace created by an update or an invoice) claims the
 *  subscription in the alert-once table; a failed claim counts the purchase rather
 *  than lose it. */
async function claimPurchaseOnce(subscriptionId) {
  if (!subscriptionId) return true;
  try {
    return await claimAlertOnce(`purchase_completed:${subscriptionId}`);
  } catch (err) {
    console.warn('[BILLING] purchase de-duplication failed:', err.message);
    return true;
  }
}

/** The checkout case's side of it: has the late path already counted this
 *  subscription? (Read only: the checkout case counts as it always did.) */
async function purchaseAlreadyCounted(subscriptionId) {
  if (!subscriptionId) return false;
  try {
    await ensureAlertLog();
    const res = await db.query('SELECT 1 FROM billing_alert_sends WHERE alert_key = $1', [`purchase_completed:${subscriptionId}`], 'org-system');
    return (res?.rows || []).length > 0;
  } catch {
    return false;
  }
}

/** Tell the owner, once per workspace, that a paid checkout could not become one.
 *  Best-effort and unawaited; the claim is given back when the send fails, so the
 *  next delivery tries again. */
function alertWorkspaceNotCreated(claim, event, reason) {
  const key = `workspace_not_created:${claim.orgId}`;
  (async () => {
    if (!(await claimAlertOnce(key))) return;
    let result;
    try {
      result = await sendEmail({
        to: process.env.BILLING_ALERT_TO || process.env.LEAD_ALERT_TO || process.env.RESEND_REPLY_TO || 'john@deerdawn.com',
        subject: `Team workspace not created for a paid checkout (${claim.orgId})`,
        html: '<p>A customer paid for a new team workspace and it could not be created, so the event is left failed and Stripe keeps redelivering it. '
          + 'It applies as soon as the cause is fixed.</p>'
          + `<ul><li><strong>Reason:</strong> ${escapeHtml(reason)}</li>`
          + `<li><strong>Workspace key:</strong> ${escapeHtml(claim.orgId)}</li>`
          + `<li><strong>Name:</strong> ${escapeHtml(claim.name)}</li>`
          + `<li><strong>Subscription:</strong> ${escapeHtml(claim.subscriptionId)}</li>`
          + `<li><strong>Customer:</strong> ${escapeHtml(claim.customerId)}</li>`
          + `<li><strong>Event:</strong> ${escapeHtml(`${event.type} (${event.id})`)}</li></ul>`
          + '<p>One alert per workspace.</p>',
        emailType: 'workspace_not_created_alert',
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result?.ok !== true) await releaseDailyAlert(key).catch(() => {});
  })().catch((err) => console.warn(`[BILLING] workspace-not-created alert for ${claim.orgId} failed: ${err.message}`));
}

// Returns the locked org row, or the row it was given.
// `outcome.late` is set when an event OTHER than the checkout completing created the
// workspace (the late path: checkout incomplete, then the update or the invoice), so
// the caller can record who paid and count the purchase after commit, as the
// checkout case does for its own.
async function createWorkspaceAtCheckout(client, event, facts, org, outcome = {}) {
  if (org) return org;
  const claim = newWorkspaceClaim(event);
  if (!claim) return org;
  const sub = facts?.now?.subscription;
  if (!sub || !LIVE_SUBSCRIPTION_STATUSES.has(sub.status) || !belongsToCustomer(sub, claim.customerId)) return org;
  // PAID, AND NOT CREATED, IS NEVER CLOSED QUIETLY. A live subscription on a price
  // the plan map does not know, or a founder with no account, cannot yet become a
  // workspace. The event is left FAILED (a 5xx: Stripe redelivers it, and it
  // applies once the price is mapped), and the owner of the API is told once.
  const state = subscriptionState(sub);
  if (!state.planId) {
    alertUnrecognisedPrice({
      orgId: claim.orgId, customerId: claim.customerId, subscriptionId: claim.subscriptionId, status: sub.status,
      priceIds: state.unrecognisedPriceIds || priceIdsOf(sub), planKept: null, source: event.type, workspaceNotCreated: true,
    }).catch((err) => console.warn('[BILLING] unrecognised price alert failed:', err.message));
    throw new Error(`the checkout for ${claim.orgId} is on a price the plan map does not know — no workspace was created, awaiting redelivery`);
  }
  const founder = await client.query('SELECT 1 FROM users WHERE user_id = $1', [claim.founderUserId]);
  if (!founder.rows.length) {
    alertWorkspaceNotCreated(claim, event, `the founder ${claim.founderUserId} has no account`);
    throw new Error(`the checkout for ${claim.orgId} names founder ${claim.founderUserId}, who has no account — the workspace was not created, awaiting redelivery`);
  }
  const inserted = await require('../services/workspaceService').createTeamWorkspaceAtCheckout(client, {
    orgId: claim.orgId,
    name: claim.name,
    founderUserId: claim.founderUserId,
  });
  if (inserted && event.type !== 'checkout.session.completed') outcome.late = { claim, sub, planId: state.planId };
  // The events below find their workspace by the subscription or the customer it
  // records, and a workspace created by one of them has recorded neither yet.
  // (The checkout case records both itself, in its own reconcile.)
  if (event.type !== 'checkout.session.completed') {
    await client.query(
      'UPDATE organizations SET stripe_customer_id = $2, stripe_subscription_id = $3 WHERE org_id = $1 AND stripe_subscription_id IS NULL',
      [claim.orgId, claim.customerId, claim.subscriptionId]
    );
  }
  const created = await client.query(
    `SELECT ${ORG_BILLING_COLUMNS} FROM organizations WHERE org_id = $1 FOR UPDATE`,
    [claim.orgId]
  );
  return created.rows[0] || null;
}

/**
 * One attempt at an event, in the two steps the rule above describes. Answers
 * { status, body } for the response, or READ_AGAIN.
 */
async function handleEvent(event, attempt) {
  const readsStripe = STRIPE_IS_THE_SOURCE.has(event.type);

  // 1. Stripe, read with no database connection held.
  let facts = null;
  let readAgainst = null;
  if (readsStripe) {
    try {
      if (await alreadyProcessed(event.id)) return { status: 200, body: { received: true, duplicate: true } };
      readAgainst = await findOrgForEvent(systemQueries, event);
      facts = await readStripeFacts(event, readAgainst);
    } catch (err) {
      return failWebhook(event, err);
    }
    // REFUSED FOR GOOD: 5xx, nothing written, the event left redeliverable,
    // whatever its age; the owner is alerted once, from 24 hours after it.
    const refused = refusedRead(event, facts);
    if (refused) {
      const alertAt = refusedReadAlertAt(event);
      const outcome = await failWebhook(event, new Error(
        `Stripe refused to show subscription ${refused.subscriptionId || '(none named)'} (${refused.reason}) — `
        + 'nothing written, awaiting redelivery'
      ));
      if (!alertAt || Date.now() >= alertAt.getTime()) {
        alertRefusedRead({
          event,
          subscriptionId: refused.subscriptionId,
          orgId: readAgainst?.org_id || (event.type === 'checkout.session.completed' ? event.data?.object?.metadata?.orgId : null) || null,
          reason: refused.reason,
        });
      }
      return outcome;
    }
  }

  // 1b. A dispute: the charge and the dispute, read the same way.
  let disputeFacts = null;
  if (DISPUTE_EVENTS.has(event.type)) {
    try {
      if (await alreadyProcessed(event.id)) return { status: 200, body: { received: true, duplicate: true } };
      disputeFacts = await readDisputeFacts(event);
    } catch (err) {
      const outcome = await failWebhook(event, err);
      // Refused for good (a key without the permission): the owner hears of it
      // once, from 24 hours after the event, as for a refused subscription read.
      if (!isRetryableStripeError(err)) {
        const alertAt = refusedReadAlertAt(event);
        if (!alertAt || Date.now() >= alertAt.getTime()) {
          alertRefusedRead({ event, subscriptionId: `dispute ${event.data?.object?.id || '(none named)'}`, orgId: null, reason: refusalReason(err) });
        }
      }
      return outcome;
    }
  }

  // 2. The write: one short transaction. No subscription is read from Stripe
  // inside it. (Two older calls still are, neither of them this rule's read:
  // the roll-over schedule for a plan with auto_roll_to, which only the legacy
  // pilot plan has.)
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const shouldProcess = await upsertStripeEvent(client, event.id, event.type);
    if (!shouldProcess) {
      await client.query('ROLLBACK');
      return { status: 200, body: { received: true, duplicate: true } };
    }


    // The workspace, locked for this transaction. It must be the row Stripe was
    // read against: if anything wrote it in between, that write may be newer
    // than the answer in hand, so read Stripe again rather than write over it.
    let org = null;
    const workspaceCreated = {};
    if (readsStripe) {
      org = await findOrgForEvent(client, event, { lock: true });
      if (billingState(org) !== billingState(readAgainst)) {
        if (attempt < MAX_ATTEMPTS) {
          await client.query('ROLLBACK');
          return READ_AGAIN;
        }
        throw new Error(`the workspace changed while Stripe was being read, ${MAX_ATTEMPTS} times — not handled, awaiting redelivery`);
      }
      org = await createWorkspaceAtCheckout(client, event, facts, org, workspaceCreated);
    }

    let affectedOrgId = null;
    // Retention ledger event to append after a successful commit (best-effort).
    let ledgerEvent = null;
    // purchase_completed product event to emit after a successful commit
    // (best-effort) — see the checkout.session.completed case. Emitted ONLY when
    // the workspace actually received a plan: every branch below that grants
    // nothing drops it through notCounted.
    let purchaseEvent = null;
    const notCounted = (why) => {
      if (!purchaseEvent) return;
      console.warn(`[STRIPE] purchase_completed not recorded for org ${purchaseEvent.actor.org_id}: ${why} `
        + `(checkout ${purchaseEvent.input.metadata.transaction_id || 'unknown'})`);
      purchaseEvent = null;
    };
    // Operator alert to send after a successful commit (best-effort) — see the
    // invoice.payment_failed case. Same contract as the ledger: an email
    // failure never rolls back or 500s the webhook.
    let alertEmail = null;
    // A live subscription on a price the map does not know, written without a
    // plan (subscriptionState): the operator is told after commit, at most once
    // a day per price, on the same best-effort contract.
    let unrecognisedPrice = null;
    // A seat-count change on an unchanged plan: real revenue movement that the
    // ledger does not record as its own row, mirrored to PostHog below.
    let seatChange = null;
    // Other workspaces on the same Stripe customer whose cached state changed.
    let extraInvalidate = [];

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orgId = session.metadata?.orgId;
        const tierId = normalizePlanId(session.metadata?.tierId);
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (!orgId || !validOrgIdPattern.test(orgId) || !PLANS[tierId]) {
          throw new Error('Invalid checkout session metadata');
        }

        if (!customerId) {
          throw new Error('Missing customer identifier on checkout session');
        }

        // Read the prior tier BEFORE reconcile overwrites it — it is the only
        // thing that separates a first paid subscription from an upgrade off an
        // already-paid plan.
        const priorLookup = await client.query(
          'SELECT plan_tier FROM organizations WHERE org_id = $1',
          [orgId]
        );
        const priorTier = normalizePlanId(priorLookup.rows[0]?.plan_tier);
        // Attribute the purchase to the buyer, not the org. recordProductEvent
        // falls back to the org id for its PostHog distinctId when the actor has
        // no user, and every other step of the revenue funnel
        // (select_plan_viewed -> checkout_started) is keyed on the user — an
        // org-keyed purchase would never join to them. Self-serve plans are
        // personal workspaces, so the founding member is the buyer.
        const buyerLookup = await client.query(
          'SELECT user_id FROM users WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1',
          [orgId]
        );
        const buyerUserId = buyerLookup.rows[0]?.user_id || null;
        const amountCents = Number.isFinite(session.amount_total) ? session.amount_total : null;
        purchaseEvent = {
          actor: buyerUserId
            ? { type: 'user', id: buyerUserId, org_id: orgId }
            : { org_id: orgId },
          input: {
            event_name: 'purchase_completed',
            source: 'api',
            surface: 'stripe_webhook',
            metadata: {
              tier: tierId,
              billing: checkoutBillingPeriod(session),
              // What Stripe actually collected, so a promotion-code purchase
              // reports the real amount instead of list price. `value` (major
              // units) and `transaction_id` mirror the client-side event's
              // property names so the two copies of a purchase are joinable.
              amount_cents: amountCents,
              value: amountCents === null ? null : amountCents / 100,
              currency: session.currency || null,
              // Stripe does not guarantee delivery order: customer.subscription
              // .updated for THIS purchase can be processed first and, via
              // reconcileSubscriptionState's stripe_customer_id fallback, will
              // already have written the purchased tier onto the org. Buying
              // into the tier you are already on is impossible, so treat
              // priorTier === tierId as that race's signature and report the
              // true prior tier as unknown rather than fabricating 'free'.
              subscription_type: (priorTier === 'free' || priorTier === tierId) ? 'new' : 'upgrade',
              prior_tier: priorTier === tierId ? null : priorTier,
              mode: session.mode || null,
              transaction_id: session.id || null,
            },
          },
        };

        if (session.mode === 'payment') {
          affectedOrgId = await reconcileSubscriptionState(client, {
            orgId,
            customerId,
            planId: tierId,
            status: 'active',
            lifetimeActivatedAt: new Date(),
            clearPending: true,
            clearSubscription: true,
            clearBillingWindow: true,
            // A one-off purchase has no per-seat quantity to inherit.
            clearSeats: true,
          });
          // Lifetime is a paid customer but not recurring MRR.
          ledgerEvent = { org_id: affectedOrgId, event_type: 'created', plan_tier: tierId, mrr_cents: 0, stripe_event_id: event.id };
          break;
        }

        if (!subscriptionId) {
          throw new Error('Missing subscription identifier on checkout session');
        }

        // What the org records BEFORE this event writes anything: nothing (the
        // ordinary first purchase), this very subscription (the purchase reached
        // the org another way first, see below), or a different one. From the
        // row locked above, which is the row Stripe was read against.
        const recordedSubscriptionId = org?.stripe_subscription_id || null;

        // THE SUBSCRIPTION AS STRIPE HAS IT NOW, NOT AS THE SESSION REMEMBERS IT.
        //
        // Stripe retries this event for days when a delivery fails, and by the
        // time a retry lands the subscription may have moved. The buyer, shown a
        // plan page that still said Free, pressed "Upgrade to Team"; POST
        // /billing/checkout adopted the Pro they had just paid for and moved it
        // to Team in place (or customer.subscription.updated reached the org
        // first and they upgraded from there). The plan used to be written from
        // session.metadata.tierId regardless: the org went back to Pro while
        // Stripe billed Team, invites answered 403, and nothing corrected it
        // until the next subscription update, a month or a year away. Seats and
        // status were already read from the subscription; the plan now is too,
        // by the same price mapping every other case here uses. Read before the
        // transaction opened (readStripeFacts).
        const now = facts?.now;
        // A read Stripe refused for good never gets here: handleEvent answers
        // it before the transaction (REFUSED_READ_ALERT_AFTER_SECONDS). The
        // session alone must never grant a plan (the bug above).
        if (!now || now.unreadable) throw new Error(`internal: subscription ${subscriptionId} was not read from Stripe`);
        const sub = now.subscription;

        // SOMEBODY ELSE'S SUBSCRIPTION GRANTS NOTHING. The session and the
        // subscription it names must be the same Stripe customer's; if Stripe
        // files the subscription under another one, nothing about it is this
        // workspace's to apply — no plan, no ledger row, no purchase reported.
        if (sub && !belongsToCustomer(sub, customerId)) {
          console.warn(
            `[STRIPE] checkout for org ${orgId} names ${subscriptionId}, which Stripe files under `
            + `${customerIdOf(sub)}, not the session's ${customerId} — not applying it`
          );
          notCounted(`${subscriptionId} is filed under another customer, so no plan was granted`);
          affectedOrgId = orgId;
          break;
        }
        // A trial books ZERO MRR at creation: Stripe has collected a card and
        // $0, and the plan's gates read this ledger — counting a 14-day trial
        // as $30/mo the day it starts would let the Oct/Nov revenue gates pass
        // on money that may never arrive. The MRR lands when the trial's first
        // real invoice pays: Stripe bills the conversion with billing_reason
        // 'subscription_cycle', which the invoice.payment_succeeded case below
        // already records.
        const isTrial = sub?.status === 'trialing';
        // Attribution needs to see trials and conversions as different things —
        // a "purchase" that collected $0 is not a purchase yet.
        purchaseEvent.input.metadata.is_trial = isTrial;

        // A SUBSCRIPTION THAT IS OVER GRANTS NOTHING. Cancelled while this event
        // waited to be delivered, or gone from Stripe: the session's plan written
        // here sat beside Stripe's `canceled`, a spelling the entitlement check
        // does not read as inactive — paid access nobody is paying for, and no
        // later event for a dead subscription takes it back. The rule
        // customer.subscription.updated applies before adopting one; what the
        // org is left with is customer.subscription.deleted's to settle. No
        // ledger row either: a 'created' is folded as "paying from here on", and
        // nothing guarantees a churn row after it (an unpaid or vanished
        // subscription never sends one) — an under-count, never an invention.
        if (!sub || !LIVE_SUBSCRIPTION_STATUSES.has(sub.status)) {
          console.warn(
            `[STRIPE] checkout for org ${orgId} completed on ${subscriptionId}, which Stripe reports as `
            + `${sub?.status || 'gone'} — not granting ${tierId} from the session`
          );
          notCounted(`${subscriptionId} is ${sub?.status || 'gone from Stripe'}, so no plan was granted`);
          affectedOrgId = orgId;
          break;
        }

        // TWO LIVE SUBSCRIPTIONS: THE BETTER ONE KEEPS THE ORG. The org already
        // records a different subscription, and the person bought twice.
        // Delivery order does not decide which one the org is billed on; the
        // rule the rest of this file uses does (liveBestFirst: best plan, then
        // most recent), so a late Pro purchase cannot replace a live Team. The
        // one that loses is a secondary subscription, which this file keeps out
        // of the org row and the ledger everywhere else too.
        if (recordedSubscriptionId && recordedSubscriptionId !== subscriptionId) {
          const recorded = facts.recorded;
          if (recorded?.id !== recordedSubscriptionId) {
            throw new Error(`internal: subscription ${recordedSubscriptionId} was not read from Stripe`);
          }
          // (Unreadable for good never gets here: handleEvent answers it first,
          // and nothing is replaced.)
          const recordedWins = LIVE_SUBSCRIPTION_STATUSES.has(recorded.subscription?.status)
            && liveBestFirst([recorded.subscription, sub])[0].id !== sub.id;
          if (recordedWins) {
            console.warn(
              `[STRIPE] checkout for org ${orgId} completed on ${subscriptionId} while it is billed on `
              + `${recordedSubscriptionId}, which ranks higher — leaving its plan alone (two live subscriptions)`
            );
            notCounted(`the workspace stays on ${recordedSubscriptionId}, so ${subscriptionId} granted no plan (two live subscriptions)`);
            affectedOrgId = orgId;
            break;
          }
        }

        // THE PLAN IS WHAT STRIPE BILLS, BY THE SAME MAPPING EVERY HANDLER USES.
        // A price the map does not know used to keep the plan the session sold;
        // the owner's decision (2026-09-28) is that a new purchase at an
        // unrecognised price gets nothing until the price is mapped, and a
        // workspace that already has a paid plan keeps it (subscriptionState).
        // The subscription, its status and period are recorded all the same, so
        // the first event after the price is mapped writes the plan. The
        // operator is alerted after commit.
        const state = subscriptionState(sub);
        const planId = state.planId;
        const purchasedSeats = state.seats;
        if (state.unrecognisedPriceIds) {
          unrecognisedPrice = {
            orgId, customerId, subscriptionId, status: sub.status, priceIds: state.unrecognisedPriceIds,
            planKept: org?.plan_tier || null, source: event.type,
          };
        }
        affectedOrgId = await reconcileSubscriptionState(client, {
          orgId,
          customerId,
          subscriptionId,
          planId,
          status: sub.status,
          currentPeriodStart: state.currentPeriodStart,
          currentPeriodEnd: state.currentPeriodEnd,
          clearPending: true,
          // From the retrieved subscription rather than session.metadata.seats:
          // adjustable_quantity means the buyer may have changed the number on
          // the Stripe page after we wrote that metadata, and the subscription is
          // what they are actually being charged for.
          seats: purchasedSeats,
          trialStartedAt: state.trialStartedAt,
          billingRecord: state.billingRecord,
        });
        // No plan could be determined, so no purchase is booked: the ledger's
        // 'created' row says "paying for this plan from here on", and DeerDawn
        // does not know which plan that is. The first event after the price is
        // mapped books the plan as a change. Nor is a purchase counted: the
        // workspace received no plan.
        if (!planId) {
          notCounted(`${subscriptionId} is on a price the map does not know (${state.unrecognisedPriceIds.join(', ') || 'no line items'}), so no plan was granted`);
          break;
        }
        // THE LEDGER ROW IS THE PURCHASE: the plan the session sold, priced at
        // the subscription's seats while it is still on that plan, as it always
        // was. When the plan has moved since, those seats count the NEW plan, so
        // the row falls back to one seat's worth rather than inventing Pro x 2.
        //
        // WHEN it happened matters as much, because the ledger is folded in time
        // order and its last row is the org's MRR. If the org already records
        // this subscription, its own later history (a plan change, a seat
        // change) may already be in the ledger; a purchase row stamped at
        // delivery time would land after that and roll the MRR back to the
        // purchase. So it is placed at the purchase itself — event.created,
        // which Stripe keeps across redeliveries — and what happened since keeps
        // the final say. Otherwise nothing of this subscription can be in the
        // ledger yet, and the row is stamped on insert exactly as before.
        const purchasedAt = recordedSubscriptionId === subscriptionId && Number.isFinite(event.created)
          ? new Date(event.created * 1000)
          : null;
        ledgerEvent = {
          org_id: affectedOrgId,
          event_type: 'created',
          plan_tier: tierId,
          mrr_cents: isTrial ? 0 : planMrrCents(tierId, planId === tierId ? purchasedSeats : null),
          stripe_event_id: event.id,
          ...(purchasedAt ? { occurred_at: purchasedAt } : {}),
        };

        // The roll-over schedule follows the plan the subscription is on now:
        // one built from the session's plan would move a subscription that has
        // changed plan since back onto the price it was bought at.
        const plan = PLANS[planId];
        if (plan?.auto_roll_to) {
          const existingSchedule = sub.schedule ? await stripe.subscriptionSchedules.retrieve(sub.schedule) : null;
          if (!existingSchedule) {
            const rollToPlan = PLANS[plan.auto_roll_to];
            if (rollToPlan?.stripe_price_id) {
              const schedule = await stripe.subscriptionSchedules.create({
                from_subscription: subscriptionId,
              });
              await stripe.subscriptionSchedules.update(schedule.id, {
                end_behavior: 'release',
                phases: [
                  {
                    items: [{ price: plan.stripe_price_id, quantity: 1 }],
                    end_date: getPeriod(sub, 'current_period_end'),
                  },
                  {
                    items: [{ price: rollToPlan.stripe_price_id, quantity: 1 }],
                  },
                ],
              });
            }
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const payload = event.data.object;
        const customerId = customerIdOf(payload);
        // The org this subscription belongs to — by subscription id first, so a
        // customer carrying two subscriptions is answered about the right row —
        // locked above, and the row Stripe was read against. None: nothing here
        // is ours to write (no row has this subscription or its customer).
        const orgRow = org;
        if (!orgRow?.org_id) break;
        const now = facts?.now;

        // What gets written. Stripe's answer, always, except when the
        // subscription is gone from Stripe, which keeps exactly what this
        // handler did before the rule. (Refused for good never gets here:
        // handleEvent answers it before the transaction.)
        let sub;

        if (orgRow.stripe_subscription_id !== payload.id) {
          // SECONDARY SUBSCRIPTION. The org is billed on a DIFFERENT
          // subscription that is still live, so this event is about a second
          // one — a duplicate from the old double-billing path, or something
          // changed by hand in the Stripe dashboard. Writing its plan onto the
          // org would reprice a paying workspace with no user action behind it.
          // Previously this was "handled" only by the WHERE clause matching no
          // row, which also meant that once the recorded subscription DIED,
          // every later event for the live one was silently dropped and the org
          // could never recover.
          if (orgRow.stripe_subscription_id && facts?.recordedLive?.live) {
            console.warn(
              `[STRIPE] org ${orgRow.org_id} received an update for ${payload.id} while billed on `
              + `${orgRow.stripe_subscription_id} — leaving its plan alone (two live subscriptions)`
            );
            affectedOrgId = orgRow.org_id;
            break;
          }

          // ADOPTION IS DECIDED BY STRIPE, NOT BY THE EVENT. The org records no
          // live subscription (none at all after churn, or a dead one), so this
          // event is offering it a new one — and the offer may be stale: an
          // `active` update delivered after the deleted event for the same
          // subscription is exactly this shape. Adopt only a subscription Stripe
          // reports live NOW, filed under this org's own customer, with Stripe's
          // plan, status and seats. A dead, unreadable or foreign one leaves the
          // org as it is: refusing to adopt is recoverable (the next real event
          // re-links a live subscription); adopting a dead one grants paid
          // access that no later event will ever take back.
          const adoptable = now?.subscription
            && LIVE_SUBSCRIPTION_STATUSES.has(now.subscription.status)
            && belongsToCustomer(now.subscription, orgRow.stripe_customer_id);
          if (!adoptable) {
            const why = !now?.subscription
              ? 'gone'
              : (belongsToCustomer(now.subscription, orgRow.stripe_customer_id) ? now.subscription.status : `filed under ${customerIdOf(now.subscription)}`);
            console.warn(
              `[STRIPE] org ${orgRow.org_id} received an update for ${payload.id}, which Stripe reports as `
              + `${why} — not adopting it from the event payload`
            );
            affectedOrgId = orgRow.org_id;
            break;
          }
          sub = now.subscription;
          console.warn(
            orgRow.stripe_subscription_id
              ? `[STRIPE] org ${orgRow.org_id} was recorded against ${orgRow.stripe_subscription_id}, `
                + `which is no longer live — adopting ${sub.id}`
              : `[STRIPE] org ${orgRow.org_id} records no subscription — adopting live ${sub.id}`
          );
        } else if (!now) {
          throw new Error(`internal: subscription ${payload.id} was not read from Stripe`);
        } else if (now.subscription) {
          // THE RECORDED SUBSCRIPTION: whatever Stripe says it is now. Plan,
          // seats, status and period all come from the answer, whatever this
          // event remembers: an older update redelivered after an upgrade, a
          // seat change or a downgrade would otherwise put the workspace back on
          // what it left while Stripe bills what it moved to; an old `active`
          // after a past_due would unlock somebody Stripe is still chasing, an
          // old `past_due` after the card was fixed would lock out somebody who
          // has paid. Nothing corrected either until the next update, a month or
          // a year away.
          if (!belongsToCustomer(now.subscription, orgRow.stripe_customer_id)) {
            console.warn(
              `[STRIPE] org ${orgRow.org_id} records ${payload.id}, which Stripe files under `
              + `${customerIdOf(now.subscription)}, not ${orgRow.stripe_customer_id} — not applying it`
            );
            affectedOrgId = orgRow.org_id;
            break;
          }
          if (ENDED_SUBSCRIPTION_STATUSES.has(now.subscription.status)) {
            // Over: customer.subscription.deleted settles it (see above).
            console.warn(
              `[STRIPE] org ${orgRow.org_id}: ${payload.id} is ${now.subscription.status} in Stripe — `
              + 'leaving the workspace for customer.subscription.deleted to settle'
            );
            affectedOrgId = orgRow.org_id;
            break;
          }
          sub = now.subscription;
        } else if (!now.unreadable) {
          // GONE FROM STRIPE (the owner's decision, 2026-09-29: keep this
          // path). A payload claiming a different status than the row is not
          // written: customer.subscription.deleted settles a vanished
          // subscription. One that claims the same status is written as it
          // stands, as before.
          if (orgRow.subscription_status && payload.status !== orgRow.subscription_status) {
            affectedOrgId = orgRow.org_id;
            break;
          }
          sub = payload;
        } else {
          throw new Error(`internal: subscription ${payload.id} was not read from Stripe`);
        }

        // Read the prior state so a real upgrade/downgrade can be told from the
        // many other things that fire this event (period rollover,
        // payment-method change, status flips). What Stripe says changed, in
        // previous_attributes, wins over the row, which may already carry this
        // very change (see priorStateFromEvent) — but only when this event
        // describes the state being written. An older event's
        // previous_attributes describe a change that has since been overtaken;
        // then the row, which is what is being changed now, is the prior state.
        const eventIsCurrent = sub === payload
          || (mapPlanFromSubscription(payload) === mapPlanFromSubscription(sub)
            && getSeatsFromSubscription(payload) === getSeatsFromSubscription(sub));
        const priorFromEvent = eventIsCurrent ? priorStateFromEvent(event) : { planId: null, seats: null };
        const priorTier = priorFromEvent.planId || orgRow.plan_tier || null;
        const priorSeatsRaw = priorFromEvent.seats ?? orgRow.purchased_seats;
        const priorSeats = priorSeatsRaw === null || priorSeatsRaw === undefined ? null : Number(priorSeatsRaw);

        // The payload is what gets written only when the subscription is gone
        // from Stripe.
        const state = subscriptionState(sub, { fromEvent: sub === payload });
        // Null when the price is not in the map: the plan is left as it is,
        // and nothing below books a plan change or a seat change from it.
        const planId = state.planId;
        if (state.unrecognisedPriceIds) {
          unrecognisedPrice = {
            orgId: orgRow.org_id, customerId: customerIdOf(sub) || customerId, subscriptionId: sub.id, status: sub.status,
            priceIds: state.unrecognisedPriceIds, planKept: orgRow.plan_tier || null, source: event.type,
          };
        }
        affectedOrgId = await reconcileSubscriptionState(client, {
          // Scope the write to the org we resolved rather than to whichever row
          // the subscription/customer clause happens to reach: that is what lets
          // a live subscription be adopted when the recorded one has died.
          orgId: orgRow.org_id,
          customerId: customerIdOf(sub) || customerId,
          // This event fires on every seat change, so it is the one that keeps
          // the cap honest as a team grows and shrinks.
          ...state,
          clearPending: true,
        });
        const nextSeats = state.seats;
        if (affectedOrgId && planId && planId === priorTier && Number.isFinite(priorSeats)
          && Number.isFinite(nextSeats) && priorSeats !== nextSeats) {
          seatChange = {
            org_id: affectedOrgId,
            event_type: 'seats_changed',
            plan_tier: planId,
            prior_seats: priorSeats,
            seats: nextSeats,
            mrr_cents: sub.status === 'active' ? planMrrCents(planId, nextSeats) : 0,
          };
        }
        // A change to a paid tier re-prices MRR immediately (not a renewal, not
        // churn). But a downgrade to free/unknown is real churn — recording it as
        // plan_changed would leave the org "active" at $0, inflating active count
        // and hiding the churn. Route paid→free to a cancelled event instead.
        if (affectedOrgId && planId && priorTier && planId !== priorTier) {
          const downgradedToFree = planMrrCents(planId) <= 0;
          if (downgradedToFree && planMrrCents(priorTier) > 0) {
            ledgerEvent = {
              org_id: affectedOrgId,
              event_type: 'cancelled',
              plan_tier: 'free',
              mrr_cents: 0,
              stripe_event_id: event.id,
            };
          } else if (!downgradedToFree && sub.status === 'active') {
            ledgerEvent = {
              org_id: affectedOrgId,
              event_type: 'plan_changed',
              plan_tier: planId,
              mrr_cents: planMrrCents(planId, getSeatsFromSubscription(sub)),
              stripe_event_id: event.id,
            };
          } else if (!downgradedToFree && sub.status === 'trialing') {
            // A plan change while still trialing re-prices nothing — Stripe has
            // still collected $0 — so the ledger row moves the tier but not the
            // MRR, exactly like the trial's own 'created' row. The money books
            // when the conversion invoice pays.
            ledgerEvent = {
              org_id: affectedOrgId,
              event_type: 'plan_changed',
              plan_tier: planId,
              mrr_cents: 0,
              stripe_event_id: event.id,
            };
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = customerIdOf(sub);
        // Locked above; the row Stripe was read against.
        const orgRow = org;
        if (!orgRow?.org_id) break;

        // A SECONDARY subscription ending is not this org's churn. The plan it
        // is billed on has not changed, and writing 'free' here would take paid
        // access from a customer whose card is still being charged.
        if (orgRow.stripe_subscription_id && orgRow.stripe_subscription_id !== sub.id) {
          console.warn(
            `[STRIPE] subscription ${sub.id} ended for org ${orgRow.org_id}, which is billed on `
            + `${orgRow.stripe_subscription_id} — leaving its plan alone`
          );
          affectedOrgId = orgRow.org_id;
          break;
        }

        // The event says the subscription ended; Stripe is the one asked. A
        // subscription Stripe still reports live has nothing to settle (Stripe
        // does not revive an ended subscription, so this is a contradiction to
        // log, not a churn to book).
        if (facts?.now?.subscription && LIVE_SUBSCRIPTION_STATUSES.has(facts.now.subscription.status)) {
          console.warn(
            `[STRIPE] org ${orgRow.org_id}: deleted event for ${sub.id}, which Stripe reports as `
            + `${facts.now.subscription.status} — nothing to settle`
          );
          affectedOrgId = orgRow.org_id;
          break;
        }

        // The subscription we WERE billing on has ended. Before calling it
        // churn, ask whether the customer is still paying for something else —
        // the exact case the double-billing bug created, and the one where
        // dropping to free costs a paying customer their access. From the same
        // one read of the customer's subscriptions (readStripeFacts).
        const [survivor] = facts?.siblings || [];
        if (survivor) {
          // The same mapping as every other write: a survivor on a price the
          // map does not know leaves the plan as it is (and books no change).
          const { unrecognisedPriceIds, ...survivorState } = subscriptionState(survivor);
          const survivorPlan = survivorState.planId;
          const survivorSeats = survivorState.seats;
          console.warn(
            `[STRIPE] org ${orgRow.org_id} still has live subscription ${survivor.id} `
            + `(${survivorPlan || 'unrecognised price'}) after ${sub.id} ended — adopting it instead of downgrading to free`
          );
          affectedOrgId = await reconcileSubscriptionState(client, {
            orgId: orgRow.org_id,
            customerId,
            ...survivorState,
            clearPending: true,
          });
          if (unrecognisedPriceIds) {
            unrecognisedPrice = {
              orgId: orgRow.org_id, customerId, subscriptionId: survivor.id, status: survivor.status,
              priceIds: unrecognisedPriceIds, planKept: orgRow.plan_tier || null, source: event.type,
            };
          }
          // Not churn: the workspace moved onto the subscription it is still
          // paying for. Recording 'cancelled' here would show a cancellation
          // that never happened and zero out MRR that is still being collected.
          if (affectedOrgId && survivorPlan) {
            ledgerEvent = {
              org_id: affectedOrgId,
              event_type: 'plan_changed',
              plan_tier: survivorPlan,
              mrr_cents: survivor.status === 'active' ? planMrrCents(survivorPlan, survivorSeats) : 0,
              stripe_event_id: event.id,
            };
          }
          break;
        }

        affectedOrgId = await reconcileSubscriptionState(client, {
          orgId: orgRow.org_id,
          planId: 'free',
          status: 'cancelled',
          clearPending: true,
          // Forget the subscription that no longer exists. Leaving its id on a
          // churned org made every reader of that column act on a dead
          // subscription: a returning customer's checkout first tried to MOVE
          // it (and was sent to the portal instead of a checkout if Stripe
          // hiccuped on the lookup), account deletion went to Stripe to cancel
          // something already cancelled and refused to delete when Stripe's
          // answer was not one it recognised, and the portal's cancel deep-link
          // pointed at it. stripe_customer_id stays — that is what lets a
          // later checkout reuse the customer and re-link by customer id.
          clearSubscription: true,
          // Drop the purchased count on churn, or a cancelled org keeps a seat
          // cap it is no longer paying for. Nobody is removed from the workspace
          // — the cap only ever gates the next INVITE.
          clearSeats: true,
          // The trial that just ended without converting still counts.
          trialStartedAt: teamTrialStartOf(sub, mapPlanFromSubscription(sub)),
        });
        if (affectedOrgId) {
          ledgerEvent = { org_id: affectedOrgId, event_type: 'cancelled', plan_tier: 'free', mrr_cents: 0, stripe_event_id: event.id };
        }
        break;
      }

      // Recurring renewal: the one signal that proves a customer actually paid.
      // The first invoice of a NON-trial subscription (subscription_create) is
      // already captured as 'created' at checkout, so only subscription_cycle
      // invoices count here. For a TRIAL this case carries more weight: the
      // conversion invoice at day 14 is Stripe's first real charge and is billed
      // with billing_reason 'subscription_cycle', so the trial's first dollar —
      // and its MRR, which the 'created' row deliberately booked as zero —
      // lands through this handler.
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const paidSubscriptionId = invoiceSubscriptionId(invoice);
        const now = facts?.now;
        // A PAID INVOICE IS A SIGNAL. The subscription it bills is written as
        // Stripe has it now onto the workspace billed on it: a recovery whose
        // own update was lost unlocks here, and a renewal delivered after a
        // later failure does not unlock (Stripe says past_due). Not when the
        // subscription has ended (deleted settles that), and not onto a
        // workspace billed on another subscription. Gone, or no workspace
        // records it (then Stripe is not read): nothing is written, as before.
        // (Refused for good never gets here.)
        let synced = null;
        if (now?.subscription && paidSubscriptionId && org?.org_id && org.stripe_subscription_id === paidSubscriptionId) {
          if (!belongsToCustomer(now.subscription, org.stripe_customer_id)) {
            console.warn(
              `[STRIPE] org ${org.org_id} records ${paidSubscriptionId}, which Stripe files under `
              + `${customerIdOf(now.subscription)}, not ${org.stripe_customer_id} — not applying it`
            );
            affectedOrgId = org.org_id;
            break;
          }
          if (!ENDED_SUBSCRIPTION_STATUSES.has(now.subscription.status)) {
            synced = subscriptionState(now.subscription);
            affectedOrgId = await reconcileSubscriptionState(client, { orgId: org.org_id, ...synced });
            if (synced.unrecognisedPriceIds) {
              unrecognisedPrice = {
                orgId: org.org_id, customerId: org.stripe_customer_id || null, subscriptionId: paidSubscriptionId, status: now.subscription.status,
                priceIds: synced.unrecognisedPriceIds, planKept: org.plan_tier || null, source: event.type,
              };
              // No plan could be read from Stripe, so the renewal below is
              // priced at the plan the workspace kept, as for any renewal that
              // was not just synced.
              synced = null;
            }
          }
        }

        if (invoice.billing_reason !== 'subscription_cycle' || !invoice.customer) break;
        // No renewal is booked for a subscription Stripe reports as no longer
        // live: the ledger folds 'renewed' as "paying from here on", and a late
        // one after the churn row would resurrect a customer who has left.
        if (now?.subscription && !LIVE_SUBSCRIPTION_STATUSES.has(now.subscription.status)) break;
        const renewalLookup = await client.query(
          'SELECT org_id, plan_tier, purchased_seats FROM organizations WHERE stripe_customer_id = $1',
          [invoice.customer]
        );
        const renewalOrg = renewalLookup.rows[0];
        if (!renewalOrg?.org_id) break;
        affectedOrgId = renewalOrg.org_id;
        ledgerEvent = {
          org_id: renewalOrg.org_id,
          event_type: 'renewed',
          // Priced at what Stripe bills now when the subscription was just read
          // and written; otherwise at the row, which is what subscription.updated
          // last reconciled, so a per-seat renewal re-prices at the count
          // actually being billed.
          plan_tier: synced ? synced.planId : renewalOrg.plan_tier,
          mrr_cents: synced
            ? planMrrCents(synced.planId, synced.seats)
            : planMrrCents(renewalOrg.plan_tier, Number(renewalOrg.purchased_seats) || null),
          stripe_event_id: event.id,
          billing_reason: invoice.billing_reason,
        };
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const failedSubscriptionId = invoiceSubscriptionId(invoice);
        if (failedSubscriptionId) {
          const now = facts?.now;
          // Whether the charge that failed still stands: false once Stripe
          // reports the subscription paid up.
          let failureStands = true;
          if (now?.subscription) {
            // A FAILED CHARGE IS A SIGNAL; THE LOCK FOLLOWS STRIPE. This used to
            // write past_due unread. The failure event's first delivery failed,
            // the card was fixed, Stripe reported active and paid — and the
            // redelivery locked the workspace (every request 403
            // subscription_inactive) until whatever event came next, normally
            // the next renewal. Now the subscription is written as Stripe has it:
            // past_due locks, as it always did; active does not. Not when it
            // has ended: deleted settles that.
            const recordsIt = Boolean(org?.org_id && org.stripe_subscription_id === failedSubscriptionId);
            if (recordsIt && !belongsToCustomer(now.subscription, org.stripe_customer_id)) {
              console.warn(
                `[STRIPE] org ${org.org_id} records ${failedSubscriptionId}, which Stripe files under `
                + `${customerIdOf(now.subscription)}, not ${org.stripe_customer_id} — not applying it`
              );
              affectedOrgId = org.org_id;
              break;
            }
            failureStands = !PAID_UP_STATUSES.has(now.subscription.status);
            if (ENDED_SUBSCRIPTION_STATUSES.has(now.subscription.status)) {
              affectedOrgId = recordsIt ? org.org_id : null;
            } else {
              const state = subscriptionState(now.subscription);
              affectedOrgId = await reconcileSubscriptionState(client, {
                subscriptionId: failedSubscriptionId,
                ...state,
              });
              if (affectedOrgId && state.unrecognisedPriceIds) {
                unrecognisedPrice = {
                  orgId: affectedOrgId, customerId: customerIdOf(now.subscription), subscriptionId: failedSubscriptionId, status: now.subscription.status,
                  priceIds: state.unrecognisedPriceIds, planKept: recordsIt ? (org.plan_tier || null) : undefined, source: event.type,
                };
              }
            }
          } else {
            // Gone from Stripe (kept, by the owner's decision of 2026-09-29):
            // past_due, from the event; customer.subscription.deleted settles
            // a subscription that has gone. Also no workspace found for the
            // invoice (Stripe is not read): the write then matches no row, as
            // before. (Refused for good never gets here.)
            affectedOrgId = await reconcileSubscriptionState(client, {
              subscriptionId: failedSubscriptionId,
              status: 'past_due',
            });
          }
          // The at-risk row and the operator's alert say the charge failed and
          // the account is blocked; neither is sent for a charge Stripe says
          // has since been paid.
          if (affectedOrgId && failureStands) {
            // Drives the retention ledger's at-risk / past_due signal.
            ledgerEvent = { org_id: affectedOrgId, event_type: 'payment_failed', mrr_cents: 0, stripe_event_id: event.id };

            // A PAST-DUE NOBODY IS TOLD ABOUT IS CHURN WITH A DELAY. The status
            // flip above locks the account (enforcement blocks past_due), the
            // ledger records it — and until 2026-09-03 that was the whole flow:
            // the customer's briefs stopped working and the only way John could
            // learn why was to go query the table. With the Team trial live this
            // path now also carries every failed day-14 conversion charge, i.e.
            // exactly the moment a trial silently fails to become revenue.
            // Stripe retries the charge on its own schedule; each retry's
            // failure re-fires this event (a new event id, so the dedup guard
            // does not eat it) and each alert names the attempt.
            const orgInfo = await client.query(
              `SELECT o.plan_tier, o.purchased_seats,
                      (SELECT u.email FROM users u WHERE u.org_id = o.org_id ORDER BY u.created_at ASC LIMIT 1) AS email
                 FROM organizations o
                WHERE o.org_id = $1`,
              [affectedOrgId]
            );
            const alerted = orgInfo.rows[0] || {};
            const customerEmail = alerted.email || invoice.customer_email || null;
            alertEmail = buildPastDueAlert({
              orgId: affectedOrgId,
              customerEmail,
              planTier: alerted.plan_tier || null,
              seats: alerted.purchased_seats || null,
              amountDueCents: Number.isFinite(invoice.amount_due) ? invoice.amount_due : null,
              attempt: Number(invoice.attempt_count) || null,
              nextAttemptAt: Number.isFinite(invoice.next_payment_attempt)
                ? new Date(invoice.next_payment_attempt * 1000)
                : null,
              invoiceUrl: invoice.hosted_invoice_url || null,
            });
          }
        }
        break;
      }

      // A REFUND NEVER CHANGES ACCESS. THE SUBSCRIPTION'S STATE IN STRIPE ALONE
      // DECIDES. (The owner's decision, 2026-09-28.)
      //
      // This used to drop the workspace to Free, mark it cancelled and forget
      // its subscription id on ANY full refund, and never cancel anything in
      // Stripe. A charge is not a subscription: refunding the latest invoice
      // left the customer billed again next period with no access, and
      // refunding a DUPLICATE charge took paid access from somebody who was
      // still paying for it. To end somebody's access, the owner cancels their
      // subscription in Stripe; customer.subscription.deleted then settles the
      // workspace, from what Stripe says, like every other ending.
      //
      // So nothing about the plan, status, seats, period or subscription id is
      // written here. The only thing booked is what the revenue ledger booked
      // for a full refund before, unchanged: a 'refunded' row, after commit and
      // best-effort. Partial refunds book nothing, as before.
      //
      // Lifetime (a one-off payment, no subscription) is covered by the same
      // rule: it is no longer sold (plans.js: not public, not self-serve), and
      // this handler no longer writes lifetime_activated_at, whose column only
      // scripts/migrate-ltd.js used to create — a database without it answered
      // 500 to every full refund. The column is now added at boot as well.
      //
      // The one read is by stripe_customer_id, a column the boot migration
      // always adds, so a refund cannot fail on a column DeerDawn's own schema
      // lacks.
      case 'charge.refunded': {
        const charge = event.data.object;
        if (!charge.customer || charge.amount_refunded < charge.amount) break;

        const orgLookup = await client.query(
          'SELECT org_id FROM organizations WHERE stripe_customer_id = $1',
          [charge.customer]
        );
        const orgId = orgLookup.rows[0]?.org_id;
        if (!orgId) break;

        ledgerEvent = { org_id: orgId, event_type: 'refunded', plan_tier: 'free', mrr_cents: 0, stripe_event_id: event.id };
        break;
      }

      // See DISPUTES above. The lock is dispute_lock_ids, never is_locked.
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.closed': {
        const dispute = event.data.object;
        const customerId = disputeFacts?.customerId;
        if (!dispute?.id || !customerId) break;
        const status = disputeFacts.status;
        const lifts = DISPUTE_LIFTED_STATUSES.has(status);
        let result;
        if (lifts) {
          // Won, or a warning closed: this dispute no longer holds the lock.
          // Any other dispute on the workspace still does.
          result = await client.query(
            `UPDATE organizations
                SET dispute_lock_ids = array_remove(dispute_lock_ids, $2),
                    dispute_locked_at = CASE WHEN cardinality(array_remove(dispute_lock_ids, $2)) = 0 THEN NULL ELSE dispute_locked_at END
              WHERE stripe_customer_id = $1 AND $2 = ANY(dispute_lock_ids)
              RETURNING org_id`,
            [customerId, dispute.id]
          );
        } else if (event.type === 'charge.dispute.funds_withdrawn' || status === 'lost') {
          // Money is gone, or the dispute was lost: it holds the lock. A lost
          // one keeps it until DeerDawn lifts it by hand.
          result = await client.query(
            `UPDATE organizations
                SET dispute_lock_ids = CASE WHEN $2 = ANY(dispute_lock_ids) THEN dispute_lock_ids ELSE array_append(dispute_lock_ids, $2) END,
                    dispute_locked_at = COALESCE(dispute_locked_at, NOW())
              WHERE stripe_customer_id = $1
              RETURNING org_id`,
            [customerId, dispute.id]
          );
        } else {
          console.warn(`[STRIPE] dispute ${dispute.id} closed as ${status || 'unknown'}: the lock is left as it is`);
          break;
        }
        affectedOrgId = result.rows[0]?.org_id || null;
        extraInvalidate = result.rows.slice(1).map((r) => r.org_id);
        break;
      }

      default:
        break;
    }

    await markStripeEvent(client, event.id, 'processed');
    await client.query('COMMIT');
    await invalidateOrgCache(affectedOrgId);
    for (const other of extraInvalidate) await invalidateOrgCache(other);
    // Append to the retention ledger after commit so a ledger failure can never
    // roll back or 500 the webhook. Idempotent via UNIQUE(stripe_event_id, type).
    if (ledgerEvent?.org_id) {
      recordSubscriptionEvent(ledgerEvent).catch((e) =>
        console.warn('[BILLING] retention ledger record failed:', e.message));
    }
    // Server truth for the revenue funnel. The client-side purchase_completed in
    // UpgradeSuccessModal stays — Google Ads attribution needs the browser — but
    // it only fires if the buyer's browser makes it back to the dashboard, and
    // client-only revenue events have burned us before.
    //
    // Idempotency is the stripe_events guard at the top of this handler, not a
    // new mechanism: a re-delivered checkout.session.completed carries the same
    // Stripe event id, so it is rejected as a duplicate before the switch runs.
    // Emitting after COMMIT is what makes that hold — only a run that actually
    // persisted the plan flip marks the event processed — and it keeps an
    // analytics failure from rolling back or 500ing the webhook.
    // A workspace the LATE path created (checkout incomplete, then the update or the
    // invoice): who paid is its founder, and the purchase is counted here, once.
    if (workspaceCreated.late) {
      const { claim, sub, planId } = workspaceCreated.late;
      billingOwner.recordPurchaser(claim.orgId, claim.founderUserId).catch((e) =>
        console.warn('[BILLING] purchaser not recorded:', e.message));
      if (await claimPurchaseOnce(claim.subscriptionId)) {
        const interval = sub?.items?.data?.[0]?.price?.recurring?.interval;
        productEvents.recordProductEvent(
          { type: 'user', id: claim.founderUserId, org_id: claim.orgId },
          {
            event_name: 'purchase_completed',
            source: 'api',
            surface: 'stripe_webhook',
            metadata: {
              tier: planId,
              billing: interval === 'year' ? 'annual' : (interval === 'month' ? 'monthly' : null),
              amount_cents: null,
              value: null,
              currency: null,
              subscription_type: 'new',
              prior_tier: 'free',
              mode: 'subscription',
              transaction_id: claim.subscriptionId,
              is_trial: sub?.status === 'trialing',
            },
          },
        ).catch((e) => console.warn('[BILLING] purchase_completed event failed:', e.message));
      }
    }
    if (purchaseEvent) {
      const purchasedSubscription = event.data?.object?.mode === 'payment'
        ? null
        : (typeof event.data?.object?.subscription === 'string' ? event.data.object.subscription : event.data?.object?.subscription?.id);
      // Once per subscription: the late path may already have counted it.
      if (!(await purchaseAlreadyCounted(purchasedSubscription))) {
        productEvents.recordProductEvent(purchaseEvent.actor, purchaseEvent.input).catch((e) =>
          console.warn('[BILLING] purchase_completed event failed:', e.message));
      }
      // WHO PAID, when the workspace actually received a subscription: the person
      // the checkout was opened for (its metadata), if they are still an owner.
      // Only the person; the card is Stripe's (services/billingOwnerService.js).
      if (event.type === 'checkout.session.completed' && event.data?.object?.mode !== 'payment') {
        billingOwner.recordPurchaser(purchaseEvent.actor.org_id, event.data?.object?.metadata?.purchaserUserId).catch((e) =>
          console.warn('[BILLING] purchaser not recorded:', e.message));
      }
    }
    // Everything after the purchase: renewals, plan changes, cancellations,
    // failed payments, refunds and seat changes. Until now these reached only
    // the retention ledger table, so PostHog had purchase_completed and nothing
    // after it: churn and LTV could not be read against the funnel that bought
    // them. 'created' is skipped because purchase_completed already is that
    // event, with richer properties. Same after-commit, best-effort contract.
    const lifecycle = [];
    if (ledgerEvent?.org_id && ledgerEvent.event_type !== 'created') lifecycle.push(ledgerEvent);
    if (seatChange) lifecycle.push(seatChange);
    if (lifecycle.length) {
      emitSubscriptionLifecycle(lifecycle, event).catch((e) =>
        console.warn('[BILLING] subscription_lifecycle event failed:', e.message));
    }
    // After commit, same as the ledger: only a run that actually persisted the
    // past_due flip alerts, and a Resend outage cannot 500 the webhook (Stripe
    // would retry, and the stripe_events guard would then eat the retry — an
    // email failure must not cost the status flip).
    if (alertEmail) {
      sendEmail({ ...alertEmail, emailType: 'past_due_alert' }).catch((e) =>
        console.warn('[BILLING] past_due alert email failed:', e.message));
    }
    if (unrecognisedPrice) {
      alertUnrecognisedPrice(unrecognisedPrice).catch((e) =>
        console.warn('[BILLING] unrecognised price alert failed:', e.message));
    }
    // TELL THE OWNER (an overdue payment, seats below the headcount), from the
    // workspace row just committed. Only when this event read a subscription from
    // Stripe: what it wrote is Stripe's word, never the event's. No Stripe call,
    // and it never fails the webhook (billingNoticeService).
    if (affectedOrgId && facts?.now?.subscription) {
      billingNotices.afterSubscriptionWrite(affectedOrgId);
    }
    return { status: 200, body: { received: true } };
  } catch (err) {
    await client.query('ROLLBACK');
    return failWebhook(event, err);
  } finally {
    client.release();
  }
}

module.exports = router;
module.exports.adoptLiveSubscription = adoptLiveSubscription;
module.exports.alertUnrecognisedPrice = alertUnrecognisedPrice;
