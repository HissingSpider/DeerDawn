'use strict';

/**
 * WHO PAYS, AND WHEN THEY MAY STOP (journey round 6, billing; the design is
 * docs/audits/journey-r3-billing-takeover-design.md and the owner's decision of
 * 2026-09-28: "block until billing moves").
 *
 * The person who pays may not leave, step down from their owner seat, be removed
 * or delete their account while a live subscription renews on their card, until a
 * remaining owner has taken over billing. They may always free themselves by
 * setting the subscription to cancel at the end of the paid period.
 *
 * DeerDawn cannot see whose card it is. It records ONE thing about who pays:
 * `organizations.billing_owner_user_id`, and reads everything else back from
 * Stripe when it matters.
 *
 *  THE BILLING OWNER IS UNKNOWN unless recorded. Unknown refuses nobody: leave,
 *  removal and deletion behave exactly as they did before this existed. That is
 *  the only reading that can never trap somebody who is not the payer. Two ways
 *  it becomes known: an owner takes over billing (below), or, when an OWNER is
 *  about to leave a workspace with a Stripe customer whose billing owner is not
 *  recorded, the customer's email is compared with the workspace's current
 *  owners and recorded when it matches exactly one. The customer is created with
 *  the email of whoever pressed Upgrade, so that is the one trace of the payer
 *  DeerDawn has; it is a heuristic and only ever consulted about an owner.
 *
 *  TAKEOVER. An owner presses "Take over billing": the payment methods that are
 *  paying now (each renewing subscription's, else the customer's default) are
 *  stored with that owner and the time, and Stripe's portal opens on the
 *  payment-method flow. A later read-back that finds EVERY renewing subscription
 *  charging a payment method that is non-empty and was not among those stored
 *  makes that owner the billing owner, compare-and-swap on the takeover it
 *  confirms and only if they are still an owner. It proves the card that was
 *  paying stopped paying after they opened the portal; it does not prove the new
 *  card is theirs, which is the property the payer needs.
 *
 *  Nothing here is decided from an event payload, and no database connection is
 *  held while Stripe is read: rows are read, the connection is released, Stripe
 *  is asked, then one guarded UPDATE runs.
 *
 * A Stripe that cannot be read (or a customer with more subscriptions than one
 * page holds, so none can be vouched for) is BillingOwnerUnconfirmed: the routes
 * answer 503 `billing_owner_unconfirmed`, nothing is written, and the caller
 * retries.
 */
const db = require('../config/db');
const stripeService = require('./stripeService');
const workspace = require('./workspaceService');
const { billingRecordOf, recordColumns } = require('./billingRecord');

const q = (text, params) => db.query(text, params, 'org-system');

// A subscription somebody is charged for, or Stripe is still trying to charge.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

class BillingOwnerUnconfirmed extends Error {
  constructor(reason) {
    super(`Stripe could not confirm what this workspace is billed: ${reason}`);
    this.name = 'BillingOwnerUnconfirmed';
    this.code = 'billing_owner_unconfirmed';
  }
}

class BillingOwnerError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'BillingOwnerError';
    this.code = code;
    this.status = status;
  }
}

const idOf = (value) => (typeof value === 'string' ? value : value?.id || null);

function stripeClient() {
  const client = stripeService.stripe;
  if (!client) throw new BillingOwnerUnconfirmed('Stripe is not configured');
  return client;
}

// ── what Stripe says about a subscription ───────────────────────────────────

function periodEndOf(subscription) {
  const v = subscription?.items?.data?.[0]?.current_period_end ?? subscription?.current_period_end;
  return Number.isFinite(v) ? v : null;
}

/** Stripe reports it ending without another charge: cancel_at_period_end, or a
 *  cancel_at no later than the current period's end. */
function isEnding(subscription) {
  if (subscription?.cancel_at_period_end === true) return true;
  const at = Number(subscription?.cancel_at);
  if (Number.isFinite(at) && at > 0) {
    const end = periodEndOf(subscription);
    return end !== null && at <= end;
  }
  return false;
}

/** Live, and not ending: another charge is coming. */
function isRenewing(subscription) {
  return LIVE_STATUSES.has(subscription?.status) && !isEnding(subscription);
}

/** The payment method the subscription will charge next: its own default, else
 *  the customer's invoice default, else the customer's default source. */
function effectivePaymentMethod(subscription, customer) {
  return idOf(subscription?.default_payment_method)
    || idOf(customer?.invoice_settings?.default_payment_method)
    || idOf(customer?.default_source)
    || null;
}

async function readSubscriptions(customerId) {
  const client = stripeClient();
  let list;
  try {
    list = await client.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  } catch (err) {
    // A customer deleted in Stripe took its subscriptions with it.
    if (err?.code === 'resource_missing') return [];
    throw new BillingOwnerUnconfirmed(err?.message || 'the subscriptions could not be listed');
  }
  // More than a page means some were not seen, so none can be vouched for.
  if (list?.has_more) throw new BillingOwnerUnconfirmed('the customer has more subscriptions than can be listed');
  return Array.isArray(list?.data) ? list.data : [];
}

async function readCustomer(customerId) {
  const client = stripeClient();
  try {
    const customer = await client.customers.retrieve(customerId);
    return customer && !customer.deleted ? customer : null;
  } catch (err) {
    if (err?.code === 'resource_missing') return null;
    throw new BillingOwnerUnconfirmed(err?.message || 'the customer could not be read');
  }
}

// ── the workspace row ───────────────────────────────────────────────────────

async function loadOrg(orgId) {
  const res = await q(
    `SELECT org_id, name, stripe_customer_id, stripe_subscription_id, billing_owner_user_id, billing_takeover
       FROM organizations WHERE org_id = $1`,
    [orgId]
  );
  return res.rows[0] || null;
}

/** Record `userId` as billing owner only where nobody is recorded (the email
 *  match), returning whoever is recorded afterwards. */
async function recordBillingOwnerIfUnknown(orgId, userId) {
  const res = await q(
    `UPDATE organizations SET billing_owner_user_id = $2
      WHERE org_id = $1 AND billing_owner_user_id IS NULL
      RETURNING billing_owner_user_id`,
    [orgId, userId]
  );
  if (res.rows[0]) return res.rows[0].billing_owner_user_id;
  const now = await q('SELECT billing_owner_user_id FROM organizations WHERE org_id = $1', [orgId]);
  return now.rows[0]?.billing_owner_user_id || null;
}

/**
 * The payer of a workspace whose billing owner is not recorded, by the Stripe
 * customer's email: the workspace's CURRENT owner whose email is exactly the
 * customer's (case aside), when there is exactly one. Null otherwise.
 */
async function matchPayerByCustomerEmail(org) {
  const customer = await readCustomer(org.stripe_customer_id);
  const email = String(customer?.email || '').trim().toLowerCase();
  if (!email) return null;
  const owners = (await workspace.listMembers(org.org_id))
    .filter((m) => m.active && m.role === 'owner' && String(m.email || '').trim().toLowerCase() === email);
  if (owners.length !== 1) return null;
  return recordBillingOwnerIfUnknown(org.org_id, owners[0].user_id);
}

// ── the gate ────────────────────────────────────────────────────────────────

/**
 * May `person` stop being part of this workspace (leave, step down, be removed,
 * or delete their account)?
 *
 * `isOwner` is whether they hold the owner role now; it only matters when the
 * billing owner is not recorded, where the email match is tried for owners alone.
 *
 * @returns {Promise<{ blocked: false } | { blocked: true, workspace: {id, name}, subscriptions: string[] }>}
 * @throws BillingOwnerUnconfirmed
 */
async function checkPayerCanLeave(orgId, person, { isOwner = false } = {}) {
  if (!orgId || !person) return { blocked: false };
  const org = await loadOrg(orgId);
  if (!org?.stripe_customer_id) return { blocked: false };

  let payer = org.billing_owner_user_id || null;
  if (!payer && isOwner) payer = await matchPayerByCustomerEmail(org);
  if (payer !== person) return { blocked: false };

  const subscriptions = await readSubscriptions(org.stripe_customer_id);
  const renewing = subscriptions.filter(isRenewing);
  if (!renewing.length) return { blocked: false };

  // A takeover somebody started may already have happened in the portal: ask
  // now, so the payer is not held behind a button nobody pressed.
  if (org.billing_takeover?.user_id && org.billing_takeover.user_id !== person) {
    const customer = await readCustomer(org.stripe_customer_id);
    const outcome = await confirmFromRead(org, subscriptions, customer);
    if (outcome.status === 'confirmed') return { blocked: false, taken_over_by: org.billing_takeover.user_id };
  }
  return {
    blocked: true,
    workspace: { id: org.org_id, name: org.name || null },
    subscriptions: renewing.map((s) => s.id),
  };
}

/** The workspaces (other than `exclude`) whose subscription `person` may be
 *  paying for: they are the recorded billing owner, or an owner of a workspace
 *  with a customer and no recorded billing owner. */
async function listPayerCandidates(person, { exclude = [] } = {}) {
  if (!person) return [];
  const res = await q(
    `SELECT DISTINCT o.org_id AS id, o.name, (m.role IN ('owner', 'admin')) AS is_owner
       FROM workspace_members m
       JOIN organizations o ON o.org_id = m.owner_key
      WHERE m.user_id = $1 AND m.removed_at IS NULL
        AND o.stripe_customer_id IS NOT NULL
        AND NOT (o.org_id = ANY($2::text[]))
        AND (o.billing_owner_user_id = $1
             OR (o.billing_owner_user_id IS NULL AND m.role IN ('owner', 'admin')))
      ORDER BY o.name NULLS LAST, o.org_id`,
    [person, [...new Set((exclude || []).filter(Boolean))]]
  );
  return res.rows.map((row) => ({ id: row.id, name: row.name || null, isOwner: row.is_owner === true }));
}

/** The first workspace of `candidates` whose subscription holds `person`, or null. */
async function findBlockingWorkspace(person, candidates) {
  for (const candidate of candidates) {
    const check = await checkPayerCanLeave(candidate.id, person, { isOwner: candidate.isOwner });
    if (check.blocked) return check;
  }
  return null;
}

// ── takeover ────────────────────────────────────────────────────────────────

/**
 * Judge a takeover against a Stripe read already in hand.
 * Answers { status: 'none' | 'nothing_renews' | 'pending' | 'confirmed' | 'not_applied' }.
 */
async function confirmFromRead(org, subscriptions, customer) {
  const takeover = org?.billing_takeover;
  if (!takeover?.user_id || !takeover.started_at) return { status: 'none' };
  const renewing = subscriptions.filter(isRenewing);
  if (!renewing.length) return { status: 'nothing_renews' };

  const before = new Set(Array.isArray(takeover.payment_methods) ? takeover.payment_methods : []);
  const stillOld = renewing
    .filter((sub) => {
      const pm = effectivePaymentMethod(sub, customer);
      return !pm || before.has(pm);
    })
    .map((sub) => sub.id);
  if (stillOld.length) return { status: 'pending', still_on_old_payment_method: stillOld };

  // Compare-and-swap on THIS takeover, and only if its owner still is one.
  const res = await q(
    `UPDATE organizations o
        SET billing_owner_user_id = $2, billing_takeover = NULL
      WHERE o.org_id = $1
        AND o.billing_takeover->>'user_id' = $2
        AND o.billing_takeover->>'started_at' = $3
        AND EXISTS (SELECT 1 FROM workspace_members m
                     WHERE m.owner_key = o.org_id AND m.user_id = $2
                       AND m.removed_at IS NULL AND m.role IN ('owner', 'admin'))
      RETURNING o.org_id`,
    [org.org_id, takeover.user_id, String(takeover.started_at)]
  );
  return res.rows[0] ? { status: 'confirmed', billing_owner: takeover.user_id } : { status: 'not_applied' };
}

/**
 * An owner starts taking over billing. Stores the payment methods paying now,
 * with them and the time. The caller then opens the portal on the payment-method
 * flow.
 */
async function startTakeover(orgId, person) {
  const org = await loadOrg(orgId);
  if (!org?.stripe_customer_id) throw new BillingOwnerError('no_billing_account', 400, 'This workspace has no billing account to take over.');
  if (org.billing_owner_user_id === person) {
    throw new BillingOwnerError('already_billing_owner', 409, 'You are already the billing owner of this workspace.');
  }
  const subscriptions = await readSubscriptions(org.stripe_customer_id);
  const customer = await readCustomer(org.stripe_customer_id);
  const renewing = subscriptions.filter(isRenewing);
  if (!renewing.length) {
    throw new BillingOwnerError('nothing_renews', 409, 'No subscription on this workspace renews, so there is no billing to take over.');
  }
  const methods = new Set();
  for (const sub of renewing) {
    const pm = effectivePaymentMethod(sub, customer);
    if (pm) methods.add(pm);
  }
  for (const pm of [idOf(customer?.invoice_settings?.default_payment_method), idOf(customer?.default_source)]) {
    if (pm) methods.add(pm);
  }
  const takeover = { user_id: person, started_at: new Date().toISOString(), payment_methods: [...methods] };
  await q('UPDATE organizations SET billing_takeover = $2::jsonb WHERE org_id = $1', [orgId, JSON.stringify(takeover)]);
  return takeover;
}

/** Read back and confirm the takeover on record, whoever started it. */
async function confirmTakeover(orgId) {
  const org = await loadOrg(orgId);
  if (!org?.stripe_customer_id) throw new BillingOwnerError('no_billing_account', 400, 'This workspace has no billing account.');
  if (!org.billing_takeover?.user_id) return { status: 'none' };
  const subscriptions = await readSubscriptions(org.stripe_customer_id);
  const customer = await readCustomer(org.stripe_customer_id);
  return confirmFromRead(org, subscriptions, customer);
}

/**
 * A checkout completed for this workspace: the person it was opened for is now
 * the billing owner, if they are still an active owner. The purchase is the one
 * moment the payer is known (the checkout's metadata carries the person who
 * pressed the button; the card is Stripe's). A later purchase by another owner
 * replaces them, and ends a takeover that was waiting. Returns whether it wrote.
 */
async function recordPurchaser(orgId, personId) {
  if (!orgId || typeof personId !== 'string' || !personId) return false;
  const res = await q(
    `UPDATE organizations o
        SET billing_owner_user_id = $2, billing_takeover = NULL
      WHERE o.org_id = $1
        AND EXISTS (SELECT 1 FROM workspace_members m
                     WHERE m.owner_key = o.org_id AND m.user_id = $2
                       AND m.removed_at IS NULL AND m.role IN ('owner', 'admin'))
      RETURNING o.org_id`,
    [orgId, personId]
  );
  return Boolean(res.rows[0]);
}

// ── the payer's own way out ─────────────────────────────────────────────────

/**
 * Set every renewing subscription of the workspace to cancel at the end of its
 * paid period. Subscriptions already ending are left alone. The pending
 * cancellation is written to the row at once from what Stripe returned, so the
 * plan page does not wait for the webhook; the webhook writes the same thing.
 */
async function cancelAtPeriodEnd(orgId) {
  const org = await loadOrg(orgId);
  if (!org?.stripe_customer_id) throw new BillingOwnerError('no_billing_account', 400, 'This workspace has no billing account.');
  const client = stripeClient();
  const subscriptions = await readSubscriptions(org.stripe_customer_id);
  const cancelled = [];
  const ending = subscriptions.filter((s) => LIVE_STATUSES.has(s?.status) && isEnding(s));
  for (const sub of subscriptions.filter(isRenewing)) {
    const updated = await client.subscriptions.update(sub.id, { cancel_at_period_end: true });
    cancelled.push(updated || { ...sub, cancel_at_period_end: true });
    if (org.stripe_subscription_id === sub.id) await writeRecord(orgId, sub.id, billingRecordOf(updated || { ...sub, cancel_at_period_end: true }));
  }
  const endsAt = [...ending, ...cancelled]
    .map((s) => (Number(s.cancel_at) > 0 ? Number(s.cancel_at) : periodEndOf(s)))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    cancelled: cancelled.map((s) => s.id),
    already_ending: ending.map((s) => s.id),
    ends_on: endsAt.length ? new Date(Math.max(...endsAt) * 1000).toISOString() : null,
  };
}

async function writeRecord(orgId, subscriptionId, record) {
  const columns = recordColumns(record);
  const names = Object.keys(columns);
  if (!names.length) return;
  const sets = names.map((name, i) => `${name} = $${i + 3}`).join(', ');
  await q(
    `UPDATE organizations SET ${sets} WHERE org_id = $1 AND stripe_subscription_id = $2`,
    [orgId, subscriptionId, ...names.map((name) => columns[name])]
  );
}

// ── the refusals, worded once ───────────────────────────────────────────────

const WAYS_OUT = 'Another owner can take over billing (Settings > Plan > Take over billing), '
  + 'or the subscription can be set to end at the close of the paid period.';

/**
 * The 409 body for a payer stopped by the gate. `kind` is what was attempted:
 * 'leave', 'step_down', 'remove' (the refusal is addressed to the owner removing
 * them) or 'delete_account'.
 */
function refusalBody(kind, block) {
  const name = block.workspace?.name || 'this workspace';
  const messages = {
    leave: `You pay for ${name}'s subscription, and it renews on your card. ${WAYS_OUT} Then you can leave.`,
    step_down: `You pay for ${name}'s subscription, and it renews on your card, so you cannot step down yet. ${WAYS_OUT}`,
    remove: `This person pays for ${name}'s subscription, and it renews on their card, so they cannot be removed yet. ${WAYS_OUT} Then you can remove them.`,
    delete_account: `You pay for the subscription of ${name}, which stays open after your account is deleted, and it renews on your card. ${WAYS_OUT} Nothing was deleted.`,
  };
  return {
    error: 'billing_owner',
    message: messages[kind] || messages.leave,
    workspace: block.workspace?.id || null,
    workspace_name: block.workspace?.name || null,
    ways_out: ['take_over_billing', 'cancel_at_period_end'],
  };
}

/** Answer a gate refusal. */
function sendRefusal(res, kind, block) {
  return res.status(409).json(refusalBody(kind, block));
}

/** Answer a gate that could not confirm with Stripe. */
function sendUnconfirmed(res) {
  return res.status(503).json({
    error: 'billing_owner_unconfirmed',
    message: 'Stripe could not confirm whether a subscription renews on this account, so nothing was changed. Try again in a moment.',
    retryable: true,
  });
}

module.exports = {
  BillingOwnerUnconfirmed,
  BillingOwnerError,
  checkPayerCanLeave,
  listPayerCandidates,
  findBlockingWorkspace,
  startTakeover,
  confirmTakeover,
  confirmFromRead,
  recordPurchaser,
  cancelAtPeriodEnd,
  refusalBody,
  sendRefusal,
  sendUnconfirmed,
  // For the tests and the plan page's own reads.
  isRenewing,
  isEnding,
  effectivePaymentMethod,
};
