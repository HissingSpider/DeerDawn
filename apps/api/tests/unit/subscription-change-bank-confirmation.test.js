'use strict';

/**
 * TWO REFUSALS AN IN-PLACE PLAN CHANGE MUST EXPLAIN, NOT MISNAME.
 *
 * 1. The bank has to confirm the payment (3-D Secure). The change uses
 *    payment_behavior 'error_if_incomplete' (round 1, B2), so Stripe refuses it
 *    with a 402 and changes nothing. The route answered that 402 exactly like a
 *    declined card: "update your card in the billing portal", which is not the
 *    reason and cannot be fixed by updating the card.
 *
 * 2. The subscription is overdue (past_due or unpaid). The change was attempted
 *    anyway: a seat change sent the new quantity to Stripe and only then
 *    answered 402 "this change is not active".
 *
 * The owner's decision (2026-09-28): say why, and send the person to Stripe's
 * billing page, where confirmation works; refuse a change on an overdue account
 * up front, with the reason, making no call that changes the subscription.
 * (Confirming in place was offered and not chosen.)
 *
 * Loads the REAL stripeService and the REAL billing route over a Stripe double
 * that records every write.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_bank_confirmation';
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

const ORG_ID = 'org-bcbcbcbc-dede-f0f0-1212-343434343434';

function subscription({ id = 'sub_1', status = 'active', price = 'price_pro_monthly', quantity = 1 } = {}) {
    const interval = /_annual$/.test(price) ? 'year' : 'month';
    return {
        id,
        status,
        customer: 'cus_1',
        metadata: {},
        items: { data: [{ id: 'si_plan', quantity, price: { id: price, recurring: { interval } } }] },
    };
}

// The shapes Stripe gives a payment its customer's bank has to confirm. The
// code differs with where the refusal came from; each must read the same way.
const BANK_CONFIRMATION_ERRORS = {
    'invoice_payment_intent_requires_action': () => Object.assign(
        new Error('This payment requires additional user action before it can be completed successfully.'),
        { type: 'StripeCardError', rawType: 'card_error', statusCode: 402, code: 'invoice_payment_intent_requires_action' },
    ),
    'authentication_required (decline code)': () => Object.assign(
        new Error('Your card was declined. This transaction requires authentication.'),
        { type: 'StripeCardError', rawType: 'card_error', statusCode: 402, code: 'card_declined', decline_code: 'authentication_required' },
    ),
    'a PaymentIntent in requires_action': () => Object.assign(
        new Error('This payment requires additional user action before it can be completed successfully.'),
        { type: 'StripeCardError', rawType: 'card_error', statusCode: 402, code: 'card_error', payment_intent: { id: 'pi_1', status: 'requires_action' } },
    ),
};

function cardDeclined() {
    return Object.assign(new Error('Your card was declined.'), {
        type: 'StripeCardError', rawType: 'card_error', statusCode: 402, code: 'card_declined', decline_code: 'generic_decline',
    });
}

/**
 * `stripeSays` is the subscription as Stripe has it; `row` overrides the org
 * row's copy (which is how a row that is behind Stripe is made). An update
 * whose billing interval changes is charged now, and `chargeFails` decides
 * what Stripe answers then (payment_behavior 'error_if_incomplete': a 402, and
 * nothing changes).
 */
function loadBilling({ stripeSays = subscription(), row = {}, chargeFails = null, members = 1 } = {}) {
    const state = { subscription: stripeSays };
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
                    if (interval !== current.items.data[0].price.recurring.interval && chargeFails) {
                        if (payload.payment_behavior === 'error_if_incomplete') throw chargeFails();
                    }
                    state.subscription = {
                        ...current,
                        metadata: payload.metadata,
                        items: { data: [{ ...current.items.data[0], price: { id: change.price, recurring: { interval } }, quantity: change.quantity }] },
                    };
                    return state.subscription;
                },
            };
        }
    }

    const tierOf = (price) => (/team/.test(price) ? 'developer_pro' : 'developer_basic');
    async function query(sql) {
        if (/^\s*SELECT/i.test(sql) && /FROM organizations/.test(sql)) {
            const item = stripeSays.items.data[0];
            return {
                rows: [{
                    plan_tier: tierOf(item.price.id),
                    account_type: tierOf(item.price.id) === 'developer_pro' ? 'organization' : 'personal',
                    stripe_subscription_id: stripeSays.id,
                    stripe_customer_id: 'cus_1',
                    subscription_status: stripeSays.status,
                    purchased_seats: tierOf(item.price.id) === 'developer_pro' ? item.quantity : null,
                    ...row,
                }],
            };
        }
        if (/UPDATE organizations/.test(sql)) { calls.orgWrites.push(sql); return { rows: [] }; }
        return { rows: [] };
    }

    for (const p of [PLANS_PATH, BILLING_PATH, DB_PATH, AUTH_PATH, WORKSPACE_PATH, ENFORCEMENT_PATH, STRIPE_SERVICE_PATH]) {
        delete require.cache[p];
    }
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };
    stub(STRIPE_LIB, MockStripe);
    stub(DB_PATH, { query, pool: { connect: async () => ({ query, release() {} }) } });
    stub(AUTH_PATH, {
        requireAuth: (req, _res, next) => { req.actor = { id: 'user-1', org_id: ORG_ID, workspace_key: ORG_ID, email: 'owner@example.com' }; next(); },
    });
    stub(WORKSPACE_PATH, {
        defaultOwnerKey: (actor) => actor?.workspace_key || actor?.org_id || null,
        resolveRole: async () => 'owner',
        canAdminister: (role) => role === 'owner',
        actorPersonId: (actor) => actor?.id || null,
        countActiveMembers: async () => members,
        listInvites: async () => [],
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
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/billing/checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

const planWrites = (calls) => calls.orgWrites.filter((sql) => /plan_tier\s*=|purchased_seats\s*=/.test(sql));

// ---------------------------------------------------------------------------
// The bank has to confirm the payment
// ---------------------------------------------------------------------------

for (const [shape, error] of Object.entries(BANK_CONFIRMATION_ERRORS)) {
    test(`a change the bank must confirm says so and offers the billing page (${shape})`, async () => {
        const { router, calls, state } = loadBilling({ chargeFails: error });
        // Monthly Pro to Team - Annual: the interval changes, so it is charged now.
        const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2, billingCycle: 'annual' });

        assert.strictEqual(res.status, 402, JSON.stringify(res.body));
        assert.strictEqual(res.body.error, 'payment_confirmation_required',
            `a payment the bank must confirm was answered as ${res.body.error}`);
        assert.match(res.body.message, /bank needs to confirm this payment/i);
        assert.match(res.body.message, /billing page/i);
        assert.doesNotMatch(res.body.message, /update your card|declined/i, 'updating the card cannot fix this');
        assert.strictEqual(res.body.billing_portal, true, 'the dashboard needs to know to offer the billing page');
        assert.notStrictEqual(res.body.updated, true);

        assert.strictEqual(planWrites(calls).length, 0);
        assert.strictEqual(state.subscription.items.data[0].price.id, 'price_pro_monthly', 'nothing may change');
        assert.strictEqual(calls.checkoutSessions.length, 0);
    });
}

test('a declined card keeps today\'s answer (guard)', async () => {
    const { router, calls } = loadBilling({ chargeFails: cardDeclined });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2, billingCycle: 'annual' });

    assert.strictEqual(res.status, 402, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'payment_failed');
    assert.strictEqual(res.body.decline_code, 'generic_decline');
    assert.strictEqual(res.body.message,
        'Your card was declined. The charge for this change did not go through, so your plan was not changed. '
        + 'Update your card in the billing portal ("Update payment method" on Settings > Plan), then try again.');
    assert.strictEqual(planWrites(calls).length, 0);
});

// ---------------------------------------------------------------------------
// An overdue subscription
// ---------------------------------------------------------------------------

const OVERDUE_CASES = [
    { name: 'a plan change, Pro to Team', stripeSays: (status) => subscription({ status }), body: { tierId: 'developer_pro', seats: 2 } },
    { name: 'a seat change, Team x2 to x3', stripeSays: (status) => subscription({ status, price: 'price_team_monthly', quantity: 2 }), body: { tierId: 'developer_pro', seats: 3 } },
];

for (const status of ['past_due', 'unpaid']) {
    for (const c of OVERDUE_CASES) {
        test(`${c.name} on a ${status} subscription is refused up front, and nothing is sent to Stripe`, async () => {
            const { router, calls, state } = loadBilling({ stripeSays: c.stripeSays(status) });
            const before = JSON.stringify(state.subscription);
            const res = await postCheckout(router, c.body);

            assert.strictEqual(res.status, 402, JSON.stringify(res.body));
            assert.strictEqual(res.body.error, 'payment_overdue', `answered ${res.body.error}`);
            assert.match(res.body.message, /overdue/i);
            assert.match(res.body.message, /Update billing to restore access/);
            assert.strictEqual(res.body.billing_portal, true);
            assert.strictEqual(res.body.subscription_status, status);

            assert.strictEqual(calls.updates.length, 0, `the change was sent to Stripe: ${JSON.stringify(calls.updates)}`);
            assert.strictEqual(JSON.stringify(state.subscription), before);
            assert.strictEqual(calls.checkoutSessions.length, 0, 'an overdue account must not be sold a second subscription either');
            assert.strictEqual(planWrites(calls).length, 0);
        });
    }
}

test('a row that is behind Stripe does not let a change through: Stripe says past_due, nothing is written to it', async () => {
    const { router, calls } = loadBilling({ stripeSays: subscription({ status: 'past_due' }), row: { subscription_status: 'active' } });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });

    assert.strictEqual(res.status, 402, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'payment_overdue');
    assert.strictEqual(calls.updates.length, 0, 'the change was sent to a past_due subscription');
    assert.strictEqual(planWrites(calls).length, 0);
});

test('a change on a paid-up subscription still goes through (guard)', async () => {
    const { router, calls } = loadBilling();
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.updated, true);
    assert.strictEqual(calls.updates.length, 1);
});
