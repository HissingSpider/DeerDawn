'use strict';

/**
 * CHECKOUT MUST NOT OPEN A SECOND SUBSCRIPTION BESIDE ONE THE ORG ROW FORGOT.
 *
 * POST /billing/checkout decided "is there a subscription to move?" from
 * organizations.stripe_subscription_id alone. That column is empty whenever the
 * webhook that fills it is late or failed — and after a refund clears it — while
 * the org's Stripe customer is still paying for a live subscription. A buyer
 * pays, lands back on a plan page that still says Free, presses "Upgrade to
 * Pro" again, and is sold a second Pro.
 *
 * The rule these tests pin: before a checkout is created for an org that has a
 * Stripe customer, Stripe is asked for that customer's live subscriptions (one
 * list call). A live one is adopted through the webhook's own reconcile path
 * and the request is then treated as a change to it; a failed lookup hands off
 * to the billing portal, never to a checkout.
 *
 * This file drives the REAL billing route, the REAL stripeService and the REAL
 * webhook module over one Stripe double and one org row that applies writes.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_checkout_adopts';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_checkout_adopts';
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
const REDIS_PATH = require.resolve('../../src/config/redis');
const AUTH_PATH = require.resolve('../../src/middleware/auth');
const WORKSPACE_PATH = require.resolve('../../src/services/workspaceService');
const ENFORCEMENT_PATH = require.resolve('../../src/services/enforcementService');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const PRODUCT_EVENTS_PATH = require.resolve('../../src/services/productEventsService');
const RETENTION_LEDGER_PATH = require.resolve('../../src/services/retentionLedger');
const EMAIL_PATH = require.resolve('../../src/services/email/resendClient');
const WEBHOOK_PATH = require.resolve('../../src/routes/webhooks-stripe');
const BILLING_PATH = require.resolve('../../src/routes/shared/billing');

const ORG_ID = 'org-cdcdcdcd-1212-3434-5656-787878787878';
const CUSTOMER = 'cus_forgotten';

function subscription({ id, status = 'active', price = 'price_pro_monthly', quantity = 1 }) {
    return {
        id,
        status,
        customer: CUSTOMER,
        created: 1_750_000_000,
        metadata: {},
        items: {
            data: [{
                id: `si_${id}`,
                quantity,
                current_period_start: 1_755_000_000,
                current_period_end: 1_757_678_400,
                price: { id: price, recurring: { interval: /_annual$/.test(price) ? 'year' : 'month' } },
            }],
        },
    };
}

/** One org row that APPLIES writes addressed to it by org_id. */
function makeDb(initialRow) {
    const row = { org_id: ORG_ID, account_type: 'personal', purchased_seats: null, ...initialRow };
    const writes = [];
    const arg = (params, n) => params[Number(n) - 1];

    function apply(text, params) {
        const setClause = /SET([\s\S]*?)WHERE/.exec(text)[1];
        for (const assignment of setClause.split(',')) {
            const bound = /(\w+)\s*=\s*\$(\d+)/.exec(assignment);
            if (bound) { row[bound[1]] = arg(params, bound[2]); continue; }
            const nulled = /(\w+)\s*=\s*NULL/.exec(assignment);
            if (nulled) row[nulled[1]] = null;
        }
    }

    async function query(text, params = []) {
        if (/^\s*SELECT/i.test(text) && /FROM organizations/.test(text)) return { rows: [{ ...row }], rowCount: 1 };
        if (/FROM users/.test(text)) return { rows: [{ user_id: 'user-1', email: 'buyer@example.com' }], rowCount: 1 };
        if (/UPDATE organizations/.test(text)) {
            writes.push({ text, params });
            const byOrg = /WHERE org_id = \$(\d+)/.exec(text);
            if (!byOrg || arg(params, byOrg[1]) !== ORG_ID) return { rows: [], rowCount: 0 };
            apply(text, params);
            return { rows: [{ org_id: ORG_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }

    return { row, writes, module: { query, pool: { connect: async () => ({ query, release() {} }) } } };
}

function load({ org, subscriptions = [], listError = null }) {
    const db = makeDb(org);
    const state = { subscriptions: subscriptions.map((s) => ({ ...s })) };
    const calls = { checkoutSessions: [], portalSessions: [], lists: [], updates: [] };

    class MockStripe {
        constructor() {
            this.customers = { create: async () => ({ id: CUSTOMER }) };
            this.checkout = { sessions: { create: async (payload) => { calls.checkoutSessions.push(payload); return { url: 'https://checkout.stripe.test/second' }; } } };
            this.billingPortal = { sessions: { create: async (payload) => { calls.portalSessions.push(payload); return { url: 'https://billing.stripe.test/portal' }; } } };
            this.webhooks = { constructEvent: () => { throw new Error('not used here'); } };
            this.subscriptions = {
                retrieve: async (id) => {
                    const found = state.subscriptions.find((s) => s.id === id);
                    if (!found) throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing', statusCode: 404 });
                    return found;
                },
                list: async (params) => {
                    calls.lists.push(params);
                    if (listError) throw listError;
                    return { data: state.subscriptions.filter((s) => s.customer === params.customer), has_more: false };
                },
                update: async (id, payload) => {
                    calls.updates.push({ id, payload });
                    const index = state.subscriptions.findIndex((s) => s.id === id);
                    const current = state.subscriptions[index];
                    const [change] = payload.items;
                    state.subscriptions[index] = {
                        ...current,
                        metadata: payload.metadata,
                        items: { data: [{ ...current.items.data[0], quantity: change.quantity, price: { id: change.price, recurring: { interval: /_annual$/.test(change.price) ? 'year' : 'month' } } }] },
                    };
                    return state.subscriptions[index];
                },
            };
        }
    }

    for (const p of [PLANS_PATH, DB_PATH, REDIS_PATH, AUTH_PATH, WORKSPACE_PATH, ENFORCEMENT_PATH, STRIPE_SERVICE_PATH,
        PRODUCT_EVENTS_PATH, RETENTION_LEDGER_PATH, EMAIL_PATH, WEBHOOK_PATH, BILLING_PATH]) {
        delete require.cache[p];
    }
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };
    stub(STRIPE_LIB, MockStripe);
    stub(DB_PATH, db.module);
    stub(REDIS_PATH, { redis: { del: async () => 1 } });
    stub(AUTH_PATH, {
        requireAuth: (req, _res, next) => { req.actor = { id: 'user-1', org_id: ORG_ID, workspace_key: ORG_ID, email: 'buyer@example.com' }; next(); },
    });
    stub(WORKSPACE_PATH, {
        defaultOwnerKey: (actor) => actor?.workspace_key || actor?.org_id || null,
        resolveRole: async () => 'owner',
        canAdminister: (role) => role === 'owner',
        actorPersonId: (actor) => actor?.id || null,
        countActiveMembers: async () => 1,
        listInvites: async () => [],
    });
    stub(ENFORCEMENT_PATH, { invalidateOrgCache: async () => {} });
    stub(PRODUCT_EVENTS_PATH, { recordProductEvent: async () => ({}) });
    stub(RETENTION_LEDGER_PATH, { recordSubscriptionEvent: async () => {} });
    stub(EMAIL_PATH, { sendEmail: async () => ({}) });

    return { router: require(BILLING_PATH), db, calls, state };
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

/** The org row a late or failed checkout.session.completed leaves behind. */
const WEBHOOK_NEVER_LANDED = { plan: 'free', plan_tier: 'free', subscription_status: 'active', stripe_subscription_id: null, stripe_customer_id: CUSTOMER };

test('a buyer whose webhook has not landed is not sold the same plan twice', async () => {
    const { router, db, calls } = load({
        org: { ...WEBHOOK_NEVER_LANDED },
        subscriptions: [subscription({ id: 'sub_paid' })],
    });

    const res = await postCheckout(router, { tierId: 'developer_basic', billingCycle: 'monthly' });

    assert.strictEqual(calls.checkoutSessions.length, 0,
        'a second Pro subscription was opened for a customer already paying for Pro');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(!res.body.url, 'there is nothing to pay for');
    assert.strictEqual(res.body.updated, false, 'nothing moved, so this is not reported as a change');
    assert.match(String(res.body.message), /nothing was charged/i);

    // Adopted through the webhook's reconcile path: the person has what they paid for.
    assert.strictEqual(db.row.stripe_subscription_id, 'sub_paid');
    assert.strictEqual(db.row.plan_tier, 'developer_basic');
    assert.strictEqual(db.row.subscription_status, 'active');
    assert.ok(db.row.billing_period_end instanceof Date, 'the billing window comes with the adoption, as it does in the webhook');
    assert.strictEqual(calls.lists.length, 1, 'one list call, no more');
});

test('upgrading past an unrecorded live subscription MOVES it, exactly as for a recorded one', async () => {
    const { router, db, calls, state } = load({
        org: { ...WEBHOOK_NEVER_LANDED },
        subscriptions: [subscription({ id: 'sub_paid' })],
    });

    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });

    assert.strictEqual(calls.checkoutSessions.length, 0, 'a Team checkout was opened beside a live Pro subscription');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.updated, true);
    assert.strictEqual(res.body.plan_tier, 'developer_pro');
    assert.strictEqual(calls.updates.length, 1);
    assert.strictEqual(calls.updates[0].id, 'sub_paid', 'the subscription the customer already pays for is the one that moves');
    assert.strictEqual(state.subscriptions[0].items.data[0].price.id, 'price_team_monthly');
    assert.strictEqual(db.row.stripe_subscription_id, 'sub_paid');
    assert.strictEqual(db.row.plan_tier, 'developer_pro');
});

test('a Stripe failure during the lookup hands off to the portal, never to a checkout', async () => {
    const outage = Object.assign(new Error('An error occurred with our connection to Stripe.'), { type: 'StripeConnectionError' });
    const { router, db, calls } = load({
        org: { ...WEBHOOK_NEVER_LANDED },
        subscriptions: [subscription({ id: 'sub_paid' })],
        listError: outage,
    });

    const res = await postCheckout(router, { tierId: 'developer_basic', billingCycle: 'monthly' });

    assert.strictEqual(calls.checkoutSessions.length, 0, 'an unanswered question was read as "no subscription" and a checkout opened');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.portal, true);
    assert.match(String(res.body.url), /billing\.stripe\.test/);
    assert.strictEqual(db.row.stripe_subscription_id, null, 'nothing is adopted on no answer');
});

test('the recorded subscription died and another live one exists: that one is adopted, not duplicated', async () => {
    // The org row names a cancelled Pro; the customer is paying for Team.
    const { router, db, calls } = load({
        org: { plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'active', stripe_subscription_id: 'sub_dead', stripe_customer_id: CUSTOMER },
        subscriptions: [
            subscription({ id: 'sub_dead', status: 'canceled' }),
            subscription({ id: 'sub_team', price: 'price_team_monthly', quantity: 3 }),
        ],
    });

    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 3 });

    assert.strictEqual(calls.checkoutSessions.length, 0, 'a second Team subscription was opened beside the live one');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.stripe_subscription_id, 'sub_team');
    assert.strictEqual(db.row.plan_tier, 'developer_pro');
    assert.strictEqual(db.row.purchased_seats, 3);
});

test('a customer with nothing live still gets a real checkout', async () => {
    const { router, db, calls } = load({
        org: { ...WEBHOOK_NEVER_LANDED, subscription_status: 'cancelled' },
        subscriptions: [subscription({ id: 'sub_old', status: 'canceled' })],
    });

    const res = await postCheckout(router, { tierId: 'developer_basic', billingCycle: 'monthly' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.checkoutSessions.length, 1);
    assert.match(String(res.body.url), /checkout\.stripe\.test/);
    assert.ok(calls.lists.length <= 1);
    assert.strictEqual(db.row.stripe_subscription_id, null);
});

test('an org with no Stripe customer costs no Stripe lookup', async () => {
    const { router, calls } = load({
        org: { ...WEBHOOK_NEVER_LANDED, stripe_customer_id: null },
        subscriptions: [],
    });

    const res = await postCheckout(router, { tierId: 'developer_basic', billingCycle: 'monthly' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.checkoutSessions.length, 1);
    assert.strictEqual(calls.lists.length, 0);
});
