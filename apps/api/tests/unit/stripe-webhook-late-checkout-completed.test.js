'use strict';

/**
 * A LATE checkout.session.completed MUST NOT PUT BACK THE PLAN THE SESSION
 * REMEMBERS WHILE STRIPE BILLS ANOTHER.
 *
 * Stripe retries this event for days when a delivery fails. The walker's story:
 * a person buys Pro on Stripe Checkout, the first delivery of the completed
 * event fails, their plan page still says Free, and they press "Upgrade to Team"
 * (2 seats). POST /billing/checkout adopts the Pro subscription they are already
 * paying for and moves it to Team in place; Stripe bills Team x2. Then the retry
 * of the original completed event arrives, and the handler wrote the plan from
 * session.metadata.tierId: the org went back to Pro with 2 seats, invites
 * answered 403 upgrade_required, and nothing corrected it until the next
 * subscription update, a month (or a year) away. The same event booked a ledger
 * row "created" at Pro x 2 seats, AFTER the Team plan change, so the revenue
 * ledger said $24 of MRR for a customer paying $30.
 *
 * The rules these tests pin:
 *   - the org's plan comes from the subscription Stripe has NOW, by the same
 *     price mapping every other case uses; a price the map does not know grants
 *     nothing (stripe-webhook-unrecognised-price.test.js);
 *   - a subscription that is over when the event lands grants nothing;
 *   - a better live subscription the org already records is not replaced by a
 *     lesser one (best plan, then most recent);
 *   - the ledger row is the purchase (what the session sold), placed at the time
 *     of the purchase when the ledger may already hold what happened since;
 *   - the ordinary first purchase lands exactly as before, and a redelivery is
 *     still deduplicated.
 *
 * This file drives the REAL billing route, the REAL stripeService and the REAL
 * webhook module over one Stripe double and one org row that applies writes.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_late_checkout_completed';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_late_checkout_completed';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = 'price_pro_monthly';
process.env.STRIPE_PRICE_DEVELOPER_BASIC_ANNUAL = 'price_pro_annual';
process.env.STRIPE_PRICE_DEVELOPER_PRO = 'price_team_monthly';
process.env.STRIPE_PRICE_DEVELOPER_PRO_ANNUAL = 'price_team_annual';
process.env.DASHBOARD_URL = 'https://app.deerdawn.com';

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

const { computeRetentionMetrics } = require('../../src/services/retentionMetrics');

const ORG_ID = 'org-5a5a5a5a-6b6b-7c7c-8d8d-9e9e9e9e9e9e';
const CUSTOMER = 'cus_late_checkout';
const PRO = 'price_pro_monthly';
const PRO_ANNUAL = 'price_pro_annual';
const TEAM = 'price_team_monthly';
const TEAM_ANNUAL = 'price_team_annual';

// When the Pro purchase happened. Stripe keeps an event's `created` across every
// redelivery, so this is also when the late event says it happened.
const PURCHASED_AT = 1_758_000_000;

const clone = (value) => JSON.parse(JSON.stringify(value));

function subscription({ id, status = 'active', price = PRO, quantity = 1, created = PURCHASED_AT - 5 }) {
    return {
        id,
        status,
        customer: CUSTOMER,
        created,
        metadata: {},
        schedule: null,
        items: {
            data: [{
                id: `si_${id}`,
                quantity,
                current_period_start: PURCHASED_AT,
                current_period_end: PURCHASED_AT + 30 * 86400,
                price: { id: price, recurring: { interval: /_annual$/.test(price) ? 'year' : 'month' } },
            }],
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
 * One org row that APPLIES the writes addressed to it, honours each UPDATE's
 * WHERE clause, keeps the stripe_events claim, and undoes a transaction on
 * ROLLBACK, so "the org is now in this state" is asserted, not "an UPDATE was
 * issued".
 */
function makeDb(initialRow) {
    const row = {
        org_id: ORG_ID,
        account_type: 'personal',
        plan: 'free',
        plan_tier: 'free',
        subscription_status: 'active',
        stripe_customer_id: CUSTOMER,
        stripe_subscription_id: null,
        purchased_seats: null,
        pending_plan: null,
        ...initialRow,
    };
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
        for (const assignment of assignments(setClause)) {
            const coalesced = /(\w+)\s*=\s*COALESCE\(\$(\d+)/.exec(assignment);
            if (coalesced) {
                const value = arg(params, coalesced[2]);
                if (value !== null && value !== undefined) row[coalesced[1]] = value;
                continue;
            }
            const bound = /(\w+)\s*=\s*\$(\d+)/.exec(assignment);
            if (bound) { row[bound[1]] = arg(params, bound[2]); continue; }
            const nulled = /(\w+)\s*=\s*NULL/.exec(assignment);
            if (nulled) { row[nulled[1]] = null; continue; }
            const literal = /(\w+)\s*=\s*'([^']*)'/.exec(assignment);
            if (literal) row[literal[1]] = literal[2];
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
            if (/WHERE stripe_subscription_id = \$1/.test(text) && row.stripe_subscription_id !== params[0]) return { rows: [], rowCount: 0 };
            if (/WHERE stripe_customer_id = \$1/.test(text) && row.stripe_customer_id !== params[0]) return { rows: [], rowCount: 0 };
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

function load({ org = {}, subscriptions = [] } = {}) {
    const db = makeDb(org);
    // retrieveError fails every Stripe read; retrieveErrors fails reads of one subscription id.
    const state = { subscriptions: subscriptions.map(clone), nextEvent: null, retrieveError: null, retrieveErrors: {} };
    const calls = { checkoutSessions: [], updates: [], retrieved: [] };
    const ledger = [];
    const productEvents = [];
    // The real ledger stamps NOW() on a row that names no time. Each such row
    // lands one minute after the last, all of them after the purchase.
    const clock = { ms: (PURCHASED_AT + 3600) * 1000 };

    class MockStripe {
        constructor() {
            this.customers = { create: async () => ({ id: CUSTOMER }) };
            this.checkout = { sessions: { create: async (payload) => { calls.checkoutSessions.push(payload); return { url: 'https://checkout.stripe.test/new' }; } } };
            this.billingPortal = { sessions: { create: async () => ({ url: 'https://billing.stripe.test/portal' }) } };
            this.webhooks = { constructEvent: () => state.nextEvent };
            this.subscriptions = {
                retrieve: async (id) => {
                    calls.retrieved.push(id);
                    if (state.retrieveError) throw state.retrieveError;
                    if (state.retrieveErrors[id]) throw state.retrieveErrors[id];
                    const found = state.subscriptions.find((s) => s.id === id);
                    if (!found) throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing', statusCode: 404 });
                    return clone(found);
                },
                list: async (params) => {
                    if (state.retrieveError) throw state.retrieveError;
                    return { data: state.subscriptions.filter((s) => s.customer === params.customer).map(clone), has_more: false };
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
                    return clone(state.subscriptions[index]);
                },
            };
            this.subscriptionSchedules = { retrieve: async () => null, create: async () => ({ id: 'sched' }), update: async () => ({}) };
            this.charges = { retrieve: async () => ({}) };
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
    stub(PRODUCT_EVENTS_PATH, { recordProductEvent: async (actor, input) => { productEvents.push({ actor, input }); return {}; } });
    stub(RETENTION_LEDGER_PATH, {
        recordSubscriptionEvent: async (entry) => {
            clock.ms += 60_000;
            ledger.push({
                ...entry,
                occurred_at: entry.occurred_at ? new Date(entry.occurred_at).toISOString() : new Date(clock.ms).toISOString(),
            });
        },
    });
    stub(EMAIL_PATH, { sendEmail: async () => ({}) });

    const app = express();
    app.use('/hook', require(WEBHOOK_PATH));
    app.use('/billing', express.json(), require(BILLING_PATH));

    async function request(path, body) {
        const server = app.listen(0);
        await new Promise((r) => server.once('listening', r));
        const { port } = server.address();
        try {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=stub' },
                body: JSON.stringify(body),
            });
            // The ledger and product events are written after COMMIT, unawaited.
            await new Promise((r) => setImmediate(r));
            return { status: res.status, body: await res.json().catch(() => ({})) };
        } finally {
            server.close();
        }
    }

    return {
        db,
        state,
        calls,
        ledger,
        productEvents,
        now: () => clock.ms + 60_000,
        current: (id) => clone(state.subscriptions.find((s) => s.id === id)),
        checkout: (body) => request('/billing/checkout', body),
        webhook: (event) => { state.nextEvent = event; return request('/hook', { stub: true }); },
    };
}

/** What the invite route asks before it lets anybody in: the real entitlement fold over the org row. */
function entitlementsOf(row) {
    return require('../../src/services/entitlementService').getEntitlementsFromOrg(row);
}

function completedEvent({ id = 'evt_checkout_pro', subscription: subscriptionId = 'sub_paid', tierId = 'developer_basic', billingCycle = 'monthly', seats = null, amountTotal = 1200, created = PURCHASED_AT } = {}) {
    return {
        id,
        type: 'checkout.session.completed',
        created,
        data: {
            object: {
                id: `cs_${id}`,
                mode: 'subscription',
                customer: CUSTOMER,
                subscription: subscriptionId,
                amount_total: amountTotal,
                currency: 'usd',
                metadata: { orgId: ORG_ID, tierId, billingCycle, ...(seats ? { seats: String(seats) } : {}) },
            },
        },
    };
}

function updatedEvent(id, sub, previousAttributes) {
    return { id, type: 'customer.subscription.updated', created: PURCHASED_AT + 1800, data: { object: sub, previous_attributes: previousAttributes } };
}

/** The org row a late or failed checkout.session.completed leaves behind. */
const WEBHOOK_NEVER_LANDED = { plan: 'free', plan_tier: 'free', subscription_status: 'active', stripe_subscription_id: null };

const THE_PRO_IT_WAS = { items: { data: [{ price: { id: PRO }, quantity: 1 }] } };

// ---------------------------------------------------------------------------
// The reported defect
// ---------------------------------------------------------------------------

test('the walker\'s story: a late completed after the unrecorded Pro was moved to Team leaves the org on Team', async () => {
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid' })] });

    // The plan page still says Free; "Upgrade to Team", two seats. Round 1's
    // adoption moves the Pro they already pay for, in place.
    const up = await h.checkout({ tierId: 'developer_pro', seats: 2 });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.strictEqual(up.body.updated, true);
    assert.strictEqual(h.calls.checkoutSessions.length, 0);

    // Stripe reports the move it just made.
    const moved = await h.webhook(updatedEvent('evt_moved_to_team', h.current('sub_paid'), THE_PRO_IT_WAS));
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));

    // Stripe's retry of the original Pro purchase.
    const late = await h.webhook(completedEvent());
    assert.strictEqual(late.status, 200, JSON.stringify(late.body));

    assert.strictEqual(h.db.row.plan_tier, 'developer_pro',
        `the late event put the org on "${h.db.row.plan_tier}" while Stripe bills ${h.current('sub_paid').items.data[0].price.id} x2`);
    assert.strictEqual(h.db.row.plan, 'developer_pro');
    assert.strictEqual(h.db.row.purchased_seats, 2);
    assert.strictEqual(h.db.row.subscription_status, 'active');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_paid');

    // The invite gate is the entitlement fold over this row.
    const ent = entitlementsOf(h.db.row);
    assert.strictEqual(ent.features.team_management, true, 'an invite would answer 403 upgrade_required on a Team the customer is paying for');
    assert.strictEqual(ent.limits.included_seats, 2);
});

test('the walker\'s story, in the ledger: the late purchase row does not override the Team plan change booked after it', async () => {
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid' })] });
    await h.checkout({ tierId: 'developer_pro', seats: 2 });
    await h.webhook(updatedEvent('evt_moved_to_team', h.current('sub_paid'), THE_PRO_IT_WAS));
    assert.strictEqual(computeRetentionMetrics(h.ledger, h.now()).mrr_cents, mrrCents('developer_pro', 2), 'precondition: the move is in the ledger');

    const late = await h.webhook(completedEvent());
    assert.strictEqual(late.status, 200, JSON.stringify(late.body));

    // The purchase is recorded as what was bought, and the plan change that
    // happened after it keeps the final say.
    const metrics = computeRetentionMetrics(h.ledger, h.now());
    assert.strictEqual(metrics.active_subscriptions, 1);
    assert.strictEqual(metrics.mrr_cents, mrrCents('developer_pro', 2),
        `the ledger reads ${metrics.mrr_cents} cents of MRR for a customer billed Team x2 ($30)`);
    assert.strictEqual(metrics.new_subscriptions, 1, 'the purchase must still count as a new subscription');
    const created = h.ledger.filter((e) => e.event_type === 'created');
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].plan_tier, 'developer_basic', 'the purchase record describes what the checkout sold');
    assert.strictEqual(created[0].mrr_cents, mrrCents('developer_basic'), 'Pro x 2 seats was never bought and is not billed');
    assert.strictEqual(created[0].occurred_at, new Date(PURCHASED_AT * 1000).toISOString());
});

test('updated first, then an in-place upgrade, then the late completed: the org stays on Team', async () => {
    // The base's own path to the same defect: customer.subscription.updated for
    // the new Pro subscription reaches the org before the completed event does.
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid' })] });

    const first = await h.webhook(updatedEvent('evt_pro_updated_first', h.current('sub_paid'), { default_payment_method: null }));
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_basic');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_paid');

    const up = await h.checkout({ tierId: 'developer_pro', seats: 2 });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.strictEqual(up.body.updated, true);
    await h.webhook(updatedEvent('evt_team_updated', h.current('sub_paid'), THE_PRO_IT_WAS));

    const late = await h.webhook(completedEvent());
    assert.strictEqual(late.status, 200, JSON.stringify(late.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(h.db.row.purchased_seats, 2);
    assert.strictEqual(entitlementsOf(h.db.row).features.team_management, true);

    const metrics = computeRetentionMetrics(h.ledger, h.now());
    assert.strictEqual(metrics.active_subscriptions, 1);
    assert.strictEqual(metrics.mrr_cents, mrrCents('developer_pro', 2));
    assert.strictEqual(metrics.new_subscriptions, 1);
});

test('the late completed can arrive before Stripe reports the move: the org still lands on what Stripe bills', async () => {
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid' })] });
    await h.checkout({ tierId: 'developer_pro', seats: 2 });

    const late = await h.webhook(completedEvent());
    assert.strictEqual(late.status, 200, JSON.stringify(late.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(h.db.row.purchased_seats, 2);

    // And the update, when it comes, re-prices the ledger to Team.
    await h.webhook(updatedEvent('evt_moved_later', h.current('sub_paid'), THE_PRO_IT_WAS));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(computeRetentionMetrics(h.ledger, h.now()).mrr_cents, mrrCents('developer_pro', 2));
});

// ---------------------------------------------------------------------------
// A subscription that is over when the event lands
// ---------------------------------------------------------------------------

test('a completed event for a subscription cancelled in the meantime grants nothing', async () => {
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid', status: 'canceled' })] });

    // The cancellation reached the org first: it records no subscription and is
    // on Free, cancelled.
    const deleted = await h.webhook({ id: 'evt_deleted', type: 'customer.subscription.deleted', created: PURCHASED_AT + 600, data: { object: h.current('sub_paid') } });
    assert.strictEqual(deleted.status, 200, JSON.stringify(deleted.body));
    assert.strictEqual(h.db.row.plan_tier, 'free');

    const late = await h.webhook(completedEvent());
    assert.strictEqual(late.status, 200, JSON.stringify(late.body));
    assert.strictEqual(h.db.row.plan_tier, 'free',
        `a subscription Stripe says is cancelled put the org on "${h.db.row.plan_tier}"`);
    assert.strictEqual(h.db.row.stripe_subscription_id, null, 'the cancelled subscription was linked to the org again');
    assert.strictEqual(entitlementsOf(h.db.row).tier, 'free', 'paid entitlements granted from the session\'s memory');

    // Nothing in the ledger says this org is paying.
    const metrics = computeRetentionMetrics(h.ledger, h.now());
    assert.strictEqual(metrics.active_subscriptions, 0);
    assert.strictEqual(metrics.mrr_cents, 0);
});

test('a completed event for a subscription Stripe no longer has is handled, and grants nothing', async () => {
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [] });

    const late = await h.webhook(completedEvent());
    assert.strictEqual(late.status, 200, `an answer that will never change was retried for three days: ${late.status}`);
    assert.strictEqual(h.db.events.get('evt_checkout_pro'), 'processed');
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.strictEqual(h.db.row.stripe_subscription_id, null);
    assert.strictEqual(computeRetentionMetrics(h.ledger, h.now()).active_subscriptions, 0);
});

test('a transient Stripe failure is retried, never written from the session', async () => {
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid' })] });
    h.state.retrieveError = Object.assign(new Error('An error occurred with our connection to Stripe.'), { type: 'StripeConnectionError' });

    const first = await h.webhook(completedEvent());
    assert.ok(first.status >= 500, `Stripe only redelivers on a non-2xx; got ${first.status}`);
    assert.notStrictEqual(h.db.events.get('evt_checkout_pro'), 'processed');
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.strictEqual(h.ledger.length, 0);

    h.state.retrieveError = null;
    const second = await h.webhook(completedEvent());
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.notStrictEqual(second.body.duplicate, true, 'the redelivery was eaten by the idempotency guard');
    assert.strictEqual(h.db.row.plan_tier, 'developer_basic');
    assert.strictEqual(h.db.events.get('evt_checkout_pro'), 'processed');
});

test('a Stripe failure a retry cannot fix never grants from the session, is never closed, and applies once Stripe can be read', async () => {
    // The session alone is not evidence of a live subscription. Round 3: a
    // failed webhook on every delivery. Round 4's first version: 5xx for 24
    // hours from the event's created, then 200 and `processed` with nothing
    // written, which left a paying customer on Free (the redelivery was a
    // duplicate). The owner's revised decision (2026-09-29): never closed; 5xx
    // and `failed` on every delivery however old, and the first delivery Stripe
    // can be read for grants the plan.
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid' })] });
    h.state.retrieveError = Object.assign(new Error('Invalid API Key provided'), { type: 'StripeAuthenticationError', statusCode: 401 });

    const recent = await h.webhook(completedEvent({ created: Math.floor(Date.now() / 1000) - 3600 }));
    assert.ok(recent.status >= 500, `got ${recent.status}`);
    assert.strictEqual(h.db.events.get('evt_checkout_pro'), 'failed');
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.strictEqual(h.db.row.stripe_subscription_id, null);

    // The same event, redelivered more than a day after it was created (created is 2025 here).
    const late = await h.webhook(completedEvent());
    assert.ok(late.status >= 500, `got ${late.status}: an old refused purchase was closed`);
    assert.strictEqual(h.db.events.get('evt_checkout_pro'), 'failed', 'Stripe must go on redelivering it');
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.strictEqual(h.db.row.stripe_subscription_id, null);
    assert.deepStrictEqual(h.ledger, []);
    assert.ok(!h.productEvents.some((e) => e.input.event_name === 'purchase_completed'));

    // The key is fixed; the next redelivery grants what Stripe bills.
    h.state.retrieveError = null;
    const applied = await h.webhook(completedEvent());
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    assert.notStrictEqual(applied.body.duplicate, true);
    assert.strictEqual(h.db.row.plan_tier, 'developer_basic');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_paid');
    assert.strictEqual(h.db.events.get('evt_checkout_pro'), 'processed');
});

// ---------------------------------------------------------------------------
// Two live subscriptions: best plan, then most recent
// ---------------------------------------------------------------------------

test('a recorded subscription Stripe cannot read for good is not replaced (isSubscriptionLive\'s bias)', async () => {
    const h = load({
        org: { plan: 'developer_pro', plan_tier: 'developer_pro', subscription_status: 'active', stripe_subscription_id: 'sub_recorded', purchased_seats: 3 },
        subscriptions: [subscription({ id: 'sub_paid' })],
    });
    h.state.retrieveErrors.sub_recorded = Object.assign(new Error('No access to this subscription'), { type: 'StripePermissionError', statusCode: 403 });

    // Was 200 with the recorded subscription kept. Since 2026-09-29 a read
    // Stripe refuses for good is never written from and never closed: 5xx,
    // nothing replaced, the event left for Stripe to redeliver.
    const res = await h.webhook(completedEvent());
    assert.ok(res.status >= 500, `answered ${res.status}`);
    assert.strictEqual(h.db.events.get('evt_checkout_pro'), 'failed');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_recorded');
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(h.db.row.purchased_seats, 3);
});

test('a late Pro purchase does not replace the live Team the org already records', async () => {
    const team = subscription({ id: 'sub_team', price: TEAM, quantity: 3, created: PURCHASED_AT - 86400 });
    const pro = subscription({ id: 'sub_pro', created: PURCHASED_AT - 5 });
    const h = load({
        org: { plan: 'developer_pro', plan_tier: 'developer_pro', subscription_status: 'active', stripe_subscription_id: 'sub_team', purchased_seats: 3 },
        subscriptions: [team, pro],
    });

    const late = await h.webhook(completedEvent({ subscription: 'sub_pro' }));
    assert.strictEqual(late.status, 200, JSON.stringify(late.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro', 'a lesser subscription replaced the Team the org is billed on');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_team');
    assert.strictEqual(h.db.row.purchased_seats, 3);
    assert.strictEqual(entitlementsOf(h.db.row).features.team_management, true);
    assert.ok(!h.ledger.some((e) => e.event_type === 'created' && e.plan_tier === 'developer_basic'),
        'a Pro purchase the org is not on was booked over its Team MRR');
});

test('a late Team purchase still wins over a lesser live Pro the org records', async () => {
    // The same rule, the other way round: the better plan is the one the org gets.
    const pro = subscription({ id: 'sub_pro', created: PURCHASED_AT - 86400 });
    const team = subscription({ id: 'sub_team', price: TEAM, quantity: 3, created: PURCHASED_AT - 5 });
    const h = load({
        org: { plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'active', stripe_subscription_id: 'sub_pro', purchased_seats: 1 },
        subscriptions: [pro, team],
    });

    const late = await h.webhook(completedEvent({ subscription: 'sub_team', tierId: 'developer_pro', seats: 3, amountTotal: 4500 }));
    assert.strictEqual(late.status, 200, JSON.stringify(late.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_pro');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_team');
    assert.strictEqual(h.db.row.purchased_seats, 3);
    assert.strictEqual(computeRetentionMetrics(h.ledger, h.now()).mrr_cents, mrrCents('developer_pro', 3));
});

test('when the recorded subscription is no longer live, the purchase is adopted', async () => {
    const h = load({
        org: { plan: 'developer_basic', plan_tier: 'developer_basic', subscription_status: 'active', stripe_subscription_id: 'sub_old' },
        subscriptions: [subscription({ id: 'sub_old', status: 'canceled', created: PURCHASED_AT - 86400 * 40 }), subscription({ id: 'sub_paid' })],
    });

    const res = await h.webhook(completedEvent());
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_paid');
    assert.strictEqual(h.db.row.plan_tier, 'developer_basic');
});

// ---------------------------------------------------------------------------
// The ordinary purchase lands exactly as before
// ---------------------------------------------------------------------------

const ORDINARY = [
    {
        name: 'Pro, monthly',
        sub: subscription({ id: 'sub_new', price: PRO }),
        session: { tierId: 'developer_basic', billingCycle: 'monthly', amountTotal: 1200 },
        expect: { plan: 'developer_basic', seats: 1, status: 'active', mrr: mrrCents('developer_basic'), billing: 'monthly', trial: false },
    },
    {
        name: 'Pro, annual',
        sub: subscription({ id: 'sub_new', price: PRO_ANNUAL }),
        session: { tierId: 'developer_basic', billingCycle: 'annual', amountTotal: 9600 },
        expect: { plan: 'developer_basic', seats: 1, status: 'active', mrr: mrrCents('developer_basic'), billing: 'annual', trial: false },
    },
    {
        // Two seats chosen on our page, four on Stripe's (adjustable_quantity),
        // and the 14-day trial: $0 collected, so zero MRR on day one.
        name: 'Team, monthly trial, seats adjusted on the Stripe page',
        sub: subscription({ id: 'sub_new', price: TEAM, quantity: 4, status: 'trialing' }),
        session: { tierId: 'developer_pro', billingCycle: 'monthly', seats: 2, amountTotal: 0 },
        expect: { plan: 'developer_pro', seats: 4, status: 'trialing', mrr: 0, billing: 'monthly', trial: true },
    },
    {
        name: 'Team, annual, seats adjusted on the Stripe page',
        sub: subscription({ id: 'sub_new', price: TEAM_ANNUAL, quantity: 3 }),
        session: { tierId: 'developer_pro', billingCycle: 'annual', seats: 2, amountTotal: 45000 },
        expect: { plan: 'developer_pro', seats: 3, status: 'active', mrr: mrrCents('developer_pro', 3), billing: 'annual', trial: false },
    },
];

for (const c of ORDINARY) {
    test(`an ordinary first purchase lands as before: ${c.name}`, async () => {
        const h = load({ org: { ...WEBHOOK_NEVER_LANDED, pending_plan: c.expect.plan }, subscriptions: [c.sub] });

        const res = await h.webhook(completedEvent({ subscription: 'sub_new', ...c.session }));
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body, { received: true });

        assert.strictEqual(h.db.row.plan, c.expect.plan);
        assert.strictEqual(h.db.row.plan_tier, c.expect.plan);
        assert.strictEqual(h.db.row.purchased_seats, c.expect.seats);
        assert.strictEqual(h.db.row.subscription_status, c.expect.status);
        assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_new');
        assert.strictEqual(h.db.row.stripe_customer_id, CUSTOMER);
        assert.strictEqual(h.db.row.pending_plan, null);
        assert.strictEqual(new Date(h.db.row.billing_period_start).getTime(), PURCHASED_AT * 1000);
        assert.strictEqual(new Date(h.db.row.billing_period_end).getTime(), (PURCHASED_AT + 30 * 86400) * 1000);

        assert.strictEqual(h.ledger.length, 1);
        const [created] = h.ledger;
        assert.strictEqual(created.event_type, 'created');
        assert.strictEqual(created.org_id, ORG_ID);
        assert.strictEqual(created.plan_tier, c.expect.plan);
        assert.strictEqual(created.mrr_cents, c.expect.mrr);
        assert.strictEqual(created.stripe_event_id, 'evt_checkout_pro');
        // No time named: the ledger stamps it on insert, as it always did.
        assert.notStrictEqual(created.occurred_at, new Date(PURCHASED_AT * 1000).toISOString());

        const purchases = h.productEvents.filter((e) => e.input.event_name === 'purchase_completed');
        assert.strictEqual(purchases.length, 1);
        assert.strictEqual(purchases[0].input.metadata.tier, c.expect.plan);
        assert.strictEqual(purchases[0].input.metadata.billing, c.expect.billing);
        assert.strictEqual(purchases[0].input.metadata.is_trial, c.expect.trial);
        assert.strictEqual(purchases[0].input.metadata.subscription_type, 'new');
    });
}

test('a first purchase at a price the map does not know grants nothing until it is mapped, and is still recorded', async () => {
    // The owner's decision (2026-09-28): a brand-new purchase at an
    // unrecognised price gets nothing until the price is mapped, and the
    // operator is alerted (tests/unit/stripe-webhook-unrecognised-price.test.js).
    // This used to grant the plan the session sold.
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_new', price: 'price_legacy_unmapped' })] });

    const res = await h.webhook(completedEvent({ subscription: 'sub_new' }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'free', 'a purchase at an unrecognised price was granted the plan the session named');
    assert.strictEqual(h.db.row.stripe_subscription_id, 'sub_new');
    assert.deepStrictEqual(h.ledger, [], 'no purchase is booked from a plan DeerDawn could not determine');
});

test('a redelivery of the same event id is still deduplicated', async () => {
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid' })] });

    const first = await h.webhook(completedEvent());
    const second = await h.webhook(completedEvent());
    assert.deepStrictEqual(first.body, { received: true });
    assert.deepStrictEqual(second.body, { received: true, duplicate: true });
    assert.strictEqual(h.ledger.length, 1);
    assert.strictEqual(h.productEvents.filter((e) => e.input.event_name === 'purchase_completed').length, 1);
});

test('purchase_completed still describes the purchase, not the plan the org has moved to', async () => {
    // Measurement: the event is what was sold at checkout, joined to the
    // client-side copy by transaction_id. The late event must not re-label a Pro
    // sale as a Team sale.
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid' })] });
    await h.checkout({ tierId: 'developer_pro', seats: 2 });

    await h.webhook(completedEvent());
    const purchases = h.productEvents.filter((e) => e.input.event_name === 'purchase_completed');
    assert.strictEqual(purchases.length, 1);
    assert.strictEqual(purchases[0].input.metadata.tier, 'developer_basic');
    assert.strictEqual(purchases[0].input.metadata.amount_cents, 1200);
    assert.strictEqual(purchases[0].input.metadata.transaction_id, 'cs_evt_checkout_pro');
});

// ---------------------------------------------------------------------------
// purchase_completed is recorded ONLY when the workspace received a plan
// ---------------------------------------------------------------------------
//
// The owner's decision (2026-09-28). A checkout for a subscription filed under
// another customer granted nothing and emitted nothing; one for a subscription
// that was already over granted nothing and still reported a purchase, and so
// did a late purchase that lost to the better subscription the workspace is
// billed on, and a first purchase at a price the map does not know. Nothing
// granted, nothing counted; each is logged for the owner instead.

const purchasesOf = (h) => h.productEvents.filter((e) => e.input.event_name === 'purchase_completed');

const NOTHING_GRANTED = [
    {
        name: 'the subscription was cancelled before the event landed',
        load: () => load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid', status: 'canceled' })] }),
        event: () => completedEvent(),
    },
    {
        name: 'the subscription is gone from Stripe',
        load: () => load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [] }),
        event: () => completedEvent(),
    },
    {
        name: 'a late Pro purchase lost to the live Team the workspace is billed on',
        load: () => load({
            org: { plan: 'developer_pro', plan_tier: 'developer_pro', subscription_status: 'active', stripe_subscription_id: 'sub_team', purchased_seats: 3 },
            subscriptions: [subscription({ id: 'sub_team', price: TEAM, quantity: 3, created: PURCHASED_AT - 86400 }), subscription({ id: 'sub_pro' })],
        }),
        event: () => completedEvent({ subscription: 'sub_pro' }),
    },
    {
        name: 'a first purchase at a price the map does not know',
        load: () => load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_new', price: 'price_legacy_unmapped' })] }),
        event: () => completedEvent({ subscription: 'sub_new' }),
    },
];

for (const c of NOTHING_GRANTED) {
    test(`nothing granted, nothing counted: ${c.name}`, async () => {
        const h = c.load();
        const before = { plan: h.db.row.plan_tier, subscription: h.db.row.stripe_subscription_id };
        const warnings = [];
        const warn = console.warn;
        console.warn = (...args) => { warnings.push(args.join(' ')); };
        let res;
        try {
            res = await h.webhook(c.event());
        } finally {
            console.warn = warn;
        }
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(h.db.row.plan_tier, before.plan, 'the case assumes nothing was granted');
        assert.deepStrictEqual(purchasesOf(h), [], `a purchase was reported for a workspace that received no plan: ${JSON.stringify(purchasesOf(h))}`);
        assert.ok(warnings.some((w) => /purchase_completed not recorded/.test(w) && w.includes(ORG_ID)),
            `the case must be logged for the owner; logged: ${JSON.stringify(warnings)}`);
    });
}

test('a checkout for a subscription filed under another customer still counts nothing (guard)', async () => {
    const other = { ...subscription({ id: 'sub_paid' }), customer: 'cus_someone_else' };
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [other] });
    const res = await h.webhook(completedEvent());
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'free');
    assert.deepStrictEqual(purchasesOf(h), []);
});

test('a workspace that received its plan is counted once (guard)', async () => {
    const h = load({ org: { ...WEBHOOK_NEVER_LANDED }, subscriptions: [subscription({ id: 'sub_paid' })] });
    const res = await h.webhook(completedEvent());
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.db.row.plan_tier, 'developer_basic');
    assert.strictEqual(purchasesOf(h).length, 1);
});
