/**
 * A SLOW STRIPE MUST NOT EMPTY THE CONNECTION POOL.
 *
 * Every subscription and invoice webhook now reads the subscription from
 * Stripe (the owner's decision, 2026-09-28: Stripe's word is final, the event
 * is only a signal). Round 2's backlog recorded what that costs if the read
 * happens inside the handler's transaction: a status-flip webhook held a pooled
 * connection idle in transaction for as long as Stripe took to answer, and 12
 * concurrent flips against a 5 s Stripe exhausted the pool of 10. With every
 * event reading Stripe, the same shape is an outage: every request that needs
 * the database queues behind webhooks that are only waiting on Stripe.
 *
 * Pinned here against the real app, the real pool and a real database: fifteen
 * webhooks (pool of ten) arrive together while Stripe takes 4 s to answer each
 * read; a request that needs a database connection, sent while they wait, must
 * still answer at once; and all fifteen must still be applied.
 *
 * Stripe is stubbed at the SDK edge: the real client object, with the two read
 * methods replaced. Webhooks are signed with the test secret, so the real
 * signature check runs. Nothing is sent to Stripe.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/stripe-webhook-slow-stripe-pool.test.js
 */

process.env.NODE_ENV = 'test';
process.env.DB_POOL_MAX = '10';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_pool_stub_never_sent_anywhere';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_slow_stripe_pool';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = process.env.STRIPE_PRICE_DEVELOPER_BASIC || 'price_pro_monthly_pool';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');

const stripeService = require('../../src/services/stripeService');
const app = require('../../src/app');
const db = require('../../src/config/db');

const WEBHOOKS = 15;
const STRIPE_DELAY_MS = 4000;
const PRO = process.env.STRIPE_PRICE_DEVELOPER_BASIC;
const TAG = crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, params) => db.query(sql, params, 'org-system');

// ── Stripe, stubbed at the SDK edge ─────────────────────────────────────────
const world = new Map();
const stripeReads = [];
const client = stripeService.stripe;
assert.ok(client, 'the Stripe client must be constructed for this test');
client.subscriptions.retrieve = async (id) => {
    stripeReads.push(id);
    await sleep(STRIPE_DELAY_MS);
    const found = world.get(id);
    if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    return JSON.parse(JSON.stringify(found));
};
client.subscriptions.list = async ({ customer }) => {
    stripeReads.push(customer);
    await sleep(STRIPE_DELAY_MS);
    return { object: 'list', data: [...world.values()].filter((s) => s.customer === customer), has_more: false };
};

function sign(payload) {
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
    return `t=${t},v1=${v1}`;
}

function subscription(id, customer, status) {
    const start = Math.floor(Date.now() / 1000) - 86_400;
    return {
        id,
        object: 'subscription',
        status,
        customer,
        created: start,
        items: { data: [{ id: `si_${id}`, quantity: 1, current_period_start: start, current_period_end: start + 30 * 86_400, price: { id: PRO } }] },
    };
}

const httpServer = app.listen(0);
const base = () => `http://127.0.0.1:${httpServer.address().port}`;
const orgs = [];

test.before(async () => {
    await new Promise((r) => (httpServer.listening ? r() : httpServer.once('listening', r)));
    for (let i = 0; i < WEBHOOKS; i += 1) {
        const orgId = `org-${uuidv4()}`;
        const customer = `cus_pool_${TAG}_${i}`;
        const subscriptionId = `sub_pool_${TAG}_${i}`;
        // A Pro workspace locked for a failed charge; the card has since been
        // fixed, so Stripe reports the subscription active.
        await q(
            `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, stripe_customer_id, stripe_subscription_id)
             VALUES ($1, $2, 'developer_basic', 'developer_basic', 'past_due', $3, $4)`,
            [orgId, `slow-stripe pool ${i}`, customer, subscriptionId],
        );
        world.set(subscriptionId, subscription(subscriptionId, customer, 'active'));
        orgs.push({ orgId, customer, subscriptionId, eventId: `evt_pool_${TAG}_${i}` });
    }
});

test.after(async () => {
    await q('DELETE FROM stripe_events WHERE event_id = ANY($1::text[])', [orgs.map((o) => o.eventId)]).catch(() => {});
    await q('DELETE FROM organizations WHERE org_id = ANY($1::text[])', [orgs.map((o) => o.orgId)]).catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
});

test('fifteen webhooks waiting on a slow Stripe leave the pool free for everybody else, and all fifteen apply', async (t) => {
    const started = Date.now();
    const deliveries = orgs.map((o) => {
        const payload = JSON.stringify({
            id: o.eventId,
            object: 'event',
            type: 'customer.subscription.updated',
            created: Math.floor(Date.now() / 1000),
            data: { object: world.get(o.subscriptionId), previous_attributes: { status: 'past_due' } },
        });
        return fetch(`${base()}/api/v1/webhooks/stripe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
            body: payload,
        }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
    });

    // While every one of them is waiting on Stripe: somebody else's request.
    await sleep(600);
    const pool = { waiting: db.pool.waitingCount, checkedOut: db.pool.totalCount - db.pool.idleCount };
    const probeStart = Date.now();
    const probe = await fetch(`${base()}/health/readiness`);
    const probeMs = Date.now() - probeStart;

    const results = await Promise.all(deliveries);
    const totalMs = Date.now() - started;
    t.diagnostic(`while waiting on Stripe: ${pool.waiting} queued for a connection, ${pool.checkedOut} checked out; probe ${probe.status} in ${probeMs} ms; all ${WEBHOOKS} answered in ${totalMs} ms`);

    assert.ok(Date.now() - started >= STRIPE_DELAY_MS, 'precondition: the webhooks really were waiting on Stripe');
    assert.strictEqual(pool.waiting, 0,
        `${pool.waiting} requests were queued for a connection and ${pool.checkedOut} connections were checked out while the webhooks waited on Stripe`);
    assert.strictEqual(probe.status, 200);
    assert.ok(probeMs < 1500,
        `a request needing the database took ${probeMs} ms while ${WEBHOOKS} webhooks waited on a ${STRIPE_DELAY_MS} ms Stripe (pool of ${process.env.DB_POOL_MAX})`);

    assert.deepStrictEqual(results.map((r) => r.status), orgs.map(() => 200), JSON.stringify(results));
    const rows = await q('SELECT org_id, subscription_status FROM organizations WHERE org_id = ANY($1::text[])', [orgs.map((o) => o.orgId)]);
    assert.deepStrictEqual(rows.rows.map((r) => r.subscription_status).sort(), orgs.map(() => 'active'),
        'every recovery Stripe reports must still be applied');
    assert.strictEqual(stripeReads.length, WEBHOOKS, `one Stripe read per event, got ${stripeReads.length}`);
    assert.ok(totalMs < STRIPE_DELAY_MS * 2, `the fifteen reads ran side by side, not in pool-sized batches (${totalMs} ms)`);
});
