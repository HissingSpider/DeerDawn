'use strict';

/**
 * AN IN-PLACE PLAN CHANGE WHOSE PAYMENT FAILS IS A FAILURE, NOT A SUCCESS.
 *
 * A monthly Pro subscriber presses "Upgrade to Team - Annual". The billing
 * interval changes, so Stripe starts a new period and invoices the prorated
 * difference immediately. The card declines.
 *
 * With no payment_behavior on the update, Stripe's default (allow_incomplete)
 * applies the change anyway and moves the subscription to past_due. The route
 * never read the returned status: it wrote Team onto the org and answered 200
 * "the prorated difference is charged now ... You have one subscription and
 * have not been charged twice." Then the past_due webhook locked every product
 * call with 403 subscription_inactive — including the Pro they had already
 * paid for.
 *
 * This file loads the REAL stripeService and the REAL billing route over a
 * Stripe double that behaves as Stripe documents for each payment_behavior.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_payment_failure';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = 'price_pro_monthly';
process.env.STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL = 'price_pro_annual';
process.env.STRIPE_PRICE_DEVELOPER_PRO = 'price_team_monthly';
process.env.STRIPE_PRICE_DEVELOPER_PRO_ANNUAL = 'price_team_annual';
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

const ORG_ID = 'org-abababab-cdcd-efef-0101-232323232323';

function proMonthly({ status = 'active' } = {}) {
    return {
        id: 'sub_pro_1',
        status,
        customer: 'cus_1',
        metadata: {},
        items: { data: [{ id: 'si_plan', quantity: 1, price: { id: 'price_pro_monthly', recurring: { interval: 'month' } } }] },
    };
}

function cardDeclined() {
    // The shape stripe-node gives a declined card: StripeCardError, HTTP 402.
    return Object.assign(new Error('Your card was declined.'), {
        type: 'StripeCardError',
        rawType: 'card_error',
        statusCode: 402,
        code: 'card_declined',
        decline_code: 'generic_decline',
    });
}

/**
 * Stripe, as documented for subscription updates:
 *  - same interval + create_prorations: nothing is invoiced now, the card is
 *    not touched, the change applies;
 *  - changed interval: the prorated difference is invoiced NOW and the card is
 *    charged. If it declines:
 *      allow_incomplete (the default): the change applies, status -> past_due;
 *      error_if_incomplete: HTTP 402, and the subscription is left unchanged.
 */
function loadBilling({ subscription = proMonthly(), cardDeclines = false, forceStatus = null } = {}) {
    const state = { subscription };
    const calls = { updates: [], checkoutSessions: [], portalSessions: [], orgWrites: [] };

    class MockStripe {
        constructor() {
            this.customers = { create: async () => ({ id: 'cus_1' }) };
            this.checkout = { sessions: { create: async (payload) => { calls.checkoutSessions.push(payload); return { url: 'https://checkout.stripe.test/s' }; } } };
            this.billingPortal = { sessions: { create: async (payload) => { calls.portalSessions.push(payload); return { url: 'https://billing.stripe.test/portal' }; } } };
            this.subscriptions = {
                retrieve: async () => state.subscription,
                list: async () => ({ data: [state.subscription] }),
                update: async (id, payload) => {
                    calls.updates.push({ id, payload });
                    const current = state.subscription;
                    const [change] = payload.items;
                    const interval = /_annual$/.test(change.price) ? 'year' : 'month';
                    const next = {
                        ...current,
                        metadata: payload.metadata,
                        items: { data: [{ ...current.items.data[0], price: { id: change.price, recurring: { interval } }, quantity: change.quantity }] },
                    };
                    const invoicedNow = interval !== current.items.data[0].price.recurring.interval;
                    if (invoicedNow && cardDeclines) {
                        if (payload.payment_behavior === 'error_if_incomplete') throw cardDeclined();
                        state.subscription = { ...next, status: 'past_due' };
                        return state.subscription;
                    }
                    state.subscription = { ...next, status: forceStatus || current.status };
                    return state.subscription;
                },
            };
        }
    }

    async function query(sql, params = []) {
        if (/^\s*SELECT/i.test(sql) && /FROM organizations/.test(sql)) {
            return { rows: [{ plan_tier: 'developer_basic', account_type: 'personal', stripe_subscription_id: state.subscription.id, stripe_customer_id: 'cus_1', subscription_status: state.subscription.status, purchased_seats: null }] };
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

    return { router: require(BILLING_PATH), calls, state };
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

const planWrites = (calls) => calls.orgWrites.filter((w) => /plan_tier\s*=/.test(w.sql));

test('a declined charge on an in-place change is a failure, and the subscription is left as it was', async () => {
    const { router, calls, state } = loadBilling({ cardDeclines: true });

    // What /checkout sends for "Team - Annual" from a monthly Pro subscriber.
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2, billingCycle: 'annual' });

    assert.ok(res.status >= 400 && res.status < 500 && res.status !== 401,
        `a change whose payment failed answered ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'payment_failed', 'the failure needs a stable machine-readable code');
    assert.notStrictEqual(res.body.updated, true);
    assert.match(String(res.body.message), /declined|did not go through/i, 'the person must be told the charge failed');
    assert.match(String(res.body.message), /billing portal/i, 'and how to fix it');
    assert.doesNotMatch(String(res.body.message), /have not been charged twice|moved to the new plan/i);

    assert.strictEqual(planWrites(calls).length, 0, 'the plan was written through for a change that was never paid for');
    assert.strictEqual(state.subscription.status, 'active',
        `Stripe was left holding a ${state.subscription.status} subscription — the account locks on the next webhook`);
    assert.strictEqual(state.subscription.items.data[0].price.id, 'price_pro_monthly', 'the subscription must be exactly as it was');
    assert.strictEqual(calls.checkoutSessions.length, 0, 'a failed change must not fall through to a second subscription');
});

test('the update tells Stripe not to apply a change it cannot charge for', async () => {
    const { router, calls } = loadBilling();
    await postCheckout(router, { tierId: 'developer_pro', seats: 2, billingCycle: 'annual' });
    assert.strictEqual(calls.updates.length, 1);
    assert.strictEqual(calls.updates[0].payload.payment_behavior, 'error_if_incomplete');
});

test('a returned subscription that is not paid up is never reported as a success', async () => {
    // Stripe accepted the update but hands back a subscription that is not paid
    // up — an unpaid balance was already outstanding. "Moved, one subscription,
    // not charged twice" would be a success claim about an account that is
    // about to lock.
    const { router, calls } = loadBilling({ subscription: proMonthly(), forceStatus: 'past_due' });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });

    assert.ok(res.status >= 400 && res.status < 500 && res.status !== 401, `answered ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'subscription_payment_incomplete');
    assert.notStrictEqual(res.body.updated, true);
    assert.match(String(res.body.message), /billing portal/i);
    assert.strictEqual(planWrites(calls).length, 0, 'a success was written through from the request, not from what Stripe returned');
});

test('a change the card pays for still succeeds, and says the charge happened now', async () => {
    const { router, calls, state } = loadBilling({ cardDeclines: false });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2, billingCycle: 'annual' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.updated, true);
    assert.strictEqual(res.body.plan_tier, 'developer_pro');
    assert.strictEqual(res.body.billed_now, true);
    assert.strictEqual(state.subscription.status, 'active');
    assert.strictEqual(planWrites(calls).length, 1);
});

test('a same-interval change never touches the card, so a card that would decline does not block it', async () => {
    const { router, calls } = loadBilling({ cardDeclines: true });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.updated, true);
    assert.match(res.body.message, /next invoice/i);
    assert.strictEqual(planWrites(calls).length, 1);
});
