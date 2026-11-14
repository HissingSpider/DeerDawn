'use strict';

// The device flow tells its client to poll, then rate-limited it for polling.
//
// POST /start answers with `interval: 2` and an `expires_in` of up to 1800, and
// the MCP server on the user's machine does exactly what it is told: one
// GET /token every two seconds until the human finishes signing in in a
// browser. app.js mounted mcpAuthLimiter (30 requests / 10 minutes / IP) over
// ALL of /api/v1/auth/mcp, so /start plus 29 polls spent the entire window in
// about 58 seconds. Every later poll was a 429 that itself counted, so the
// bucket never reopened; the API key minted when the user did sign in was not
// collected until the ten minutes elapsed. Sign-in did not fail, it hung.
//
// Who that hit: anybody who spent more than a minute in the browser, which is
// everybody creating an account mid-flow. Not anybody dogfooding with a
// dashboard session already open, which is why it survived.
//
// These drive the real app, so they pin the MOUNT as well as the limiter: the
// budget only helps if /token is actually routed to it.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'false';
process.env.RATE_LIMIT_FALLBACK = 'memory';
process.env.DISABLE_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
// The per-address ceiling in front of the per-code bucket. Lowered here so the
// flood case is a few hundred requests rather than a few thousand; the per-code
// budget below is the real one, untouched.
process.env.MCP_DEVICE_POLL_IP_LIMIT = '200';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');

// The flow legs emit product events; there is no Postgres here and the emit is
// deliberately fire-and-forget, so stub it rather than wait out a DB breaker.
const productEvents = require('../../src/services/productEventsService');
productEvents.recordProductEvent = async () => ({});

const app = require('../../src/app');
const { redis } = require('../../src/config/redis');
const { EXTENDED_DEVICE_CODE_TTL, DEVICE_POLL_INTERVAL_SECONDS } = require('../../src/config/deviceFlow');

const httpServer = app.listen(0);
after(() => new Promise((resolve) => httpServer.close(resolve)));

const start = (ip) => request(httpServer)
    .post('/api/v1/auth/mcp/start')
    .set('X-Forwarded-For', ip)
    .send({ honors_server_expiry: true });

const poll = (ip, deviceCode) => request(httpServer)
    .get('/api/v1/auth/mcp/token')
    .query({ device_code: deviceCode })
    .set('X-Forwarded-For', ip);

test('a client that polls for three minutes, as instructed, is never rate limited', async () => {
    const ip = '203.0.113.60';
    const started = await start(ip);
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    const { device_code: deviceCode, interval, expires_in: expiresIn } = started.body;
    assert.strictEqual(interval, DEVICE_POLL_INTERVAL_SECONDS);
    assert.strictEqual(expiresIn, EXTENDED_DEVICE_CODE_TTL);

    // Three minutes of the polling the server itself asked for. The old shared
    // bucket was spent by poll 29, about 58 seconds in.
    const polls = Math.ceil(180 / interval);
    assert.ok(polls > 60, 'this test is only meaningful past the old 30-request budget');
    const codes = [];
    for (let i = 0; i < polls; i += 1) {
        codes.push((await poll(ip, deviceCode)).status);
    }
    assert.ok(!codes.includes(429), `polling as instructed must never 429, got ${codes.filter((c) => c === 429).length} of ${polls}`);
    assert.ok(codes.every((c) => c === 200), 'a pending poll answers 200 with status: pending');
});

test('the key minted after a long browser step is still collectable', async () => {
    const ip = '203.0.113.61';
    const started = await start(ip);
    const deviceCode = started.body.device_code;

    // 75 seconds of polling, the point at which the old bucket had been closed
    // for some time already.
    for (let i = 0; i < Math.ceil(75 / DEVICE_POLL_INTERVAL_SECONDS); i += 1) {
        await poll(ip, deviceCode);
    }

    // The browser step lands. Written straight into Redis because /authorize
    // needs a signed-in dashboard session, which is not what this file is about.
    await redis.set(
        `mcp:device:${deviceCode}`,
        JSON.stringify({ status: 'authorized', api_key: 'dd_collected_after_a_slow_signin', user_code: started.body.user_code }),
        'EX',
        EXTENDED_DEVICE_CODE_TTL
    );

    const pickup = await poll(ip, deviceCode);
    assert.strictEqual(pickup.status, 200, JSON.stringify(pickup.body));
    assert.strictEqual(pickup.body.status, 'authorized');
    assert.strictEqual(pickup.body.api_key, 'dd_collected_after_a_slow_signin');
});

test('two people behind one address do not spend each other\'s poll budget', async () => {
    const ip = '198.51.100.7';
    const first = await start(ip);
    const second = await start(ip);

    for (let i = 0; i < 60; i += 1) {
        await poll(ip, first.body.device_code);
    }

    const theirs = await poll(ip, second.body.device_code);
    assert.strictEqual(theirs.status, 200, 'a colleague on the same NAT must still be able to sign in');
});

test('a trailing slash is not a way around the budget for this path', async () => {
    const ip = '198.51.100.9';
    const started = await start(ip);
    // Express routes both spellings to the same handler; the limiter must read
    // them as the same endpoint or one of them picks the wrong bucket.
    const res = await request(httpServer)
        .get('/api/v1/auth/mcp/token/')
        .query({ device_code: started.body.device_code })
        .set('X-Forwarded-For', ip);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.status, 'pending');
});

test('/start is still tightly limited', async () => {
    const ip = '203.0.113.62';
    const codes = [];
    for (let i = 0; i < 40; i += 1) {
        codes.push((await start(ip)).status);
    }
    assert.ok(codes.includes(429), `flooding /start must still be refused, got ${codes.join(',')}`);
    assert.strictEqual(codes[codes.length - 1], 429, 'the tight bucket stays closed once tripped');
});

test('inventing a fresh device code per request does not buy an unlimited budget', async () => {
    const ip = '203.0.113.63';
    const ceiling = Number(process.env.MCP_DEVICE_POLL_IP_LIMIT);
    const codes = [];
    for (let i = 0; i < ceiling + 20; i += 1) {
        // Correctly shaped, never issued: each one would draw its own bucket if
        // the per-code key were the only thing counting.
        codes.push((await poll(ip, crypto.randomBytes(16).toString('hex'))).status);
    }
    assert.ok(codes.includes(429), 'a rotating-code flood must still hit the per-address ceiling');
});

test('a garbage device code shares the address bucket rather than minting one', async () => {
    const ip = '203.0.113.64';
    const ceiling = Number(process.env.MCP_DEVICE_POLL_IP_LIMIT);
    const codes = [];
    for (let i = 0; i < ceiling + 20; i += 1) {
        codes.push((await poll(ip, `not-a-device-code-${i}`)).status);
    }
    assert.ok(codes.includes(429), 'unissued codes must not each draw their own budget');
});
