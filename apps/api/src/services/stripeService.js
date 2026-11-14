const Stripe = require('stripe');
const db = require('../config/db');
const { getPlan, isSelfServePlan, normalizePlanId, getAllPricePlanMappings } = require('../config/plans');

// HOW LONG A STRIPE CALL MAY TAKE, AND HOW OFTEN IT IS RETRIED.
//
// The client was built with the SDK's defaults (stripe-node 20): an 80-second
// timeout and 2 network retries, so a Stripe that hung could hold one call for
// about four minutes, far past the time Stripe allows a webhook delivery to
// answer (it does not publish the number and asks for a quick 2xx; reports put
// it between 10 and 30 seconds). A delivery that has timed out on Stripe's side
// is redelivered while the first one is still running.
//
//   CLIENT_OPTIONS: every call a person is waiting on (checkout, the portal, a
//     plan change). Ten seconds is several times a slow Stripe answer; one
//     retry covers a dropped connection. The SDK sends an idempotency key with
//     every POST, so retrying a write cannot apply it twice.
//   WEBHOOK_READ_OPTIONS: the webhook's reads of a subscription (routes/
//     webhooks-stripe.js). A failed read already answers 5xx and Stripe
//     redelivers the event, which is the retry, so the SDK does not retry; five
//     seconds each keeps the longest event (an update that asks after the
//     recorded subscription, then reads its own) within ten seconds of Stripe.
const CLIENT_OPTIONS = { timeout: 10_000, maxNetworkRetries: 1 };
const WEBHOOK_READ_OPTIONS = Object.freeze({ timeout: 5_000, maxNetworkRetries: 0 });

const stripe = process.env.STRIPE_SECRET_KEY 
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-02-25.clover', ...CLIENT_OPTIONS })
    : null;
const PROTECTED_ACTIONS_METER_EVENT = 'protected_actions';

function normalizeBillingCycle(value) {
    return value === 'annual' ? 'annual' : 'monthly';
}

// Annual is the default cadence on every checkout surface, so an unset annual
// price id is no longer a partial outage that only affects people who chose
// annual — it is EVERY checkout failing with "We couldn't start checkout."
// Degrade to the monthly price instead: a monthly sale is a worse outcome than
// an annual one, zero sales is a far worse outcome than both, and Stripe's own
// checkout page shows the real cadence and amount before the customer pays, so
// nothing is misrepresented at the moment of payment. Logged loudly because a
// silent downgrade of every annual sale is a configuration bug to fix, not a
// steady state to live in.
//
// The variable to set, per plan, for the message below. A plan with no entry
// gets a generic sentence rather than the wrong variable's name.
const ANNUAL_PRICE_ENV_VAR = Object.freeze({
    developer_basic: 'STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL',
    developer_pro: 'STRIPE_PRICE_DEVELOPER_PRO_ANNUAL',
});
function getBasePriceId(plan, billingCycle) {
    if (!plan?.stripe_prices) return plan?.stripe_price_id || null;
    if (billingCycle === 'annual') {
        if (plan.stripe_prices.annual) return plan.stripe_prices.annual;
        const monthlyFallback = plan.stripe_prices.monthly || plan.stripe_price_id || null;
        if (monthlyFallback) {
            console.error(
                `[STRIPE] MISCONFIGURATION: no annual price for plan "${plan.id}" — `
                + 'falling back to the monthly price so checkout still completes. '
                + `Set ${ANNUAL_PRICE_ENV_VAR[plan.id] || 'the plan\'s annual price env var'} to a live yearly recurring price.`
            );
        }
        return monthlyFallback;
    }
    return plan.stripe_prices.monthly || plan.stripe_price_id || null;
}

function getOveragePriceId(plan, billingCycle) {
    if (!plan?.stripe_prices) return null;
    return billingCycle === 'annual'
        ? plan.stripe_prices.overage_annual || null
        : plan.stripe_prices.overage_monthly || null;
}

/**
 * The price for EXACTLY this cadence, or null. No fallback.
 *
 * getBasePriceId's annual-to-monthly degrade is safe for a NEW checkout only
 * because Stripe's own page then shows the buyer the real cadence and amount
 * before they pay. A plan CHANGE has no such page: the subscription is repriced
 * server-side and the customer sees nothing until an invoice. Degrading there
 * moved an annual Pro subscriber onto MONTHLY Team, silently, because one env
 * var was unset — a change of billing period nobody asked for, made by a
 * configuration gap.
 */
function getExactBasePriceId(plan, billingCycle) {
    if (!plan?.stripe_prices) return plan?.stripe_price_id || null;
    if (billingCycle === 'annual') return plan.stripe_prices.annual || null;
    return plan.stripe_prices.monthly || plan.stripe_price_id || null;
}

function validateCheckoutCatalog(plan, tierId, billingCycle, { exactCadence = false } = {}) {
    if (!plan) {
        throw new Error('Invalid plan');
    }

    const basePriceId = exactCadence
        ? getExactBasePriceId(plan, billingCycle)
        : getBasePriceId(plan, billingCycle);
    if (!basePriceId) {
        // "Missing Stripe base price" is the phrase routes/shared/billing.js
        // turns into a 503 billing_unavailable; keep it at the front.
        throw new Error(
            `Missing Stripe base price for ${tierId} (${billingCycle})`
            + (exactCadence ? ' — an in-place plan change will not substitute a different billing period' : '')
        );
    }

    if (plan.overage_per_decision) {
        const overagePriceId = getOveragePriceId(plan, billingCycle);
        if (!overagePriceId) {
            throw new Error(`Missing Stripe overage price for ${tierId} (${billingCycle})`);
        }
    }

    return { basePriceId };
}

function getCheckoutMode(tierId) {
    return normalizePlanId(tierId) === 'lifetime' ? 'payment' : 'subscription';
}

/**
 * How many seats to bill, for a plan and a requested count.
 *
 * Shared by the NEW-subscription path and the plan-CHANGE path, because the seat
 * floor is a property of the plan and not of how the customer happens to be
 * arriving at it. A clamp that lives only on createCheckoutSession sells the
 * one-seat Team that `minimum_seats` exists to prevent, to anyone upgrading from
 * Pro instead of buying fresh.
 *
 * Seats are clamped rather than trusted: the caller is a browser.
 */
function resolveSeatQuantity(plan, seats) {
    const isPerSeat = plan?.limits?.included_seats !== 1 && plan?.account_type === 'organization';
    const minSeats = isPerSeat ? Math.max(1, Number(plan.limits?.minimum_seats) || 1) : 1;
    const quantity = isPerSeat
        ? Math.max(minSeats, Math.min(500, Math.floor(Number(seats) || minSeats)))
        : 1;
    return { isPerSeat, minSeats, quantity };
}

/** Statuses in which a subscription is a live billing relationship we can move. */
// Not 'incomplete': nothing was ever collected on it, so there is nothing to move.
// The owner's answer (2026-09-29) is to check out again for the same plan, and
// POST /billing/checkout ends the unfinished subscription first.
const MOVABLE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/**
 * Statuses in which a moved subscription may be reported as moved: money is
 * arriving, or a trial says it will. Anything else means the account locks on
 * the next webhook, and "your plan changed" would be the last thing it heard.
 */
const PAID_UP_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

/** A payment Stripe refused (declined card, bank confirmation needed): HTTP 402. */
function isPaymentError(err) {
    return err?.type === 'StripeCardError' || err?.rawType === 'card_error' || Number(err?.statusCode) === 402;
}

/**
 * Did Stripe refuse because the customer's BANK has to confirm the payment
 * (3-D Secure / strong customer authentication), rather than because the card
 * was declined?
 *
 * The two need different answers. A declined card is fixed by updating the
 * card; a payment that needs confirming is not, and "update your card" sent
 * people round a loop that could never end. Stripe says it in more than one
 * way depending on where the refusal came from: an error code on the invoice's
 * payment, `authentication_required` as the code or the decline code, or the
 * PaymentIntent it attaches in `requires_action`.
 */
const BANK_CONFIRMATION_CODES = new Set([
    'authentication_required',
    'invoice_payment_intent_requires_action',
    'subscription_payment_intent_requires_action',
    'payment_intent_action_required',
]);
function needsBankConfirmation(err) {
    if (!err || typeof err !== 'object') return false;
    if (BANK_CONFIRMATION_CODES.has(err.code) || BANK_CONFIRMATION_CODES.has(err.raw?.code)) return true;
    if (err.decline_code === 'authentication_required' || err.raw?.decline_code === 'authentication_required') return true;
    const intent = err.payment_intent || err.raw?.payment_intent;
    return intent?.status === 'requires_action';
}

/**
 * Subscriptions whose payment is OVERDUE. A plan or seat change on one is
 * refused before anything is sent to Stripe: the change cannot be paid for
 * while a payment is outstanding, and sending it anyway moved the subscription
 * (a seat change's quantity reached Stripe) before the answer came back as a
 * failure.
 */
const OVERDUE_SUBSCRIPTION_STATUSES = new Set(['past_due', 'unpaid']);

/**
 * Move an EXISTING subscription onto another plan, instead of opening a second
 * one beside it.
 *
 * WHY THIS EXISTS. POST /billing/checkout used to create a Stripe Checkout
 * session for every upgrade, having checked only that the requested tier ranked
 * above the org's current one. A Pro subscriber who upgraded to Team therefore
 * ended with TWO live subscriptions on one Stripe customer — $12/mo and $30/mo,
 * both charging — and because `organizations` holds a single
 * stripe_subscription_id, the webhook then overwrote Pro's id with Team's and
 * the first subscription stopped existing as far as DeerDawn was concerned.
 * Nothing errored. The buyer saw a normal Stripe page and got the plan they
 * asked for; the duplicate only ever surfaced on a card statement.
 *
 * Returns `{ changed: false, reason }` rather than throwing for the two cases
 * that are not failures at all — the subscription is gone, or it is no longer
 * live — because the caller's correct response to those is a real checkout, and
 * an exception cannot be told apart from a Stripe outage. The same shape carries
 * the two payment answers the caller must put in front of the person rather
 * than route around: `payment_failed` (the card refused the charge; nothing was
 * changed) and `payment_incomplete:<status>` (Stripe returned a subscription
 * that is not paid up). Two more are refusals the person must be told about:
 * `payment_requires_action` (the bank must confirm the payment; nothing was
 * changed) and `overdue:<status>` (past_due or unpaid; nothing was sent).
 * `changed: true` means moved AND paid up.
 */
async function changeSubscriptionPlan(subscriptionId, tierId, { orgId = null, billingCycle = null, seats = 1 } = {}) {
    if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.');
    if (!subscriptionId) return { changed: false, reason: 'no_subscription' };

    const canonicalTier = normalizePlanId(tierId);
    if (!isSelfServePlan(canonicalTier)) {
        throw new Error('This plan is sales-assisted. Please contact sales to upgrade.');
    }
    const plan = getPlan(canonicalTier);

    let subscription;
    try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
        if (err?.code === 'resource_missing') return { changed: false, reason: 'subscription_missing' };
        throw err;
    }

    if (!MOVABLE_SUBSCRIPTION_STATUSES.has(subscription?.status)) {
        return { changed: false, reason: `not_live:${subscription?.status || 'unknown'}` };
    }
    // OVERDUE: refused here, before any write, whatever the caller's copy of
    // the status said. (POST /billing/checkout refuses it earlier still, from
    // the recorded status, without asking Stripe at all.)
    if (OVERDUE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
        return { changed: false, reason: `overdue:${subscription.status}`, subscriptionId, status: subscription.status };
    }

    // The item carrying the PLAN is the one whose price maps to a plan. An
    // overage or add-on line has its own price and its own quantity; repricing
    // it would move the wrong line and leave the plan exactly where it was.
    const priceToPlan = getAllPricePlanMappings();
    const planItem = (subscription.items?.data || []).find(
        (item) => item?.price?.id && priceToPlan[item.price.id]
    );
    // No line item is at a price the map knows: the subscription is on a price
    // DeerDawn does not recognise, so there is no plan item to move. The
    // caller tells the person and alerts the owner, so it gets what the alert
    // names.
    if (!planItem) {
        return {
            changed: false,
            reason: 'no_plan_item',
            subscriptionId,
            status: subscription.status,
            customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id || null,
            priceIds: (subscription.items?.data || []).map((item) => item?.price?.id).filter(Boolean),
        };
    }

    // CADENCE IS INHERITED, NOT DEFAULTED.
    //
    // `billingCycle` is null when the caller did not ask for one, and the answer
    // is then whatever the customer is already on. /settings/plan has no billing
    // toggle — it offers "Upgrade to Team" and nothing else — so it names no
    // cadence; defaulting that to 'monthly' would move an ANNUAL subscriber onto
    // monthly billing as a side effect of changing plan, from a page that never
    // mentions billing periods. An explicit choice still wins.
    const inheritedCycle = planItem.price?.recurring?.interval === 'year' ? 'annual' : 'monthly';
    const normalizedBillingCycle = billingCycle ? normalizeBillingCycle(billingCycle) : inheritedCycle;
    // Validate the catalog BEFORE writing anything. A missing price id must fail
    // as a configuration error with nothing half-applied, never leave a
    // subscription pointing at a price that does not exist.
    //
    // exactCadence: a new checkout may degrade annual to monthly (Stripe's page
    // shows the buyer what they are about to pay); an in-place change may not,
    // because nothing shows them anything. An unset annual price is a 503 the
    // operator can fix, not a billing period the customer silently loses.
    const { basePriceId } = validateCheckoutCatalog(plan, canonicalTier, normalizedBillingCycle, { exactCadence: true });

    const { isPerSeat, quantity } = resolveSeatQuantity(plan, seats);

    // Whether this change also moves the billing PERIOD (monthly <-> annual).
    // It decides when the customer is charged, so the caller needs it to
    // describe the change truthfully: Stripe keeps the billing date only when
    // the interval is unchanged. When it changes, Stripe resets the billing
    // cycle anchor to now and invoices the prorated difference IMMEDIATELY —
    // there is no "next invoice" for it to land on.
    const intervalChanged = normalizedBillingCycle !== inheritedCycle;

    let updated;
    try {
        updated = await stripe.subscriptions.update(subscriptionId, {
            // Address the item by ID so Stripe SWAPS it. Passing only a price
            // appends a second line, which is the same duplicate charge one level
            // down.
            items: [{ id: planItem.id, price: basePriceId, quantity }],
            // The customer has already paid for part of this period at the old
            // price. Forfeiting that silently is a second charge wearing a different
            // hat. On an unchanged interval the prorations land on the next invoice
            // rather than firing an immediate card charge that could fail
            // mid-upgrade; on a changed interval Stripe bills them now regardless
            // (see intervalChanged above).
            proration_behavior: 'create_prorations',
            // A CHANGE THAT CANNOT BE PAID FOR IS NOT MADE.
            //
            // Stripe's default, allow_incomplete, applies the change even when
            // the immediate charge fails and leaves the subscription past_due:
            // a monthly Pro subscriber whose card declined on "Team - Annual"
            // was moved to Team, told the change was charged, and then locked
            // out of everything — the Pro they had paid for included — by the
            // past_due webhook.
            //
            // error_if_incomplete answers a failed charge with a 402 and leaves
            // the subscription exactly as it was, so the person can fix the card
            // and press the same button again. pending_if_incomplete would also
            // keep the old plan live, but it parks the change on the
            // subscription as a pending update that expires by itself, leaves an
            // open invoice to be paid somewhere this product never shows, and
            // refuses `metadata` on the same call — three new states to explain
            // for a result the person can reach by retrying.
            //
            // Only a changed interval invoices now, so only that path can fail
            // here; a same-interval change never touches the card.
            payment_behavior: 'error_if_incomplete',
            metadata: {
                ...(subscription.metadata || {}),
                ...(orgId ? { orgId } : {}),
                tierId: canonicalTier,
                billingCycle: normalizedBillingCycle,
                ...(isPerSeat ? { seats: String(quantity) } : {}),
            },
        });
    } catch (err) {
        // The bank wants to confirm the payment. Nothing was changed (see
        // payment_behavior above). The caller sends the person to Stripe's
        // billing page, where confirmation works; it is not built here.
        if (isPaymentError(err) && needsBankConfirmation(err)) {
            return { changed: false, reason: 'payment_requires_action', subscriptionId };
        }
        // Not an outage and not a refusal to be handed to the portal: the
        // person's card said no, and they are the only one who can change that.
        if (isPaymentError(err)) {
            return {
                changed: false,
                reason: 'payment_failed',
                subscriptionId,
                payment: {
                    code: err.code || null,
                    declineCode: err.decline_code || null,
                    // Stripe writes card-error messages for the cardholder
                    // ("Your card has insufficient funds."), so they may be shown.
                    message: typeof err.message === 'string' ? err.message : null,
                },
            };
        }
        throw err;
    }

    // THE CLAIM IS BUILT FROM WHAT STRIPE RETURNED. This used to fall back to the
    // status the subscription had BEFORE the update, which is the one value
    // guaranteed not to describe the result. A change is reported as made only
    // when the subscription Stripe hands back is paid up; anything else is
    // somebody about to be locked out, and must not be told their plan moved.
    const status = updated?.status || null;
    if (!status) return { changed: false, reason: 'unexpected_response', subscriptionId };
    if (!PAID_UP_SUBSCRIPTION_STATUSES.has(status)) {
        return { changed: false, reason: `payment_incomplete:${status}`, subscriptionId, status };
    }

    return {
        changed: true,
        reason: 'updated',
        subscriptionId,
        planId: canonicalTier,
        billingCycle: normalizedBillingCycle,
        previousBillingCycle: inheritedCycle,
        intervalChanged,
        seats: isPerSeat ? quantity : null,
        status,
    };
}

function resolvePromotionCodeId(promotionCode) {
    if (!promotionCode || typeof promotionCode !== 'string') return null;
    const normalized = promotionCode.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!normalized) return null;
    return process.env[`STRIPE_PROMOTION_CODE_${normalized}`] || null;
}

/**
 * Creates a Stripe customer for an org if one doesn't exist.
 */
async function getOrCreateCustomer(orgId, email) {
    if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.');
  
    const res = await db.query('SELECT stripe_customer_id FROM organizations WHERE org_id = $1', [orgId], orgId);
  
    if (res.rows[0]?.stripe_customer_id) {
        return res.rows[0].stripe_customer_id;
    }

    const customer = await stripe.customers.create({
        email,
        metadata: { orgId }
    });

    await db.query('UPDATE organizations SET stripe_customer_id = $1 WHERE org_id = $2', [customer.id, orgId], orgId);
    return customer.id;
}

/**
 * End a subscription Stripe reports as `incomplete` (the first payment never
 * succeeded), so that it cannot complete LATER beside the checkout that replaces
 * it: two subscriptions on one customer, both charging. Already ended or gone
 * counts as done; any other failure throws, and the caller does not open a
 * second checkout.
 */
async function cancelIncompleteSubscription(subscriptionId) {
    if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.');
    try {
        await stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
        if (err?.code === 'resource_missing' || /canceled|cancelled/i.test(err?.message || '')) return;
        throw err;
    }
}

/** Has this workspace ever had a Team trial? (organizations.team_trial_started_at,
 *  written by the Stripe webhook from a subscription Stripe confirmed.) */
async function workspaceHadTeamTrial(orgId) {
    const res = await db.query('SELECT team_trial_started_at FROM organizations WHERE org_id = $1', [orgId], orgId);
    return Boolean(res.rows[0]?.team_trial_started_at);
}

/**
 * Creates a checkout session for upgrading to a specific tier.
 */
async function createCheckoutSession(orgId, email, tierId, { dashboardUrl, billingCycle = 'monthly', promotionCode = null, campaign = null, seats = 1, purchaserUserId = null, newWorkspace = null } = {}) {
    if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.');

    // A TEAM WORKSPACE THAT DOES NOT EXIST YET (journey r6). `newWorkspace` is
    // { name, founderUserId }: `orgId` is the key it will be created under, and
    // there is no organizations row to hold a Stripe customer, so Stripe makes the
    // customer at checkout (customer_email) rather than DeerDawn making one that an
    // abandoned checkout would leave behind. The name and the founder ride in the
    // session metadata; the webhook creates the workspace when Stripe confirms the
    // subscription (workspaceService.createTeamWorkspaceAtCheckout).
    const customerId = newWorkspace ? null : await getOrCreateCustomer(orgId, email);
    const canonicalTier = normalizePlanId(tierId);
    const normalizedBillingCycle = normalizeBillingCycle(billingCycle);
    const plan = getPlan(canonicalTier);

    // Sales-assisted plans should not be self-serve checkout.
    if (!isSelfServePlan(canonicalTier)) {
        throw new Error('This plan is sales-assisted. Please contact sales to upgrade.');
    }

    if (plan.account_type === 'personal') {
        if (canonicalTier !== 'developer_basic' && canonicalTier !== 'developer_pro' && canonicalTier !== 'lifetime') {
            throw new Error('Personal workspaces are no longer supported. Please contact sales to migrate.');
        }
    }

    const { basePriceId } = validateCheckoutCatalog(plan, canonicalTier, normalizedBillingCycle);

    const baseDashboardUrl = dashboardUrl || process.env.DASHBOARD_URL;
    if (!baseDashboardUrl) {
        throw new Error('Missing DASHBOARD_URL (required for Stripe redirect URLs)');
    }

    // TRIAL. Read from the plan, like the seat floor above — the number the
    // pricing page advertises and the number Stripe applies must be the same
    // field. Only subscriptions can trial (a one-off payment has no period to
    // defer), and payment_method_collection is pinned to 'always' so a trial
    // still collects the card: Stripe's default happens to be 'always' today,
    // but the trial's whole design — converts by default at day 14 — hangs on
    // that word, so it is stated rather than inherited.
    //
    // ONE TEAM TRIAL PER WORKSPACE (the owner's decision, 2026-09-29). A workspace
    // that has ever had one goes straight to paid: no trial days reach Stripe.
    // "Had one" is organizations.team_trial_started_at, which the webhook writes
    // from a subscription Stripe CONFIRMED as a trial, so pressing this button
    // records nothing. The rule is per WORKSPACE: a person starting a trial in a
    // different, new workspace gets one.
    const planTrialDays = getCheckoutMode(canonicalTier) === 'subscription'
        ? Math.max(0, Math.floor(Number(plan.trial_days) || 0))
        : 0;
    const trialDays = planTrialDays > 0 && !(await workspaceHadTeamTrial(orgId)) ? planTrialDays : 0;

    let successUrl;
    let cancelUrl;
    try {
        // Land back on the home graph (not the billing page) so checkout ends on a
        // success confirmation over the workspace, not a settings screen. The
        // UpgradeSuccessModal reads these params: {CHECKOUT_SESSION_ID} (expanded by
        // Stripe on redirect) is the purchase_completed dedup/transaction id so a
        // refresh does not double-fire the Google Ads conversion; tier + billing let
        // it value the conversion correctly.
        const successQuery = new URLSearchParams({
            upgrade: 'success',
            tier: canonicalTier,
            billing: normalizedBillingCycle,
            session_id: '{CHECKOUT_SESSION_ID}',
            // trial=1 tells the modal this checkout collected a card and $0 —
            // it must not announce "Payment complete" about a deferred payment.
            ...(trialDays > 0 ? { trial: '1' } : {}),
            // The workspace this was bought for. The dashboard opens in it
            // (lib/api.ts, "THE WORKSPACE A RETURN LINK NAMES") rather than in
            // whichever workspace another tab chose last. Not an authority: the
            // dashboard takes it only from the person's own workspace listing,
            // and the API checks membership on every request.
            ...(orgId ? { workspace: orgId } : {}),
            ...(newWorkspace ? { new_workspace: '1' } : {}),
        });
        successUrl = new URL(`/?${successQuery.toString()}`, baseDashboardUrl)
            .toString()
            // URLSearchParams percent-encodes the braces; Stripe needs the literal token.
            .replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');
        // Abandoned: nothing was created, so there is no workspace to return to.
        // Back to the wizard that started it.
        const cancelQuery = new URLSearchParams({ canceled: 'true', ...(orgId && !newWorkspace ? { workspace: orgId } : {}) });
        cancelUrl = new URL(`${newWorkspace ? '/settings/new-team' : '/checkout'}?${cancelQuery.toString()}`, baseDashboardUrl).toString();
    } catch {
        throw new Error('Invalid DASHBOARD_URL (must be an absolute URL like https://app.deerdawn.com)');
    }

    // SEATS. A per-seat plan billed at quantity 1 charges one person's price for a
    // whole team, silently and in the customer's favour — which is still a
    // billing bug, and the kind nobody reports. Seats are clamped rather than
    // trusted: the caller is a browser.
    //
    // adjustable_quantity lets the buyer correct the count in Stripe's own UI
    // rather than going back to change it here, and the minimum is 1 because a
    // subscription for zero people is not a thing that should be purchasable.
    // The floor comes from the plan, not from a literal here: Team sells a
    // minimum of two seats because a one-seat Team is a more expensive Pro with
    // no feature that means anything alone. resolveSeatQuantity is shared with
    // changeSubscriptionPlan so an upgrade from Pro obeys the same floor as a
    // fresh purchase.
    const { isPerSeat, minSeats, quantity } = resolveSeatQuantity(plan, seats);
    const lineItems = [{
        price: basePriceId,
        quantity,
        ...(isPerSeat ? { adjustable_quantity: { enabled: true, minimum: minSeats, maximum: 500 } } : {}),
    }];
    if (plan.overage_per_decision && getCheckoutMode(canonicalTier) === 'subscription') {
        const overagePriceId = getOveragePriceId(plan, normalizedBillingCycle);
        lineItems.push({ price: overagePriceId });
    }

    const promotionCodeId = resolvePromotionCodeId(promotionCode);

    const session = await stripe.checkout.sessions.create({
        ...(customerId ? { customer: customerId } : { customer_email: email }),
        mode: getCheckoutMode(canonicalTier),
        payment_method_types: ['card'],
        ...(trialDays > 0 || newWorkspace ? {
            subscription_data: {
                ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
                // A NEW WORKSPACE'S CLAIM RIDES ON THE SUBSCRIPTION TOO. The
                // webhook creates the workspace from whichever event first shows
                // the subscription live, and a card that needed extra confirmation
                // completes the checkout while it is still incomplete: the event
                // that turns it active is a subscription update or a paid invoice,
                // which carry the subscription's metadata, not the session's.
                ...(newWorkspace ? {
                    metadata: {
                        orgId,
                        tierId: canonicalTier,
                        newWorkspaceName: String(newWorkspace.name).trim().slice(0, 120),
                        founderUserId: String(newWorkspace.founderUserId),
                    },
                } : {}),
            },
            ...(trialDays > 0 ? { payment_method_collection: 'always' } : {}),
        } : {}),
        allow_promotion_codes: true,
        ...(promotionCodeId ? { discounts: [{ promotion_code: promotionCodeId }] } : {}),
        line_items: lineItems,
        metadata: {
            orgId,
            tierId: canonicalTier,
            billingCycle: normalizedBillingCycle,
            // Carried into the webhook so the seat cap can be set from what was
            // actually bought rather than from the plan's default.
            ...(isPerSeat ? { seats: String(quantity) } : {}),
            ...(promotionCode ? { promotionCode: String(promotionCode).trim().toUpperCase() } : {}),
            ...(campaign ? { campaign: String(campaign).trim() } : {}),
            // The person who pressed the button, so the webhook can record who
            // pays (services/billingOwnerService.js recordPurchaser). A person,
            // never a card: the card lives only in Stripe. A new team workspace's
            // founder is its purchaser.
            ...((purchaserUserId || newWorkspace?.founderUserId)
                ? { purchaserUserId: String(purchaserUserId || newWorkspace.founderUserId) }
                : {}),
            ...(newWorkspace ? {
                newWorkspaceName: String(newWorkspace.name).trim().slice(0, 120),
                founderUserId: String(newWorkspace.founderUserId),
            } : {}),
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
    });

    return session.url;
}

/**
 * Cancel an org's Stripe subscription because the account (or org) is being
 * deleted. One helper for every deletion path — the account route, the org
 * route, and the Clerk user.deleted webhook — so none of them can drift into
 * purging data while the card keeps getting charged, which is exactly the bug
 * this replaces: every deletion path erased the data and left the subscription
 * billing a customer who no longer existed.
 *
 * Returns { ok, cancelled, reason }. `ok: false` means a subscription that
 * could still bill exists and could not be confirmed cancelled — interactive
 * callers must refuse to delete anything on that answer, because "data gone,
 * billing alive" is the one end state this function exists to prevent.
 * Idempotent: a subscription that is already cancelled, or gone from Stripe
 * entirely, is success.
 *
 * EVERY SUBSCRIPTION ON THE CUSTOMER, NOT ONLY THE ONE THE ROW NAMES. This
 * cancelled organizations.stripe_subscription_id and answered `no_subscription`
 * when it was empty. A customer can be paying for a subscription the row does
 * not record — a second checkout opened while the first one's webhook was late,
 * one made by hand in the Stripe dashboard, one left behind after a refund
 * cleared the column — and deleting the account left it charging a card for an
 * account that no longer existed, with no org row left for its webhooks to
 * find. The customer id is unique to this org, so everything on it is this
 * org's to cancel.
 */
async function cancelSubscriptionForDeletion(orgId) {
    let subscriptionId;
    let customerId;
    try {
        const r = await db.query(
            'SELECT stripe_subscription_id FROM organizations WHERE org_id = $1',
            [orgId],
            orgId
        );
        subscriptionId = r.rows[0]?.stripe_subscription_id || null;
        const c = await db.query(
            'SELECT stripe_customer_id FROM organizations WHERE org_id = $1',
            [orgId],
            orgId
        );
        customerId = c.rows[0]?.stripe_customer_id || null;
    } catch (err) {
        return { ok: false, cancelled: false, reason: `lookup_failed:${err.message}` };
    }
    if (!subscriptionId && !customerId) {
        return { ok: true, cancelled: false, reason: 'no_subscription' };
    }
    if (!stripe) {
        // A recorded subscription, or a customer that may carry one, with no way
        // to reach Stripe is a failure, not a pass — deleting anyway would
        // strand the billing.
        return { ok: false, cancelled: false, reason: 'stripe_not_configured' };
    }

    // What to cancel, read from Stripe rather than from the row.
    const targets = [];
    if (customerId) {
        let listed;
        try {
            listed = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
        } catch (err) {
            // A customer deleted in Stripe took its subscriptions with it. Any
            // other failure is "could not tell", which is not permission.
            if (err?.code !== 'resource_missing') {
                return { ok: false, cancelled: false, reason: `stripe_error:listing subscriptions:${err.message}` };
            }
            listed = { data: [] };
        }
        // More than a page means some were not seen, so none can be vouched for.
        if (listed?.has_more) {
            return { ok: false, cancelled: false, reason: 'too_many_subscriptions' };
        }
        const data = listed?.data || [];
        // Anything not already over can still bill: past_due and unpaid can be
        // paid, incomplete can be completed, trialing converts by itself.
        for (const sub of data) {
            if (sub?.id && !ENDED_SUBSCRIPTION_STATUSES.has(sub.status)) targets.push(sub.id);
        }
        // The row's own, if Stripe did not list it under this customer at all:
        // asked for by id, exactly as before, rather than assumed gone.
        if (subscriptionId && !data.some((sub) => sub?.id === subscriptionId)) targets.push(subscriptionId);
    } else {
        targets.push(subscriptionId);
    }

    if (targets.length === 0) {
        return { ok: true, cancelled: false, reason: 'no_subscription' };
    }

    const outcomes = [];
    for (const id of targets) {
        outcomes.push(await cancelOneForDeletion(id));
    }
    const failed = outcomes.find((outcome) => !outcome.ok);
    const cancelled = outcomes.some((outcome) => outcome.cancelled);
    if (failed) {
        return { ok: false, cancelled, reason: failed.reason, subscriptions: targets };
    }
    return {
        ok: true,
        cancelled,
        reason: outcomes.length === 1 ? outcomes[0].reason : 'cancelled',
        subscriptions: targets,
    };
}

/** Statuses after which a subscription can never charge again. */
const ENDED_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);

/** One cancellation, judged by Stripe's read-back. */
async function cancelOneForDeletion(subscriptionId) {
    try {
        const sub = await stripe.subscriptions.cancel(subscriptionId);
        // The success claim is built from the read-back, not the request.
        if (sub?.status !== 'canceled') {
            return { ok: false, cancelled: false, reason: `unexpected_status:${sub?.status}` };
        }
        return { ok: true, cancelled: true, reason: 'cancelled' };
    } catch (err) {
        // Already gone from Stripe (deleted in the dashboard, test-mode reset) or
        // already cancelled: the end state we wanted exists, so deletion may proceed.
        if (err?.code === 'resource_missing') {
            return { ok: true, cancelled: false, reason: 'subscription_missing_in_stripe' };
        }
        if (/canceled/i.test(err?.message || '')) {
            return { ok: true, cancelled: false, reason: 'already_cancelled' };
        }
        return { ok: false, cancelled: false, reason: `stripe_error:${err.message}` };
    }
}

/**
 * A PERSON CHANGED THEIR EMAIL IN CLERK; THEIR RECEIPTS SHOULD FOLLOW.
 *
 * The Stripe customer is created with the checking-out person's address and
 * never touched again, so after an email change invoices, receipts and dunning
 * mail kept going to the old address (possibly a mailbox the person no longer
 * controls) while DeerDawn's own row moved.
 *
 * Only customers this person is the BILLING OWNER of are touched: workspaces
 * they own (their personal org, and any workspace where they hold the owner
 * role) whose Stripe customer's email is still the person's OLD address. A
 * co-owner's billing address is never overwritten by somebody else's change.
 *
 * Best-effort and never throws: every failure is returned as a count for the
 * caller to report. The client is read at call time (module.exports.stripe) so
 * a test can substitute it without a network.
 */
async function syncCustomerEmailForPerson({ userId, oldEmail, newEmail, client = null } = {}) {
    const result = { checked: 0, updated: 0, failed: 0, reason: null };
    const stripeClient = client || module.exports.stripe;
    if (!userId || !oldEmail || !newEmail) return { ...result, reason: 'missing_input' };
    if (!stripeClient) return { ...result, reason: 'stripe_not_configured' };

    let rows;
    try {
        const r = await db.query(
            `SELECT o.org_id, o.stripe_customer_id
               FROM organizations o
              WHERE o.stripe_customer_id IS NOT NULL
                AND (o.org_id = (SELECT org_id FROM users WHERE user_id = $1)
                     OR o.org_id IN (SELECT owner_key FROM workspace_members
                                      WHERE user_id = $1 AND role = 'owner' AND removed_at IS NULL))`,
            [userId],
            'org-system'
        );
        rows = r.rows;
    } catch (err) {
        return { ...result, failed: 1, reason: `lookup_failed:${err.code || err.message}` };
    }

    const old = String(oldEmail).toLowerCase();
    for (const { stripe_customer_id: customerId } of rows) {
        result.checked += 1;
        try {
            const customer = await stripeClient.customers.retrieve(customerId);
            if (!customer || customer.deleted) continue;
            if (String(customer.email || '').toLowerCase() !== old) continue;
            await stripeClient.customers.update(customerId, { email: newEmail });
            result.updated += 1;
        } catch (err) {
            result.failed += 1;
            result.reason = `stripe_error:${err.code || err.message}`;
        }
    }
    return result;
}

/**
 * Generates a Billing Portal link for managing payment methods/invoices.
 */
// Turn a high-level intent from the dashboard billing card into Stripe portal
// flow_data so the button deep-links straight into that flow instead of the
// portal home. Unknown intents (or "cancel" with no subscription on file) return
// null, so the session falls back to the portal home and never errors.
function buildPortalFlowData(flow, subscriptionId) {
    if (flow === 'payment_method') {
        return { type: 'payment_method_update' };
    }
    if (flow === 'cancel' && subscriptionId) {
        return {
            type: 'subscription_cancel',
            subscription_cancel: { subscription: subscriptionId },
        };
    }
    return null;
}

async function createPortalSession(orgId, { dashboardUrl, flow = null } = {}) {
    if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.');

    const res = await db.query(
        'SELECT stripe_customer_id, stripe_subscription_id FROM organizations WHERE org_id = $1',
        [orgId],
        orgId
    );
    const customerId = res.rows[0]?.stripe_customer_id;
    const subscriptionId = res.rows[0]?.stripe_subscription_id;

    if (!customerId) throw new Error('No billing account found');

    const baseDashboardUrl = dashboardUrl || process.env.DASHBOARD_URL;
    if (!baseDashboardUrl) {
        throw new Error('Missing DASHBOARD_URL (required for Stripe redirect URLs)');
    }

    let returnUrl;
    try {
        // Names the workspace this portal session is for, as the checkout's
        // success URL does, so the person comes back to it.
        returnUrl = new URL(`/settings/plan?${new URLSearchParams({ workspace: orgId }).toString()}`, baseDashboardUrl).toString();
    } catch {
        throw new Error('Invalid DASHBOARD_URL (must be an absolute URL like https://app.deerdawn.com)');
    }

    const params = {
        customer: customerId,
        return_url: returnUrl,
    };

    const flowData = buildPortalFlowData(flow, subscriptionId);
    if (flowData) params.flow_data = flowData;

    const session = await stripe.billingPortal.sessions.create(params);

    return session.url;
}

/**
 * Reports usage delta to Stripe.
 */
async function reportUsage(orgId, quantity, timestamp = Math.floor(Date.now() / 1000)) {
    if (!stripe) {
    // Fail silently for usage reporting in dev/sandbox if not configured
        console.warn(`[STRIPE] Usage report skipped for Org ${orgId}: Stripe not configured.`);
        return;
    }
  
    const res = await db.query(
        'SELECT stripe_subscription_id, stripe_customer_id FROM organizations WHERE org_id = $1',
        [orgId],
        orgId
    );
    const subId = res.rows[0]?.stripe_subscription_id;
    const customerId = res.rows[0]?.stripe_customer_id;

    if (!subId) return; // No subscription to report to

    const sub = await stripe.subscriptions.retrieve(subId);
    const meteredItem = sub.items.data.find((item) => item.price?.recurring?.usage_type === 'metered');

    if (meteredItem) {
        if (meteredItem.price?.recurring?.meter) {
            if (!customerId) {
                console.warn(`[STRIPE] Meter event skipped for Org ${orgId}: missing stripe_customer_id.`);
                return;
            }

            await stripe.billing.meterEvents.create({
                event_name: PROTECTED_ACTIONS_METER_EVENT,
                payload: {
                    stripe_customer_id: customerId,
                    value: String(quantity),
                },
                timestamp,
            });
            return;
        }

        await stripe.subscriptionItems.createUsageRecord(meteredItem.id, {
            quantity: quantity,
            timestamp: timestamp,
            action: 'increment',
        });
    }
}

module.exports = {
    stripe,
    CLIENT_OPTIONS,
    WEBHOOK_READ_OPTIONS,
    getOrCreateCustomer,
    createCheckoutSession,
    changeSubscriptionPlan,
    cancelIncompleteSubscription,
    createPortalSession,
    cancelSubscriptionForDeletion,
    syncCustomerEmailForPerson,
    reportUsage,
    // Price resolution decides whether a checkout can happen at all, and its
    // annual-price fallback is the difference between a monthly sale and no
    // sale. Exposed for direct unit coverage rather than only being reachable
    // through a live Stripe call.
    __testables: { getBasePriceId, validateCheckoutCatalog, resolveSeatQuantity },
};
