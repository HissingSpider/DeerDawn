'use strict';

/**
 * STRIPE'S WORD IS FINAL. THE EVENT IS ONLY A SIGNAL.
 *
 * The owner's decision (2026-09-28), replacing three rounds of case-by-case
 * patches (round 1 B1, round 2 R2-1): every subscription and invoice event
 * re-reads the subscription from Stripe and writes what Stripe says NOW. The
 * event's payload is never the source of plan, seats, status or period.
 *
 * The two defects it closes:
 *   B3-1  An older customer.subscription.updated, delivered after a newer change,
 *         put the workspace back on the old plan and seats while Stripe billed
 *         the new ones. The handler asked Stripe only when the payload's STATUS
 *         differed from the row's, and wrote a same-status payload as it stood.
 *   B3-2  A late invoice.payment_failed locked a workspace that had already paid:
 *         it wrote past_due without asking Stripe.
 *
 * What the rule must also get right:
 *   - no database connection is held while Stripe is read (every event now
 *     reads it, so a slow Stripe must not become an exhausted pool);
 *   - one read of the subscription per event;
 *   - a transient Stripe failure answers 5xx and writes nothing;
 *   - Stripe refusing a read for good writes nothing: 5xx for 24 hours from the
 *     event's `created`, then 200 and one alert to the owner (the owner's
 *     decision, 2026-09-29, which replaced "behave exactly as before");
 *   - the subscription being gone from Stripe behaves exactly as before (also
 *     decided 2026-09-29: customer.subscription.deleted settles it);
 *   - duplicates stay idempotent, ledger and alerts included;
 *   - the outcome does not depend on the order in which late events land.
 *
 * Drives the REAL router over a Stripe double at the stripeService edge and a
 * Postgres double that applies writes to one org row, honours each WHERE
 * clause, undoes a transaction on ROLLBACK and counts checked-out connections.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_stripe_is_the_source';
// plans.js reads these at require time; without them no line item maps to a plan.
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
const express = require('express');

const DB_PATH = require.resolve('../../src/config/db');
const REDIS_PATH = require.resolve('../../src/config/redis');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const PRODUCT_EVENTS_PATH = require.resolve('../../src/services/productEventsService');
const RETENTION_LEDGER_PATH = require.resolve('../../src/services/retentionLedger');
const EMAIL_PATH = require.resolve('../../src/services/email/resendClient');
const ROUTE_PATH = require.resolve('../../src/routes/webhooks-stripe');

const { computeRetentionMetrics } = require('../../src/services/retentionMetrics');

const PRO = process.env.STRIPE_PRICE_DEVELOPER_BASIC;
const TEAM = process.env.STRIPE_PRICE_DEVELOPER_PRO;
const ORG_ID = 'org-3c3c3c3c-4d4d-5e5e-6f6f-7a7a7a7a7a7a';
const CUSTOMER = 'cus_stripe_is_the_source';
const DAY = 86_400;
// The purchase. Every event below is created after it; the ledger's clock
// ("now", for rows that name no time) starts well after all of them.
const T0 = 1_758_000_000;

const clone = (value) => JSON.parse(JSON.stringify(value));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sub({ id = 'sub_1', status = 'active', price = PRO, quantity = 1, customer = CUSTOMER, created = T0, periodStart = T0 } = {}) {
    return {
        id,
        object: 'subscription',
        status,
        customer,
        created,
        metadata: {},
        schedule: null,
        items: {
            data: [{
                id: `si_${id}`,
                quantity,
                current_period_start: periodStart,
                current_period_end: periodStart + 30 * DAY,
                price: { id: price },
            }],
        },
    };
}

/** previous_attributes for a line item that changed. */
const itemsWas = (price, quantity) => ({ items: { data: [{ price: { id: price }, quantity }] } });

let seq = 0;
const eventId = (prefix) => `evt_${prefix}_${(seq += 1)}`;

function updated(subscription, { prev = { default_payment_method: 'pm_old' }, created = T0 + DAY, id = eventId('upd') } = {}) {
    return { id, type: 'customer.subscription.updated', created, data: { object: clone(subscription), ...(prev ? { previous_attributes: prev } : {}) } };
}

function deletedEvent(subscription, { created = T0 + 2 * DAY, id = eventId('del') } = {}) {
    return { id, type: 'customer.subscription.deleted', created, data: { object: clone(subscription) } };
}

function invoiceEvent(type, { subscription = 'sub_1', customer = CUSTOMER, billingReason = 'subscription_cycle', created = T0 + 30 * DAY, id = eventId('inv'), amountDue = 1200 } = {}) {
    return {
        id,
        type,
        created,
        data: {
            object: {
                id: `in_${id}`,
                object: 'invoice',
                customer,
                subscription,
                billing_reason: billingReason,
                amount_due: amountDue,
                attempt_count: 1,
                next_payment_attempt: created + 3 * DAY,
                hosted_invoice_url: null,
            },
        },
    };
}

function completed({ subscription = 'sub_1', tierId = 'developer_basic', created = T0, id = eventId('cs'), customer = CUSTOMER, amountTotal = 1200 } = {}) {
    return {
        id,
        type: 'checkout.session.completed',
        created,
        data: {
            object: {
                id: `cs_${id}`,
                object: 'checkout.session',
                mode: 'subscription',
                customer,
                subscription,
                amount_total: amountTotal,
                currency: 'usd',
                metadata: { orgId: ORG_ID, tierId, billingCycle: 'monthly' },
            },
        },
    };
}

/** Split a SET clause on the commas between assignments, not inside COALESCE(...). */
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
 * One org row that APPLIES the writes addressed to it, honours each WHERE
 * clause, keeps the stripe_events claim (and its "only a failed row may be
 * reclaimed" rule), and undoes a transaction on ROLLBACK. `conn.held` is the
 * number of pooled connections checked out right now: the thing a slow Stripe
 * must never be waited on with.
 */
function makeDb(initialRow) {
    const row = {
        org_id: ORG_ID,
        account_type: 'personal',
        plan: initialRow.plan_tier || 'free',
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
    // billing_alert_sends: the alert guard's table. A row outlives a restart
    // of the route module (it is the database's, not the process's).
    const alertSends = new Map();
    const conn = { held: 0 };
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
            if (nulled) { row[nulled[1]] = null; continue; }
            const truthy = /(\w+)\s*=\s*TRUE/.exec(assignment);
            if (truthy) row[truthy[1]] = true;
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
            // Faithful to the two statements the route uses: DO NOTHING (once,
            // ever) and DO UPDATE ... WHERE older than a day (daily).
            if (alertSends.has(params[0])) {
                if (/DO NOTHING/.test(text)) return { rows: [], rowCount: 0 };
                if (Date.now() - alertSends.get(params[0]) < DAY * 1000) return { rows: [], rowCount: 0 };
            }
            alertSends.set(params[0], Date.now());
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
            // Faithful to the statement: a guard on 'processed' is honoured
            // when the statement carries one, and only then.
            if (/status\s*(<>|!=)\s*'processed'/.test(text) && events.get(params[0]) === 'processed') return { rows: [], rowCount: 0 };
            events.set(params[0], 'failed');
            return { rows: [], rowCount: 1 };
        }
        if (/UPDATE stripe_events/.test(text)) {
            events.set(params[0], params[1]);
            return { rows: [], rowCount: 1 };
        }
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

    const pool = {
        connect: async () => {
            conn.held += 1;
            let released = false;
            return { query, release() { if (!released) { released = true; conn.held -= 1; } } };
        },
    };
    return { row, events, alertSends, conn, module: { query, pool } };
}

function missing(id) {
    return Object.assign(new Error(`No such subscription: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
}
const connectionError = () => Object.assign(new Error('An error occurred with our connection to Stripe.'), { type: 'StripeConnectionError' });
const permissionError = () => Object.assign(new Error('This API key does not have access to this subscription'), { type: 'StripePermissionError', statusCode: 403 });

/**
 * Stripe's CURRENT view of the world, which is what the handler must believe.
 * `control.failure` throws from every read; `control.onRead` sees each read as
 * it starts; `control.afterRead` runs once the answer has been taken, so a test
 * can move the world on while an event is between its read and its write.
 */
function makeStripe(initial) {
    const subs = new Map(initial.map((s) => [s.id, clone(s)]));
    const reads = [];
    const control = { failure: null, onRead: null, afterRead: null };
    async function gate(method, key) {
        reads.push({ method, key });
        if (control.onRead) control.onRead(method, key);
        if (control.failure) throw control.failure();
    }
    const api = {
        retrieve: async (id) => {
            await gate('retrieve', id);
            const found = subs.get(id);
            const answer = found ? clone(found) : null;
            if (control.afterRead) control.afterRead('retrieve', id);
            if (!answer) throw missing(id);
            return answer;
        },
        list: async ({ customer }) => {
            await gate('list', customer);
            const data = [...subs.values()].filter((s) => s.customer === customer).sort((a, b) => b.created - a.created).map(clone);
            if (control.afterRead) control.afterRead('list', customer);
            return { object: 'list', data, has_more: false };
        },
    };
    function set(id, { status, price, quantity, customer } = {}) {
        const s = subs.get(id);
        if (status) s.status = status;
        if (price) s.items.data[0].price = { id: price };
        if (quantity != null) s.items.data[0].quantity = quantity;
        if (customer) s.customer = customer;
        return clone(s);
    }
    return { subs, reads, control, api, set, now: (id) => clone(subs.get(id)) };
}

function load({ org = {}, subscriptions = [] } = {}) {
    const db = makeDb(org);
    const stripe = makeStripe(subscriptions);
    // emailMode: 'ok' | 'fail' ({ ok: false }) | 'skip' ({ skipped: true }) | 'throw'
    const state = { nextEvent: null, emailMode: 'ok' };
    const ledger = [];
    const emails = [];
    const emailAttempts = [];
    const productEvents = [];
    // The real ledger stamps NOW() on a row that names no time; here each such
    // row lands a minute after the last, all of them after every event below.
    const clock = { ms: (T0 + 60 * DAY) * 1000 };

    for (const p of [DB_PATH, REDIS_PATH, STRIPE_SERVICE_PATH, PRODUCT_EVENTS_PATH, RETENTION_LEDGER_PATH, EMAIL_PATH, ROUTE_PATH]) {
        delete require.cache[p];
    }
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };
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
    stub(PRODUCT_EVENTS_PATH, { recordProductEvent: async (actor, input) => { productEvents.push({ actor, input }); return {}; } });
    stub(RETENTION_LEDGER_PATH, {
        // UNIQUE (stripe_event_id, event_type), as the real table has.
        recordSubscriptionEvent: async (entry) => {
            if (entry.stripe_event_id && ledger.some((e) => e.stripe_event_id === entry.stripe_event_id && e.event_type === entry.event_type)) return;
            clock.ms += 60_000;
            ledger.push({ ...entry, occurred_at: entry.occurred_at ? new Date(entry.occurred_at).toISOString() : new Date(clock.ms).toISOString() });
        },
    });
    // Resend's real answers: { ok: true } sent, { ok: false } failed,
    // { skipped: true } not configured. Only a sent mail lands in `emails`.
    stub(EMAIL_PATH, {
        sendEmail: async (mail) => {
            emailAttempts.push({ mode: state.emailMode, mail });
            if (state.emailMode === 'throw') throw new Error('resend exploded');
            if (state.emailMode === 'fail') return { ok: false, status: 503 };
            if (state.emailMode === 'skip') return { skipped: true, reason: 'no_api_key' };
            emails.push(mail);
            return { ok: true };
        },
    });

    let app = express();
    app.use('/hook', require(ROUTE_PATH));
    /** A restart of the API: the route module is loaded afresh (its in-memory
     *  state gone); the database, Stripe and the mailbox are the same. */
    function restart() {
        delete require.cache[ROUTE_PATH];
        app = express();
        app.use('/hook', require(ROUTE_PATH));
    }

    async function webhook(event) {
        state.nextEvent = event;
        const before = stripe.reads.length;
        // Bound to 127.0.0.1, the address fetched below: listening on every
        // interface let the OS hand out a port another process already held on
        // 127.0.0.1, whose answer (a 501) then failed the test at random.
        const server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        const { port } = server.address();
        try {
            const res = await fetch(`http://127.0.0.1:${port}/hook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=stub' },
                body: JSON.stringify({ stub: true }),
            });
            const body = await res.json().catch(() => ({}));
            // The ledger, analytics and alert are written after COMMIT, unawaited.
            await new Promise((r) => setImmediate(r));
            await sleep(10);
            return { status: res.status, body, reads: stripe.reads.slice(before) };
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
        emailAttempts,
        state,
        productEvents,
        webhook,
        restart,
        metrics: () => computeRetentionMetrics(ledger, clock.ms + 60_000),
        /** What POST /billing/checkout writes after an in-place move, before any webhook. */
        checkoutWrote: (patch) => Object.assign(db.row, patch),
    };
}

function entitlementsOf(row) {
    return require('../../src/services/entitlementService').getEntitlementsFromOrg(row);
}

/** The enforcement gate: a paid plan beside one of these statuses answers 403 subscription_inactive. */
function locked(row) {
    return ['cancelled', 'unpaid', 'incomplete', 'past_due', 'trial_expired'].includes(row.subscription_status) && row.plan_tier !== 'free';
}

const onPlan = (plan, seats, extra = {}) => ({ plan, plan_tier: plan, purchased_seats: seats, stripe_subscription_id: 'sub_1', subscription_status: 'active', ...extra });

function permutations(items) {
    if (items.length <= 1) return [items];
    return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

// ---------------------------------------------------------------------------
// B3-1: an older update, delivered after a newer change
// ---------------------------------------------------------------------------

const STALE_UPDATE_CASES = [
    {
        name: 'an upgrade, Pro to Team x3 (in place, from the plan page)',
        before: { price: PRO, quantity: 1 }, after: { price: TEAM, quantity: 3 }, checkoutWrites: true,
        expect: { plan: 'developer_pro', seats: 3, mrr: mrrCents('developer_pro', 3) },
    },
    {
        name: 'a downgrade, Team x2 to Pro (in the portal)',
        before: { price: TEAM, quantity: 2 }, after: { price: PRO, quantity: 1 }, checkoutWrites: false,
        expect: { plan: 'developer_basic', seats: 1, mrr: mrrCents('developer_basic') },
    },
    {
        name: 'more seats, Team x2 to x5 (from the team page)',
        before: { price: TEAM, quantity: 2 }, after: { price: TEAM, quantity: 5 }, checkoutWrites: true,
        expect: { plan: 'developer_pro', seats: 5, mrr: null },
    },
    {
        name: 'fewer seats, Team x5 to x2 (in the portal)',
        before: { price: TEAM, quantity: 5 }, after: { price: TEAM, quantity: 2 }, checkoutWrites: false,
        expect: { plan: 'developer_pro', seats: 2, mrr: null },
    },
];

const planOfPrice = (price) => (price === TEAM ? 'developer_pro' : 'developer_basic');

for (const c of STALE_UPDATE_CASES) {
    test(`B3-1: after ${c.name}, an OLDER update delivered late leaves the workspace on what Stripe bills`, async () => {
        const was = sub({ ...c.before });
        const h = load({ org: onPlan(planOfPrice(c.before.price), c.before.quantity), subscriptions: [was] });
        const olderUpdate = updated(was, { created: T0 + DAY });

        // The change happens in Stripe; the plan page writes it through first.
        const now = h.stripe.set('sub_1', { ...c.after });
        if (c.checkoutWrites) h.checkoutWrote({ plan: planOfPrice(c.after.price), plan_tier: planOfPrice(c.after.price), purchased_seats: c.after.quantity });
        const change = await h.webhook(updated(now, { prev: itemsWas(c.before.price, c.before.quantity), created: T0 + 2 * DAY }));
        assert.strictEqual(change.status, 200, JSON.stringify(change.body));

        // Its first delivery failed, or Stripe simply sent the two out of order.
        const late = await h.webhook(olderUpdate);
        assert.strictEqual(late.status, 200, JSON.stringify(late.body));

        assert.strictEqual(h.db.row.plan_tier, c.expect.plan,
            `the older update put the workspace on "${h.db.row.plan_tier}" while Stripe bills ${planOfPrice(c.after.price)} x${c.after.quantity}`);
        assert.strictEqual(h.db.row.purchased_seats, c.expect.seats,
            `the older update set ${h.db.row.purchased_seats} seats while Stripe bills ${c.after.quantity}`);
        assert.strictEqual(h.db.row.subscription_status, 'active');
        assert.strictEqual(locked(h.db.row), false);
        const ent = entitlementsOf(h.db.row);
        assert.strictEqual(ent.tier, c.expect.plan);
        if (c.expect.plan === 'developer_pro') assert.strictEqual(ent.limits.included_seats, c.expect.seats);

        // The ledger follows Stripe too: the late event books nothing.
        const lateRows = h.ledger.filter((e) => e.stripe_event_id === olderUpdate.id);
        assert.deepStrictEqual(lateRows, [], `the older update booked ${JSON.stringify(lateRows)}`);
        if (c.expect.mrr != null) assert.strictEqual(h.metrics().mrr_cents, c.expect.mrr);
    });
}

test('B3-1: two updates for the same subscription end the same in either delivery order (J15)', async () => {
    const outcomes = [];
    for (const swapped of [false, true]) {
        const pro = sub({ price: PRO, quantity: 1 });
        const h = load({ org: onPlan('developer_basic', 1), subscriptions: [pro] });
        // A card update, then an upgrade to Team x2 two seconds later.
        const cardUpdate = updated(pro, { prev: { default_payment_method: 'pm_old' }, created: T0 + DAY });
        const team = h.stripe.set('sub_1', { price: TEAM, quantity: 2 });
        h.checkoutWrote({ plan: 'developer_pro', plan_tier: 'developer_pro', purchased_seats: 2 });
        const upgrade = updated(team, { prev: itemsWas(PRO, 1), created: T0 + DAY + 2 });

        for (const event of swapped ? [upgrade, cardUpdate] : [cardUpdate, upgrade]) {
            const res = await h.webhook(event);
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        }
        outcomes.push({
            order: swapped ? 'upgrade first' : 'card update first',
            plan: h.db.row.plan_tier,
            seats: h.db.row.purchased_seats,
            mrr: h.metrics().mrr_cents,
            planChanges: h.ledger.filter((e) => e.event_type === 'plan_changed').length,
        });
    }
    for (const o of outcomes) {
        assert.deepStrictEqual({ plan: o.plan, seats: o.seats, mrr: o.mrr, planChanges: o.planChanges },
            { plan: 'developer_pro', seats: 2, mrr: mrrCents('developer_pro', 2), planChanges: 1 },
            `${o.order}: ${JSON.stringify(o)} while Stripe bills Team x2`);
    }
});

// ---------------------------------------------------------------------------
// B3-2: a late invoice.payment_failed
// ---------------------------------------------------------------------------

test('B3-2: a late invoice.payment_failed does not lock a workspace Stripe reports paid', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub({ status: 'active' })] });

    const res = await h.webhook(invoiceEvent('invoice.payment_failed', { created: T0 + 30 * DAY }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.subscription_status, 'active',
        'a failure Stripe has since been paid for locked the workspace (every request answers 403 subscription_inactive)');
    assert.strictEqual(locked(h.db.row), false);
    assert.ok(!h.ledger.some((e) => e.event_type === 'payment_failed'), 'an at-risk row for a customer Stripe says is paid');
    assert.strictEqual(h.emails.length, 0, 'the operator was told a paid-up account is past_due and blocked');
});

test('a failed payment Stripe still reports past_due locks, alerts and books the at-risk row, as before', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub({ status: 'past_due' })] });

    const res = await h.webhook(invoiceEvent('invoice.payment_failed'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.subscription_status, 'past_due');
    assert.strictEqual(locked(h.db.row), true);
    assert.strictEqual(h.ledger.filter((e) => e.event_type === 'payment_failed').length, 1);
    assert.strictEqual(h.emails.length, 1);
    assert.strictEqual(h.emails[0].emailType, 'past_due_alert');
});

test('B3-2 (J1): a failed renewal and its recovery, delivered in any order, end on what Stripe reports', async () => {
    // Stripe: the renewal failed, the card was fixed, the invoice paid. Now active.
    const failures = [];
    const orders = permutations(['failed', 'went_past_due', 'recovered', 'renewal_paid']);
    for (const order of orders) {
        const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub({ status: 'active' })] });
        const pastDue = sub({ status: 'past_due' });
        const active = sub({ status: 'active' });
        const events = {
            failed: invoiceEvent('invoice.payment_failed', { created: T0 + 30 * DAY }),
            went_past_due: updated(pastDue, { prev: { status: 'active' }, created: T0 + 30 * DAY + 1 }),
            recovered: updated(active, { prev: { status: 'past_due' }, created: T0 + 31 * DAY }),
            renewal_paid: invoiceEvent('invoice.payment_succeeded', { created: T0 + 31 * DAY }),
        };
        for (const name of order) {
            const res = await h.webhook(events[name]);
            assert.strictEqual(res.status, 200, `${order.join(' > ')}: ${name} answered ${res.status} ${JSON.stringify(res.body)}`);
        }
        const outcome = { status: h.db.row.subscription_status, locked: locked(h.db.row), at_risk: h.metrics().past_due };
        if (outcome.status !== 'active' || outcome.locked || outcome.at_risk !== 0) failures.push(`${order.join(' > ')} -> ${JSON.stringify(outcome)}`);
    }
    assert.deepStrictEqual(failures, [], `Stripe reports active and paid; ${failures.length} of ${orders.length} delivery orders end otherwise`);
});

// ---------------------------------------------------------------------------
// Renewals: invoice.payment_succeeded re-reads the subscription too
// ---------------------------------------------------------------------------

test('a late renewal does not unlock a workspace Stripe reports past_due', async () => {
    const h = load({ org: onPlan('developer_basic', 1, { subscription_status: 'past_due' }), subscriptions: [sub({ status: 'past_due' })] });

    const res = await h.webhook(invoiceEvent('invoice.payment_succeeded', { created: T0 + 30 * DAY }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.subscription_status, 'past_due');
    assert.strictEqual(locked(h.db.row), true);
});

test('a late renewal for a subscription Stripe has since cancelled neither unlocks nor books revenue', async () => {
    // The cancellation's own customer.subscription.deleted has not landed yet.
    const h = load({ org: onPlan('developer_basic', 1, { subscription_status: 'past_due' }), subscriptions: [sub({ status: 'canceled' })] });

    const res = await h.webhook(invoiceEvent('invoice.payment_succeeded', { created: T0 + 30 * DAY }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(locked(h.db.row), true, 'a renewal for a cancelled subscription unlocked a past_due workspace');
    assert.ok(!h.ledger.some((e) => e.event_type === 'renewed'),
        `a renewal was booked for a subscription Stripe reports cancelled: ${JSON.stringify(h.ledger)}`);
});

test('a renewal writes what Stripe bills: a recovery nobody reported unlocks, at Stripe\'s plan and seats', async () => {
    // The recovery's own update was lost; Stripe says active, Team x3.
    const h = load({ org: onPlan('developer_pro', 2, { subscription_status: 'past_due' }), subscriptions: [sub({ status: 'active', price: TEAM, quantity: 3 })] });

    const res = await h.webhook(invoiceEvent('invoice.payment_succeeded', { created: T0 + 30 * DAY, amountDue: 4500 }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.subscription_status, 'active', 'Stripe says paid; the workspace stayed locked');
    assert.strictEqual(h.db.row.purchased_seats, 3);
    assert.strictEqual(locked(h.db.row), false);
    const renewed = h.ledger.find((e) => e.event_type === 'renewed');
    assert.ok(renewed, 'the renewal booked nothing');
    assert.strictEqual(renewed.mrr_cents, mrrCents('developer_pro', 3), 'the renewal is priced at the seats Stripe bills');
});

test('a late renewal after a later failure still leaves the workspace locked', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub({ status: 'past_due' })] });

    // The NEXT renewal failed and is recorded; the one before it (paid) arrives late.
    const failed = await h.webhook(invoiceEvent('invoice.payment_failed', { created: T0 + 60 * DAY }));
    assert.strictEqual(failed.status, 200, JSON.stringify(failed.body));
    const late = await h.webhook(invoiceEvent('invoice.payment_succeeded', { created: T0 + 30 * DAY }));
    assert.strictEqual(late.status, 200, JSON.stringify(late.body));

    assert.strictEqual(h.db.row.subscription_status, 'past_due');
    assert.strictEqual(locked(h.db.row), true);
    // Not pinned: the ledger's at-risk flag. The late 'renewed' row is stamped
    // on insert, after the failure it preceded, and clears the flag, as it did
    // before this rule (dating it at the invoice instead inverts it against a
    // 'created' row stamped on insert; left for the ledger's own card).
});

test('invoice.paid is not an event this handler acts on: nothing is read or written', async () => {
    const h = load({ org: onPlan('developer_basic', 1, { subscription_status: 'past_due' }), subscriptions: [sub({ status: 'active' })] });
    const before = { ...h.db.row };

    const res = await h.webhook(invoiceEvent('invoice.paid'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(h.db.row, before);
    assert.deepStrictEqual(res.reads, []);
});

// ---------------------------------------------------------------------------
// customer.subscription.deleted
// ---------------------------------------------------------------------------

test('a deleted event for a subscription Stripe no longer has settles to Free, as before', async () => {
    const pro = sub();
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [] });

    const res = await h.webhook(deletedEvent({ ...pro, status: 'canceled' }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.strictEqual(h.db.row.subscription_status, 'cancelled');
    assert.strictEqual(h.db.row.stripe_subscription_id, null);
    assert.strictEqual(h.db.row.purchased_seats, null);
    assert.deepStrictEqual(h.ledger.map((e) => e.event_type), ['cancelled']);
});

test('a late deleted for an OLD subscription does not downgrade the newer live one the org has adopted', async () => {
    const oldPro = sub({ id: 'sub_old', status: 'canceled', created: T0 - 90 * DAY });
    const team = sub({ id: 'sub_new', price: TEAM, quantity: 2, created: T0 });
    const h = load({ org: onPlan('developer_pro', 2, { stripe_subscription_id: 'sub_new' }), subscriptions: [oldPro, team] });
    const before = { ...h.db.row };

    const res = await h.webhook(deletedEvent(oldPro));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(h.db.row, before, 'the live Team the org is billed on was touched by the old subscription\'s end');
    assert.deepStrictEqual(h.ledger, []);
});

test('a stale "active" update for a subscription Stripe has cancelled does not unlock a past_due workspace before the deleted event lands', async () => {
    // Stripe: past_due, then cancelled at the end of its retries. The deleted
    // event has not been processed yet; an old `active` update arrives.
    for (const order of [['stale', 'deleted'], ['deleted', 'stale']]) {
        const pro = sub({ status: 'canceled' });
        const h = load({ org: onPlan('developer_basic', 1, { subscription_status: 'past_due' }), subscriptions: [pro] });
        const events = { stale: updated({ ...pro, status: 'active' }, { prev: { status: 'past_due' }, created: T0 + 29 * DAY }), deleted: deletedEvent(pro, { created: T0 + 40 * DAY }) };

        const first = await h.webhook(events[order[0]]);
        assert.strictEqual(first.status, 200, JSON.stringify(first.body));
        if (order[0] === 'stale') {
            assert.ok(h.db.row.subscription_status !== 'canceled' && locked(h.db.row),
                `a subscription Stripe reports cancelled was written as "${h.db.row.subscription_status}" on ${h.db.row.plan_tier}: paid access nobody pays for`);
        }
        const second = await h.webhook(events[order[1]]);
        assert.strictEqual(second.status, 200, JSON.stringify(second.body));
        assert.strictEqual(h.db.row.plan_tier, 'free', `${order.join(' > ')}`);
        assert.strictEqual(h.db.row.subscription_status, 'cancelled', `${order.join(' > ')}`);
    }
});

// ---------------------------------------------------------------------------
// The rule's own mechanics
// ---------------------------------------------------------------------------

/** One ordinary delivery of each kind, against a workspace that records sub_1. */
function everyEventKind() {
    return [
        { name: 'customer.subscription.updated (same status)', org: onPlan('developer_basic', 1), subs: [sub({ price: TEAM, quantity: 2 })], event: () => updated(sub({ price: TEAM, quantity: 2 }), { prev: itemsWas(PRO, 1) }) },
        { name: 'customer.subscription.updated (status moves)', org: onPlan('developer_basic', 1, { subscription_status: 'past_due' }), subs: [sub()], event: () => updated(sub(), { prev: { status: 'past_due' } }) },
        { name: 'checkout.session.completed', org: { plan_tier: 'free' }, subs: [sub()], event: () => completed() },
        { name: 'invoice.payment_failed', org: onPlan('developer_basic', 1), subs: [sub({ status: 'past_due' })], event: () => invoiceEvent('invoice.payment_failed') },
        { name: 'invoice.payment_succeeded', org: onPlan('developer_basic', 1), subs: [sub()], event: () => invoiceEvent('invoice.payment_succeeded') },
        { name: 'customer.subscription.deleted', org: onPlan('developer_basic', 1), subs: [sub({ status: 'canceled' })], event: () => deletedEvent(sub({ status: 'canceled' })) },
    ];
}

test('every subscription and invoice event reads the subscription from Stripe, once', async () => {
    const wrong = [];
    for (const kind of everyEventKind()) {
        const h = load({ org: kind.org, subscriptions: kind.subs });
        const res = await h.webhook(kind.event());
        assert.strictEqual(res.status, 200, `${kind.name}: ${JSON.stringify(res.body)}`);
        // Deleted reads the customer's subscriptions (it needs the survivors
        // too); that one list IS its read of the subscription.
        const expected = kind.name.startsWith('customer.subscription.deleted') ? [{ method: 'list', key: CUSTOMER }] : [{ method: 'retrieve', key: 'sub_1' }];
        if (JSON.stringify(res.reads) !== JSON.stringify(expected)) wrong.push(`${kind.name}: ${JSON.stringify(res.reads)}`);
    }
    assert.deepStrictEqual(wrong, [], 'each event must take its facts from one read of Stripe, not from its payload');
});

test('no database connection is held while Stripe is being read', async () => {
    const held = [];
    for (const kind of everyEventKind()) {
        const h = load({ org: kind.org, subscriptions: kind.subs });
        h.stripe.control.onRead = (method, key) => { if (h.db.conn.held > 0) held.push(`${kind.name}: ${method}(${key}) with ${h.db.conn.held} connection(s) checked out`); };
        const res = await h.webhook(kind.event());
        assert.strictEqual(res.status, 200, `${kind.name}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(h.db.conn.held, 0, `${kind.name}: a connection was never released`);
    }
    assert.deepStrictEqual(held, [], 'with every event reading Stripe, a slow Stripe would hold the whole pool idle in transaction');
});

test('a transient Stripe failure answers 5xx and writes nothing, for every event; the redelivery then applies', async () => {
    const wrong = [];
    for (const kind of everyEventKind()) {
        const h = load({ org: kind.org, subscriptions: kind.subs });
        const event = kind.event();
        const before = { ...h.db.row };
        h.stripe.control.failure = connectionError;

        const first = await h.webhook(event);
        if (first.status < 500) wrong.push(`${kind.name}: answered ${first.status} ${JSON.stringify(first.body)} to a Stripe outage`);
        if (JSON.stringify(h.db.row) !== JSON.stringify(before)) wrong.push(`${kind.name}: wrote ${JSON.stringify(h.db.row)} with Stripe unreachable`);
        if (h.ledger.length || h.emails.length) wrong.push(`${kind.name}: booked ${JSON.stringify(h.ledger)} / alerted ${h.emails.length}`);
        if (h.db.events.get(event.id) === 'processed') wrong.push(`${kind.name}: recorded as processed`);

        h.stripe.control.failure = null;
        const second = await h.webhook(event);
        if (second.status !== 200 || second.body.duplicate) wrong.push(`${kind.name}: the redelivery answered ${second.status} ${JSON.stringify(second.body)}`);
        if (h.db.events.get(event.id) !== 'processed') wrong.push(`${kind.name}: the redelivery left the event ${h.db.events.get(event.id)}`);
    }
    assert.deepStrictEqual(wrong, []);
});

test('a duplicate of each event changes nothing, books nothing, alerts nobody and reads nothing', async () => {
    const wrong = [];
    for (const kind of everyEventKind()) {
        const h = load({ org: kind.org, subscriptions: kind.subs });
        const event = kind.event();
        const first = await h.webhook(event);
        assert.strictEqual(first.status, 200, `${kind.name}: ${JSON.stringify(first.body)}`);
        const after = { row: { ...h.db.row }, ledger: h.ledger.length, emails: h.emails.length, product: h.productEvents.length };

        const again = await h.webhook(event);
        if (again.status !== 200 || again.body.duplicate !== true) wrong.push(`${kind.name}: the duplicate answered ${again.status} ${JSON.stringify(again.body)}`);
        if (again.reads.length) wrong.push(`${kind.name}: the duplicate read Stripe ${JSON.stringify(again.reads)}`);
        const now = { row: { ...h.db.row }, ledger: h.ledger.length, emails: h.emails.length, product: h.productEvents.length };
        if (JSON.stringify(now) !== JSON.stringify(after)) wrong.push(`${kind.name}: the duplicate moved ${JSON.stringify(after)} to ${JSON.stringify(now)}`);
    }
    assert.deepStrictEqual(wrong, []);
});

test('a duplicate delivered while Stripe is down does not reopen an event already processed', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub({ status: 'past_due' })] });
    const event = invoiceEvent('invoice.payment_failed');
    assert.strictEqual((await h.webhook(event)).status, 200);

    h.stripe.control.failure = connectionError;
    const during = await h.webhook(event);
    assert.strictEqual(during.status, 200, JSON.stringify(during.body));
    assert.strictEqual(during.body.duplicate, true);
    assert.strictEqual(h.db.events.get(event.id), 'processed', 'a processed event was marked failed, so the next redelivery would run it again');

    h.stripe.control.failure = null;
    const after = await h.webhook(event);
    assert.strictEqual(after.body.duplicate, true);
    assert.strictEqual(h.emails.length, 1, 'the operator was alerted twice for one failed charge');
    assert.strictEqual(h.ledger.length, 1);
});

test('J7: the purchase\'s late events land in any order and the workspace ends on the Team x3 Stripe bills', async () => {
    // A Pro purchase whose completed AND its own subscription update both
    // failed first delivery. The person saw Free, pressed Upgrade to Team x3;
    // POST /billing/checkout adopted the Pro and moved it in place.
    const failures = [];
    for (const order of permutations(['completed', 'purchase_update', 'upgrade'])) {
        const pro = sub({ price: PRO, quantity: 1 });
        const h = load({ org: onPlan('developer_pro', 3), subscriptions: [pro] });
        const team = h.stripe.set('sub_1', { price: TEAM, quantity: 3 });
        const events = {
            completed: completed({ created: T0 }),
            purchase_update: updated(pro, { prev: { status: 'incomplete' }, created: T0 }),
            upgrade: updated(team, { prev: itemsWas(PRO, 1), created: T0 + DAY }),
        };
        for (const name of order) {
            const res = await h.webhook(events[name]);
            assert.strictEqual(res.status, 200, `${order.join(' > ')}: ${name} ${JSON.stringify(res.body)}`);
        }
        const m = h.metrics();
        const outcome = {
            plan: h.db.row.plan_tier,
            seats: h.db.row.purchased_seats,
            invites: entitlementsOf(h.db.row).features.team_management,
            mrr: m.mrr_cents,
            created: h.ledger.filter((e) => e.event_type === 'created').length,
            planChanges: h.ledger.filter((e) => e.event_type === 'plan_changed').length,
        };
        const expected = { plan: 'developer_pro', seats: 3, invites: true, mrr: mrrCents('developer_pro', 3), created: 1, planChanges: 1 };
        if (JSON.stringify(outcome) !== JSON.stringify(expected)) failures.push(`${order.join(' > ')} -> ${JSON.stringify(outcome)}`);
    }
    assert.deepStrictEqual(failures, [], 'the same three events must leave the same workspace and the same ledger in all six orders');
});

test('a write that lands while Stripe is being read makes the event read Stripe again, so it cannot write an older answer', async () => {
    // Team x2. The person raises seats to 3, then to 5, seconds apart. The x3
    // event reads Stripe (x3); before it writes, the x5 event commits.
    const h = load({ org: onPlan('developer_pro', 2), subscriptions: [sub({ price: TEAM, quantity: 3 })] });
    let first = true;
    h.stripe.control.afterRead = () => {
        if (!first) return;
        first = false;
        h.stripe.set('sub_1', { quantity: 5 });
        h.checkoutWrote({ purchased_seats: 5 });
    };

    const res = await h.webhook(updated(sub({ price: TEAM, quantity: 3 }), { prev: itemsWas(TEAM, 2) }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.purchased_seats, 5, 'an answer read before a newer write was written over it');
});

// ---------------------------------------------------------------------------
// The customer check: a subscription is applied only to its own customer's org
// ---------------------------------------------------------------------------

test('a checkout whose subscription Stripe files under ANOTHER customer grants nothing', async () => {
    const h = load({ org: { plan_tier: 'free' }, subscriptions: [sub({ price: TEAM, quantity: 3, customer: 'cus_someone_else' })] });

    const res = await h.webhook(completed({ tierId: 'developer_pro' }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'free', 'somebody else\'s subscription was granted to this workspace');
    assert.strictEqual(h.db.row.stripe_subscription_id, null);
    assert.deepStrictEqual(h.ledger, []);
    assert.ok(!h.productEvents.some((e) => e.input.event_name === 'purchase_completed'), 'a purchase nobody here made was reported');
});

test('an update cannot adopt a subscription Stripe files under another customer', async () => {
    const h = load({ org: { plan_tier: 'free', stripe_subscription_id: null }, subscriptions: [sub({ id: 'sub_x', price: TEAM, quantity: 3, customer: 'cus_someone_else' })] });

    // The payload claims this org's customer; Stripe says otherwise.
    const res = await h.webhook(updated(sub({ id: 'sub_x', price: TEAM, quantity: 3 }), { prev: null }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.strictEqual(h.db.row.stripe_subscription_id, null);
});

// ---------------------------------------------------------------------------
// The two edges of "Stripe's word is final", decided by the owner (2026-09-29,
// the refusal half revised the same day).
//
// GONE FROM STRIPE: kept exactly as before; customer.subscription.deleted
// settles a subscription that has gone. These four were pinned as "undecided
// edge, unchanged"; their expectations are unchanged, only their names.
//
// REFUSED FOR GOOD: ALERT THE OWNER, NEVER CLOSE. Every delivery answers 5xx,
// writes nothing and leaves the event `failed`, however old it is, so Stripe
// keeps redelivering it and the first delivery Stripe can be read for applies
// it. The owner is alerted once per event, from 24 hours after its `created`;
// a send that fails, is skipped or throws is tried again on the next delivery.
// These three used to write from the payload (or settle to Free); each name
// says what it expected before.
// ---------------------------------------------------------------------------

const HOUR = 3_600;
const nowS = () => Math.floor(Date.now() / 1000);
/** An event created `hours` ago. The fixtures above are dated 2025, i.e. more than 24 hours old. */
const hoursAgo = (hours) => nowS() - hours * HOUR;
const notAppliedAlerts = (h) => h.emails.filter((m) => m.emailType === 'stripe_event_not_applied_alert');

test('refused for good, same status (was: the payload was written, Team x2): 5xx, nothing written, the event redeliverable; one alert (the event is older than a day)', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub()] });
    h.stripe.control.failure = permissionError;
    const before = { ...h.db.row };
    const event = updated(sub({ price: TEAM, quantity: 2 }), { prev: itemsWas(PRO, 1) });

    const res = await h.webhook(event);
    assert.ok(res.status >= 500, `answered ${res.status}`);
    assert.deepStrictEqual(h.db.row, before, 'a payload was written for a subscription Stripe would not show');
    assert.strictEqual(h.db.events.get(event.id), 'failed');
    assert.strictEqual(notAppliedAlerts(h).length, 1);
});

test('gone from Stripe, same status (decided: kept): the payload is written', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [] });

    const res = await h.webhook(updated(sub({ price: TEAM, quantity: 2 }), { prev: itemsWas(PRO, 1) }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(h.db.row.purchased_seats, 2);
    assert.strictEqual(notAppliedAlerts(h).length, 0, 'gone is not a refusal');
});

test('gone from Stripe, status differs (decided: kept): the org is left alone', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [] });
    const before = { ...h.db.row };

    const res = await h.webhook(updated(sub({ status: 'past_due' }), { prev: { status: 'active' } }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(h.db.row, before);
});

test('refused for good, invoice.payment_failed (was: locked past_due, booked at-risk, alerted past_due): 5xx, nothing written or booked, only the not-applied alert', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub()] });
    h.stripe.control.failure = permissionError;
    const before = { ...h.db.row };
    const event = invoiceEvent('invoice.payment_failed');

    const res = await h.webhook(event);
    assert.ok(res.status >= 500, `answered ${res.status}`);
    assert.deepStrictEqual(h.db.row, before, 'a failed payment Stripe would not confirm locked a workspace');
    assert.strictEqual(locked(h.db.row), false);
    assert.deepStrictEqual(h.ledger, []);
    assert.strictEqual(h.db.events.get(event.id), 'failed');
    assert.deepStrictEqual(h.emails.map((m) => m.emailType), ['stripe_event_not_applied_alert']);
});

test('gone from Stripe, invoice.payment_failed (decided: kept): locks, books and alerts', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [] });

    const res = await h.webhook(invoiceEvent('invoice.payment_failed'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.subscription_status, 'past_due');
    assert.strictEqual(h.ledger.filter((e) => e.event_type === 'payment_failed').length, 1);
    assert.strictEqual(h.emails.length, 1);
    assert.strictEqual(h.emails[0].emailType, 'past_due_alert');
});

test('gone from Stripe, a renewal (decided: kept): booked from the org row, writes nothing', async () => {
    const h = load({ org: onPlan('developer_pro', 3, { subscription_status: 'past_due' }), subscriptions: [] });
    const before = { ...h.db.row };

    const res = await h.webhook(invoiceEvent('invoice.payment_succeeded'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(h.db.row, before);
    const renewed = h.ledger.find((e) => e.event_type === 'renewed');
    assert.ok(renewed);
    assert.strictEqual(renewed.mrr_cents, mrrCents('developer_pro', 3));
});

test('refused for good, a deleted event (was: settled to Free, cancelled): 5xx, nothing written, the event redeliverable; the owner is alerted', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub({ status: 'canceled' })] });
    h.stripe.control.failure = permissionError;
    const before = { ...h.db.row };
    const event = deletedEvent(sub({ status: 'canceled' }));

    const res = await h.webhook(event);
    assert.ok(res.status >= 500, `answered ${res.status}`);
    assert.deepStrictEqual(h.db.row, before, 'a workspace was settled to Free without Stripe saying whether anything else is paid for');
    assert.deepStrictEqual(h.ledger, []);
    assert.strictEqual(h.db.events.get(event.id), 'failed');
    assert.strictEqual(notAppliedAlerts(h).length, 1);
});

// The two cases the review found in the first version, which CLOSED an event
// refused for more than 24 hours: the purchase stayed on Free, the
// cancellation kept paid access. Each must apply once Stripe can be read.

test('a PURCHASE refused for more than 24 hours is granted once the refusal is lifted and Stripe redelivers the same event', async () => {
    const h = load({ org: { plan_tier: 'free' }, subscriptions: [sub({ price: TEAM, quantity: 3 })] });
    const event = { ...completed({ tierId: 'developer_pro' }), created: hoursAgo(25) };
    h.stripe.control.failure = permissionError;

    const refused = await h.webhook(event);
    assert.ok(refused.status >= 500, `a purchase Stripe would not show was answered ${refused.status}: Stripe stops redelivering it`);
    assert.strictEqual(h.db.events.get(event.id), 'failed', 'the event must stay redeliverable');
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.strictEqual(notAppliedAlerts(h).length, 1, 'the owner is told it has been refused for a day');

    h.stripe.control.failure = null;
    const applied = await h.webhook(event);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.notStrictEqual(applied.body.duplicate, true, 'the redelivery was eaten as a duplicate: the customer stays on Free while paying');
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(h.db.row.purchased_seats, 3);
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_1');
    assert.strictEqual(entitlementsOf(h.db.row).features.team_management, true);
    assert.strictEqual(h.db.events.get(event.id), 'processed');
    assert.strictEqual(notAppliedAlerts(h).length, 1, 'still one alert');
});

test('a CANCELLATION refused for more than 24 hours settles once the refusal is lifted and Stripe redelivers the same event', async () => {
    const h = load({ org: onPlan('developer_pro', 3), subscriptions: [sub({ price: TEAM, quantity: 3, status: 'canceled' })] });
    const event = { ...deletedEvent(sub({ price: TEAM, quantity: 3, status: 'canceled' })), created: hoursAgo(25) };
    h.stripe.control.failure = permissionError;

    const refused = await h.webhook(event);
    assert.ok(refused.status >= 500, `a cancellation Stripe would not show was answered ${refused.status}: paid access is kept for good`);
    assert.strictEqual(h.db.events.get(event.id), 'failed');
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');

    h.stripe.control.failure = null;
    const applied = await h.webhook(event);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.notStrictEqual(applied.body.duplicate, true, 'the redelivery was eaten as a duplicate: paid access nobody pays for, for good');
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.strictEqual(h.db.row.subscription_status, 'cancelled');
    assert.strictEqual(h.db.row.stripe_subscription_id, null);
    assert.deepStrictEqual(h.ledger.map((e) => e.event_type), ['cancelled']);
    assert.strictEqual(notAppliedAlerts(h).length, 1);
});

// The refusal itself, for every event that reads Stripe.

test('refused for good WITHIN 24 hours of the event: 5xx and nothing written, for every event; the event stays redeliverable; nobody is alerted yet', async () => {
    const wrong = [];
    for (const kind of everyEventKind()) {
        const h = load({ org: kind.org, subscriptions: kind.subs });
        const event = { ...kind.event(), created: hoursAgo(23) };
        const before = { ...h.db.row };
        h.stripe.control.failure = permissionError;

        const res = await h.webhook(event);
        if (res.status < 500) wrong.push(`${kind.name}: answered ${res.status} ${JSON.stringify(res.body)} to a refusal`);
        if (JSON.stringify(h.db.row) !== JSON.stringify(before)) wrong.push(`${kind.name}: wrote ${JSON.stringify(h.db.row)}`);
        if (h.ledger.length || h.emailAttempts.length) wrong.push(`${kind.name}: booked ${JSON.stringify(h.ledger)} / emailed ${h.emailAttempts.map((a) => a.mail.emailType)}`);
        if (h.db.events.get(event.id) !== 'failed') wrong.push(`${kind.name}: the event is ${h.db.events.get(event.id)}, not failed (redeliverable)`);
    }
    assert.deepStrictEqual(wrong, []);
});

test('refused for good PAST 24 hours: every delivery is 5xx, writes nothing, leaves the event redeliverable; exactly one alert naming the event, subscription, workspace and reason, for every event', async () => {
    const wrong = [];
    for (const kind of everyEventKind()) {
        const h = load({ org: kind.org, subscriptions: kind.subs });
        const event = { ...kind.event(), created: hoursAgo(25) };
        const before = { ...h.db.row };
        h.stripe.control.failure = permissionError;

        for (let delivery = 1; delivery <= 4; delivery += 1) {
            const res = await h.webhook(event);
            if (res.status < 500) wrong.push(`${kind.name}: delivery ${delivery} answered ${res.status} ${JSON.stringify(res.body)}`);
            if (h.db.events.get(event.id) !== 'failed') wrong.push(`${kind.name}: delivery ${delivery} left the event ${h.db.events.get(event.id)}`);
        }
        if (JSON.stringify(h.db.row) !== JSON.stringify(before)) wrong.push(`${kind.name}: wrote ${JSON.stringify(h.db.row)}`);
        if (h.ledger.length) wrong.push(`${kind.name}: booked ${JSON.stringify(h.ledger)}`);
        if (h.productEvents.length) wrong.push(`${kind.name}: reported ${JSON.stringify(h.productEvents.map((e) => e.input.event_name))}`);
        const alerts = notAppliedAlerts(h);
        if (alerts.length !== 1 || h.emailAttempts.length !== 1) {
            wrong.push(`${kind.name}: sent ${alerts.length}, attempted ${h.emailAttempts.length} over four deliveries`);
            continue;
        }
        const [alert] = alerts;
        for (const [what, needle] of [['event type', event.type], ['event id', event.id], ['subscription', 'sub_1'], ['workspace', ORG_ID], ['reason', 'StripePermissionError (403)'], ['reason text', 'does not have access']]) {
            if (!alert.html.includes(needle) && !alert.subject.includes(needle)) wrong.push(`${kind.name}: the alert does not name the ${what} (${needle})`);
        }
    }
    assert.deepStrictEqual(wrong, []);
});

test('the once-only alert survives a restart: the claim is in billing_alert_sends, not in memory', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub()] });
    const event = { ...invoiceEvent('invoice.payment_failed'), created: hoursAgo(30) };
    h.stripe.control.failure = permissionError;
    await h.webhook(event);
    assert.strictEqual(notAppliedAlerts(h).length, 1);
    assert.ok(h.db.alertSends.has(`stripe_event_not_applied:${event.id}`), 'the claim is not in the table');

    h.restart();
    const again = await h.webhook(event);
    assert.ok(again.status >= 500);
    assert.strictEqual(h.emailAttempts.length, 1, 'a restarted API alerted the owner a second time');
});

for (const [mode, what] of [['fail', 'fails (Resend answers an error)'], ['skip', 'is skipped (no Resend key)'], ['throw', 'throws']]) {
    test(`an alert whose send ${what} is not lost: the next delivery tries again, and once it is sent nobody is told twice`, async () => {
        const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub()] });
        const event = { ...invoiceEvent('invoice.payment_failed'), created: hoursAgo(26) };
        h.stripe.control.failure = permissionError;

        h.state.emailMode = mode;
        const first = await h.webhook(event);
        assert.ok(first.status >= 500);
        assert.strictEqual(h.emailAttempts.length, 1, 'the first delivery past 24 hours tries to send');
        assert.strictEqual(notAppliedAlerts(h).length, 0);
        assert.ok(!h.db.alertSends.has(`stripe_event_not_applied:${event.id}`), 'an unsent alert kept its claim, so nobody would ever be told');

        h.state.emailMode = 'ok';
        await h.webhook(event);
        assert.strictEqual(notAppliedAlerts(h).length, 1, 'the next delivery did not try again');
        await h.webhook(event);
        await h.webhook(event);
        assert.strictEqual(notAppliedAlerts(h).length, 1);
        assert.strictEqual(h.emailAttempts.length, 2);
    });
}

test('an event first delivered more than 24 hours after it was created: retried like any other; the alert goes with the first refused delivery', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub({ status: 'past_due' })] });
    const event = { ...invoiceEvent('invoice.payment_failed'), created: hoursAgo(40) };
    h.stripe.control.failure = permissionError;
    const first = await h.webhook(event);
    assert.ok(first.status >= 500);
    assert.strictEqual(notAppliedAlerts(h).length, 1);

    h.stripe.control.failure = null;
    const applied = await h.webhook(event);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.strictEqual(h.db.row.subscription_status, 'past_due', 'the failed payment applied once Stripe could be read');
});

test('an event with no usable created: retried like any other (never closed); it cannot be timed, so the alert goes with its first refused delivery', async () => {
    const h = load({ org: onPlan('developer_basic', 1), subscriptions: [sub({ status: 'past_due' })] });
    const event = invoiceEvent('invoice.payment_failed');
    delete event.created;
    const before = { ...h.db.row };
    h.stripe.control.failure = permissionError;

    const res = await h.webhook(event);
    assert.ok(res.status >= 500, `answered ${res.status}`);
    assert.deepStrictEqual(h.db.row, before);
    assert.strictEqual(h.db.events.get(event.id), 'failed');
    assert.strictEqual(notAppliedAlerts(h).length, 1);
    assert.match(notAppliedAlerts(h)[0].html, /no creation time/);

    h.stripe.control.failure = null;
    const applied = await h.webhook(event);
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.strictEqual(h.db.row.subscription_status, 'past_due');
});

test('a refusal lifted before the next delivery: the redelivery applies what Stripe says, and nobody is alerted if it was under a day', async () => {
    const h = load({ org: { plan_tier: 'free' }, subscriptions: [sub({ price: TEAM, quantity: 3 })] });
    const event = { ...completed({ tierId: 'developer_pro' }), created: hoursAgo(2) };
    h.stripe.control.failure = permissionError;
    const first = await h.webhook(event);
    assert.ok(first.status >= 500, `got ${first.status}`);
    assert.strictEqual(h.db.row.plan_tier, 'free');

    h.stripe.control.failure = null;
    const second = await h.webhook(event);
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.notStrictEqual(second.body.duplicate, true);
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(h.db.row.purchased_seats, 3);
    assert.strictEqual(h.emailAttempts.length, 0);
});

test('an update whose RECORDED subscription Stripe refuses to show: nothing is adopted or written, the event is redeliverable, one alert naming the recorded subscription', async () => {
    const h = load({ org: onPlan('developer_basic', 1, { stripe_subscription_id: 'sub_recorded' }), subscriptions: [sub({ id: 'sub_other', price: TEAM, quantity: 2 })] });
    const before = { ...h.db.row };
    h.stripe.control.onRead = (method, key) => {
        h.stripe.control.failure = key === 'sub_recorded' ? permissionError : null;
    };
    const event = { ...updated(sub({ id: 'sub_other', price: TEAM, quantity: 2 })), created: hoursAgo(30) };
    const res = await h.webhook(event);
    assert.ok(res.status >= 500, `answered ${res.status}`);
    assert.deepStrictEqual(h.db.row, before);
    assert.strictEqual(h.db.events.get(event.id), 'failed');
    assert.strictEqual(notAppliedAlerts(h).length, 1);
    assert.match(notAppliedAlerts(h)[0].html, /sub_recorded/);
});

// N2: an invoice that concerns no workspace asks Stripe nothing and answers as
// before the refusal rule, whatever Stripe would say.

for (const type of ['invoice.payment_failed', 'invoice.payment_succeeded']) {
    test(`${type} for a subscription no workspace records reads nothing and answers 200, even while Stripe refuses`, async () => {
        const h = load({ org: onPlan('developer_basic', 1, { stripe_customer_id: 'cus_somebody', stripe_subscription_id: 'sub_somebody' }), subscriptions: [sub()] });
        h.stripe.control.failure = permissionError;
        const before = { ...h.db.row };
        const res = await h.webhook({ ...invoiceEvent(type, { subscription: 'sub_unknown', customer: 'cus_unknown' }), created: hoursAgo(30) });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.reads, [], 'Stripe was read for an invoice no workspace records');
        assert.deepStrictEqual(h.db.row, before);
        assert.deepStrictEqual(h.ledger, []);
        assert.strictEqual(h.emailAttempts.length, 0);
    });
}
