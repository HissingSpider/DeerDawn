'use strict';

/**
 * TELLING THE OWNER (journey round 6, billing; the owner's decisions 2 and 4).
 *
 *  OVERDUE. DeerDawn itself emails the owner of a workspace when Stripe confirms
 *  a payment is overdue (the subscription reads past_due or unpaid: fix the card;
 *  or incomplete: the first payment never went through, check out again), once
 *  per overdue episode, with how to fix it. It used to alert DeerDawn's operator
 *  and nobody else, so the one person who could fix the card learned of it from
 *  a locked workspace.
 *
 *  SEATS BELOW HEADCOUNT. A Team workspace with more active members than paid
 *  seats (the count was reduced in Stripe's portal while people were in) is told
 *  to its owner, on the team page and the plan page (seatShortfall) and by one
 *  email per shortfall episode. NOBODY IS SUSPENDED: the cap only ever gates the
 *  next invite.
 *
 * WHERE THE FACTS COME FROM. Both read the workspace row AFTER the webhook has
 * committed it, and the row was written from the subscription Stripe returned to
 * that webhook's one read (routes/webhooks-stripe.js). This module makes no
 * Stripe call, holds no transaction, and never throws into the webhook: a notice
 * that fails is a warning in the log.
 *
 * ONCE PER EPISODE is a marker on the row (`overdue_notified_at`,
 * `seat_shortfall_notified_at`). It is claimed with a guarded UPDATE before the
 * send, so two events for one episode send once; it is given back when NO
 * recipient was reached, so the next event tries again; and it is cleared when
 * the episode ends (paid up, or the headcount fits), so the next episode is told.
 *
 * WHO IS TOLD. The billing owner when one is recorded and still an owner;
 * otherwise every active owner. Members and viewers are never emailed: they
 * cannot fix a card.
 */
const db = require('../config/db');
const env = require('../config/env');
const resendClient = require('./email/resendClient');
const workspace = require('./workspaceService');
const { PLANS, normalizePlanId } = require('../config/plans');

const q = (text, params) => db.query(text, params, 'org-system');

const OVERDUE_STATUSES = new Set(['past_due', 'unpaid', 'incomplete']);
// Statuses in which a workspace is a live paying customer: a seat shortfall on
// anything else is not the owner's to fix by seats.
const PAYING_STATUSES = new Set(['active', 'trialing', 'past_due']);
const MAX_RECIPIENTS = 10;

const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
));

function dashboardUrl() {
  return String(env.DASHBOARD_URL || process.env.DASHBOARD_URL || 'https://app.deerdawn.com').replace(/\/+$/, '');
}

const planPageUrl = (orgId) => `${dashboardUrl()}/settings/plan?${new URLSearchParams({ workspace: orgId }).toString()}`;

function isPerSeatPlan(tier) {
  const plan = PLANS[normalizePlanId(tier)];
  return plan?.account_type === 'organization' && plan?.limits?.included_seats !== 1;
}

/**
 * The seat shortfall of a workspace: `{ members, seats, over_by }`, or null when
 * the seats cover the people in it (or there is nothing to compare: not a
 * per-seat plan, no purchased count on record, not a paying workspace).
 * Active members only: a pending invite is not yet somebody in the workspace.
 */
function seatShortfall({ planTier, status, purchasedSeats, activeMembers }) {
  if (!isPerSeatPlan(planTier)) return null;
  if (status && !PAYING_STATUSES.has(status)) return null;
  const seats = Number(purchasedSeats);
  const members = Number(activeMembers);
  if (!Number.isFinite(seats) || seats <= 0 || !Number.isFinite(members)) return null;
  return members > seats ? { members, seats, over_by: members - seats } : null;
}

/** The seat shortfall of a workspace, read from its row and its roster. */
async function seatShortfallForOrg(orgId) {
  // Scoped to the workspace it describes, like every read of that row on the
  // plan and team pages.
  const res = await db.query('SELECT plan_tier, subscription_status, purchased_seats FROM organizations WHERE org_id = $1', [orgId], orgId);
  const row = res.rows[0];
  if (!row) return null;
  return seatShortfall({
    planTier: row.plan_tier,
    status: row.subscription_status,
    purchasedSeats: row.purchased_seats,
    activeMembers: await workspace.countActiveMembers(orgId),
  });
}

async function recipientsFor(orgId, billingOwnerId) {
  const owners = (await workspace.listMembers(orgId))
    .filter((m) => m.active && m.role === 'owner' && m.email);
  const payer = billingOwnerId ? owners.find((m) => m.user_id === billingOwnerId) : null;
  return (payer ? [payer] : owners).slice(0, MAX_RECIPIENTS).map((m) => m.email);
}

const shell = (body) => `<!doctype html><html><body style="margin:0;background:#ffffff;">
<div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#111827;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;">
${body}
</div></body></html>`;

const button = (href, label) => `<p style="margin:28px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;">${escapeHtml(label)}</a></p>`;

/** The email for an overdue payment. `retry` is { plan, seats } for incomplete. */
function buildOverdueEmail({ orgId, orgName, status, planTier, seats }) {
  const name = escapeHtml(orgName || 'your workspace');
  if (status === 'incomplete') {
    const query = new URLSearchParams({ plan: normalizePlanId(planTier) });
    if (Number(seats) > 0) query.set('seats', String(Math.floor(Number(seats))));
    const href = `${dashboardUrl()}/checkout?${query.toString()}`;
    return {
      subject: `The first payment for ${String(orgName || 'your workspace').slice(0, 80)} did not go through`,
      html: shell(
        `<p>Stripe reports that the first payment for <strong>${name}</strong> did not go through, so nothing has been collected and the workspace is locked.</p>`
        + '<p>Check out again for the same plan to finish setting it up.</p>'
        + button(href, 'Check out again')
        + '<p style="color:#6b7280;font-size:13px;">Only a workspace owner can do this. You are receiving this because you are an owner of the workspace.</p>'
      ),
    };
  }
  const what = status === 'unpaid'
    ? 'Stripe has stopped retrying a payment that failed, and the subscription is unpaid'
    : 'A payment failed, and Stripe is retrying it';
  return {
    subject: `A payment for ${String(orgName || 'your workspace').slice(0, 80)} is overdue`,
    html: shell(
      `<p>${what}: the subscription for <strong>${name}</strong> is overdue, and the workspace is locked until a payment goes through.</p>`
      + '<p>Open the plan page and choose Update payment method. It opens Stripe\'s billing portal, where you can change the card or pay the open invoice.</p>'
      + button(planPageUrl(orgId), 'Update payment method')
      + '<p style="color:#6b7280;font-size:13px;">You are receiving this because you are an owner of the workspace. It is sent once for each overdue payment.</p>'
    ),
  };
}

function buildSeatShortfallEmail({ orgId, orgName, members, seats }) {
  const name = escapeHtml(orgName || 'your workspace');
  const people = `${members} ${members === 1 ? 'person' : 'people'}`;
  const paid = `${seats} ${seats === 1 ? 'seat' : 'seats'}`;
  return {
    subject: `${String(orgName || 'Your workspace').slice(0, 80)} has more people than paid seats`,
    html: shell(
      `<p><strong>${name}</strong> has ${people} in it and ${paid} on the subscription.</p>`
      + '<p>Nobody has been removed or locked out. You can add seats on the plan page, or remove people from the team page. Until the seats cover everyone, nobody new can be invited.</p>'
      + button(planPageUrl(orgId), 'Open the plan page')
      + '<p style="color:#6b7280;font-size:13px;">You are receiving this because you are an owner of the workspace. It is sent once each time the seats fall below the headcount.</p>'
    ),
  };
}

/** Send `message` to each recipient; true when at least one was reached. */
async function sendToAll(recipients, message, emailType) {
  let reached = 0;
  for (const to of recipients) {
    let result;
    try {
      result = await resendClient.sendEmail({ to, subject: message.subject, html: message.html, emailType });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result?.ok === true) reached += 1;
    else console.warn(`[BILLING] ${emailType} to an owner was not sent (${result?.skipped ? `skipped: ${result.reason || 'unknown'}` : (result?.error || result?.status || 'unknown')})`);
  }
  return reached > 0;
}

async function noticeOverdue(row) {
  if (!row.stripe_subscription_id || !OVERDUE_STATUSES.has(row.subscription_status)) {
    // Not overdue: the episode, if there was one, is over.
    if (row.overdue_notified_at) {
      await q(
        'UPDATE organizations SET overdue_notified_at = NULL WHERE org_id = $1 AND overdue_notified_at IS NOT NULL',
        [row.org_id]
      );
    }
    return;
  }
  if (row.overdue_notified_at) return;
  // Claimed before the send, and only while the status is still the one read.
  const claim = await q(
    `UPDATE organizations SET overdue_notified_at = NOW()
      WHERE org_id = $1 AND overdue_notified_at IS NULL AND subscription_status = $2
      RETURNING org_id`,
    [row.org_id, row.subscription_status]
  );
  if (!claim.rows[0]) return;
  const recipients = await recipientsFor(row.org_id, row.billing_owner_user_id);
  const sent = recipients.length > 0 && await sendToAll(recipients, buildOverdueEmail({
    orgId: row.org_id,
    orgName: row.name,
    status: row.subscription_status,
    planTier: row.plan_tier,
    seats: row.purchased_seats,
  }), 'payment_overdue');
  // Nobody reached: give the claim back so the next event tries again.
  if (!sent) await q('UPDATE organizations SET overdue_notified_at = NULL WHERE org_id = $1', [row.org_id]);
}

async function noticeSeatShortfall(row) {
  const shortfall = seatShortfall({
    planTier: row.plan_tier,
    status: row.subscription_status,
    purchasedSeats: row.purchased_seats,
    activeMembers: await workspace.countActiveMembers(row.org_id),
  });
  if (!shortfall) {
    if (row.seat_shortfall_notified_at) {
      await q(
        'UPDATE organizations SET seat_shortfall_notified_at = NULL WHERE org_id = $1 AND seat_shortfall_notified_at IS NOT NULL',
        [row.org_id]
      );
    }
    return;
  }
  if (row.seat_shortfall_notified_at) return;
  const claim = await q(
    `UPDATE organizations SET seat_shortfall_notified_at = NOW()
      WHERE org_id = $1 AND seat_shortfall_notified_at IS NULL RETURNING org_id`,
    [row.org_id]
  );
  if (!claim.rows[0]) return;
  const recipients = await recipientsFor(row.org_id, row.billing_owner_user_id);
  const sent = recipients.length > 0 && await sendToAll(recipients, buildSeatShortfallEmail({
    orgId: row.org_id,
    orgName: row.name,
    members: shortfall.members,
    seats: shortfall.seats,
  }), 'seats_below_headcount');
  if (!sent) await q('UPDATE organizations SET seat_shortfall_notified_at = NULL WHERE org_id = $1', [row.org_id]);
}

/**
 * Called by the Stripe webhook AFTER it commits a subscription write, for the
 * workspace the write reached. Reads the row (which is Stripe's answer) and tells
 * the owner what needs telling. Never throws.
 */
async function afterSubscriptionWrite(orgId) {
  if (!orgId) return;
  try {
    const res = await q(
      `SELECT org_id, name, plan_tier, subscription_status, purchased_seats, stripe_subscription_id,
              billing_owner_user_id, overdue_notified_at, seat_shortfall_notified_at
         FROM organizations WHERE org_id = $1`,
      [orgId]
    );
    const row = res.rows[0];
    if (!row) return;
    await noticeOverdue(row).catch((err) => console.warn(`[BILLING] overdue notice for ${orgId} failed: ${err.message}`));
    await noticeSeatShortfall(row).catch((err) => console.warn(`[BILLING] seat shortfall notice for ${orgId} failed: ${err.message}`));
  } catch (err) {
    console.warn(`[BILLING] notices for ${orgId} failed: ${err.message}`);
  }
}

/** A member left or was removed: if the headcount now fits, the shortfall
 *  episode is over and the marker goes. Never throws. */
async function clearSeatShortfallIfResolved(orgId) {
  try {
    if (!(await seatShortfallForOrg(orgId))) {
      await q(
        'UPDATE organizations SET seat_shortfall_notified_at = NULL WHERE org_id = $1 AND seat_shortfall_notified_at IS NOT NULL',
        [orgId]
      );
    }
  } catch (err) {
    console.warn(`[BILLING] seat shortfall marker for ${orgId} not cleared: ${err.message}`);
  }
}

module.exports = {
  afterSubscriptionWrite,
  clearSeatShortfallIfResolved,
  seatShortfall,
  seatShortfallForOrg,
  buildOverdueEmail,
  buildSeatShortfallEmail,
};
