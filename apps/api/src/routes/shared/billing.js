const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { requireBillingEnabled } = require('../../config/selfHosted');
const { createCheckoutSession, createPortalSession, changeSubscriptionPlan, cancelIncompleteSubscription } = require('../../services/stripeService');
// The webhook's own reconcile, so a subscription this route discovers is
// recorded exactly as the webhook would have recorded it.
const { adoptLiveSubscription, alertUnrecognisedPrice } = require('../webhooks-stripe');
const { invalidateOrgCache } = require('../../services/enforcementService');
const workspace = require('../../services/workspaceService');
const billingOwnerService = require('../../services/billingOwnerService');
const { BillingOwnerUnconfirmed, BillingOwnerError } = billingOwnerService;
const {
    PLANS,
    getPlanOrder,
    normalizePlanId,
    getPublicBillingPlans,
    isSelfServePlan,
} = require('../../config/plans');

// Self-hosted: every billing route answers 404 billing_disabled, before auth,
// so no Stripe call is ever attempted and the dashboard can tell why.
router.use(requireBillingEnabled);
router.use(requireAuth);

/**
 * The workspace a billing action applies to: the BOUND one, not the org the
 * caller signed up under.
 *
 * Every route here read req.actor.org_id, which is always the personal org. A
 * workspace made by the new-team wizard could therefore never be upgraded — the
 * checkout silently bought Team for the founder's personal account instead — and
 * an invited teammate's usage summary described their own empty org.
 */
function billingWorkspace(req) {
    if (!req.actor?.workspace_key && !req.actor?.org_id) return null;
    return workspace.defaultOwnerKey(req.actor);
}

/**
 * Spending money on a workspace, or changing its plan, is an owner's power.
 * Resolved from workspace membership, not users.role, which is 'owner'/'admin'
 * for every self-signup and so separates nobody from anybody on a team.
 * Returns the workspace key, or null after sending the refusal.
 */
async function requireBillingOwner(req, res) {
    const orgId = billingWorkspace(req);
    if (!orgId) {
        res.status(403).json({ error: 'forbidden' });
        return null;
    }
    const role = await workspace.resolveRole(req.actor, orgId);
    if (!workspace.canAdminister(role)) {
        res.status(403).json({
            error: 'forbidden',
            message: 'Only a workspace owner can change its billing.',
        });
        return null;
    }
    return orgId;
}

// ── TWO REFUSALS WHOSE WAY THROUGH IS STRIPE'S BILLING PAGE ─────────────────
//
// Both answer 402 with their own code, a sentence, and `billing_portal: true`:
// the dashboard offers the existing portal hand-off (POST /billing/portal,
// owners only, as this route is). Neither promises anything about timing.
//
// The bank has to confirm the payment (3-D Secure). This used to answer
// "update your card", which is not the reason and cannot be fixed by updating
// the card. Stripe's billing page is where confirmation works; confirming in
// place was offered to the owner and not chosen.
const BANK_CONFIRMATION_MESSAGE = 'Your bank needs to confirm this payment, so nothing was changed. '
    + 'Make this change from the billing page instead, where your bank can confirm it.';
// A payment on the subscription is overdue (past_due or unpaid). Refused before
// anything is sent to Stripe: a seat change on a past-due subscription used to
// send the new quantity to Stripe and only then answer that it was not active.
// "Update billing to restore access." is the sentence every locked request
// already reads (middleware/enforcePlan.js).
const OVERDUE_MESSAGE = 'A payment on this subscription is overdue, so nothing was changed. '
    + 'Update billing to restore access, then try again.';
// The subscription is on a Stripe price DeerDawn's price map does not know, so
// there is no plan line to move. This used to answer with the portal link and
// "your existing subscription is still active", and never said why. The
// second sentence is the billing-page hand-off the bank refusal already uses;
// the third is the sentence this answer always carried.
const UNRECOGNISED_PRICE_MESSAGE = 'This subscription is on a price DeerDawn does not recognise, so nothing was changed. '
    + 'Make this change from the billing page instead. Your existing subscription is still active.';

function paymentRefusal(res, { error, message, currentTier, subscriptionId, status }) {
    return res.status(402).json({
        error,
        updated: false,
        url: null,
        plan_tier: currentTier,
        subscription_id: subscriptionId,
        ...(status ? { subscription_status: status } : {}),
        billing_portal: true,
        message,
    });
}

function getDashboardUrl(req) {
    // Prefer explicit config. Fall back to a safe subset of request origins for dev/preview.
    const configured = process.env.DASHBOARD_URL;
    if (configured) return configured;

    // Whitelist approach - only allow specific origins to prevent open redirect
    const ALLOWED_ORIGINS = new Set([
        'https://app.deerdawn.com',
        'https://www.deerdawn.com',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
    ]);

    const origin = req.headers?.origin;
    if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
        return origin;
    }

    if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000';
    return null;
}

function sendBillingError(res, err) {
    const message = (err && typeof err.message === 'string') ? err.message : 'Billing error';

    // Common misconfigurations should not show up as generic 500s in the UI.
    if (
        message.includes('Stripe is not configured') ||
        message.includes('Missing DASHBOARD_URL') ||
        message.includes('Invalid DASHBOARD_URL') ||
        message.includes('missing price ID') ||
        // The message validateCheckoutCatalog ACTUALLY throws — "Missing Stripe
        // base price for developer_pro (monthly)" / "Missing Stripe overage
        // price for …". The lowercase "missing price ID" above matches no
        // string this codebase produces, so an unset STRIPE_PRICE_* env var
        // 500'd as internal_error and the buyer was told to retry something
        // that could never succeed. A plan listed as self-serve without its
        // price id has to say so, at the surface, in those words.
        message.includes('Missing Stripe base price') ||
        message.includes('Missing Stripe overage price') ||
        message.toLowerCase().includes('sales-assisted') ||
        message.toLowerCase().includes('contact sales')
    ) {
        return res.status(503).json({ error: 'billing_unavailable', message });
    }

    // Stripe SDK errors: treat as bad gateway so it’s clear it’s upstream.
    if (err && (err.type || err.rawType || err.name?.startsWith('Stripe'))) {
        return res.status(502).json({ error: 'stripe_error', message: 'Stripe is temporarily unavailable. Please try again.' });
    }

    return res.status(500).json({ error: 'internal_error' });
}

async function getUsageSummary(orgId) {
    const orgRes = await db.query(
        `SELECT billing_period_start, billing_cycle_anchor
           FROM organizations
          WHERE org_id = $1`,
        [orgId],
        orgId
    );
    if (!orgRes.rows[0]) {
        return null;
    }

    const periodStart = orgRes.rows[0].billing_period_start
        || orgRes.rows[0].billing_cycle_anchor
        || new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    // "Syncs used this cycle" is sourced from real context-sync activity recorded
    // in product_events (context_delivered = context actually reached a tool — the
    // same signal behind the dashboard's "This week / context loads" strip). The
    // legacy usage_counters.decisions_count is NOT a reliable source here: nothing
    // increments it on the sync path, so it reads 0 even under heavy real usage,
    // which is what made the entire Usage & value page render zeros. We still fall
    // back to the counter if the events query fails, so a populated meter is honored.
    let syncsUsed = 0;
    try {
        const usageRes = await db.query(
            `SELECT COUNT(*)::int AS used
               FROM product_events
              WHERE org_id = $1
                AND event_name = 'context_delivered'
                AND created_at >= $2`,
            [orgId, periodStart],
            orgId
        );
        syncsUsed = Number.parseInt(usageRes.rows[0]?.used || 0, 10);
    } catch (err) {
        console.warn('[BILLING] product_events usage count failed, falling back to usage_counters:', err.message);
        const counterRes = await db.query(
            'SELECT decisions_count FROM usage_counters WHERE org_id = $1 AND period_start = $2',
            [orgId, periodStart],
            orgId
        ).catch(() => ({ rows: [] }));
        syncsUsed = Number.parseInt(counterRes.rows[0]?.decisions_count || 0, 10);
    }

    const planRes = await db.query(
        'SELECT plan, plan_tier FROM organizations WHERE org_id = $1',
        [orgId],
        orgId
    );
    const planTier = normalizePlanId(planRes.rows[0]?.plan_tier || planRes.rows[0]?.plan || 'free');
    const syncsLimit = PLANS[planTier]?.limits?.included_decisions ?? null;
    const pct = syncsLimit ? Math.min(Math.round((syncsUsed / syncsLimit) * 100), 999) : 0;

    return {
        syncs_used: syncsUsed,
        syncs_limit: syncsLimit,
        pct,
    };
}

// GET /api/v1/billing/plans
router.get('/plans', (req, res) => {
    res.json({ plans: getPublicBillingPlans() });
});

// GET /api/v1/billing/usage-summary
router.get('/usage-summary', async (req, res) => {
    const orgId = billingWorkspace(req);
    if (!orgId) return res.status(403).json({ error: 'forbidden' });

    try {
        const summary = await getUsageSummary(orgId);
        if (!summary) return res.status(404).json({ error: 'org_not_found' });
        res.json(summary);
    } catch (err) {
        console.error('[BILLING] usage summary failed:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v1/billing/checkout
//
// `afterAdoption` is set only by the handler itself, on the one re-run that
// follows recording a live subscription the org row had forgotten (see the
// lookup before createCheckoutSession). It makes that re-run answer "you
// already have this" instead of refusing, and stops it looking twice.
async function handleCheckout(req, res, { afterAdoption = false } = {}) {
    const requestedTier = normalizePlanId(req.body?.tierId);
    // What the caller actually asked for (null = did not ask). A NEW checkout
    // needs a concrete cadence and defaults to monthly; a plan CHANGE inherits
    // the one the subscription already has, so it needs to know the difference.
    const requestedBillingCycle = ['monthly', 'annual'].includes(req.body?.billingCycle)
        ? req.body.billingCycle
        : null;
    const billingCycle = typeof req.body?.billingCycle === 'string' ? req.body.billingCycle : 'monthly';
    const promotionCode = typeof req.body?.promotionCode === 'string' ? req.body.promotionCode.trim().toUpperCase() : null;
    const campaign = typeof req.body?.campaign === 'string' ? req.body.campaign.trim() : null;
    // How many people the buyer is paying for. Ignored by stripeService for
    // per-person plans; without it every per-seat checkout billed quantity 1,
    // charging one seat's price for a whole team.
    // What the caller actually asked for (null = did not ask). A same-tier
    // request only means "change the seat count" when a count was named; without
    // the distinction the defaulted 1 would read as a downgrade request on every
    // plain re-checkout.
    //
    // NORMALISED TO A WHOLE NUMBER ONCE, HERE, BEFORE ANYTHING COMPARES IT.
    //
    // stripeService.resolveSeatQuantity floors and clamps on its way to Stripe,
    // but the seat-change branch below compares the RAW value to
    // purchased_seats: `2.5 !== 2` read as a change, so a request that Stripe
    // would have treated as a no-op was sent as a real subscription move and
    // prorated. And `Number(null)` is 0, not NaN, so an explicit `seats: null`
    // used to arrive as a request for zero seats rather than as "did not ask".
    const rawSeats = req.body?.seats;
    const namedSeats = rawSeats !== undefined && rawSeats !== null && rawSeats !== '';
    const parsedSeats = namedSeats ? Math.floor(Number(rawSeats)) : null;
    if (namedSeats && (!Number.isFinite(parsedSeats) || parsedSeats < 1)) {
        return res.status(400).json({
            error: 'invalid_seats',
            message: 'Seats must be a whole number of 1 or more.',
        });
    }
    // Whether a reduction is a deliberate act or an accident of whatever the
    // link carried. See the seat-change branch below.
    const allowReduce = req.body?.allow_reduce === true;
    const requestedSeats = parsedSeats;
    const seats = requestedSeats ?? 1;

    if (!PLANS[requestedTier]) return res.status(400).json({ error: 'invalid_plan' });
    if (!isSelfServePlan(requestedTier)) {
        return res.status(400).json({ error: 'invalid_plan', message: 'This plan is not available for self-serve checkout.' });
    }
    if (!['monthly', 'annual'].includes(billingCycle)) {
        return res.status(400).json({ error: 'invalid_billing_cycle' });
    }

    // A TEAM WORKSPACE THAT IS CREATED BY PAYING FOR IT (journey r6). The caller
    // names it here and no organizations row is written: the webhook creates the
    // workspace when Stripe confirms the subscription.
    if (req.body?.newWorkspaceName !== undefined && req.body?.newWorkspaceName !== null) {
        return startNewWorkspaceCheckout(req, res, { requestedTier, billingCycle, promotionCode, campaign, seats });
    }

    let orgId;
    try {
        orgId = await requireBillingOwner(req, res);
    } catch (err) {
        console.error('[BILLING] checkout role check failed:', err);
        return res.status(503).json({ error: 'billing_unavailable' });
    }
    if (!orgId) return undefined;

    try {
        // Pricing guardrails: prevent no-op or downgrade checkouts.
        const orgRes = await db.query(
            'SELECT plan_tier, account_type, stripe_subscription_id, stripe_customer_id, subscription_status, purchased_seats FROM organizations WHERE org_id = $1',
            [orgId],
            orgId
        );
        const currentTier = normalizePlanId(orgRes.rows[0]?.plan_tier);

        // CHECKING OUT AGAIN AFTER A FIRST PAYMENT THAT NEVER WENT THROUGH.
        //
        // The owner's answer (2026-09-29): a workspace whose subscription Stripe
        // reports as `incomplete` is locked (nothing was ever collected), and the
        // way out is a NEW checkout, not the billing portal and not a change to
        // the unfinished subscription. So this request is not a plan or seat
        // change and is not held to "same or lower tier": any plan may be bought
        // afresh, the same one by default. What it must not do is leave the
        // unfinished subscription open: if its payment completed LATER it would
        // sit beside the new one, and the customer would be charged twice. It is
        // ended below, from the same Stripe list that checks for a live
        // subscription, before the checkout opens. Nothing is adopted from it.
        const incompleteRetry = Boolean(orgRes.rows[0]?.stripe_subscription_id)
            && orgRes.rows[0]?.subscription_status === 'incomplete';

        // ── ADDING A SEAT IS NOT A PLAN CHANGE, BUT IT ARRIVES HERE ──────────
        //
        // Every dashboard purchase buys the two-seat minimum, and there was no
        // way in the product to buy a third: the invite refuses at the cap, and
        // this route refused the only request that could raise it ("Cannot start
        // checkout for the same or lower tier") because the tier had not moved.
        // A team that wanted to grow had to leave the product.
        //
        // A same-tier request from an owner who named a seat count is a SEAT
        // CHANGE. It goes through the existing subscription-move path below
        // (changeSubscriptionPlan reprices the same plan item with a new
        // quantity and prorates), never through a second Checkout session —
        // opening one would be the duplicate-subscription bug wearing a
        // different hat.
        const plan = PLANS[requestedTier];
        const isPerSeatPlan = plan?.limits?.included_seats !== 1 && plan?.account_type === 'organization';
        const isSeatChange = requestedSeats !== null
            && isPerSeatPlan
            && requestedTier === currentTier
            && !incompleteRetry
            && Boolean(orgRes.rows[0]?.stripe_subscription_id);

        if (isSeatChange) {
            // Seats below the people already in the workspace would bill for
            // fewer than are using it, and the cap is checked on INVITE, so
            // nothing downstream would notice. Pending invites count for the
            // same reason they count there: they are seats already spent.
            const [activeMembers, pendingInvites] = await Promise.all([
                workspace.countActiveMembers(orgId),
                workspace.listInvites(orgId),
            ]);
            const floor = activeMembers + pendingInvites.length;
            if (requestedSeats < floor) {
                return res.status(400).json({
                    error: 'seats_below_headcount',
                    message: `This workspace has ${floor} ${floor === 1 ? 'person or pending invite' : 'people and pending invites'}. Remove somebody before reducing to ${requestedSeats} seats.`,
                    seats: requestedSeats,
                    minimum_seats: floor,
                });
            }
            const currentSeats = Number(orgRes.rows[0]?.purchased_seats) || null;
            if (currentSeats !== null && requestedSeats === currentSeats) {
                // Asking for what you already have is an answer, not an error.
                return res.json({
                    updated: false,
                    url: null,
                    plan_tier: currentTier,
                    seats: currentSeats,
                    message: `This workspace already has ${currentSeats} seats. Nothing was changed or charged.`,
                });
            }

            // SHEDDING A SEAT IS A DECISION, NOT A DEFAULT.
            //
            // This route is reachable from marketing links that carry a seat
            // count in the body, and a Team owner arriving on one with fewer
            // seats than they hold would have had their subscription quietly
            // reduced and prorated. The headcount floor above does not catch it:
            // an owner with 5 purchased seats and 2 people in the workspace can
            // be cut to 2 without tripping anything. Growing stays one request;
            // shrinking needs the caller to say it meant to, which the dashboard
            // sends only from an explicit control.
            if (currentSeats !== null && requestedSeats < currentSeats && !allowReduce) {
                return res.status(409).json({
                    error: 'seat_reduction_not_confirmed',
                    message: `This workspace has ${currentSeats} seats. Reducing to ${requestedSeats} needs to be confirmed.`,
                    current: currentSeats,
                    requested: requestedSeats,
                });
            }
        } else if (!incompleteRetry && getPlanOrder(requestedTier) <= getPlanOrder(currentTier)) {
            if (afterAdoption) {
                // The person pressed Upgrade on a page that did not yet know they
                // had paid — the webhook was late, or a refund cleared the row —
                // and the subscription just adopted already covers what they
                // asked for. That is an answer, not an error: they have it, and
                // nothing new was bought.
                const status = orgRes.rows[0]?.subscription_status;
                const planName = PLANS[currentTier]?.publicName || currentTier;
                const unpaid = status && !['active', 'trialing'].includes(status);
                return res.json({
                    updated: false,
                    url: null,
                    adopted: true,
                    plan_tier: currentTier,
                    subscription_id: orgRes.rows[0]?.stripe_subscription_id || null,
                    message: `This workspace already has a ${planName} subscription, so no new checkout was opened and nothing was charged. `
                        + 'It is now linked to this workspace.'
                        + (unpaid
                            ? ` Stripe reports it as ${String(status).replace(/_/g, ' ')}: update your card in the billing portal ("Update payment method" on Settings > Plan).`
                            : ''),
                });
            }
            if (requestedTier !== 'pilot') {
                return res.status(400).json({ error: 'invalid_plan', message: 'Cannot start checkout for the same or lower tier.' });
            }
        }

        // ── ONE WORKSPACE, ONE SUBSCRIPTION ──────────────────────────────────
        //
        // This route used to create a Checkout session unconditionally once the
        // tier guard above passed. A Pro subscriber upgrading to Team therefore
        // ended with TWO live subscriptions on one Stripe customer, both
        // charging, and the webhook — which stores a single
        // stripe_subscription_id — overwrote the first with the second, so
        // DeerDawn forgot the one it was still billing them for. Nothing
        // errored; the duplicate surfaced only on a card statement.
        //
        // When there is a live subscription, MOVE it. The three answers that are
        // not a move each mean something different and none of them may fall
        // back to "open a second subscription":
        //   - gone / not live  → nothing is being billed, so a real checkout is
        //                        correct and the buyer is not charged twice.
        //   - refused / error  → hand it to the customer portal. A human can see
        //                        both sides there; we must not guess.
        const existingSubscriptionId = orgRes.rows[0]?.stripe_subscription_id || null;
        // OVERDUE: refused up front, from the recorded status, with no call to
        // Stripe at all. changeSubscriptionPlan refuses it again from Stripe's
        // own answer, before any write, in case this row is behind.
        const recordedStatus = orgRes.rows[0]?.subscription_status || null;
        if (existingSubscriptionId && ['past_due', 'unpaid'].includes(recordedStatus)) {
            return paymentRefusal(res, {
                error: 'payment_overdue',
                message: OVERDUE_MESSAGE,
                currentTier,
                subscriptionId: existingSubscriptionId,
                status: recordedStatus,
            });
        }
        if (existingSubscriptionId && !incompleteRetry) {
            let change = null;
            let changeFailed = false;
            try {
                change = await changeSubscriptionPlan(existingSubscriptionId, requestedTier, {
                    orgId,
                    // The RAW request value, not the defaulted one. A caller
                    // that named no cadence (the billing page has no toggle)
                    // must keep the one it is already billed on; passing the
                    // 'monthly' default here would move an annual subscriber to
                    // monthly as a side effect of changing plan.
                    billingCycle: requestedBillingCycle,
                    seats,
                });
            } catch (err) {
                // A configuration failure (missing price id, Stripe not
                // configured) is the caller's problem to see, not something to
                // paper over with a portal link — sendBillingError names it.
                if (/Missing Stripe|not configured|DASHBOARD_URL|sales-assisted/i.test(err?.message || '')) throw err;
                console.error('[BILLING] subscription plan change failed:', err);
                changeFailed = true;
            }

            if (change?.changed) {
                // Write the plan through immediately. customer.subscription.updated
                // will say the same thing a moment later — this is idempotent
                // with it, not a substitute for it — but a buyer who lands back
                // on the billing page before the webhook arrives must not be
                // told they are still on the old plan.
                await db.query(
                    `UPDATE organizations
                        SET plan = $1,
                            plan_tier = $1,
                            pending_plan = NULL,
                            purchased_seats = COALESCE($2, purchased_seats)
                      WHERE org_id = $3`,
                    [change.planId, change.seats ?? null, orgId],
                    orgId
                );
                await invalidateOrgCache(orgId).catch(() => {});
                // WHEN the money moves depends on whether the billing period
                // moved with the plan. Same interval: Stripe keeps the billing
                // date and the prorated difference rides on the next invoice.
                // Changed interval (monthly <-> annual): Stripe starts a new
                // period today and charges the prorated difference NOW. This
                // said "next invoice" for both, so a monthly subscriber moved
                // to annual was told nothing would be charged yet and then saw
                // a year's charge the same minute.
                const billedNow = change.intervalChanged === true;
                // A seat change must not be described as a plan change. Same
                // subscription, same plan, a different quantity — and telling
                // somebody who bought one more seat that their plan moved is the
                // kind of wrong that sends them to the portal to check.
                const whatMoved = isSeatChange
                    ? `Your subscription now covers ${change.seats ?? requestedSeats} seats`
                    : 'Your existing subscription was moved to the new plan';
                const message = billedNow
                    ? `${whatMoved} and to ${change.billingCycle} billing. `
                        + 'A new billing period started today, so the prorated difference is charged now rather than on a later invoice. '
                        + 'You have one subscription and have not been charged twice.'
                    : `${whatMoved}. The prorated difference will appear on your next invoice. `
                        + 'You have one subscription and have not been charged twice.';
                return res.json({
                    updated: true,
                    url: null,
                    plan_tier: change.planId,
                    seats: change.seats ?? null,
                    subscription_id: existingSubscriptionId,
                    billing_cycle: change.billingCycle ?? null,
                    interval_changed: billedNow,
                    billed_now: billedNow,
                    message,
                });
            }

            // THE BANK HAS TO CONFIRM IT, or a payment is overdue after all
            // (Stripe knew before this row did). Nothing was changed in either
            // case; each says why and offers the billing page.
            if (change?.reason === 'payment_requires_action') {
                return paymentRefusal(res, {
                    error: 'payment_confirmation_required',
                    message: BANK_CONFIRMATION_MESSAGE,
                    currentTier,
                    subscriptionId: existingSubscriptionId,
                });
            }
            if (String(change?.reason || '').startsWith('overdue:')) {
                return paymentRefusal(res, {
                    error: 'payment_overdue',
                    message: OVERDUE_MESSAGE,
                    currentTier,
                    subscriptionId: existingSubscriptionId,
                    status: change.status || change.reason.slice('overdue:'.length),
                });
            }

            // THE CARD SAID NO. Not an outage and not something the portal
            // hand-off below would explain: that answer reads "your existing
            // subscription is still active" and redirects, and the person never
            // learns why their upgrade did not happen. 402 with the reason, in a
            // sentence every billing surface already prints verbatim for a 4xx.
            // Nothing was changed — the update asked Stripe to refuse rather than
            // apply a change it could not charge for — so nothing is written.
            if (change?.reason === 'payment_failed') {
                const cardSaid = change.payment?.message ? `${change.payment.message.trim().replace(/\.?$/, '.')} ` : '';
                return res.status(402).json({
                    error: 'payment_failed',
                    updated: false,
                    url: null,
                    plan_tier: currentTier,
                    subscription_id: existingSubscriptionId,
                    ...(change.payment?.declineCode ? { decline_code: change.payment.declineCode } : {}),
                    message: `${cardSaid}The charge for this change did not go through, so your plan was not changed. `
                        + 'Update your card in the billing portal ("Update payment method" on Settings > Plan), then try again.',
                });
            }
            // Stripe took the change but handed back a subscription that is not
            // paid up. Reporting it as done is how a buyer was told "moved, not
            // charged twice" about an account the next webhook locked. The plan
            // is not written through: the webhook records what Stripe settles on.
            if (String(change?.reason || '').startsWith('payment_incomplete:')) {
                const status = change.status || change.reason.slice('payment_incomplete:'.length);
                return res.status(402).json({
                    error: 'subscription_payment_incomplete',
                    updated: false,
                    url: null,
                    plan_tier: currentTier,
                    subscription_id: existingSubscriptionId,
                    subscription_status: status,
                    message: `Stripe reports this subscription as ${String(status).replace(/_/g, ' ')}: a payment on it has not gone through, `
                        + 'so this change is not active. Update your card in the billing portal ("Update payment method" on Settings > Plan) '
                        + 'to settle it.',
                });
            }

            // An unusable answer is NOT permission to create a second
            // subscription. `change` is undefined/null only if the service
            // returned something unexpected, which is exactly when guessing is
            // most expensive.
            const unmovable = changeFailed || !change;
            const noLiveSubscription = change?.reason === 'subscription_missing'
                || String(change?.reason || '').startsWith('not_live:');
            if (unmovable || !noLiveSubscription) {
                const unrecognisedPrice = change?.reason === 'no_plan_item';
                if (unrecognisedPrice) {
                    // The owner's alert for an unrecognised price, by the same
                    // rule as the webhook's: once per price per day, best-effort,
                    // never the reason this answer fails.
                    Promise.resolve().then(() => alertUnrecognisedPrice({
                        orgId,
                        customerId: change.customerId || orgRes.rows[0]?.stripe_customer_id || null,
                        subscriptionId: change.subscriptionId || existingSubscriptionId,
                        status: change.status || recordedStatus || 'unknown',
                        priceIds: Array.isArray(change.priceIds) ? change.priceIds : [],
                        planKept: currentTier,
                        source: isSeatChange ? 'POST /billing/checkout (a seat change)' : 'POST /billing/checkout (a plan change)',
                        nothingWritten: true,
                    })).catch((e) => console.warn('[BILLING] unrecognised price alert failed:', e.message));
                }
                const portalDashboardUrl = getDashboardUrl(req);
                const url = await createPortalSession(orgId, { dashboardUrl: portalDashboardUrl, flow: null });
                return res.json({
                    url,
                    portal: true,
                    reason: change?.reason || 'subscription_change_failed',
                    message: unrecognisedPrice
                        ? UNRECOGNISED_PRICE_MESSAGE
                        : 'Change your plan from the billing portal — your existing subscription is still active.',
                });
            }
            // Falls through: the RECORDED subscription is not live, so there is
            // nothing of the row's to move. Whether the customer is paying for
            // a different one is asked below, before any checkout opens.
        }

        // ── THE ROW IS NOT THE ONLY RECORD OF A SUBSCRIPTION ────────────────
        //
        // Everything above answered "is there a subscription to move?" from
        // organizations.stripe_subscription_id, which is empty until the
        // checkout webhook lands (and again after a refund clears it) while the
        // customer is already being charged. A buyer who paid, came back to a
        // plan page that still said Free and pressed Upgrade again was sold a
        // second subscription. So before opening one for an org that has a
        // Stripe customer, ask Stripe — one list call — and if that customer is
        // paying for something live, record it through the webhook's reconcile
        // and handle this request again as a change to it, by the same path as
        // any recorded subscription.
        //
        // No answer is not "no subscription". A lookup that fails hands off to
        // the portal, as the move above does on an unusable answer; and the
        // re-run never looks twice — reaching here again means the subscription
        // it just adopted was not movable, which is not a reason to buy another.
        const customerId = orgRes.rows[0]?.stripe_customer_id || null;
        const seen = {};
        if (customerId) {
            let adopted = null;
            let lookupFailed = afterAdoption;
            if (!afterAdoption) {
                try {
                    adopted = await adoptLiveSubscription(
                        { query: (text, values) => db.query(text, values, orgId) },
                        { orgId, customerId, seen },
                    );
                } catch (err) {
                    if (/not configured/i.test(err?.message || '')) throw err;
                    console.error('[BILLING] live-subscription lookup failed:', err);
                    lookupFailed = true;
                }
            }
            if (adopted) return handleCheckout(req, res, { afterAdoption: true });
            if (lookupFailed) {
                const url = await createPortalSession(orgId, { dashboardUrl: getDashboardUrl(req), flow: null });
                return res.json({
                    url,
                    portal: true,
                    reason: afterAdoption ? 'adopted_subscription_not_movable' : 'subscription_lookup_failed',
                    message: 'Change your plan from the billing portal — no new subscription was started, because we could not confirm what this workspace is already paying for.',
                });
            }
        }

        // End every unfinished subscription this customer has (see incompleteRetry).
        // Fails closed: one that cannot be ended means no second checkout.
        if (incompleteRetry && customerId) {
            for (const unfinishedId of seen.incompleteIds || []) {
                await cancelIncompleteSubscription(unfinishedId);
            }
        }

        // Bug 11 fix: actor.email is absent when the JWT doesn't include an email
        // claim (some Clerk configurations). Fall back to the DB rather than a
        // junk @example.com address that makes Stripe support and chargebacks hard.
        let userEmail = req.actor.email;
        if (!userEmail) {
            const userRes = await db.query(
                'SELECT email FROM users WHERE user_id = $1',
                [workspace.actorPersonId(req.actor)],
                orgId
            );
            userEmail = userRes.rows[0]?.email || `admin-${orgId}@deerdawn.com`;
        }
        
        const dashboardUrl = getDashboardUrl(req);
        if (!dashboardUrl) {
            return res.status(503).json({ error: 'billing_unavailable', message: 'Missing DASHBOARD_URL for checkout redirects' });
        }
        const url = await createCheckoutSession(orgId, userEmail, requestedTier, {
            dashboardUrl, billingCycle, promotionCode, campaign, seats,
            purchaserUserId: workspace.actorPersonId(req.actor),
        });
        res.json({ url });
    } catch (err) {
        console.error('[BILLING] checkout failed:', err);
        return sendBillingError(res, err);
    }
}

// Opening a checkout for a team workspace that does not exist yet. Nothing is
// written here: not an organization, not a membership, not a Stripe customer. An
// abandoned checkout therefore leaves nothing behind, and the workspace appears
// when the Team subscription is confirmed (webhooks-stripe.js, "createWorkspaceAtCheckout").
async function startNewWorkspaceCheckout(req, res, { requestedTier, billingCycle, promotionCode, campaign, seats }) {
    const name = typeof req.body?.newWorkspaceName === 'string' ? req.body.newWorkspaceName.trim() : '';
    if (!name) return res.status(400).json({ error: 'name_required', message: 'Name the workspace before paying for it.' });
    if (name.length > 120) return res.status(400).json({ error: 'name_too_long', message: 'A workspace name is 120 characters or fewer.' });
    // Only a per-seat team plan creates a workspace: a Pro or Lifetime purchase
    // upgrades the person's own.
    const plan = PLANS[requestedTier];
    if (!(plan?.limits?.included_seats !== 1 && plan?.account_type === 'organization')) {
        return res.status(400).json({ error: 'invalid_plan', message: 'A new team workspace is created by buying the Team plan.' });
    }
    // The PERSON, not the credential: they become the workspace's owner.
    const founderUserId = workspace.actorPersonId(req.actor);
    if (!founderUserId) return res.status(403).json({ error: 'forbidden' });

    try {
        let userEmail = req.actor.email;
        if (!userEmail) {
            const userRes = await db.query('SELECT email FROM users WHERE user_id = $1', [founderUserId], 'org-system');
            userEmail = userRes.rows[0]?.email || null;
        }
        if (!userEmail) return res.status(400).json({ error: 'email_required', message: 'Your account has no email address to bill.' });
        const dashboardUrl = getDashboardUrl(req);
        if (!dashboardUrl) {
            return res.status(503).json({ error: 'billing_unavailable', message: 'Missing DASHBOARD_URL for checkout redirects' });
        }
        const newOrgKey = `org-${crypto.randomUUID()}`;
        const url = await createCheckoutSession(newOrgKey, userEmail, requestedTier, {
            dashboardUrl, billingCycle, promotionCode, campaign, seats,
            newWorkspace: { name, founderUserId },
        });
        return res.json({ url, workspace: newOrgKey, created: false });
    } catch (err) {
        console.error('[BILLING] new-workspace checkout failed:', err);
        return sendBillingError(res, err);
    }
}

router.post('/checkout', (req, res) => handleCheckout(req, res));

// Portal deep-link intents the billing card can request. Anything else is
// ignored and the customer lands on the portal home.
const PORTAL_FLOWS = new Set(['payment_method', 'cancel']);

// POST /api/v1/billing/portal
router.post('/portal', async (req, res) => {
    const flow = PORTAL_FLOWS.has(req.body?.flow) ? req.body.flow : null;
    try {
        const orgId = await requireBillingOwner(req, res);
        if (!orgId) return undefined;
        const dashboardUrl = getDashboardUrl(req);
        const url = await createPortalSession(orgId, { dashboardUrl, flow });
        res.json({ url });
    } catch (err) {
        console.error('[BILLING] portal failed:', err);
        if (err && err.message === 'No billing account found') {
            return res.status(400).json({ error: 'no_billing_account', message: err.message });
        }
        return sendBillingError(res, err);
    }
});

// ── WHO PAYS: TAKING BILLING OVER, AND THE PAYER'S OWN WAY OUT ──────────────
//
// (Journey r6; docs/audits/journey-r3-billing-takeover-design.md.) The person who
// pays may not leave, step down, be removed or delete their account while a live
// subscription renews on their card, until a remaining owner has taken billing
// over (services/billingOwnerService.js has the whole account).
//
// Every Stripe read below happens with no database connection held, and one that
// cannot be made answers 503 with nothing written.

function sendBillingOwnerError(res, err) {
    if (err instanceof BillingOwnerUnconfirmed) return billingOwnerService.sendUnconfirmed(res);
    if (err instanceof BillingOwnerError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
    }
    return null;
}

// POST /api/v1/billing/takeover/start
// An owner starts taking over billing: the payment methods paying now are stored
// with them, and the answer is the Stripe portal opened on the payment-method
// flow. Nobody's billing ownership changes until the card that was paying has
// been replaced (confirm, below).
router.post('/takeover/start', async (req, res) => {
    try {
        const orgId = await requireBillingOwner(req, res);
        if (!orgId) return undefined;
        await billingOwnerService.startTakeover(orgId, workspace.actorPersonId(req.actor));
        const url = await createPortalSession(orgId, { dashboardUrl: getDashboardUrl(req), flow: 'payment_method' });
        return res.json({ started: true, url });
    } catch (err) {
        if (sendBillingOwnerError(res, err)) return undefined;
        console.error('[BILLING] takeover start failed:', err);
        return sendBillingError(res, err);
    }
});

// POST /api/v1/billing/takeover/confirm
// Back from the portal: read Stripe back. `confirmed` makes the person who
// started it the billing owner; `pending` says the card that was paying still is.
router.post('/takeover/confirm', async (req, res) => {
    try {
        const orgId = await requireBillingOwner(req, res);
        if (!orgId) return undefined;
        const outcome = await billingOwnerService.confirmTakeover(orgId);
        const org = await db.query('SELECT billing_owner_user_id FROM organizations WHERE org_id = $1', [orgId], orgId);
        return res.json({
            ...outcome,
            billing_owner_is_you: org.rows[0]?.billing_owner_user_id === workspace.actorPersonId(req.actor),
        });
    } catch (err) {
        if (sendBillingOwnerError(res, err)) return undefined;
        console.error('[BILLING] takeover confirm failed:', err);
        return sendBillingError(res, err);
    }
});

// POST /api/v1/billing/cancel-at-period-end
// The payer's own way out: every renewing subscription of the workspace is set to
// end when the paid period does. Open to a workspace owner AND to the recorded
// billing owner in whatever role they now hold (an owner may have demoted them,
// and they must still be able to stop the card being charged).
router.post('/cancel-at-period-end', async (req, res) => {
    try {
        const orgId = billingWorkspace(req);
        if (!orgId) return res.status(403).json({ error: 'forbidden' });
        const person = workspace.actorPersonId(req.actor);
        const role = await workspace.resolveRole(req.actor, orgId);
        let allowed = workspace.canAdminister(role);
        if (!allowed && role && person) {
            const org = await db.query('SELECT billing_owner_user_id FROM organizations WHERE org_id = $1', [orgId], orgId);
            allowed = org.rows[0]?.billing_owner_user_id === person;
        }
        if (!allowed) {
            return res.status(403).json({ error: 'forbidden', message: 'Only a workspace owner, or the person who pays for it, can end its subscription.' });
        }
        const outcome = await billingOwnerService.cancelAtPeriodEnd(orgId);
        await invalidateOrgCache(orgId).catch(() => {});
        return res.json({
            ...outcome,
            message: outcome.cancelled.length
                ? `The subscription will end at the close of the paid period${outcome.ends_on ? `, on ${outcome.ends_on.slice(0, 10)}` : ''}. Nothing more will be charged.`
                : 'No subscription on this workspace renews, so nothing was changed.',
        });
    } catch (err) {
        if (sendBillingOwnerError(res, err)) return undefined;
        console.error('[BILLING] cancel at period end failed:', err);
        return sendBillingError(res, err);
    }
});

// POST /api/v1/billing/downgrade
// Self-serve drop to Free for accounts with NO active Stripe subscription
// (comped / Founding / manually provisioned). Stripe subscribers are sent to the
// portal cancel flow instead, so our DB never desyncs from what Stripe still bills.
router.post('/downgrade', async (req, res) => {
    try {
        const orgId = await requireBillingOwner(req, res);
        if (!orgId) return undefined;

        const orgRes = await db.query(
            'SELECT plan_tier, plan, stripe_subscription_id FROM organizations WHERE org_id = $1',
            [orgId],
            orgId
        );
        if (!orgRes.rows[0]) return res.status(404).json({ error: 'org_not_found' });

        const currentTier = normalizePlanId(orgRes.rows[0].plan_tier || orgRes.rows[0].plan);
        if (currentTier === 'free') {
            return res.status(400).json({ error: 'already_free', message: 'This account is already on the Free plan.' });
        }
        if (orgRes.rows[0].stripe_subscription_id) {
            // Paid through Stripe — cancelling here would strip access while Stripe
            // keeps charging the card. Send them to the portal cancel flow instead.
            return res.status(409).json({
                error: 'stripe_subscription_active',
                message: 'Cancel your paid subscription from the billing portal.',
            });
        }

        // active (not an INACTIVE_STATUS) + free tier = a normal free account, so
        // entitlements resolve to free and the plan page reads "Free · Active".
        await db.query(
            `UPDATE organizations
                SET plan = 'free', plan_tier = 'free', subscription_status = 'active', pending_plan = NULL
              WHERE org_id = $1`,
            [orgId],
            orgId
        );
        await invalidateOrgCache(orgId).catch(() => {});

        res.json({ success: true, plan_tier: 'free' });
    } catch (err) {
        console.error('[BILLING] downgrade failed:', err);
        return sendBillingError(res, err);
    }
});

module.exports = router;
module.exports.getUsageSummary = getUsageSummary;
