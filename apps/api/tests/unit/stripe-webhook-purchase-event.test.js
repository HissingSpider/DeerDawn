process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_purchase';
// A per-seat price id must exist BEFORE plans.js first loads (it reads env at
// require time), or getSeatsFromSubscription cannot recognise the Team line
// item and every seat-count assertion silently degrades to null.
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly_test';
// The Pro price the SUBSCRIPTION fixture below is on. It must be in the price
// map too: a purchase at a price the map does not know grants nothing, and a
// workspace that received no plan reports no purchase (owner's decision,
// 2026-09-28). Before that, an unmapped price fell back to the session's tier,
// and this fixture relied on it without saying so.
process.env.STRIPE_PRICE_DEVELOPER_BASIC = process.env.STRIPE_PRICE_DEVELOPER_BASIC || 'price_developer_basic_monthly';

// B-2 — purchase_completed is emitted server-side, from the Stripe webhook.
//
// The client-side copy (UpgradeSuccessModal) only fires if the buyer's browser
// makes it back to the dashboard, and this team has been burned by client-only
// funnel events before. These tests pin the three things that make the server
// event trustworthy: it fires on a real checkout, it carries what revenue
// reporting needs, and a re-delivered webhook does not double-count it.

// MRR is booked at the plan's LIST price (webhooks-stripe.js planMrrCents), so
// the expected figures are read from plans.js rather than typed: they changed
// with the 2026-11 hosted pricing (Individual $12, Team $15 a seat). Lazy, so
// plans.js is loaded after this file has set its env.
function mrrCents(planId, seats = 1) {
    return require('../../src/config/plans').PLANS[planId].price * 100 * seats;
}

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const DB_PATH = require.resolve('../../src/config/db');
const REDIS_PATH = require.resolve('../../src/config/redis');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const PRODUCT_EVENTS_PATH = require.resolve('../../src/services/productEventsService');
const RETENTION_LEDGER_PATH = require.resolve('../../src/services/retentionLedger');
const ROUTE_PATH = require.resolve('../../src/routes/webhooks-stripe');

// The subscription Stripe hands back for a monthly Founding Pro checkout. Only
// the fields the handler reads are modelled.
const SUBSCRIPTION = {
    id: 'sub_test_1',
    status: 'active',
    items: { data: [{ current_period_start: 1755000000, current_period_end: 1757678400, price: { id: 'price_developer_basic_monthly' } }] },
};

/**
 * A Postgres double that models the ONE behaviour this test turns on: the
 * stripe_events insert only claims an event id once, exactly like the real
 * ON CONFLICT ... WHERE status = 'failed'. Everything else answers with the
 * narrowest row the handler needs.
 */
function makeDb({ priorTier = 'free', buyerUserId = 'user-buyer-1' } = {}) {
    const claimedEvents = new Set();
    const statements = [];

    async function query(text, params = []) {
        statements.push({ text, params });
        if (/INSERT INTO stripe_events/.test(text) && /'processing'/.test(text)) {
            const eventId = params[0];
            if (claimedEvents.has(eventId)) return { rows: [], rowCount: 0 };
            claimedEvents.add(eventId);
            return { rows: [{ event_id: eventId }], rowCount: 1 };
        }
        if (/SELECT plan_tier FROM organizations/.test(text)) {
            return { rows: [{ plan_tier: priorTier }], rowCount: 1 };
        }
        if (/SELECT user_id FROM users/.test(text)) {
            return buyerUserId ? { rows: [{ user_id: buyerUserId }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/UPDATE organizations/.test(text)) {
            return { rows: [{ org_id: params[params.length - 1] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }

    return {
        statements,
        module: {
            query,
            pool: { connect: async () => ({ query, release() {} }) },
        },
    };
}

/**
 * Load the router with its collaborators replaced. Stripe is stubbed at the
 * stripeService boundary (not the vendor lib) because the route only ever
 * reaches Stripe through that module, and signature verification has its own
 * coverage in tests/layer7-security.test.js.
 */
function loadRoute({ event, db, subscription = SUBSCRIPTION }) {
    const recorded = [];
    const ledger = [];
    const stripeStub = {
        stripe: {
            webhooks: { constructEvent: () => event },
            subscriptions: { retrieve: async () => subscription },
            subscriptionSchedules: { retrieve: async () => null, create: async () => ({ id: 'sched_1' }), update: async () => ({}) },
            charges: { retrieve: async () => ({}) },
        },
    };

    for (const path of [DB_PATH, REDIS_PATH, STRIPE_SERVICE_PATH, PRODUCT_EVENTS_PATH, RETENTION_LEDGER_PATH, ROUTE_PATH]) {
        delete require.cache[path];
    }
    // The ledger is stubbed at its module boundary (like productEvents) so the
    // MRR each webhook books is assertable directly — the trial's entire revenue
    // contract is a number in this array.
    require.cache[RETENTION_LEDGER_PATH] = {
        id: RETENTION_LEDGER_PATH,
        filename: RETENTION_LEDGER_PATH,
        loaded: true,
        exports: {
            recordSubscriptionEvent: async (ledgerEvent) => { ledger.push(ledgerEvent); },
        },
    };
    require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: db.module };
    require.cache[REDIS_PATH] = { id: REDIS_PATH, filename: REDIS_PATH, loaded: true, exports: { redis: { del: async () => 1 } } };
    require.cache[STRIPE_SERVICE_PATH] = { id: STRIPE_SERVICE_PATH, filename: STRIPE_SERVICE_PATH, loaded: true, exports: stripeStub };
    require.cache[PRODUCT_EVENTS_PATH] = {
        id: PRODUCT_EVENTS_PATH,
        filename: PRODUCT_EVENTS_PATH,
        loaded: true,
        exports: {
            recordProductEvent: async (actor, input) => { recorded.push({ actor, input }); return {}; },
        },
    };

    const router = require(ROUTE_PATH);
    return { router, recorded, ledger };
}

/** Deliver the payload through the real router over real HTTP, as Stripe does. */
async function deliver(router, body) {
    const app = express();
    app.use('/hook', router);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=stub' },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

const ORG_ID = 'org-11111111-2222-3333-4444-555555555555';

function checkoutEvent(overrides = {}) {
    return {
        id: overrides.id || 'evt_checkout_1',
        type: 'checkout.session.completed',
        data: {
            object: {
                id: 'cs_test_abc123',
                mode: 'subscription',
                customer: 'cus_test_1',
                subscription: SUBSCRIPTION.id,
                amount_total: 9600,
                currency: 'usd',
                metadata: { orgId: ORG_ID, tierId: 'developer_basic', billingCycle: 'annual' },
                ...(overrides.session || {}),
            },
        },
    };
}

test('a completed checkout emits purchase_completed with plan, period, amount and currency', async () => {
    const db = makeDb();
    const { router, recorded } = loadRoute({ event: checkoutEvent(), db });

    const res = await deliver(router, { stub: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { received: true });

    assert.equal(recorded.length, 1, 'exactly one purchase event per checkout');
    const { actor, input } = recorded[0];
    assert.equal(input.event_name, 'purchase_completed');
    assert.equal(input.source, 'api');
    assert.equal(input.surface, 'stripe_webhook');

    assert.equal(input.metadata.tier, 'developer_basic');
    assert.equal(input.metadata.billing, 'annual');
    assert.equal(input.metadata.amount_cents, 9600);
    assert.equal(input.metadata.value, 96);
    assert.equal(input.metadata.currency, 'usd');
    // Same key the client-side event uses, so the two copies of one purchase
    // are joinable in PostHog instead of looking like two sales.
    assert.equal(input.metadata.transaction_id, 'cs_test_abc123');

    // Attributed to the buyer, not the org: recordProductEvent's PostHog
    // distinctId falls back to the org id when the actor has no user, and the
    // rest of the revenue funnel is keyed on the person.
    assert.equal(actor.type, 'user');
    assert.equal(actor.id, 'user-buyer-1');
    assert.equal(actor.org_id, ORG_ID);
});

test('a first paid subscription is marked new, an upgrade off a paid plan is marked upgrade', async () => {
    const fromFree = loadRoute({ event: checkoutEvent(), db: makeDb({ priorTier: 'free' }) });
    await deliver(fromFree.router, { stub: true });
    assert.equal(fromFree.recorded[0].input.metadata.subscription_type, 'new');
    assert.equal(fromFree.recorded[0].input.metadata.prior_tier, 'free');

    // A genuine upgrade moves BETWEEN tiers, so the prior tier differs from the
    // one being bought. (Buying the tier you are already on is not an upgrade —
    // it is the out-of-order-delivery race asserted in the next test.)
    const fromPaid = loadRoute({
        event: checkoutEvent({ session: { metadata: { orgId: ORG_ID, tierId: 'developer_pro', billingCycle: 'annual' } } }),
        db: makeDb({ priorTier: 'developer_basic' }),
    });
    await deliver(fromPaid.router, { stub: true });
    assert.equal(fromPaid.recorded[0].input.metadata.subscription_type, 'upgrade');
    assert.equal(fromPaid.recorded[0].input.metadata.prior_tier, 'developer_basic');
});

test('an out-of-order subscription.updated cannot turn a new purchase into a fake upgrade', async () => {
    // customer.subscription.updated for THIS purchase can be processed first and,
    // through reconcileSubscriptionState's stripe_customer_id fallback, will have
    // already written the purchased tier onto the org. Reading plan_tier then
    // returns the tier being bought. Nobody upgrades to the plan they are on, so
    // that equality is the race's signature: report 'new', and report the true
    // prior tier as unknown rather than inventing 'free'.
    const raced = loadRoute({ event: checkoutEvent(), db: makeDb({ priorTier: 'developer_basic' }) });
    await deliver(raced.router, { stub: true });
    assert.equal(raced.recorded[0].input.metadata.subscription_type, 'new');
    assert.equal(raced.recorded[0].input.metadata.prior_tier, null);
});

test('a re-delivered webhook does not double-count the purchase', async () => {
    // Stripe re-delivers until it gets a 2xx, and re-deliveries carry the SAME
    // event id. The stripe_events claim above the switch is what makes the
    // purchase event idempotent — this asserts the wiring actually rides on it.
    const db = makeDb();
    const event = checkoutEvent();
    const { router, recorded } = loadRoute({ event, db });

    const first = await deliver(router, { stub: true });
    const second = await deliver(router, { stub: true });

    assert.deepEqual(first.body, { received: true });
    assert.deepEqual(second.body, { received: true, duplicate: true });
    assert.equal(recorded.length, 1, 'the second delivery must not emit a second purchase');
});

test('a lifetime (one-time payment) checkout reports its period as one_time', async () => {
    // mode 'payment' has no billing cycle at all, and metadata.billingCycle
    // would still say "monthly" — reporting that would be wrong.
    const db = makeDb();
    const event = checkoutEvent({
        id: 'evt_checkout_lifetime',
        session: { mode: 'payment', subscription: null, amount_total: 25000, metadata: { orgId: ORG_ID, tierId: 'lifetime', billingCycle: 'monthly' } },
    });
    const { router, recorded } = loadRoute({ event, db });

    await deliver(router, { stub: true });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].input.metadata.tier, 'lifetime');
    assert.equal(recorded[0].input.metadata.billing, 'one_time');
    assert.equal(recorded[0].input.metadata.mode, 'payment');
    assert.equal(recorded[0].input.metadata.value, 250);
});

// ---------------------------------------------------------------------------
// Team's 14-day trial. The subscription arrives with status 'trialing' and $0
// collected; the revenue gates read the subscription_events ledger, so the one
// thing that must never happen is a trial booking MRR the day it starts.
// ---------------------------------------------------------------------------

/** A Team checkout that landed in a trial: three seats, $0 collected. */
function teamTrialCheckout(overrides = {}) {
    return checkoutEvent({
        id: overrides.id || 'evt_checkout_trial_1',
        session: {
            amount_total: 0,
            metadata: { orgId: ORG_ID, tierId: 'developer_pro', billingCycle: 'monthly' },
            ...(overrides.session || {}),
        },
    });
}

const TEAM_TRIAL_SUBSCRIPTION = {
    id: SUBSCRIPTION.id,
    status: 'trialing',
    items: { data: [{ current_period_start: 1755000000, current_period_end: 1757678400, quantity: 3, price: { id: process.env.STRIPE_PRICE_DEVELOPER_PRO } }] },
};

test('a trialing checkout books ZERO MRR and flags the purchase event as a trial', async () => {
    const db = makeDb();
    const { router, recorded, ledger } = loadRoute({
        event: teamTrialCheckout(),
        db,
        subscription: TEAM_TRIAL_SUBSCRIPTION,
    });

    const res = await deliver(router, { stub: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const created = ledger.find((e) => e.event_type === 'created');
    assert.ok(created, 'the trial still writes a created row — the relationship exists');
    assert.equal(created.plan_tier, 'developer_pro');
    assert.equal(created.mrr_cents, 0,
        'a trial that books MRR on day zero lets the revenue gates pass on money that may never arrive');

    // Attribution must be able to tell a trial from a sale: this "purchase"
    // collected $0.
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].input.metadata.is_trial, true);
    assert.equal(recorded[0].input.metadata.amount_cents, 0);
});

test('a paid (non-trial) per-seat checkout books price × seats, not one seat', async () => {
    const db = makeDb();
    const activeTeam = { ...TEAM_TRIAL_SUBSCRIPTION, status: 'active' };
    const { router, recorded, ledger } = loadRoute({
        event: teamTrialCheckout({ id: 'evt_checkout_team_paid', session: { amount_total: 4500 } }),
        db,
        subscription: activeTeam,
    });

    await deliver(router, { stub: true });

    const created = ledger.find((e) => e.event_type === 'created');
    assert.ok(created);
    // $15/seat × 3 seats. Before this, every Team sale under-reported at $15
    // flat — planMrrCents ignored quantity entirely.
    assert.equal(created.mrr_cents, mrrCents('developer_pro', 3));
    assert.equal(recorded[0].input.metadata.is_trial, false);
});

test('the trial converts through invoice.payment_succeeded, where the MRR finally lands', async () => {
    // Stripe bills the day-14 conversion with billing_reason 'subscription_cycle'
    // — the same reason as a renewal — so the renewal handler is the conversion
    // handler. It must price from purchased_seats, or a 3-seat team converts at
    // one seat's worth.
    const db = makeDb();
    const invoiceEvent = {
        id: 'evt_invoice_conversion_1',
        type: 'invoice.payment_succeeded',
        data: { object: { billing_reason: 'subscription_cycle', customer: 'cus_test_1', subscription: SUBSCRIPTION.id } },
    };
    // The org row as reconcile left it at checkout: Team, three purchased seats.
    const dbModule = db.module;
    const origQuery = dbModule.query;
    dbModule.query = async (text, params) => {
        if (/SELECT org_id, plan_tier, purchased_seats FROM organizations/.test(text)) {
            return { rows: [{ org_id: ORG_ID, plan_tier: 'developer_pro', purchased_seats: 3 }], rowCount: 1 };
        }
        return origQuery(text, params);
    };
    dbModule.pool = { connect: async () => ({ query: dbModule.query, release() {} }) };

    const { router, ledger } = loadRoute({ event: invoiceEvent, db });
    const res = await deliver(router, { stub: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const renewed = ledger.find((e) => e.event_type === 'renewed');
    assert.ok(renewed, 'the conversion invoice must write a renewed row');
    assert.equal(renewed.plan_tier, 'developer_pro');
    assert.equal(renewed.mrr_cents, mrrCents('developer_pro', 3), 'conversion prices at the purchased seat count');
});

test('a rejected checkout session emits nothing', async () => {
    // Invalid metadata throws before COMMIT, so nothing was persisted — a
    // purchase event here would be a phantom sale in the revenue funnel.
    const db = makeDb();
    const event = checkoutEvent({ id: 'evt_checkout_bad', session: { metadata: { orgId: 'not-an-org-id', tierId: 'developer_basic' } } });
    const { router, recorded } = loadRoute({ event, db });

    const res = await deliver(router, { stub: true });
    assert.equal(res.status, 500);
    assert.equal(recorded.length, 0);
});

test('a renewal reaches product analytics as subscription_lifecycle, not only the ledger', async () => {
    // Until 2026-09-16 PostHog saw purchase_completed and nothing after it, so
    // churn and LTV could not be read against the funnel that bought them.
    const db = makeDb();
    const invoiceEvent = {
        id: 'evt_invoice_renewal_ph',
        type: 'invoice.payment_succeeded',
        data: { object: { billing_reason: 'subscription_cycle', customer: 'cus_test_1', subscription: SUBSCRIPTION.id } },
    };
    const dbModule = db.module;
    const origQuery = dbModule.query;
    dbModule.query = async (text, params) => {
        if (/SELECT org_id, plan_tier, purchased_seats FROM organizations/.test(text)) {
            return { rows: [{ org_id: ORG_ID, plan_tier: 'developer_basic', purchased_seats: null }], rowCount: 1 };
        }
        return origQuery(text, params);
    };
    dbModule.pool = { connect: async () => ({ query: dbModule.query, release() {} }) };

    const { router, recorded } = loadRoute({ event: invoiceEvent, db });
    const res = await deliver(router, { stub: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await new Promise((resolve) => setImmediate(resolve));

    const lifecycle = recorded.filter((r) => r.input.event_name === 'subscription_lifecycle');
    assert.equal(lifecycle.length, 1);
    assert.equal(lifecycle[0].input.metadata.event_type, 'renewed');
    assert.equal(lifecycle[0].input.metadata.stripe_event_id, 'evt_invoice_renewal_ph');
    assert.equal(lifecycle[0].actor.id, 'user-buyer-1', 'attributed to the buyer, like purchase_completed');
});

test('a checkout does not also emit a lifecycle event (purchase_completed is that event)', async () => {
    const db = makeDb();
    const { router, recorded } = loadRoute({ event: checkoutEvent({ id: 'evt_checkout_no_dup' }), db });
    await deliver(router, { stub: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded.filter((r) => r.input.event_name === 'subscription_lifecycle').length, 0);
});
