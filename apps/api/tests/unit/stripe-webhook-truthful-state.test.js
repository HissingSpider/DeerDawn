'use strict';

/**
 * THE WEBHOOK MUST RECORD WHAT HAPPENED, NOT WHAT IT FOUND LYING AROUND.
 *
 * Five defects, one shape: the handler answered 200 and recorded something that
 * was not true, because it took its facts from the nearest convenient place
 * instead of from the thing that actually knew.
 *
 *  1. "Did the plan change?" was answered from organizations.plan_tier — which
 *     POST /billing/checkout has ALREADY written by the time the webhook for an
 *     in-place upgrade arrives. Row says Team, event says Team, so no
 *     plan_changed and no seats_changed was ever recorded for the one path every
 *     Pro-to-Team upgrade takes. Stripe says what changed in
 *     `previous_attributes`; that is the source.
 *  2. A cancelled subscription's "survivor" could be an `incomplete` or `unpaid`
 *     one — an abandoned checkout nobody is paying for — and the org kept a paid
 *     plan on it.
 *  3. Churn left stripe_subscription_id pointing at the dead subscription.
 *  4. A transient Stripe error was turned into an ANSWER ("assume live" / "no
 *     siblings"), the event was dropped or mis-handled on that guess, and then
 *     marked processed so it could never be looked at again.
 *  5. invoice.payment_failed read invoice.subscription, which "basil" payloads
 *     moved to invoice.parent.subscription_details.subscription — so the day the
 *     endpoint's API version is upgraded, failed payments stop locking accounts
 *     and stop alerting anyone, with a 200 on every delivery.
 *
 * Every test drives the real router with a fixture event and asserts on what
 * was written: the org row, the stripe_events row, the ledger call, the alert.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_truthful';
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
const ORG_ID = 'org-11111111-2222-3333-4444-555555555555';
const CUSTOMER = 'cus_truthful';

function subscription({ id, status = 'active', price, quantity = 1, created = 1_750_000_000 }) {
    return {
        id,
        status,
        customer: CUSTOMER,
        created,
        items: { data: [{ id: `si_${id}`, quantity, current_period_start: 1_755_000_000, current_period_end: 1_757_678_400, price: { id: price } }] },
    };
}

/**
 * A Postgres double that APPLIES what the handler writes, to one org row and to
 * the stripe_events table, and honours the WHERE clause. Asserting on the row
 * afterwards is the point: "an UPDATE was issued" and "the org is now in this
 * state" are different claims, and only the second one is what a customer lives
 * with.
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

    // `pending` holds writes made inside the handler's transaction, so a
    // ROLLBACK really does undo them — a 5xx that left its half-finished writes
    // behind would otherwise look the same here as one that did not.
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
            // The real statement only re-claims a row whose status is 'failed'.
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
            const bySub = /WHERE stripe_subscription_id = \$1/.test(text);
            if (bySub && row.stripe_subscription_id !== params[0]) return { rows: [], rowCount: 0 };
            return { rows: [{ ...row, email: 'buyer@example.com' }], rowCount: 1 };
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

function loadRoute({ event, db, stripeSubscriptions }) {
    const recorded = { ledger: [], productEvents: [], emails: [] };
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
    stub(PRODUCT_EVENTS_PATH, { recordProductEvent: async (actor, input) => { recorded.productEvents.push(input); return {}; } });
    stub(RETENTION_LEDGER_PATH, { recordSubscriptionEvent: async (entry) => { recorded.ledger.push(entry); } });
    stub(EMAIL_PATH, { sendEmail: async (mail) => { recorded.emails.push(mail); return {}; } });

    return { router: require(ROUTE_PATH), recorded };
}

/** Stripe double over a fixed list, the same shape the two-subscriptions suite uses. */
function stripeOver(subscriptions) {
    return {
        retrieve: async (id) => {
            const found = subscriptions.find((s) => s.id === id);
            if (!found) throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing', statusCode: 404 });
            return found;
        },
        list: async ({ customer }) => ({ data: subscriptions.filter((s) => s.customer === customer) }),
    };
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
        // The ledger / analytics / alert calls are made after the response is
        // committed and are not awaited by the handler; let them land.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 20));
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

// ---------------------------------------------------------------------------
// 1. The ledger sees an in-place upgrade even though the API wrote the row first
// ---------------------------------------------------------------------------

test('an in-place Pro to Team upgrade is recorded as plan_changed although the org row already says Team', async () => {
    const teamNow = subscription({ id: 'sub_1', price: TEAM_PRICE, quantity: 3 });
    // The state POST /billing/checkout leaves behind BEFORE this event arrives.
    const db = makeDb({ plan_tier: 'developer_pro', purchased_seats: 3, stripe_subscription_id: 'sub_1' });
    const { router, recorded } = loadRoute({
        db,
        stripeSubscriptions: stripeOver([teamNow]),
        event: {
            id: 'evt_upgrade_in_place',
            type: 'customer.subscription.updated',
            data: {
                object: teamNow,
                // What Stripe actually sends for a swapped item: the OLD item.
                previous_attributes: { items: { data: [{ id: 'si_sub_1', quantity: 1, price: { id: PRO_PRICE } }] } },
            },
        },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const change = recorded.ledger.find((entry) => entry.event_type === 'plan_changed');
    assert.ok(change, `the upgrade left no plan_changed row in the ledger — recorded: ${JSON.stringify(recorded.ledger)}`);
    assert.strictEqual(change.plan_tier, 'developer_pro');
    assert.strictEqual(change.org_id, ORG_ID);
    assert.strictEqual(change.stripe_event_id, 'evt_upgrade_in_place');
    assert.ok(change.mrr_cents > 0, 'an active Team subscription is recurring revenue');
});

test('a seat change is recorded although the org row already holds the new count', async () => {
    const teamNow = subscription({ id: 'sub_1', price: TEAM_PRICE, quantity: 5 });
    const db = makeDb({ plan_tier: 'developer_pro', purchased_seats: 5, stripe_subscription_id: 'sub_1' });
    const { router, recorded } = loadRoute({
        db,
        stripeSubscriptions: stripeOver([teamNow]),
        event: {
            id: 'evt_seats',
            type: 'customer.subscription.updated',
            data: {
                object: teamNow,
                previous_attributes: { items: { data: [{ id: 'si_sub_1', quantity: 3, price: { id: TEAM_PRICE } }] } },
            },
        },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const seatEvent = recorded.productEvents.find((e) => e.metadata?.event_type === 'seats_changed');
    assert.ok(seatEvent, `no seats_changed was emitted — emitted: ${JSON.stringify(recorded.productEvents)}`);
    assert.strictEqual(seatEvent.metadata.prior_seats, 3);
    assert.strictEqual(seatEvent.metadata.seats, 5);
    assert.ok(!recorded.ledger.some((entry) => entry.event_type === 'plan_changed'),
        'the plan did not change, only the seat count');
});

test('an update that changed neither plan nor seats records neither', async () => {
    // The tolerance above must not turn every period rollover into a plan change.
    const teamNow = subscription({ id: 'sub_1', price: TEAM_PRICE, quantity: 3 });
    const db = makeDb({ plan_tier: 'developer_pro', purchased_seats: 3, stripe_subscription_id: 'sub_1' });
    const { router, recorded } = loadRoute({
        db,
        stripeSubscriptions: stripeOver([teamNow]),
        event: {
            id: 'evt_rollover',
            type: 'customer.subscription.updated',
            data: { object: teamNow, previous_attributes: { current_period_start: 1_752_000_000, latest_invoice: 'in_old' } },
        },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(recorded.ledger, []);
    assert.ok(!recorded.productEvents.some((e) => e.metadata?.event_type === 'seats_changed'));
});

test('with no previous_attributes the org row is still the comparison (a lost event self-heals)', async () => {
    // The event that made the change never arrived; a later one does. The row
    // still says Pro, the subscription says Team, and the ledger must catch up.
    const teamNow = subscription({ id: 'sub_1', price: TEAM_PRICE, quantity: 2 });
    const db = makeDb({ plan_tier: 'developer_basic', purchased_seats: 1, stripe_subscription_id: 'sub_1' });
    const { router, recorded } = loadRoute({
        db,
        stripeSubscriptions: stripeOver([teamNow]),
        event: { id: 'evt_late', type: 'customer.subscription.updated', data: { object: teamNow } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.plan_tier, 'developer_pro');
    assert.ok(recorded.ledger.some((entry) => entry.event_type === 'plan_changed' && entry.plan_tier === 'developer_pro'));
});

// ---------------------------------------------------------------------------
// 2. + 3. What "still paying" means, and what churn leaves behind
// ---------------------------------------------------------------------------

for (const deadStatus of ['incomplete', 'unpaid']) {
    test(`an ${deadStatus} subscription is not a survivor: cancelling the real one is churn`, async () => {
        const pro = subscription({ id: 'sub_pro', price: PRO_PRICE });
        // An abandoned Team checkout: a subscription object exists, no money does.
        const abandoned = subscription({ id: 'sub_abandoned', status: deadStatus, price: TEAM_PRICE, quantity: 2 });
        const db = makeDb({ plan_tier: 'developer_basic', purchased_seats: null, stripe_subscription_id: 'sub_pro' });
        const { router, recorded } = loadRoute({
            db,
            stripeSubscriptions: stripeOver([abandoned]),
            event: { id: `evt_del_${deadStatus}`, type: 'customer.subscription.deleted', data: { object: { ...pro, status: 'canceled' } } },
        });

        const res = await deliver(router);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(db.row.plan_tier, 'free',
            `the org was left on "${db.row.plan_tier}" by adopting a subscription nobody is paying for`);
        assert.ok(recorded.ledger.some((entry) => entry.event_type === 'cancelled'),
            'this is churn and the ledger has to say so');
    });
}

test('a past_due survivor IS still adopted — Stripe is still trying to charge for it', async () => {
    const team = subscription({ id: 'sub_team', price: TEAM_PRICE, quantity: 3 });
    const proPastDue = subscription({ id: 'sub_pro', status: 'past_due', price: PRO_PRICE });
    const db = makeDb({ plan_tier: 'developer_pro', purchased_seats: 3, stripe_subscription_id: 'sub_team' });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripeOver([proPastDue]),
        event: { id: 'evt_del_team', type: 'customer.subscription.deleted', data: { object: { ...team, status: 'canceled' } } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.plan_tier, 'developer_basic');
    assert.strictEqual(db.row.stripe_subscription_id, 'sub_pro');
});

test('churn forgets the subscription that ended, and keeps the customer', async () => {
    const pro = subscription({ id: 'sub_pro', price: PRO_PRICE });
    const db = makeDb({ plan_tier: 'developer_basic', purchased_seats: null, stripe_subscription_id: 'sub_pro' });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripeOver([]),
        event: { id: 'evt_churn', type: 'customer.subscription.deleted', data: { object: { ...pro, status: 'canceled' } } },
    });

    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.plan_tier, 'free');
    assert.strictEqual(db.row.stripe_subscription_id, null,
        'a churned org still named the dead subscription, so the next checkout tried to move it');
    assert.strictEqual(db.row.stripe_customer_id, CUSTOMER,
        'the customer id is what lets a returning buyer be re-linked');
});

// ---------------------------------------------------------------------------
// 4. A Stripe blip is not an answer
// ---------------------------------------------------------------------------

function connectionError() {
    return Object.assign(new Error('An error occurred with our connection to Stripe.'), { type: 'StripeConnectionError' });
}

test('a transient Stripe failure while checking the recorded subscription is retried, not recorded as handled', async () => {
    // The org is recorded against sub_dead, which really is gone. The update is
    // for the live one. If the liveness check cannot be made, "assume live" drops
    // this event — and marking it processed means it is dropped for good.
    const live = subscription({ id: 'sub_live', price: TEAM_PRICE, quantity: 2 });
    const db = makeDb({ plan_tier: 'developer_basic', purchased_seats: null, stripe_subscription_id: 'sub_dead' });
    const event = { id: 'evt_blip', type: 'customer.subscription.updated', data: { object: live } };

    let stripeUp = false;
    const flaky = {
        retrieve: async (id) => {
            if (!stripeUp) throw connectionError();
            return stripeOver([live]).retrieve(id);
        },
        list: async () => ({ data: [live] }),
    };

    const first = await deliver(loadRoute({ db, event, stripeSubscriptions: flaky }).router);
    assert.ok(first.status >= 500, `Stripe only redelivers on a non-2xx; got ${first.status}`);
    assert.notStrictEqual(db.events.get('evt_blip'), 'processed',
        'an event that was not handled was recorded as handled');
    assert.strictEqual(db.row.plan_tier, 'developer_basic', 'nothing may be half-written by a failed attempt');

    // Stripe redelivers the SAME event id once it is reachable again.
    stripeUp = true;
    const second = await deliver(loadRoute({ db, event, stripeSubscriptions: flaky }).router);
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.notStrictEqual(second.body.duplicate, true, 'the redelivery was eaten by the idempotency guard');
    assert.strictEqual(db.row.plan_tier, 'developer_pro');
    assert.strictEqual(db.row.stripe_subscription_id, 'sub_live');
    assert.strictEqual(db.events.get('evt_blip'), 'processed');
});

test('a transient Stripe failure while looking for a survivor does not downgrade a paying customer', async () => {
    const team = subscription({ id: 'sub_team', price: TEAM_PRICE, quantity: 3 });
    const pro = subscription({ id: 'sub_pro', price: PRO_PRICE });
    const db = makeDb({ plan_tier: 'developer_pro', purchased_seats: 3, stripe_subscription_id: 'sub_team' });
    const event = { id: 'evt_del_blip', type: 'customer.subscription.deleted', data: { object: { ...team, status: 'canceled' } } };

    const down = { retrieve: async () => { throw connectionError(); }, list: async () => { throw connectionError(); } };
    const first = await deliver(loadRoute({ db, event, stripeSubscriptions: down }).router);
    assert.ok(first.status >= 500, `got ${first.status}`);
    assert.strictEqual(db.row.plan_tier, 'developer_pro',
        'a connection error was read as "no other subscription" and the customer still paying for Pro was set to free');

    const second = await deliver(loadRoute({ db, event, stripeSubscriptions: stripeOver([pro]) }).router);
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(db.row.plan_tier, 'developer_basic');
});

test('a Stripe failure a retry cannot fix adopts nothing, and leaves the event for Stripe to redeliver', async () => {
    // Was: refuse to adopt, answer 200, so a revoked key would not fail the
    // event for three days. The owner's decision (2026-09-29): a refused read
    // is never closed; 5xx, nothing adopted, applied once the key can read.
    const live = subscription({ id: 'sub_live', price: TEAM_PRICE, quantity: 2 });
    const db = makeDb({ plan_tier: 'developer_basic', purchased_seats: null, stripe_subscription_id: 'sub_other' });
    const denied = Object.assign(new Error('Invalid API Key provided'), { type: 'StripeAuthenticationError', statusCode: 401 });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: { retrieve: async () => { throw denied; }, list: async () => { throw denied; } },
        event: { id: 'evt_denied', type: 'customer.subscription.updated', data: { object: live } },
    });

    const res = await deliver(router);
    assert.ok(res.status >= 500, `answered ${res.status}`);
    assert.strictEqual(db.row.plan_tier, 'developer_basic');
});

// ---------------------------------------------------------------------------
// 5. invoice.payment_failed, in both payload shapes
// ---------------------------------------------------------------------------

/** Trimmed from a real 2025-03-31.basil invoice.payment_failed payload: there
 *  is NO top-level `subscription`; it lives under parent.subscription_details. */
const BASIL_INVOICE = {
    id: 'in_basil_1',
    object: 'invoice',
    customer: CUSTOMER,
    customer_email: 'buyer@example.com',
    amount_due: 3000,
    attempt_count: 2,
    billing_reason: 'subscription_cycle',
    next_payment_attempt: 1_758_000_000,
    hosted_invoice_url: 'https://invoice.stripe.com/i/basil',
    parent: {
        type: 'subscription_details',
        quote_details: null,
        subscription_details: { metadata: {}, subscription: 'sub_team' },
    },
};

const LEGACY_INVOICE = (() => {
    const { parent: _basilOnly, ...rest } = BASIL_INVOICE;
    return { ...rest, id: 'in_legacy_1', subscription: 'sub_team' };
})();

for (const [shape, invoice] of [['basil (invoice.parent.subscription_details)', BASIL_INVOICE], ['legacy (invoice.subscription)', LEGACY_INVOICE]]) {
    test(`a failed payment marks the org past_due and alerts the operator — ${shape}`, async () => {
        const db = makeDb({ plan_tier: 'developer_pro', purchased_seats: 2, stripe_subscription_id: 'sub_team', subscription_status: 'active' });
        const { router, recorded } = loadRoute({
            db,
            stripeSubscriptions: stripeOver([]),
            event: { id: `evt_failed_${invoice.id}`, type: 'invoice.payment_failed', data: { object: invoice } },
        });

        const res = await deliver(router);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(db.row.subscription_status, 'past_due',
            'the failed charge changed nothing: the subscription id was not found on the invoice');
        assert.ok(recorded.ledger.some((entry) => entry.event_type === 'payment_failed' && entry.org_id === ORG_ID));
        assert.strictEqual(recorded.emails.length, 1, 'nobody was told a payment failed');
        assert.strictEqual(recorded.emails[0].emailType, 'past_due_alert');
    });
}

test('a basil invoice whose subscription arrives expanded still resolves', async () => {
    const expanded = { ...BASIL_INVOICE, id: 'in_basil_expanded', parent: { ...BASIL_INVOICE.parent, subscription_details: { subscription: { id: 'sub_team', object: 'subscription' } } } };
    const db = makeDb({ plan_tier: 'developer_pro', purchased_seats: 2, stripe_subscription_id: 'sub_team', subscription_status: 'active' });
    const { router } = loadRoute({
        db,
        stripeSubscriptions: stripeOver([]),
        event: { id: 'evt_failed_expanded', type: 'invoice.payment_failed', data: { object: expanded } },
    });
    const res = await deliver(router);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(db.row.subscription_status, 'past_due');
});
