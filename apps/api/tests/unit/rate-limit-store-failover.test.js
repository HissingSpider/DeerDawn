'use strict';

/**
 * THE LIMITERS HAVE TO ACTUALLY COUNT IN REDIS, AND MUST SURVIVE IT BEING DOWN.
 *
 * rateLimit.js picked its store while the file was being required. ioredis
 * connects asynchronously, so `status` was `connecting` at that instant on every
 * boot: every limiter silently became an in-memory, per-machine counter for the
 * life of the process, and each configured limit was really N-machines times
 * itself.
 *
 * These tests model that timing directly. The shared client is `connecting`
 * when the module loads and `ready` afterwards, exactly as in production, and
 * the assertions are about where the hits were counted and what the request
 * got back — not about what the source says.
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'false';
process.env.RATE_LIMIT_FALLBACK = 'memory';
process.env.DISABLE_REDIS = 'true';
process.env.RATE_LIMIT_REDIS_TIMEOUT_MS = '150';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');

// The stub client the app uses when Redis is disabled. It is the same object
// rateLimit.js holds, so changing its status here is what "Redis finished
// connecting after the module loaded" looks like from inside the process.
const { redis } = require('../../src/config/redis');

// A Redis that implements just what rate-limit-redis speaks: SCRIPT LOAD and
// EVALSHA for its increment/get scripts, plus DECR and DEL.
function fakeRedis() {
    const counters = new Map();
    const scripts = new Map();
    const commands = [];
    const call = async (...args) => {
        commands.push(args[0]);
        const [cmd, ...rest] = args;
        if (cmd === 'SCRIPT') {
            const sha = crypto.createHash('sha1').update(rest[1]).digest('hex');
            scripts.set(sha, /INCR/.test(rest[1]) ? 'increment' : 'get');
            return sha;
        }
        if (cmd === 'EVALSHA') {
            const [sha, , key] = rest;
            const kind = scripts.get(sha);
            if (!kind) throw new Error('NOSCRIPT');
            if (kind === 'increment') counters.set(key, (counters.get(key) || 0) + 1);
            return [counters.get(key) || 0, 60000];
        }
        if (cmd === 'DECR') { counters.set(rest[0], (counters.get(rest[0]) || 0) - 1); return counters.get(rest[0]); }
        if (cmd === 'DEL') { counters.delete(rest[0]); return 1; }
        throw new Error(`fakeRedis: unhandled ${cmd}`);
    };
    return { call, counters, commands };
}

// Production ordering: the client is still connecting when the limiters are built.
redis.status = 'connecting';
const { resolveRateLimitStore } = require('../../src/middleware/rateLimit');

function machine(prefix, max = 3) {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/t', rateLimit({
        windowMs: 60 * 1000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        store: resolveRateLimitStore(prefix),
    }), (_req, res) => res.json({ ok: true }));
    return app;
}

const hit = (app, ip) => request(app).get('/t').set('X-Forwarded-For', ip).then((r) => r.status);

test('a limiter built while Redis was still connecting counts in Redis once it is ready', async () => {
    const prefix = `rl:test-${crypto.randomUUID()}:`;
    // Two "machines": two independent limiter instances over one Redis, which
    // is what two Fly machines are.
    const a = machine(prefix);
    const b = machine(prefix);

    const fake = fakeRedis();
    redis.call = fake.call;
    redis.status = 'ready';

    const codes = [
        await hit(a, '198.51.100.7'),
        await hit(b, '198.51.100.7'),
        await hit(a, '198.51.100.7'),
        await hit(b, '198.51.100.7'),
    ];

    assert.ok(fake.commands.includes('EVALSHA'), 'the hits must reach Redis, not a per-process Map');
    assert.deepStrictEqual(
        codes, [200, 200, 200, 429],
        'max=3 is a limit on the CLIENT, shared across machines; per-machine memory counters allowed 6'
    );
});

test('Redis failing mid-flight degrades to a memory limit: no 500, and still a limit', async () => {
    const app = machine(`rl:test-${crypto.randomUUID()}:`, 2);
    redis.status = 'ready';
    redis.call = async () => { throw new Error('ECONNRESET'); };

    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push(await hit(app, '198.51.100.8'));

    assert.ok(!codes.includes(500), `a Redis error must never become a 500 (got ${codes.join(',')})`);
    assert.deepStrictEqual(codes, [200, 200, 429, 429], 'failing open means a weaker limiter, not no limiter');
});

// The timeout is the assertion's backstop: against the old store this request
// never completed at all, and a test that hangs is a test nobody reads.
test('a Redis command that never answers does not hang the request', { timeout: 10000 }, async () => {
    const app = machine(`rl:test-${crypto.randomUUID()}:`, 5);
    redis.status = 'ready';
    redis.call = () => new Promise(() => {});

    const started = Date.now();
    const status = await hit(app, '198.51.100.9');
    const elapsed = Date.now() - started;

    assert.strictEqual(status, 200);
    assert.ok(elapsed < 2000, `the request waited ${elapsed}ms on a dead Redis`);
});

test('Redis disabled (local dev, DISABLE_REDIS=true) is a working memory limiter', async () => {
    const app = machine(`rl:test-${crypto.randomUUID()}:`, 2);
    redis.status = 'disabled';
    redis.call = () => Promise.reject(new Error('Redis disabled'));

    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push(await hit(app, '198.51.100.10'));
    assert.deepStrictEqual(codes, [200, 200, 429]);
});

test('Redis coming back is picked up without a restart', async () => {
    const app = machine(`rl:test-${crypto.randomUUID()}:`, 10);
    redis.status = 'reconnecting';
    assert.strictEqual(await hit(app, '198.51.100.11'), 200);

    const fake = fakeRedis();
    redis.call = fake.call;
    redis.status = 'ready';
    assert.strictEqual(await hit(app, '198.51.100.11'), 200);
    assert.ok(fake.commands.includes('EVALSHA'), 'a limiter that fell back must return to Redis when Redis returns');
});
