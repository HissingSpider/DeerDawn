'use strict';

/**
 * THE NATIVE CREDENTIAL ROUTES ARE OFF WHEN CLERK IS AUTHORITATIVE.
 *
 * They were mounted unguarded in production. POST /auth/signup accepts any
 * email without verifying it, so anybody could pre-create an account (and a
 * workspace they named) for somebody else's address, and the 409 user_exists
 * answered "is this address registered?" for anyone who asked. The security
 * plan said a localAuthEnabled() guard existed; it did not.
 *
 * The guard runs before validation and before any database read, so these
 * drive the real router with no database: a 404 means the gate refused, a 400
 * means the request reached the handler's validation.
 */

process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { localAuthEnabled } = require('../../src/config/localAuth');
const authRouter = require('../../src/routes/shared/auth');

const ROUTES = ['/login', '/signup', '/forgot-password', '/reset-password'];

function app() {
    const a = express();
    a.use(express.json());
    a.use('/auth', authRouter);
    return a;
}

function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) {
        saved[k] = process.env[k];
        if (vars[k] === undefined) delete process.env[k];
        else process.env[k] = vars[k];
    }
    return Promise.resolve().then(fn).finally(() => {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
}

test('the rule: on unless Clerk is authoritative without an explicit local fallback', () => {
    assert.strictEqual(localAuthEnabled({}), true, 'no provider set = local dev / tests');
    assert.strictEqual(localAuthEnabled({ AUTH_PROVIDER: 'local' }), true);
    assert.strictEqual(localAuthEnabled({ AUTH_PROVIDER: 'clerk' }), false, 'production configuration');
    assert.strictEqual(localAuthEnabled({ AUTH_PROVIDER: 'clerk', ALLOW_LOCAL_JWT_FALLBACK: 'true' }), true);
    assert.strictEqual(localAuthEnabled({ AUTH_PROVIDER: 'clerk', ALLOW_LOCAL_JWT_FALLBACK: 'false' }), false);
});

test('clerk-only (production) configuration: every credential route is a 404', async () => {
    await withEnv({ AUTH_PROVIDER: 'clerk', ALLOW_LOCAL_JWT_FALLBACK: undefined }, async () => {
        for (const route of ROUTES) {
            const res = await request(app()).post(`/auth${route}`).send({});
            assert.strictEqual(res.status, 404, `${route} must not be served when Clerk is authoritative`);
        }
        // The enumeration probe the scan used: a well-formed signup for a
        // registered address answered 409 user_exists. It must not reach the
        // handler at all.
        const probe = await request(app()).post('/auth/signup')
            .send({ email: 'someone@example.com', password: 'a-long-enough-password-1' });
        assert.strictEqual(probe.status, 404);
        assert.notStrictEqual(probe.body?.error, 'user_exists');
    });
});

test('local development configuration: the routes are still served', async () => {
    await withEnv({ AUTH_PROVIDER: undefined, ALLOW_LOCAL_JWT_FALLBACK: undefined }, async () => {
        for (const route of ROUTES) {
            const res = await request(app()).post(`/auth${route}`).send({});
            assert.strictEqual(res.status, 400, `${route} must reach its validation in local dev (got ${res.status})`);
        }
    });
});

test('an explicit local fallback re-enables them under Clerk (self-host opt-in)', async () => {
    await withEnv({ AUTH_PROVIDER: 'clerk', ALLOW_LOCAL_JWT_FALLBACK: 'true' }, async () => {
        const res = await request(app()).post('/auth/login').send({});
        assert.strictEqual(res.status, 400);
    });
});

test.after(async () => {
    try { await require('../../src/config/redis').closeRedisConnections?.(); } catch { /* ignore */ }
    try { await require('../../src/config/db').pool.end(); } catch { /* ignore */ }
});
