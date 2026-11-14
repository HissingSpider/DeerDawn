'use strict';

/**
 * A PLAN CHANGE MOVES THE SUBSCRIPTION YOU HAVE. IT DOES NOT OPEN A SECOND ONE.
 *
 * POST /billing/checkout checked only that the requested tier ranked above the
 * org's current one, and then created a Stripe Checkout session unconditionally.
 * For a Pro subscriber upgrading to Team that produced TWO live subscriptions on
 * one customer: $12/mo and $30/mo, both billing, both real. The org row holds a
 * single stripe_subscription_id, so the webhook then overwrote Pro's id with
 * Team's and the first subscription stopped existing as far as DeerDawn was
 * concerned — invisible to us, and on the customer's card every month.
 *
 * Nothing errored at any point. The buyer saw a normal Stripe page, paid, and
 * got the plan they asked for; the second charge only shows up on a statement.
 *
 * These tests pin the shape of the fix rather than one path through it: when a
 * live subscription exists the API UPDATES it (price + quantity, prorated) and
 * returns no checkout URL; when there is nothing live to move, a real checkout
 * is still the right answer.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_upgrade';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = 'price_pro_monthly';
process.env.STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL = 'price_pro_annual';
process.env.STRIPE_PRICE_DEVELOPER_PRO = 'price_team_monthly';
process.env.STRIPE_PRICE_DEVELOPER_PRO_ANNUAL = 'price_team_annual';
process.env.DASHBOARD_URL = 'https://app.deerdawn.com';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const STRIPE_LIB = require.resolve('stripe');
const DB_PATH = require.resolve('../../src/config/db');
const AUTH_PATH = require.resolve('../../src/middleware/auth');
const WORKSPACE_PATH = require.resolve('../../src/services/workspaceService');
const ENFORCEMENT_PATH = require.resolve('../../src/services/enforcementService');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const BILLING_PATH = require.resolve('../../src/routes/shared/billing');

const ORG_ID = 'org-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** A live Pro subscription: one plan line item, plus an add-on that is not one. */
function proSubscription(overrides = {}) {
    return {
        id: 'sub_pro_1',
        status: 'active',
        customer: 'cus_1',
        metadata: {},
        items: {
            data: [
                { id: 'si_plan', quantity: 1, price: { id: 'price_pro_monthly' } },
                // Deliberately first-looking noise: an add-on line has its own
                // quantity and its own price, and repricing it would move the
                // wrong item while leaving the plan exactly where it was.
                { id: 'si_addon', quantity: 3, price: { id: 'price_some_addon' } },
            ],
        },
        ...overrides,
    };
}

/** Load stripeService with a recording Stripe double. */
function loadStripeService({ subscription = proSubscription(), retrieveError = null } = {}) {
    const calls = { checkoutSessions: [], subscriptionUpdates: [], portalSessions: [] };

    class MockStripe {
        constructor() {
            this.customers = { create: async () => ({ id: 'cus_1' }) };
            this.checkout = {
                sessions: {
                    create: async (payload) => {
                        calls.checkoutSessions.push(payload);
                        return { url: 'https://checkout.stripe.test/new_session' };
                    },
                },
            };
            this.billingPortal = {
                sessions: {
                    create: async (payload) => {
                        calls.portalSessions.push(payload);
                        return { url: 'https://billing.stripe.test/portal' };
                    },
                },
            };
            this.subscriptions = {
                retrieve: async () => {
                    if (retrieveError) throw retrieveError;
                    return subscription;
                },
                update: async (id, payload) => {
                    calls.subscriptionUpdates.push({ id, payload });
                    return { ...subscription, id, status: subscription.status };
                },
                list: async () => ({ data: [] }),
            };
            this.billing = { meterEvents: { create: async () => ({}) } };
            this.subscriptionItems = { createUsageRecord: async () => ({}) };
        }
    }

    for (const p of [STRIPE_SERVICE_PATH, DB_PATH]) delete require.cache[p];
    require.cache[STRIPE_LIB] = { id: STRIPE_LIB, filename: STRIPE_LIB, loaded: true, exports: MockStripe };
    require.cache[DB_PATH] = {
        id: DB_PATH,
        filename: DB_PATH,
        loaded: true,
        exports: {
            query: async (sql) => {
                if (/SELECT stripe_customer_id/.test(sql)) return { rows: [{ stripe_customer_id: 'cus_1', stripe_subscription_id: subscription?.id || null }] };
                return { rows: [] };
            },
            pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) },
        },
    };

    return { service: require(STRIPE_SERVICE_PATH), calls };
}

test('an upgrade reprices the EXISTING subscription instead of opening a second one', async () => {
    const { service, calls } = loadStripeService();
    assert.ok(typeof service.changeSubscriptionPlan === 'function',
        'stripeService must expose a way to move a subscription between plans');

    const result = await service.changeSubscriptionPlan('sub_pro_1', 'developer_pro', {
        orgId: ORG_ID,
        billingCycle: 'monthly',
        seats: 4,
    });

    assert.strictEqual(result.changed, true, JSON.stringify(result));
    assert.strictEqual(calls.checkoutSessions.length, 0,
        'a plan change must never create a checkout session — that is the second subscription');
    assert.strictEqual(calls.subscriptionUpdates.length, 1);

    const [{ id, payload }] = calls.subscriptionUpdates;
    assert.strictEqual(id, 'sub_pro_1');
    // The PLAN item is the one repriced, addressed by its own id so Stripe
    // swaps it rather than appending a line beside it.
    assert.deepStrictEqual(payload.items, [{ id: 'si_plan', price: 'price_team_monthly', quantity: 4 }]);
    // The customer has already paid for part of this period at the old price.
    // Forfeiting it silently is a second charge wearing a different hat.
    assert.strictEqual(payload.proration_behavior, 'create_prorations');
});

test('the seat floor still applies to a plan change, not only to a new checkout', () => {
    // A one-seat Team costs more than Pro and does less. The floor cannot live
    // only on the checkout path, or the upgrade path sells the thing the floor
    // exists to prevent.
    const { PLANS } = require('../../src/config/plans');
    assert.strictEqual(PLANS.developer_pro.limits.minimum_seats, 2);
});

test('a Team upgrade asking for one seat is raised to the floor', async () => {
    const { service, calls } = loadStripeService();
    await service.changeSubscriptionPlan('sub_pro_1', 'developer_pro', { orgId: ORG_ID, seats: 1 });
    assert.strictEqual(calls.subscriptionUpdates[0].payload.items[0].quantity, 2);
});

test('a subscription that is no longer live is reported, not updated', async () => {
    // Nothing is being billed, so a fresh checkout is the correct answer and the
    // caller has to be able to tell the two cases apart.
    const { service, calls } = loadStripeService({ subscription: proSubscription({ status: 'canceled' }) });
    const result = await service.changeSubscriptionPlan('sub_pro_1', 'developer_pro', { orgId: ORG_ID });
    assert.strictEqual(result.changed, false);
    assert.match(String(result.reason), /not_live/);
    assert.strictEqual(calls.subscriptionUpdates.length, 0);
});

test('a subscription Stripe has never heard of is reported, not thrown', async () => {
    const missing = Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
    const { service } = loadStripeService({ retrieveError: missing });
    const result = await service.changeSubscriptionPlan('sub_gone', 'developer_pro', { orgId: ORG_ID });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.reason, 'subscription_missing');
});

// ---------------------------------------------------------------------------
// The route: which of the two paths a real request takes.
// ---------------------------------------------------------------------------

function loadBillingRoute({ org, changeResult, checkoutUrl = 'https://checkout.stripe.test/new_session' }) {
    const calls = { checkout: [], change: [], portal: [], writes: [] };

    async function query(sql, params = []) {
        if (/FROM organizations/.test(sql) && /SELECT/.test(sql)) return { rows: [org] };
        if (/UPDATE organizations/.test(sql)) { calls.writes.push({ sql, params }); return { rows: [{ org_id: ORG_ID }] }; }
        if (/FROM users/.test(sql)) return { rows: [{ email: 'buyer@example.com' }] };
        return { rows: [] };
    }

    for (const p of [BILLING_PATH, DB_PATH, AUTH_PATH, WORKSPACE_PATH, ENFORCEMENT_PATH, STRIPE_SERVICE_PATH]) {
        delete require.cache[p];
    }
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };

    stub(DB_PATH, { query, pool: { connect: async () => ({ query, release() {} }) } });
    stub(AUTH_PATH, {
        requireAuth: (req, _res, next) => { req.actor = { id: 'user-1', org_id: ORG_ID, workspace_key: ORG_ID, email: 'buyer@example.com' }; next(); },
    });
    stub(WORKSPACE_PATH, {
        defaultOwnerKey: (actor) => actor?.workspace_key || actor?.org_id || null,
        resolveRole: async () => 'owner',
        canAdminister: (role) => role === 'owner',
        actorPersonId: (actor) => actor?.id || null,
    });
    stub(ENFORCEMENT_PATH, { invalidateOrgCache: async () => {} });
    stub(STRIPE_SERVICE_PATH, {
        createCheckoutSession: async (...args) => { calls.checkout.push(args); return checkoutUrl; },
        createPortalSession: async (...args) => { calls.portal.push(args); return 'https://billing.stripe.test/portal'; },
        changeSubscriptionPlan: async (...args) => { calls.change.push(args); return changeResult; },
    });

    return { router: require(BILLING_PATH), calls };
}

async function postCheckout(router, body) {
    const app = express();
    app.use(express.json());
    app.use('/billing', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/billing/checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

test('a Pro subscriber upgrading to Team gets ONE subscription, not a second checkout', async () => {
    const { router, calls } = loadBillingRoute({
        org: {
            plan_tier: 'developer_basic',
            account_type: 'personal',
            stripe_subscription_id: 'sub_pro_1',
            subscription_status: 'active',
        },
        changeResult: { changed: true, planId: 'developer_pro', seats: 2, subscriptionId: 'sub_pro_1' },
    });

    const res = await postCheckout(router, { tierId: 'developer_pro', billingCycle: 'monthly', seats: 2 });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.checkout.length, 0,
        'creating a checkout session here is the double-billing bug');
    assert.strictEqual(calls.change.length, 1, 'the existing subscription must be the thing that moves');
    assert.strictEqual(res.body.updated, true);
    assert.strictEqual(res.body.plan_tier, 'developer_pro');
    assert.ok(!res.body.url, 'there is no Stripe page to send the buyer to — the change already happened');
});

test('a free account with no subscription still gets a real checkout', async () => {
    const { router, calls } = loadBillingRoute({
        org: { plan_tier: 'free', account_type: 'personal', stripe_subscription_id: null, subscription_status: null },
        changeResult: { changed: false, reason: 'no_subscription' },
    });

    const res = await postCheckout(router, { tierId: 'developer_basic', billingCycle: 'annual' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.change.length, 0);
    assert.strictEqual(calls.checkout.length, 1);
    assert.match(res.body.url, /checkout\.stripe\.test/);
});

test('a recorded subscription Stripe says is dead falls through to a real checkout', async () => {
    // The org row can outlive the subscription (cancelled in the Stripe
    // dashboard, a test-mode reset). Sending that buyer to the portal would
    // strand them; nothing is being billed, so a new subscription is correct.
    const { router, calls } = loadBillingRoute({
        org: {
            plan_tier: 'developer_basic',
            account_type: 'personal',
            stripe_subscription_id: 'sub_dead',
            subscription_status: 'active',
        },
        changeResult: { changed: false, reason: 'not_live:canceled' },
    });

    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.change.length, 1, 'it must try to move the recorded subscription first');
    assert.strictEqual(calls.checkout.length, 1, 'and only then open a new one');
    assert.match(res.body.url, /checkout\.stripe\.test/);
});

test('a plan change Stripe refuses sends the caller to the portal, never to a second subscription', async () => {
    const { router, calls } = loadBillingRoute({
        org: {
            plan_tier: 'developer_basic',
            account_type: 'personal',
            stripe_subscription_id: 'sub_pro_1',
            subscription_status: 'active',
        },
        changeResult: null,
    });
    // changeResult null makes the stub return undefined; the route must treat an
    // unusable answer as "hand this to a human", not as "make another one".
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });
    assert.strictEqual(calls.checkout.length, 0, 'an unexpected answer must never fall back to a second subscription');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.url, /billing\.stripe\.test/);
    assert.strictEqual(calls.portal.length, 1);
});

// ---------------------------------------------------------------------------
// Cadence. An in-place change must not quietly move somebody's billing period.
// ---------------------------------------------------------------------------

test('a plan change with no cadence asked for keeps the one the customer is on', async () => {
    // /settings/plan has no billing toggle — it offers "Upgrade to Team" and
    // nothing else — so it sends no cadence. It used to send a hard-coded
    // 'monthly', which would have moved an ANNUAL Pro subscriber onto monthly
    // Team as a side effect of changing plan. Nobody asked for that, and the
    // page that caused it never mentioned billing periods at all.
    const annualPro = proSubscription({
        items: {
            data: [{ id: 'si_plan', quantity: 1, price: { id: 'price_pro_annual', recurring: { interval: 'year' } } }],
        },
    });
    const { service, calls } = loadStripeService({ subscription: annualPro });

    await service.changeSubscriptionPlan('sub_pro_1', 'developer_pro', { orgId: ORG_ID, seats: 2 });

    assert.strictEqual(calls.subscriptionUpdates[0].payload.items[0].price, 'price_team_annual',
        'an annual subscriber must stay annual when the caller names no cadence');
});

test('a cadence the caller DOES ask for still wins', async () => {
    const annualPro = proSubscription({
        items: {
            data: [{ id: 'si_plan', quantity: 1, price: { id: 'price_pro_annual', recurring: { interval: 'year' } } }],
        },
    });
    const { service, calls } = loadStripeService({ subscription: annualPro });

    await service.changeSubscriptionPlan('sub_pro_1', 'developer_pro', { orgId: ORG_ID, seats: 2, billingCycle: 'monthly' });

    assert.strictEqual(calls.subscriptionUpdates[0].payload.items[0].price, 'price_team_monthly',
        'an explicit choice must not be overridden by the existing cadence');
});

test('a monthly subscriber with no cadence asked for stays monthly', async () => {
    const { service, calls } = loadStripeService();
    await service.changeSubscriptionPlan('sub_pro_1', 'developer_pro', { orgId: ORG_ID, seats: 2 });
    assert.strictEqual(calls.subscriptionUpdates[0].payload.items[0].price, 'price_team_monthly');
});
