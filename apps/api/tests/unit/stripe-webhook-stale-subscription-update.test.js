'use strict';

/**
 * A STALE customer.subscription.updated MUST NOT BRING A DEAD SUBSCRIPTION BACK.
 *
 * Stripe does not deliver events in order, and it redelivers any event that was
 * answered with a 5xx. So an `updated` event can arrive AFTER the
 * `customer.subscription.deleted` for the same subscription, still carrying the
 * `status: 'active'` it had when it was created.
 *
 * The deleted handler clears organizations.stripe_subscription_id on churn. The
 * stale update then misses the org by subscription id, finds it by customer id,
 * skips the "secondary subscription" guard (the org records no subscription to
 * compare against), and wrote the dead subscription's plan and `active` onto the
 * org. The subscription is dead in Stripe, so no later event ever corrects it:
 * paid access, permanently, for nothing.
 *
 * The rule these tests pin: an update for a subscription the org does not
 * record is never trusted from its payload. Stripe is asked what the
 * subscription is NOW, and only a live answer is adopted — with the state Stripe
 * returned, not the state the event remembered.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_stale_update';
// plans.js reads these at require time; without them no line item maps to a plan.
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

const PRO_PRICE = process.env.STRIPE_PRICE_DEVELOPER_BASIC;
const TEAM_PRICE = process.env.STRIPE_PRICE_DEVELOPER_PRO;
const ORG_ID = 'org-12121212-3434-5656-7878-909090909090';
const CUSTOMER = 'cus_stale_update';

function subscription({ id, status = 'active', price = PRO_PRICE, quantity = 1 }) {
    return {
        id,
        status,
        customer: CUSTOMER,
        created: 1_750_000_000,
        items: { data: [{ id: `si_${id}`, quantity, current_period_start: 1_755_000_000, current_period_end: 1_757_678_400, price: { id: price } }] },
    };
}

/**
 * A Postgres double that APPLIES the handler's writes to one org row and to the
 * stripe_events table, honours each UPDATE's WHERE clause, and undoes the
 * transaction on ROLLBACK — so "the org is now in this state" is asserted, not
 * "an UPDATE was issued".
 */
function makeDb(initialRow) {
    const row = { org_id: ORG_ID, stripe_customer_id: CUSTOMER, ...initialRow };
    const events = new Map();
    const arg = (params, n) => params[Number(n) - 1];

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

    function apply(text, params) {
        const setClause = /SET([\s\S]*?)WHERE/.exec(text)[1];
        for (const assignment of setClause.split(',')) {
            const bound = /(\w+)\s*=\s*\$(\d+)/.exec(assignment);
            if (bound) { row[bound[1]] = arg(params, bound[2]); continue; }
            const nulled = /(\w+)\s*=\s*NULL/.exec(assignment);
            if (nulled) row[nulled[1]] = null;
        }
    }

    let snapshot = null;
    async function query(text, params = []) {
        if (/^\s*BEGIN/i.test(text)) { snapshot = { row: { ...row }, events: new Map(events) }; return { rows: [] }; }
        if (/^\s*COMMIT/i.test(text)) { snapshot = null; return { rows: [] }; }
        if (/^\s*ROLLBACK/i.test(text)) {
            if (snapshot) {
                for (const key of Object.keys(row)) delete row[key];
                Object.assign(row, snapshot.row);
                events.clear();
                for (const [k, v] of snapshot.events) events.set(k, v);
                snapshot = null;
            }
            return { rows: [] };
        }
        if (/INSERT INTO stripe_events/.test(text) && /'processing'/.test(text)) {
            const existing = events.get(params[0]);
            if (existing && existing !== 'failed') return { rows: [], rowCount: 0 };
            events.set(params[0], 'processing');
            return { rows: [{ event_id: params[0] }], rowCount: 1 };
        }
        if (/INSERT INTO stripe_events/.test(text) && /'failed'/.test(text)) {
            events.set(params[0], 'failed');
            return { rows: [], rowCount: 1 };
        }
        if (/UPDATE stripe_events/.test(text)) {
            events.set(params[0], params[1]);
            return { rows: [], rowCount: 1 };
        }
        if (/^\s*SELECT/i.test(text) && /FROM organizations/.test(text)) {
            if (/WHERE stripe_subscription_id = \$1/.test(text) && row.stripe_subscription_id !== params[0]) {
                return { rows: [], rowCount: 0 };
            }
            return { rows: [{ ...row }], rowCount: 1 };
        }
        if (/FROM users/.test(text)) return { rows: [{ user_id: 'user-1', email: 'buyer@example.com' }], rowCount: 1 };
        if (/UPDATE organizations/.test(text)) {
            if (!matches(text, params)) return { rows: [], rowCount: 0 };
            apply(text, params);
            return { rows: [{ org_id: ORG_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }

    return { row, events, module: { query, pool: { connect: async () => ({ query, release() {} }) } } };
}

/** Stripe's CURRENT view of the world, which is what the handler must believe. */
function stripeNow(subscriptions, { onRetrieve = null } = {}) {
    const retrieved = [];
    return {
        retrieved,
        api: {
            retrieve: async (id) => {
                retrieved.push(id);
                if (onRetrieve) await onRetrieve(id);
                const found = subscriptions.find((s) => s.id === id);
                if (!found) throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing', statusCode: 404 });
                return found;
            },
            list: async ({ customer }) => ({ data: subscriptions.filter((s) => s.customer === customer) }),
        },
    };
}

function loadRoute({ event, db, stripeSubscriptions }) {
    const recorded = { ledger: [] };
    const stripeStub = {
        stripe: {
            webhooks: { constructEvent: () => event },
            subscriptions: stripeSubscriptions,
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
    stub(RETENTION_LEDGER_PATH, { recordSubscriptionEvent: async (entry) => { recorded.ledger.push(entry); } });
    stub(EMAIL_PATH, { sendEmail: async () => ({}) });

    return { router: require(ROUTE_PATH), recorded };
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
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 20));
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

/** The state customer.subscription.deleted leaves behind on churn. */
const CHURNED = { plan: 'free', plan_tier: 'free', subscription_status: 'cancelled', stripe_subscription_id: null, purchased_seats: null };

function connectionError() {
    return Object.assign(new Error('An error occurred with our connection to Stripe.'), { type: 'StripeConnectionError' });
}

// ---------------------------------------------------------------------------
// The reported defect: a churned org, and an old update for the dead subscription
// ---------------------------------------------------------------------------

test('a stale "active" update for a subscription Stripe has cancelled does not restore paid access', async () => {
    const db = makeDb({ ...CHURNED });
    const stripe = stripeNow([subscription({ id: 'sub_dead', status: 'canceled' })]);
    const { router, recorded } = loadRoute({
        db,
        stripeSubscriptions: stripe.api,
        // Created before the cancellation, delivered after it.
        event: { id: 'evt_stale_active', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_dead', status: 'active' }) } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.plan_tier, 'free',
        `a subscription Stripe says is cancelled put the org back on "${db.row.plan_tier}" — paid access nobody is paying for`);
    assert.strictEqual(db.row.subscription_status, 'cancelled');
    assert.strictEqual(db.row.stripe_subscription_id, null, 'the dead subscription was re-linked to the org');
    assert.deepStrictEqual(stripe.retrieved, ['sub_dead'], 'the subscription\'s current state has to come from Stripe, not the payload');
    assert.ok(!recorded.ledger.some((e) => e.event_type === 'plan_changed'), 'no plan change happened');
});

test('a stale update for a subscription Stripe no longer has at all leaves the org alone', async () => {
    const db = makeDb({ ...CHURNED });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripeNow([]).api,
        event: { id: 'evt_stale_missing', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_gone', status: 'active' }) } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.plan_tier, 'free');
    assert.strictEqual(db.row.stripe_subscription_id, null);
});

test('a transient Stripe failure during that check is retried, never written through', async () => {
    const db = makeDb({ ...CHURNED });
    const event = { id: 'evt_stale_blip', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_dead', status: 'active' }) } };

    const down = { retrieve: async () => { throw connectionError(); }, list: async () => { throw connectionError(); } };
    const first = await deliver(loadRoute({ db, event, stripeSubscriptions: down }).router);
    assert.ok(first.status >= 500, `Stripe only redelivers on a non-2xx; got ${first.status}`);
    assert.notStrictEqual(db.events.get('evt_stale_blip'), 'processed', 'an event that was not handled was recorded as handled');
    assert.strictEqual(db.row.plan_tier, 'free', 'a failed check fell through to writing the payload');

    // The redelivery, once Stripe answers: the subscription is dead, so nothing moves.
    const second = await deliver(loadRoute({ db, event, stripeSubscriptions: stripeNow([subscription({ id: 'sub_dead', status: 'canceled' })]).api }).router);
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.notStrictEqual(second.body.duplicate, true, 'the redelivery was eaten by the idempotency guard');
    assert.strictEqual(db.row.plan_tier, 'free');
    assert.strictEqual(db.events.get('evt_stale_blip'), 'processed');
});

test('a failure a retry cannot fix does not adopt from the payload either', async () => {
    // "Could not check" is never "live". This answered 200 so that a revoked
    // key would not keep the event failing for three days; the owner's
    // decision (2026-09-29) is the opposite: a refused read is never closed,
    // so it answers 5xx and applies once the key can read the subscription.
    const db = makeDb({ ...CHURNED });
    const denied = Object.assign(new Error('Invalid API Key provided'), { type: 'StripeAuthenticationError', statusCode: 401 });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: { retrieve: async () => { throw denied; }, list: async () => { throw denied; } },
        event: { id: 'evt_stale_denied', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_dead', status: 'active' }) } },
    });

    const res = await deliver(router);
    assert.ok(res.status >= 500, `answered ${res.status}`);
    assert.strictEqual(db.row.plan_tier, 'free');
    assert.strictEqual(db.row.stripe_subscription_id, null);
});

// ---------------------------------------------------------------------------
// The adoption the customer-id fallback exists for must keep working
// ---------------------------------------------------------------------------

test('a LIVE subscription the org does not record is still adopted — with Stripe\'s current state, not the payload\'s', async () => {
    // checkout.session.completed was lost; the org has a customer but no
    // subscription id. The first update for the live subscription re-links it.
    // The payload is older than the subscription: it still says 2 seats, and
    // Stripe says 3.
    const db = makeDb({ plan: 'free', plan_tier: 'free', subscription_status: 'active', stripe_subscription_id: null, purchased_seats: null });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripeNow([subscription({ id: 'sub_new', price: TEAM_PRICE, quantity: 3 })]).api,
        event: { id: 'evt_adopt_live', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_new', price: TEAM_PRICE, quantity: 2 }) } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.plan_tier, 'developer_pro');
    assert.strictEqual(db.row.stripe_subscription_id, 'sub_new');
    assert.strictEqual(db.row.subscription_status, 'active');
    assert.strictEqual(db.row.purchased_seats, 3, 'the seat count came from the event\'s memory instead of from Stripe');
});

test('when the recorded subscription died, a stale update for another dead one is not adopted', async () => {
    // Both are gone. The existing adoption path asks whether the RECORDED one is
    // live (it is not) and then trusted the other one's payload.
    const db = makeDb({ plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'active', stripe_subscription_id: 'sub_recorded' });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripeNow([subscription({ id: 'sub_other', status: 'canceled', price: TEAM_PRICE, quantity: 2 })]).api,
        event: { id: 'evt_other_dead', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_other', status: 'active', price: TEAM_PRICE, quantity: 2 }) } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.plan_tier, 'developer_basic', 'a cancelled Team subscription repriced the org from a stale payload');
    assert.strictEqual(db.row.stripe_subscription_id, 'sub_recorded');
});

// ---------------------------------------------------------------------------
// The same question for the recorded subscription: an old "active" after a newer
// past_due
// ---------------------------------------------------------------------------

test('a stale "active" update for the RECORDED subscription does not undo a newer past_due', async () => {
    const db = makeDb({ plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'past_due', stripe_subscription_id: 'sub_rec' });
    const stripe = stripeNow([subscription({ id: 'sub_rec', status: 'past_due' })]);
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripe.api,
        event: { id: 'evt_rec_stale', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_rec', status: 'active' }) } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.subscription_status, 'past_due',
        'an old event unlocked an account whose payment Stripe is still chasing');
});

test('a real recovery on the recorded subscription still unlocks the account', async () => {
    // The card was fixed and the invoice paid: Stripe says active, and so does the event.
    const db = makeDb({ plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'past_due', stripe_subscription_id: 'sub_rec' });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripeNow([subscription({ id: 'sub_rec', status: 'active' })]).api,
        event: { id: 'evt_rec_recovered', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_rec', status: 'active' }) } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.subscription_status, 'active');
    assert.strictEqual(db.row.plan_tier, 'developer_basic');
});

test('a stale past_due update for the RECORDED subscription does not re-lock an account that has paid', async () => {
    // The mirror image: the past_due event failed delivery, the card was fixed
    // and the account recovered, then Stripe redelivered the old past_due.
    const db = makeDb({ plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'active', stripe_subscription_id: 'sub_rec' });
    const stripe = stripeNow([subscription({ id: 'sub_rec', status: 'active' })]);
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripe.api,
        event: { id: 'evt_rec_stale_lock', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_rec', status: 'past_due' }) } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.subscription_status, 'active',
        'an old event locked out a customer Stripe says is paid up');
});

test('an update that does not move the status still asks Stripe, once', async () => {
    // Renewals, seat changes, card changes. This used to stay on the payload
    // ("only a status flip is worth the call"), and that was journey scan round
    // 3's B3-1: an older same-status update put back the plan and seats the
    // customer had left. The owner's rule since 2026-09-28: every event reads
    // the subscription from Stripe — exactly once.
    const db = makeDb({ plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'active', stripe_subscription_id: 'sub_rec' });
    const stripe = stripeNow([subscription({ id: 'sub_rec', status: 'active' })]);
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripe.api,
        event: { id: 'evt_rec_rollover', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_rec', status: 'active' }) } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(stripe.retrieved, ['sub_rec']);
});

test('a transient failure while confirming a recovery is retried, not guessed', async () => {
    const db = makeDb({ plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'past_due', stripe_subscription_id: 'sub_rec' });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: { retrieve: async () => { throw connectionError(); }, list: async () => { throw connectionError(); } },
        event: { id: 'evt_rec_blip', type: 'customer.subscription.updated', data: { object: subscription({ id: 'sub_rec', status: 'active' }) } },
    });

    const res = await deliver(router);
    assert.ok(res.status >= 500, `got ${res.status}`);
    assert.strictEqual(db.row.subscription_status, 'past_due');
    assert.notStrictEqual(db.events.get('evt_rec_blip'), 'processed');
});
