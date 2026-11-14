'use strict';

/**
 * A SUBSCRIPTION WHOSE PRICE DEERDAWN DOES NOT RECOGNISE.
 *
 * With "Stripe's word is final" every subscription and invoice event re-reads
 * the subscription and writes its plan through the price map. A price missing
 * from the map was mapped to 'free', so on every event — renewals included — a
 * paying customer on it lost their plan. It happens after a new price is
 * created in Stripe and before its env var is set, and to anyone on an old
 * price that has no slot (neither annual price has a legacy slot, and
 * STRIPE_PRICE_DEVELOPER_PRO_ANNUAL leaves the map once STRIPE_PRICE_MAX_ANNUAL
 * is set).
 *
 * The owner's decision (2026-09-28):
 *   - a live subscription with an unrecognised price keeps whatever plan the
 *     workspace already has, and the owner gets an alert naming the price;
 *   - a brand-new purchase at an unrecognised price gets nothing until it is
 *     mapped, and the owner is alerted;
 *   - status, period and subscription id are still Stripe's;
 *   - no plan_changed or created row is booked from a plan DeerDawn could not
 *     determine;
 *   - at most one alert per price per day, after commit, best-effort;
 *   - an ENDED subscription behaves as before.
 *
 * And (2026-09-29): the plan is kept WHATEVER THE STATUS: unpaid, incomplete
 * and paused no longer write Free; the status alone decides the lock.
 *
 * Drives the REAL router over a Stripe double at the stripeService edge and a
 * Postgres double that applies writes to one org row (the harness of
 * stripe-webhook-stripe-is-the-source.test.js, plus the alert guard's table).
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_unrecognised_price';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = process.env.STRIPE_PRICE_DEVELOPER_BASIC || 'price_pro_monthly';
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly';

// MRR is booked at the plan's LIST price (webhooks-stripe.js planMrrCents), so
// the expected figures are read from plans.js rather than typed: they changed
// with the 2026-11 hosted pricing (Individual $12, Team $15 a seat). Lazy, so
// plans.js is loaded after this file has set its env.
function mrrCents(planId, seats = 1) {
    return require('../../src/config/plans').PLANS[planId].price * 100 * seats;
}

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const express = require('express');

const DB_PATH = require.resolve('../../src/config/db');
const REDIS_PATH = require.resolve('../../src/config/redis');
const PLANS_PATH = require.resolve('../../src/config/plans');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const PRODUCT_EVENTS_PATH = require.resolve('../../src/services/productEventsService');
const RETENTION_LEDGER_PATH = require.resolve('../../src/services/retentionLedger');
const EMAIL_PATH = require.resolve('../../src/services/email/resendClient');
const ROUTE_PATH = require.resolve('../../src/routes/webhooks-stripe');

const PRO = process.env.STRIPE_PRICE_DEVELOPER_BASIC;
const TEAM = process.env.STRIPE_PRICE_DEVELOPER_PRO;
// A new Pro price and a new Team price created in Stripe; no env var names them yet.
const NEW_PRO = 'price_pro_new_unmapped';
const NEW_TEAM = 'price_team_new_unmapped';
const ORG_ID = 'org-5e5e5e5e-6f6f-7a7a-8b8b-9c9c9c9c9c9c';
const CUSTOMER = 'cus_unrecognised_price';
const DAY = 86_400;
const T0 = 1_758_000_000;
const clone = (value) => JSON.parse(JSON.stringify(value));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sub({ id = 'sub_1', status = 'active', price = NEW_PRO, quantity = 1, customer = CUSTOMER, created = T0, periodStart = T0 } = {}) {
    return {
        id,
        object: 'subscription',
        status,
        customer,
        created,
        metadata: {},
        schedule: null,
        items: { data: [{ id: `si_${id}`, quantity, current_period_start: periodStart, current_period_end: periodStart + 30 * DAY, price: { id: price } }] },
    };
}

let seq = 0;
const eventId = (prefix) => `evt_${prefix}_${(seq += 1)}`;
const itemsWas = (price, quantity) => ({ items: { data: [{ price: { id: price }, quantity }] } });

function updated(subscription, { prev = { default_payment_method: 'pm_old' }, created = T0 + DAY } = {}) {
    return { id: eventId('upd'), type: 'customer.subscription.updated', created, data: { object: clone(subscription), ...(prev ? { previous_attributes: prev } : {}) } };
}

function deletedEvent(subscription) {
    return { id: eventId('del'), type: 'customer.subscription.deleted', created: T0 + 2 * DAY, data: { object: clone(subscription) } };
}

function invoiceEvent(type, { subscription = 'sub_1', billingReason = 'subscription_cycle', created = T0 + 30 * DAY } = {}) {
    const id = eventId('inv');
    return {
        id,
        type,
        created,
        data: { object: { id: `in_${id}`, object: 'invoice', customer: CUSTOMER, subscription, billing_reason: billingReason, amount_due: 1200, attempt_count: 1, next_payment_attempt: created + 3 * DAY, hosted_invoice_url: null } },
    };
}

function completed({ subscription = 'sub_1', tierId = 'developer_basic' } = {}) {
    const id = eventId('cs');
    return {
        id,
        type: 'checkout.session.completed',
        created: T0,
        data: { object: { id: `cs_${id}`, object: 'checkout.session', mode: 'subscription', customer: CUSTOMER, subscription, amount_total: 1200, currency: 'usd', metadata: { orgId: ORG_ID, tierId, billingCycle: 'monthly' } } },
    };
}

function assignments(setClause) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of setClause) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
        current += ch;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

/**
 * One org row that applies the writes addressed to it and undoes a transaction
 * on ROLLBACK, the stripe_events claim, and the alert guard's table (whose
 * "a day" is measured on `clock`, so a test can move time on).
 */
function makeDb(initialRow, clock) {
    const row = {
        org_id: ORG_ID,
        plan: 'free',
        plan_tier: 'free',
        subscription_status: 'active',
        stripe_customer_id: CUSTOMER,
        stripe_subscription_id: null,
        purchased_seats: null,
        pending_plan: null,
        billing_period_start: null,
        billing_period_end: null,
        ...initialRow,
    };
    const events = new Map();
    const alertSends = new Map();
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
        for (const assignment of assignments(setClause)) {
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
        if (/CREATE TABLE IF NOT EXISTS billing_alert_sends/.test(text)) return { rows: [] };
        if (/INSERT INTO billing_alert_sends/.test(text)) {
            const last = alertSends.get(params[0]);
            if (last !== undefined && clock.ms - last < DAY * 1000) return { rows: [], rowCount: 0 };
            alertSends.set(params[0], clock.ms);
            return { rows: [{ alert_key: params[0] }], rowCount: 1 };
        }
        if (/DELETE FROM billing_alert_sends/.test(text)) { alertSends.delete(params[0]); return { rows: [], rowCount: 1 }; }
        if (/^\s*SELECT/i.test(text) && /FROM stripe_events/.test(text)) {
            const status = events.get(params[0]);
            return status ? { rows: [{ status }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/INSERT INTO stripe_events/.test(text) && /'processing'/.test(text)) {
            const existing = events.get(params[0]);
            if (existing && existing !== 'failed') return { rows: [], rowCount: 0 };
            events.set(params[0], 'processing');
            return { rows: [{ event_id: params[0] }], rowCount: 1 };
        }
        if (/INSERT INTO stripe_events/.test(text) && /'failed'/.test(text)) {
            if (/status\s*(<>|!=)\s*'processed'/.test(text) && events.get(params[0]) === 'processed') return { rows: [], rowCount: 0 };
            events.set(params[0], 'failed');
            return { rows: [], rowCount: 1 };
        }
        if (/UPDATE stripe_events/.test(text)) { events.set(params[0], params[1]); return { rows: [], rowCount: 1 }; }
        if (/^\s*SELECT/i.test(text) && /FROM organizations/.test(text)) {
            const where = /WHERE\s+(?:o\.)?(stripe_subscription_id|stripe_customer_id|org_id)\s*=\s*\$1/.exec(text);
            const hit = where ? row[where[1]] === params[0] : true;
            return hit ? { rows: [{ ...row, email: 'buyer@example.com' }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/FROM users/.test(text)) return { rows: [{ user_id: 'user-1', email: 'buyer@example.com' }], rowCount: 1 };
        if (/UPDATE organizations/.test(text)) {
            if (!matches(text, params)) return { rows: [], rowCount: 0 };
            apply(text, params);
            return { rows: [{ org_id: ORG_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }

    const pool = { connect: async () => ({ query, release() {} }) };
    return { row, events, alertSends, module: { query, pool } };
}

function permissionError() {
    return Object.assign(new Error('This API key does not have access to this subscription'), { type: 'StripePermissionError', statusCode: 403 });
}

function makeStripe(initial) {
    const subs = new Map(initial.map((s) => [s.id, clone(s)]));
    const control = { failure: null };
    const api = {
        retrieve: async (id) => {
            if (control.failure) throw control.failure();
            const found = subs.get(id);
            if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
            return clone(found);
        },
        list: async ({ customer }) => {
            if (control.failure) throw control.failure();
            return { object: 'list', data: [...subs.values()].filter((s) => s.customer === customer).sort((a, b) => b.created - a.created).map(clone), has_more: false };
        },
    };
    function set(id, { status, price, quantity, periodStart } = {}) {
        const s = subs.get(id);
        if (status) s.status = status;
        if (price) s.items.data[0].price = { id: price };
        if (quantity != null) s.items.data[0].quantity = quantity;
        if (periodStart != null) {
            s.items.data[0].current_period_start = periodStart;
            s.items.data[0].current_period_end = periodStart + 30 * DAY;
        }
        return clone(s);
    }
    return { subs, control, api, set };
}

/** Set (or clear, with undefined) env vars, then load plans.js and the route afresh. */
function withEnv(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

function load({ org = {}, subscriptions = [], env = {} } = {}) {
    const clock = { ms: (T0 + 60 * DAY) * 1000 };
    const db = makeDb(org, clock);
    const stripe = makeStripe(subscriptions);
    const state = { nextEvent: null, emailFails: false };
    const ledger = [];
    const emails = [];
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };
    let app = null;

    function mount(envPatch) {
        withEnv(envPatch);
        for (const p of [DB_PATH, REDIS_PATH, PLANS_PATH, STRIPE_SERVICE_PATH, PRODUCT_EVENTS_PATH, RETENTION_LEDGER_PATH, EMAIL_PATH, ROUTE_PATH]) {
            delete require.cache[p];
        }
        stub(DB_PATH, db.module);
        stub(REDIS_PATH, { redis: { del: async () => 1 } });
        stub(STRIPE_SERVICE_PATH, {
            stripe: {
                webhooks: { constructEvent: () => state.nextEvent },
                subscriptions: stripe.api,
                subscriptionSchedules: { retrieve: async () => null, create: async () => ({ id: 'sched' }), update: async () => ({}) },
                charges: { retrieve: async () => ({}) },
            },
        });
        stub(PRODUCT_EVENTS_PATH, { recordProductEvent: async () => ({}) });
        stub(RETENTION_LEDGER_PATH, {
            recordSubscriptionEvent: async (entry) => {
                if (entry.stripe_event_id && ledger.some((e) => e.stripe_event_id === entry.stripe_event_id && e.event_type === entry.event_type)) return;
                ledger.push({ ...entry });
            },
        });
        stub(EMAIL_PATH, {
            sendEmail: async (mail) => {
                if (state.emailFails && mail.emailType === 'unrecognised_price_alert') return { ok: false, status: 503 };
                emails.push(mail);
                return { ok: true };
            },
        });
        app = express();
        app.use('/hook', require(ROUTE_PATH));
    }
    mount(env);

    async function webhook(event) {
        state.nextEvent = event;
        // Bound to 127.0.0.1, the address fetched below: listening on every
        // interface let the OS hand out a port another process already held on
        // 127.0.0.1, whose answer (a 501) then failed the test at random.
        const server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/hook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=stub' },
                body: JSON.stringify({ stub: true }),
            });
            const body = await res.json().catch(() => ({}));
            // The ledger and the alerts are written after COMMIT, unawaited.
            await new Promise((r) => setImmediate(r));
            await sleep(15);
            return { status: res.status, body };
        } finally {
            server.close();
            server.closeAllConnections();
        }
    }

    return {
        db,
        stripe,
        ledger,
        emails,
        clock,
        state,
        webhook,
        /** The price gets its env var and the API is deployed again. */
        remap: (envPatch) => mount(envPatch),
        priceAlerts: () => emails.filter((m) => m.emailType === 'unrecognised_price_alert'),
    };
}

// Every test leaves the env as it found it.
const ENV_KEYS = ['STRIPE_PRICE_DEVELOPER_BASIC_LEGACY', 'STRIPE_PRICE_MAX_MONTHLY'];
test.afterEach(() => withEnv(Object.fromEntries(ENV_KEYS.map((k) => [k, undefined]))));

function entitlementsOf(row) {
    return require('../../src/services/entitlementService').getEntitlementsFromOrg(row);
}

/** The enforcement gate: a paid plan beside one of these statuses answers 403 subscription_inactive. */
function locked(row) {
    return ['cancelled', 'unpaid', 'incomplete', 'past_due', 'trial_expired'].includes(row.subscription_status) && row.plan_tier !== 'free';
}

const WORKSPACES = [
    { name: 'a paying Pro workspace', plan: 'developer_basic', seats: 1, price: NEW_PRO, mappedPrice: PRO },
    { name: 'a paying Team workspace', plan: 'developer_pro', seats: 3, price: NEW_TEAM, mappedPrice: TEAM },
];

const paying = (w) => ({ plan: w.plan, plan_tier: w.plan, purchased_seats: w.seats, stripe_subscription_id: 'sub_1', subscription_status: 'active' });

function assertKept(h, w, { status = 'active' } = {}) {
    const row = h.db.row;
    assert.strictEqual(row.plan_tier, w.plan, `${w.name} on an unrecognised price was put on "${row.plan_tier}" while it pays for ${w.plan}`);
    assert.strictEqual(row.plan, w.plan);
    assert.strictEqual(row.purchased_seats, w.seats, `seats moved to ${row.purchased_seats}`);
    assert.strictEqual(row.subscription_status, status, 'status is Stripe\'s');
    assert.strictEqual(row.stripe_subscription_id, 'sub_1');
    if (status === 'active') {
        assert.strictEqual(locked(row), false);
        assert.strictEqual(entitlementsOf(row).tier, w.plan, 'the plan it pays for no longer works');
    }
}

function assertNoPlanRows(h) {
    const invented = h.ledger.filter((e) => e.event_type === 'plan_changed' || e.event_type === 'created' || e.plan_tier === 'free');
    assert.deepStrictEqual(invented, [], `the ledger booked a plan DeerDawn could not determine: ${JSON.stringify(invented)}`);
}

function assertOneAlertFor(h, priceId) {
    const alerts = h.priceAlerts();
    assert.strictEqual(alerts.length, 1, `expected one alert for ${priceId}, got ${alerts.length}`);
    const [alert] = alerts;
    assert.match(alert.subject, new RegExp(priceId));
    assert.match(alert.html, new RegExp(priceId), 'the alert must name the price');
    assert.match(alert.html, /sub_1|sub_new|sub_2/, 'the alert must name the subscription');
    assert.match(alert.html, new RegExp(ORG_ID), 'the alert must name the workspace');
    assert.match(alert.html, /STRIPE_PRICE_DEVELOPER_BASIC\b/, 'the alert must name the env vars the map is built from');
    assert.match(alert.html, /STRIPE_PRICE_MAX_ANNUAL \(not set\)/);
}

for (const w of WORKSPACES) {
    test(`renewal: ${w.name} on an unrecognised price keeps its plan, the period moves, one alert`, async () => {
        const h = load({ org: paying(w), subscriptions: [sub({ price: w.price, quantity: w.seats })] });
        const renewed = h.stripe.set('sub_1', { periodStart: T0 + 30 * DAY });
        const upd = await h.webhook(updated(renewed, { prev: { current_period_start: T0 }, created: T0 + 30 * DAY }));
        const paid = await h.webhook(invoiceEvent('invoice.payment_succeeded', { created: T0 + 30 * DAY }));
        assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
        assert.strictEqual(paid.status, 200, JSON.stringify(paid.body));

        assertKept(h, w);
        assert.strictEqual(new Date(h.db.row.billing_period_end).getTime(), (T0 + 60 * DAY) * 1000, 'the period is Stripe\'s');
        assertNoPlanRows(h);
        const renewals = h.ledger.filter((e) => e.event_type === 'renewed');
        assert.strictEqual(renewals.length, 1);
        assert.strictEqual(renewals[0].plan_tier, w.plan, 'the renewal is priced at the plan the workspace kept');
        assertOneAlertFor(h, w.price);
    });

    test(`update: ${w.name} moved onto an unrecognised price keeps its plan, books no change, one alert`, async () => {
        const h = load({ org: paying(w), subscriptions: [sub({ price: w.mappedPrice, quantity: w.seats })] });
        // The owner moves subscribers onto a new price in Stripe before its env var is set.
        const moved = h.stripe.set('sub_1', { price: w.price });
        const res = await h.webhook(updated(moved, { prev: itemsWas(w.mappedPrice, w.seats) }));
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assertKept(h, w);
        assertNoPlanRows(h);
        assert.ok(!h.ledger.some((e) => e.event_type === 'cancelled'), 'a paying customer was booked as churn');
        assertOneAlertFor(h, w.price);
    });

    test(`payment failed, then recovered: ${w.name} on an unrecognised price locks and unlocks on its own plan, one price alert`, async () => {
        const h = load({ org: paying(w), subscriptions: [sub({ price: w.price, quantity: w.seats })] });

        h.stripe.set('sub_1', { status: 'past_due' });
        const failed = await h.webhook(invoiceEvent('invoice.payment_failed', { created: T0 + 30 * DAY }));
        assert.strictEqual(failed.status, 200, JSON.stringify(failed.body));
        assertKept(h, w, { status: 'past_due' });
        assert.strictEqual(locked(h.db.row), true, 'past_due on a paid plan locks, as it does on a recognised price');
        assert.strictEqual(h.emails.filter((m) => m.emailType === 'past_due_alert').length, 1, 'the payment-failed alert is still sent');

        const recovered = h.stripe.set('sub_1', { status: 'active' });
        const paid = await h.webhook(invoiceEvent('invoice.payment_succeeded', { created: T0 + 31 * DAY }));
        const upd = await h.webhook(updated(recovered, { prev: { status: 'past_due' }, created: T0 + 31 * DAY }));
        assert.strictEqual(paid.status, 200, JSON.stringify(paid.body));
        assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
        assertKept(h, w);
        assertNoPlanRows(h);
        assertOneAlertFor(h, w.price);
    });

    test(`seat change: ${w.name} on an unrecognised price keeps its plan and its seats, one alert`, async () => {
        const h = load({ org: paying(w), subscriptions: [sub({ price: w.price, quantity: w.seats })] });
        const more = h.stripe.set('sub_1', { quantity: w.seats + 2 });
        const res = await h.webhook(updated(more, { prev: itemsWas(w.price, w.seats) }));
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        // The seat line is recognised by its price, so the count cannot be
        // read without knowing the plan: it is kept, not guessed.
        assertKept(h, w);
        assert.ok(!h.ledger.some((e) => e.event_type === 'seats_changed'));
        assertNoPlanRows(h);
        assertOneAlertFor(h, w.price);
    });
}

test('first checkout at an unrecognised price: nothing is granted, the event is processed, one alert; once mapped, the next event writes the plan', async () => {
    const h = load({ org: { plan: 'free', plan_tier: 'free', stripe_subscription_id: null }, subscriptions: [sub({ id: 'sub_new', price: NEW_PRO })] });
    const event = completed({ subscription: 'sub_new' });
    const res = await h.webhook(event);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.events.get(event.id), 'processed', 'the event must be processed, not failed, or Stripe redelivers it for three days');
    assert.strictEqual(h.db.row.plan_tier, 'free', 'a purchase at an unrecognised price was granted a plan');
    assert.strictEqual(entitlementsOf(h.db.row).tier, 'free');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_new', 'the subscription is recorded, so the first event after mapping can apply it');
    assert.deepStrictEqual(h.ledger, [], `the ledger booked ${JSON.stringify(h.ledger)}`);
    assertOneAlertFor(h, NEW_PRO);
    assert.match(h.priceAlerts()[0].html, /granted nothing/);

    // The owner sets the env var and deploys. The next event writes Pro.
    h.remap({ STRIPE_PRICE_DEVELOPER_BASIC_LEGACY: NEW_PRO });
    const next = await h.webhook(updated(h.stripe.set('sub_new', {}), { prev: { default_payment_method: 'pm_old' } }));
    assert.strictEqual(next.status, 200, JSON.stringify(next.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_basic');
    assert.strictEqual(entitlementsOf(h.db.row).tier, 'developer_basic');
    assert.strictEqual(h.priceAlerts().length, 1, 'a mapped price alerts nobody');
});

test('a Team workspace keeps Team while its price is unrecognised, and gets its seats from Stripe on the first event after the price is mapped', async () => {
    const w = WORKSPACES[1];
    const h = load({ org: paying(w), subscriptions: [sub({ price: w.price, quantity: 5 })] });
    await h.webhook(updated(h.stripe.set('sub_1', {}), { prev: itemsWas(w.price, 3) }));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    h.remap({ STRIPE_PRICE_MAX_MONTHLY: NEW_TEAM });
    const res = await h.webhook(updated(h.stripe.set('sub_1', {}), { prev: { default_payment_method: 'pm_old' } }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(h.db.row.purchased_seats, 5);
});

// A subscription ends and the customer is still paying for another one: the
// workspace adopts the survivor. The seats it gets are the seats Stripe bills
// the SURVIVOR for, not the ones the ended subscription had, and not none. The
// owner's rule for an unrecognised price applies to a survivor like to any live
// subscription: the plan and the seats the workspace has are kept, and the
// owner is alerted. The survivor below bills a different seat count from the
// ended one, so "written" and "kept" cannot be confused.

test('a surviving subscription is adopted with the seats Stripe bills for it', async () => {
    const h = load({
        org: { ...paying(WORKSPACES[1]) },
        subscriptions: [sub({ id: 'sub_1', price: TEAM, quantity: 3, status: 'canceled' }), sub({ id: 'sub_2', price: TEAM, quantity: 5, created: T0 + 5 })],
    });
    const res = await h.webhook(deletedEvent(h.stripe.set('sub_1', {})));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_2');
    assert.strictEqual(h.db.row.subscription_status, 'active');
    assert.strictEqual(h.db.row.purchased_seats, 5, `the adopted subscription bills 5 seats; the workspace records ${h.db.row.purchased_seats}`);
    assert.strictEqual(entitlementsOf(h.db.row).limits.included_seats, 5, 'the seat cap an invite meets is the one being paid for');
    assert.ok(!h.ledger.some((e) => e.event_type === 'cancelled'), 'this is not churn');
    const change = h.ledger.find((e) => e.event_type === 'plan_changed');
    assert.ok(change, 'the move onto the survivor is booked');
    assert.strictEqual(change.plan_tier, 'developer_pro');
    assert.strictEqual(change.mrr_cents, 5 * mrrCents('developer_pro'), 'priced at the survivor\'s seats');
    assert.strictEqual(h.priceAlerts().length, 0, 'a recognised price alerts nobody');
});

test('a surviving subscription on an unrecognised price keeps the workspace\'s plan and seats, books no plan change, and alerts', async () => {
    const h = load({
        org: { ...paying(WORKSPACES[1]) },
        subscriptions: [sub({ id: 'sub_1', price: TEAM, quantity: 3, status: 'canceled' }), sub({ id: 'sub_2', price: NEW_TEAM, quantity: 5, created: T0 + 5 })],
    });
    const res = await h.webhook(deletedEvent(h.stripe.set('sub_1', {})));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro', 'a customer still paying for a live subscription was dropped');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_2');
    assert.strictEqual(h.db.row.subscription_status, 'active');
    assert.strictEqual(h.db.row.purchased_seats, 3,
        `the survivor's seat line is not recognisable without its plan, so the seats the workspace has are kept; it records ${h.db.row.purchased_seats}`);
    assert.strictEqual(entitlementsOf(h.db.row).limits.included_seats, 3);
    assertNoPlanRows(h);
    assert.ok(!h.ledger.some((e) => e.event_type === 'cancelled'), 'this is not churn');
    assertOneAlertFor(h, NEW_TEAM);
});

test('one alert per price per day: a second price alerts on its own, the same price again the next day', async () => {
    const w = WORKSPACES[0];
    const h = load({ org: paying(w), subscriptions: [sub({ price: NEW_PRO })] });
    for (let i = 0; i < 3; i += 1) await h.webhook(updated(h.stripe.set('sub_1', {})));
    assert.strictEqual(h.priceAlerts().length, 1);

    h.stripe.set('sub_1', { price: 'price_pro_another_unmapped' });
    await h.webhook(updated(h.stripe.set('sub_1', {})));
    assert.strictEqual(h.priceAlerts().length, 2, 'a second unrecognised price is its own alert');

    h.stripe.set('sub_1', { price: NEW_PRO });
    await h.webhook(updated(h.stripe.set('sub_1', {})));
    assert.strictEqual(h.priceAlerts().length, 2, 'the first price already alerted today');
    h.clock.ms += DAY * 1000 + 1;
    await h.webhook(updated(h.stripe.set('sub_1', {})));
    assert.strictEqual(h.priceAlerts().length, 3, 'a day later the price alerts again');
    assertKept(h, w);
});

test('an alert that cannot be sent never fails the webhook, and the next event tries again', async () => {
    const w = WORKSPACES[0];
    const h = load({ org: paying(w), subscriptions: [sub({ price: NEW_PRO })] });
    h.state.emailFails = true;
    const res = await h.webhook(updated(h.stripe.set('sub_1', {})));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assertKept(h, w);
    assert.strictEqual(h.priceAlerts().length, 0);
    h.state.emailFails = false;
    await h.webhook(updated(h.stripe.set('sub_1', {})));
    assert.strictEqual(h.priceAlerts().length, 1, 'a failed send kept its claim, so nobody was ever told');
});

test('an ENDED subscription on an unrecognised price follows the path for ended subscriptions, unchanged (guard)', async () => {
    const w = WORKSPACES[0];
    const h = load({ org: paying(w), subscriptions: [sub({ price: NEW_PRO, status: 'canceled' })] });
    const upd = await h.webhook(updated(h.stripe.set('sub_1', {})));
    assert.strictEqual(upd.status, 200);
    assert.strictEqual(h.db.row.plan_tier, w.plan, 'the update leaves it for the deleted event to settle');
    assert.strictEqual(h.db.row.subscription_status, 'active');
    const del = await h.webhook(deletedEvent(h.stripe.set('sub_1', {})));
    assert.strictEqual(del.status, 200);
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.strictEqual(h.db.row.subscription_status, 'cancelled');
    assert.strictEqual(h.db.row.stripe_subscription_id, null);
    assert.ok(h.ledger.some((e) => e.event_type === 'cancelled'));
    assert.strictEqual(h.priceAlerts().length, 0, 'an ended subscription alerts nobody');
});

test('refused for good, an update on an unrecognised price does not change the plan either', async () => {
    const w = WORKSPACES[0];
    const h = load({ org: paying(w), subscriptions: [sub({ price: NEW_PRO })] });
    h.stripe.control.failure = permissionError;
    const res = await h.webhook(updated(sub({ price: NEW_PRO })));
    // Was 200 and 'free': the payload was written and its unrecognised price
    // mapped to Free. Since 2026-09-29 nothing is written from an event whose
    // subscription Stripe refuses to show, and it is never closed (5xx, Stripe
    // redelivers); an unrecognised price never changes the plan in any case.
    assert.ok(res.status >= 500, `answered ${res.status}`);
    assert.strictEqual(h.db.row.plan_tier, w.plan);
    assert.strictEqual(h.priceAlerts().length, 0);
});

// The owner's decision (2026-09-29): the plan is never changed by an
// unrecognised price WHATEVER THE STATUS. unpaid, incomplete and paused used to
// write Free, and the workspace stayed Free after the customer paid.
for (const status of ['unpaid', 'incomplete', 'paused']) {
    for (const w of WORKSPACES) {
        test(`${w.name} on an unrecognised price that Stripe reports ${status} keeps its plan and seats, takes Stripe's status, and alerts`, async () => {
            const h = load({ org: paying(w), subscriptions: [sub({ price: w.price, quantity: w.seats, status })] });
            const res = await h.webhook(updated(h.stripe.set('sub_1', {}), { prev: { status: 'active' } }));
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assertKept(h, w, { status });
            assert.strictEqual(locked(h.db.row), status !== 'paused', 'the status alone decides the lock: unpaid and incomplete lock, paused does not');
            assertNoPlanRows(h);
            assertOneAlertFor(h, w.price);

            // Paid up again: the plan it kept works.
            const res2 = await h.webhook(updated(h.stripe.set('sub_1', { status: 'active' }), { prev: { status } }));
            assert.strictEqual(res2.status, 200, JSON.stringify(res2.body));
            assertKept(h, w);
        });
    }
}

test('the alert lists every env var the price map is built from', () => {
    delete require.cache[PLANS_PATH];
    const { PRICE_MAP_ENV_VARS } = require('../../src/config/plans');
    const source = fs.readFileSync(PLANS_PATH, 'utf8');
    const read = new Set([...source.matchAll(/process\.env\.(STRIPE_PRICE_[A-Z0-9_]+)/g)].map((m) => m[1]));
    assert.ok(Array.isArray(PRICE_MAP_ENV_VARS), 'plans.js must export PRICE_MAP_ENV_VARS');
    assert.deepStrictEqual([...PRICE_MAP_ENV_VARS].sort(), [...read].sort());
});
