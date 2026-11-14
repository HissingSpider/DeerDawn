'use strict';

/**
 * AN IN-PLACE PLAN CHANGE HAS NO STRIPE PAGE, SO THE API IS THE ONLY THING
 * TELLING THE CUSTOMER WHAT JUST HAPPENED TO THEIR MONEY.
 *
 * A new checkout ends on Stripe's own page, which shows the cadence and the
 * amount before anyone pays; whatever we got wrong upstream is corrected there.
 * POST /billing/checkout for a workspace that already has a subscription ends
 * nowhere: the subscription is repriced server-side and the response IS the
 * receipt. Two things were wrong on that path and neither could be seen by the
 * buyer until a card statement:
 *
 *  1. With STRIPE_PRICE_DEVELOPER_PRO_ANNUAL unset, an ANNUAL Pro subscriber
 *     upgrading to Team was moved onto MONTHLY Team. getBasePriceId's
 *     annual-to-monthly degrade exists so a new checkout still completes; on
 *     this path it changes somebody's billing period because of an env var.
 *  2. The response said the prorated difference lands on the next invoice. That
 *     is true only when the billing interval is unchanged. Monthly to annual
 *     resets the billing anchor and Stripe charges immediately.
 *
 * This file loads the REAL stripeService and the REAL billing route over a
 * recording Stripe double. The annual Team price is deliberately NOT configured.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_cadence';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = 'price_pro_monthly';
process.env.STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL = 'price_pro_annual';
process.env.STRIPE_PRICE_DEVELOPER_PRO = 'price_team_monthly';
process.env.DASHBOARD_URL = 'https://app.deerdawn.com';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const STRIPE_LIB = require.resolve('stripe');
const PLANS_PATH = require.resolve('../../src/config/plans');
const DB_PATH = require.resolve('../../src/config/db');
const AUTH_PATH = require.resolve('../../src/middleware/auth');
const WORKSPACE_PATH = require.resolve('../../src/services/workspaceService');
const ENFORCEMENT_PATH = require.resolve('../../src/services/enforcementService');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const BILLING_PATH = require.resolve('../../src/routes/shared/billing');

const ORG_ID = 'org-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function proSubscription(interval) {
    return {
        id: 'sub_pro_1',
        status: 'active',
        customer: 'cus_1',
        metadata: {},
        items: {
            data: [{
                id: 'si_plan',
                quantity: 1,
                price: { id: interval === 'year' ? 'price_pro_annual' : 'price_pro_monthly', recurring: { interval } },
            }],
        },
    };
}

/**
 * plans.js reads its price ids at require time, so the annual Team price is
 * set or unset PER LOAD and plans.js is evicted with everything that read it.
 */
function loadBilling({ subscription, teamAnnualPrice = null }) {
    delete process.env.STRIPE_PRICE_DEVELOPER_PRO_ANNUAL;
    if (teamAnnualPrice) process.env.STRIPE_PRICE_DEVELOPER_PRO_ANNUAL = teamAnnualPrice;
    else delete process.env.STRIPE_PRICE_DEVELOPER_PRO_ANNUAL;

    const calls = { subscriptionUpdates: [], checkoutSessions: [], orgWrites: [] };

    class MockStripe {
        constructor() {
            this.customers = { create: async () => ({ id: 'cus_1' }) };
            this.checkout = { sessions: { create: async (payload) => { calls.checkoutSessions.push(payload); return { url: 'https://checkout.stripe.test/s' }; } } };
            this.billingPortal = { sessions: { create: async () => ({ url: 'https://billing.stripe.test/portal' }) } };
            this.subscriptions = {
                retrieve: async () => subscription,
                update: async (id, payload) => { calls.subscriptionUpdates.push({ id, payload }); return { ...subscription, id }; },
                list: async () => ({ data: [] }),
            };
        }
    }

    async function query(sql, params = []) {
        if (/^\s*SELECT/i.test(sql) && /FROM organizations/.test(sql)) {
            return { rows: [{ plan_tier: 'developer_basic', account_type: 'personal', stripe_subscription_id: subscription.id, stripe_customer_id: 'cus_1', subscription_status: 'active' }] };
        }
        if (/UPDATE organizations/.test(sql)) { calls.orgWrites.push({ sql, params }); return { rows: [] }; }
        return { rows: [] };
    }

    for (const p of [PLANS_PATH, BILLING_PATH, DB_PATH, AUTH_PATH, WORKSPACE_PATH, ENFORCEMENT_PATH, STRIPE_SERVICE_PATH]) {
        delete require.cache[p];
    }
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };
    stub(STRIPE_LIB, MockStripe);
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

// ---------------------------------------------------------------------------
// The billing period is the customer's, not the configuration's
// ---------------------------------------------------------------------------

test('an ANNUAL subscriber is refused, not moved to monthly, when the annual Team price is unset', async () => {
    const { router, calls } = loadBilling({ subscription: proSubscription('year') });

    // /settings/plan names no cadence: the subscription's own is inherited.
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });

    assert.strictEqual(calls.subscriptionUpdates.length, 0,
        `the subscription was repriced to ${calls.subscriptionUpdates[0]?.payload?.items?.[0]?.price} — `
        + 'an annual customer was moved onto monthly billing by a missing env var');
    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'billing_unavailable');
    assert.match(res.body.message, /developer_pro/);
    assert.match(res.body.message, /annual/, 'the operator has to be told WHICH price is missing');
    assert.strictEqual(calls.orgWrites.length, 0, 'nothing may be written for a change that did not happen');
    assert.strictEqual(calls.checkoutSessions.length, 0, 'and it must not fall through to a second subscription');
});

test('a monthly subscriber who ASKS for annual is refused too, rather than quietly given monthly', async () => {
    const { router, calls } = loadBilling({ subscription: proSubscription('month') });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2, billingCycle: 'annual' });
    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.strictEqual(calls.subscriptionUpdates.length, 0);
});

test('a monthly subscriber is unaffected by the missing ANNUAL price', async () => {
    // The refusal must not become a reason nobody can upgrade.
    const { router, calls } = loadBilling({ subscription: proSubscription('month') });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.subscriptionUpdates[0].payload.items[0].price, 'price_team_monthly');
});

test('a NEW checkout still degrades annual to monthly so the sale can complete', async () => {
    // The fallback this narrows was added deliberately: annual is the default
    // cadence on every surface, so without it one unset var fails EVERY
    // checkout. Stripe's page shows the real cadence before payment.
    loadBilling({ subscription: proSubscription('month') });
    const { __testables } = require(STRIPE_SERVICE_PATH);
    const { getPlan } = require(PLANS_PATH);
    assert.strictEqual(__testables.getBasePriceId(getPlan('developer_pro'), 'annual'), 'price_team_monthly');
});

// ---------------------------------------------------------------------------
// When the money moves
// ---------------------------------------------------------------------------

test('same interval: the response says the difference lands on the next invoice', async () => {
    const { router } = loadBilling({ subscription: proSubscription('year'), teamAnnualPrice: 'price_team_annual' });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.updated, true);
    assert.strictEqual(res.body.billed_now, false);
    assert.strictEqual(res.body.billing_cycle, 'annual');
    assert.match(res.body.message, /next invoice/i);
});

test('changed interval: the response says the charge happens NOW, and never says "next invoice"', async () => {
    // Monthly Pro to annual Team is what /checkout sends by default (its cadence
    // defaults to annual). Stripe resets the billing anchor and invoices the
    // prorated difference immediately.
    const { router, calls } = loadBilling({ subscription: proSubscription('month'), teamAnnualPrice: 'price_team_annual' });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2, billingCycle: 'annual' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.subscriptionUpdates[0].payload.items[0].price, 'price_team_annual');
    assert.strictEqual(res.body.billed_now, true);
    assert.strictEqual(res.body.interval_changed, true);
    assert.strictEqual(res.body.billing_cycle, 'annual');
    assert.doesNotMatch(res.body.message, /next invoice/i,
        'the customer was told nothing is charged yet, about a charge Stripe makes the same minute');
    assert.match(res.body.message, /charged now/i);
    assert.match(res.body.message, /annual/i);
});
