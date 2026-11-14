'use strict';

/**
 * A HUNG STRIPE MUST NOT HOLD A WEBHOOK PAST STRIPE'S OWN DELIVERY DEADLINE.
 *
 * The Stripe client was constructed with no timeout and no retry limit, so it
 * ran on stripe-node 20's defaults: 80 seconds per attempt and 2 retries, about
 * four minutes for one call. Every subscription and invoice event reads Stripe
 * before it answers, and Stripe gives a delivery far less than that (it does
 * not publish the number; reports put it between 10 and 30 seconds).
 *
 * Proved by behaviour against the REAL SDK: a local server that accepts the
 * connection and never answers stands in for a hung Stripe, and the client is
 * built with exactly the options stripeService builds it with.
 */

process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Stripe = require('stripe');

const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const DB_PATH = require.resolve('../../src/config/db');
const REDIS_PATH = require.resolve('../../src/config/redis');
const ROUTE_PATH = require.resolve('../../src/routes/webhooks-stripe');
const PRODUCT_EVENTS_PATH = require.resolve('../../src/services/productEventsService');
const RETENTION_LEDGER_PATH = require.resolve('../../src/services/retentionLedger');
const EMAIL_PATH = require.resolve('../../src/services/email/resendClient');

/** A server that takes every request and never answers it. */
async function hungStripe() {
    const seen = [];
    const open = new Set();
    const server = http.createServer((req) => { seen.push(`${req.method} ${req.url}`); });
    server.on('connection', (s) => { open.add(s); s.on('close', () => open.delete(s)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        port: server.address().port,
        seen,
        close: () => { for (const s of open) s.destroy(); return new Promise((r) => server.close(r)); },
    };
}

/** The options stripeService passes to `new Stripe(...)`, captured, not guessed. */
function constructedWith() {
    const captured = [];
    const stripePath = require.resolve('stripe');
    const real = require.cache[stripePath];
    function Captured(key, options) { captured.push(options); }
    delete require.cache[STRIPE_SERVICE_PATH];
    require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: Captured };
    const before = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_client_bounds_never_sent';
    try {
        require(STRIPE_SERVICE_PATH);
    } finally {
        require.cache[stripePath] = real;
        delete require.cache[STRIPE_SERVICE_PATH];
        if (before === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = before;
    }
    assert.strictEqual(captured.length, 1, 'stripeService must build exactly one client');
    return captured[0];
}

test('the Stripe client is built with an explicit timeout and retry count, not the SDK\'s 80 s x 3', () => {
    const options = constructedWith();
    assert.ok(Number.isInteger(options.timeout), `no timeout: ${JSON.stringify(options)}`);
    assert.ok(options.timeout <= 10_000, `timeout ${options.timeout} ms`);
    assert.ok(Number.isInteger(options.maxNetworkRetries), `no retry count: ${JSON.stringify(options)}`);
    assert.ok(options.maxNetworkRetries <= 1, `maxNetworkRetries ${options.maxNetworkRetries}`);
    assert.strictEqual(options.apiVersion, '2026-02-25.clover', 'the API version is unchanged');
});

test('a call on the client, against a Stripe that never answers, gives up within its budget', async () => {
    const hung = await hungStripe();
    const options = constructedWith();
    const client = new Stripe('sk_test_client_bounds_never_sent', { ...options, host: '127.0.0.1', port: hung.port, protocol: 'http' });
    const started = Date.now();
    try {
        await assert.rejects(client.subscriptions.retrieve('sub_hung'), (err) => err.type === 'StripeConnectionError');
        const took = Date.now() - started;
        const attempts = hung.seen.length;
        assert.strictEqual(attempts, options.maxNetworkRetries + 1, `${attempts} attempts`);
        // Each attempt's timeout, plus the SDK's backoff between them (at most 5 s, in practice ~0.5-1 s).
        assert.ok(took < options.timeout * attempts + 5_000, `a hung Stripe held the call for ${took} ms`);
    } finally {
        await hung.close();
    }
});

test('the webhook reads Stripe with a 5 s bound and no SDK retry: a hung Stripe is a 5xx within 5 s, and Stripe redelivers', async () => {
    const hung = await hungStripe();
    const real = new Stripe('sk_test_client_bounds_never_sent', { apiVersion: '2026-02-25.clover', host: '127.0.0.1', port: hung.port, protocol: 'http' });
    const service = require(STRIPE_SERVICE_PATH);
    const event = {
        id: 'evt_client_bounds_1', type: 'invoice.payment_failed', created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_hung', billing_reason: 'subscription_cycle' } },
    };
    const events = new Map();
    const query = async (text, params = []) => {
        if (/SELECT status FROM stripe_events/.test(text)) return { rows: events.has(params[0]) ? [{ status: events.get(params[0]) }] : [] };
        if (/INSERT INTO stripe_events/.test(text) && /'failed'/.test(text)) { events.set(params[0], 'failed'); return { rows: [], rowCount: 1 }; }
        if (/FROM organizations/.test(text)) return { rows: [{ org_id: 'org-1', stripe_subscription_id: 'sub_hung', stripe_customer_id: 'cus_1', plan_tier: 'developer_basic', subscription_status: 'active' }] };
        return { rows: [], rowCount: 0 };
    };
    for (const p of [DB_PATH, REDIS_PATH, STRIPE_SERVICE_PATH, PRODUCT_EVENTS_PATH, RETENTION_LEDGER_PATH, EMAIL_PATH, ROUTE_PATH]) delete require.cache[p];
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };
    stub(DB_PATH, { query, pool: { connect: async () => ({ query, release() {} }) } });
    stub(REDIS_PATH, { redis: { del: async () => 1 } });
    // The REAL SDK client pointed at the hung server, with the service's own webhook options.
    real.webhooks.constructEvent = () => event;
    stub(STRIPE_SERVICE_PATH, { stripe: real, WEBHOOK_READ_OPTIONS: service.WEBHOOK_READ_OPTIONS });
    stub(PRODUCT_EVENTS_PATH, { recordProductEvent: async () => ({}) });
    stub(RETENTION_LEDGER_PATH, { recordSubscriptionEvent: async () => {} });
    stub(EMAIL_PATH, { sendEmail: async () => ({}) });
    const express = require('express');
    const app = express();
    app.use('/hook', require(ROUTE_PATH));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
        const started = Date.now();
        const res = await fetch(`http://127.0.0.1:${server.address().port}/hook`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=stub' }, body: '{}',
        });
        const took = Date.now() - started;
        assert.ok(res.status >= 500, `answered ${res.status}`);
        assert.strictEqual(events.get(event.id), 'failed', 'the event must stay redeliverable');
        assert.strictEqual(hung.seen.length, 1, `the webhook's read was attempted ${hung.seen.length} times`);
        assert.ok(took < 7_000, `a hung Stripe held the webhook for ${took} ms`);
    } finally {
        server.close();
        server.closeAllConnections();
        await hung.close();
    }
});
