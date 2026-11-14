'use strict';

/**
 * ONE ORG ROW, TWO SUBSCRIPTION IDS.
 *
 * `organizations` holds a single stripe_subscription_id, and every webhook
 * reconciles against it. That is fine right up until a Stripe customer carries
 * two live subscriptions — which is what the /billing/checkout double-billing
 * bug produced, and what a plan change made in the Stripe dashboard can produce
 * at any time. The org remembers whichever one wrote last, and the other one
 * keeps billing a customer we have forgotten about.
 *
 * The state that gets LOST is the dangerous half:
 *
 *   customer.subscription.deleted for the recorded subscription set the org to
 *   free and cleared its seats, without ever asking whether the customer had
 *   another live subscription. Cancel the Team you bought by mistake and the Pro
 *   you have been paying for since March silently becomes Free. They keep
 *   paying. Nothing errors.
 *
 *   customer.subscription.updated for the OTHER subscription matched zero rows
 *   and 200'd, so a real status change on the subscription actually being billed
 *   was dropped on the floor.
 *
 * These tests pin both directions: a survivor is adopted rather than ignored,
 * and a secondary subscription never overwrites the primary.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_two_subs';
// plans.js reads these at require time; without them the price→plan map cannot
// recognise either line item and every assertion below degrades to 'free'.
process.env.STRIPE_PRICE_DEVELOPER_BASIC = process.env.STRIPE_PRICE_DEVELOPER_BASIC || 'price_pro_monthly';
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const DB_PATH = require.resolve('../../src/config/db');
const REDIS_PATH = require.resolve('../../src/config/redis');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const PRODUCT_EVENTS_PATH = require.resolve('../../src/services/productEventsService');
const RETENTION_LEDGER_PATH = require.resolve('../../src/services/retentionLedger');
const EMAIL_PATH = require.resolve('../../src/services/email/resendClient');
const ROUTE_PATH = require.resolve('../../src/routes/webhooks-stripe');

const ORG_ID = 'org-99999999-8888-7777-6666-555555555555';
const CUSTOMER = 'cus_two_subs';

const PRO_SUB = {
    id: 'sub_pro',
    status: 'active',
    customer: CUSTOMER,
    created: 1_700_000_000,
    items: { data: [{ id: 'si_pro', quantity: 1, current_period_start: 1_755_000_000, current_period_end: 1_757_678_400, price: { id: 'price_pro_monthly' } }] },
};

const TEAM_SUB = {
    id: 'sub_team',
    status: 'active',
    customer: CUSTOMER,
    created: 1_750_000_000,
    items: { data: [{ id: 'si_team', quantity: 3, current_period_start: 1_755_000_000, current_period_end: 1_757_678_400, price: { id: 'price_team_monthly' } }] },
};

/**
 * A Postgres double that models the one column this turns on: the org row's
 * current stripe_subscription_id, and which UPDATEs its WHERE clause would
 * actually match.
 *
 * Evaluating the WHERE matters. A double that applies every UPDATE turns "the
 * handler wrote nothing because its WHERE matched no row" into "the handler
 * corrupted the org", and a double that applies NONE hides the writes that do
 * land. Only a faithful one can tell the difference between the two things this
 * file is about — a write that is wrongly skipped, and a write that is wrongly
 * applied.
 */
function makeDb({ recordedSubscriptionId, planTier = 'developer_basic', purchasedSeats = 1 }) {
    const claimed = new Set();
    const updates = [];
    const row = {
        org_id: ORG_ID,
        plan_tier: planTier,
        purchased_seats: purchasedSeats,
        stripe_subscription_id: recordedSubscriptionId,
        stripe_customer_id: CUSTOMER,
    };

    const arg = (params, n) => params[Number(n) - 1];

    /** Would this UPDATE's WHERE clause match our single org row? */
    function matches(text, params) {
        const byOrg = /WHERE org_id = \$(\d+)/.exec(text);
        if (byOrg) return arg(params, byOrg[1]) === row.org_id;

        const bySubOrCustomer = /WHERE \(stripe_subscription_id = \$(\d+) OR \(stripe_subscription_id IS NULL AND stripe_customer_id = \$(\d+)\)\)/.exec(text);
        if (bySubOrCustomer) {
            return row.stripe_subscription_id === arg(params, bySubOrCustomer[1])
                || (row.stripe_subscription_id == null && row.stripe_customer_id === arg(params, bySubOrCustomer[2]));
        }

        const bySub = /WHERE stripe_subscription_id = \$(\d+)/.exec(text);
        if (bySub) return row.stripe_subscription_id === arg(params, bySub[1]);

        return false;
    }

    async function query(text, params = []) {
        if (/INSERT INTO stripe_events/.test(text) && /'processing'/.test(text)) {
            if (claimed.has(params[0])) return { rows: [], rowCount: 0 };
            claimed.add(params[0]);
            return { rows: [{ event_id: params[0] }], rowCount: 1 };
        }
        if (/^\s*SELECT/i.test(text) && /FROM organizations/.test(text)) {
            return { rows: [row], rowCount: 1 };
        }
        if (/FROM users/.test(text)) return { rows: [{ user_id: 'user-1', email: 'buyer@example.com' }], rowCount: 1 };
        if (/UPDATE organizations/.test(text)) {
            const applied = matches(text, params);
            updates.push({ text, params, applied });
            return applied ? { rows: [{ org_id: ORG_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
    }

    return { updates, row, module: { query, pool: { connect: async () => ({ query, release() {} }) } } };
}

function loadRoute({ event, db, subscriptions = [] }) {
    const stripeStub = {
        stripe: {
            webhooks: { constructEvent: () => event },
            subscriptions: {
                retrieve: async (id) => subscriptions.find((s) => s.id === id) || null,
                list: async ({ customer }) => ({ data: subscriptions.filter((s) => s.customer === customer) }),
            },
            subscriptionSchedules: { retrieve: async () => null, create: async () => ({ id: 'sched' }), update: async () => ({}) },
            charges: { retrieve: async () => ({}) },
        },
    };

    for (const p of [DB_PATH, REDIS_PATH, STRIPE_SERVICE_PATH, PRODUCT_EVENTS_PATH, RETENTION_LEDGER_PATH, EMAIL_PATH, ROUTE_PATH]) {
        delete require.cache[p];
    }
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };
    stub(DB_PATH, db.module);
    stub(REDIS_PATH, { redis: { del: async () => 1 } });
    stub(STRIPE_SERVICE_PATH, stripeStub);
    stub(PRODUCT_EVENTS_PATH, { recordProductEvent: async () => ({}) });
    stub(RETENTION_LEDGER_PATH, { recordSubscriptionEvent: async () => {} });
    stub(EMAIL_PATH, { sendEmail: async () => ({}) });

    return require(ROUTE_PATH);
}

async function deliver(router) {
    const app = express();
    app.use('/hook', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=stub' },
            body: JSON.stringify({ stub: true }),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

/** What the org's plan column was last actually written to, if at all. */
function writtenPlan(updates) {
    for (let i = updates.length - 1; i >= 0; i -= 1) {
        const { text, params, applied } = updates[i];
        if (!applied) continue;
        const match = /plan = \$(\d+)/.exec(text);
        if (match) return params[Number(match[1]) - 1];
    }
    return null;
}

test('cancelling one of two subscriptions does not strip the plan the customer still pays for', async () => {
    // The org is recorded against the Team subscription; Pro is still live.
    const db = makeDb({ recordedSubscriptionId: TEAM_SUB.id, planTier: 'developer_pro', purchasedSeats: 3 });
    const router = loadRoute({
        db,
        subscriptions: [PRO_SUB],
        event: {
            id: 'evt_del_team',
            type: 'customer.subscription.deleted',
            data: { object: { ...TEAM_SUB, status: 'canceled' } },
        },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const plan = writtenPlan(db.updates);
    assert.notStrictEqual(plan, 'free',
        'the customer is still being billed for Pro — dropping them to free takes their money and their access');
    assert.strictEqual(plan, 'developer_basic',
        'the surviving subscription is what the org is actually paying for, so it is what the org should be on');
});

test('a lone subscription ending still drops the org to free', async () => {
    // The tolerance above must not become a refusal to churn anybody.
    const db = makeDb({ recordedSubscriptionId: PRO_SUB.id, planTier: 'developer_basic' });
    const router = loadRoute({
        db,
        subscriptions: [],
        event: {
            id: 'evt_del_only',
            type: 'customer.subscription.deleted',
            data: { object: { ...PRO_SUB, status: 'canceled' } },
        },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(writtenPlan(db.updates), 'free');
});

test('a SECONDARY subscription ending never touches the plan at all', async () => {
    // The org is on Team and recorded against it; an old Pro subscription is
    // being cleaned up. The org's plan is not this event's business.
    const db = makeDb({ recordedSubscriptionId: TEAM_SUB.id, planTier: 'developer_pro', purchasedSeats: 3 });
    const router = loadRoute({
        db,
        subscriptions: [TEAM_SUB],
        event: {
            id: 'evt_del_secondary',
            type: 'customer.subscription.deleted',
            data: { object: { ...PRO_SUB, status: 'canceled' } },
        },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const plan = writtenPlan(db.updates);
    assert.ok(plan === null || plan === 'developer_pro',
        `a secondary subscription's cancellation wrote plan="${plan}" onto an org paying for Team`);
});

test('an update to a secondary subscription does not overwrite the primary plan', async () => {
    // Both live; the org is recorded against Team. Stripe fires
    // customer.subscription.updated on the OLD Pro subscription (a card change,
    // a period rollover). Writing Pro onto this org would downgrade a paying
    // Team workspace with no user action at all.
    const db = makeDb({ recordedSubscriptionId: TEAM_SUB.id, planTier: 'developer_pro', purchasedSeats: 3 });
    const router = loadRoute({
        db,
        subscriptions: [PRO_SUB, TEAM_SUB],
        event: {
            id: 'evt_upd_secondary',
            type: 'customer.subscription.updated',
            data: { object: PRO_SUB },
        },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const plan = writtenPlan(db.updates);
    assert.ok(plan === null || plan === 'developer_pro',
        `a secondary subscription's update wrote plan="${plan}" onto an org paying for Team`);
});

test('an update to the recorded subscription still reconciles normally', async () => {
    const db = makeDb({ recordedSubscriptionId: TEAM_SUB.id, planTier: 'developer_pro', purchasedSeats: 3 });
    // Stripe itself reports the new seat count. The seats come from Stripe's
    // answer, not the payload (the owner's rule since 2026-09-28), so Stripe
    // has to be the one that says 5.
    const teamAtFive = { ...TEAM_SUB, items: { data: [{ ...TEAM_SUB.items.data[0], quantity: 5 }] } };
    const router = loadRoute({
        db,
        subscriptions: [teamAtFive],
        event: {
            id: 'evt_upd_primary',
            type: 'customer.subscription.updated',
            data: { object: { ...TEAM_SUB, items: { data: [{ ...TEAM_SUB.items.data[0], quantity: 5 }] } } },
        },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(writtenPlan(db.updates), 'developer_pro');
    const seatWrite = db.updates.find((u) => u.applied && /purchased_seats = \$/.test(u.text));
    assert.ok(seatWrite && seatWrite.params.includes(5), 'the seat count on the recorded subscription must still follow it');
});
