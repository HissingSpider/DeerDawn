'use strict';

/**
 * A SIGNUP THAT syncUser PROVISIONED FIRST IS STILL A SIGNUP.
 *
 * The other half of signup-provisioning-race.test.js. When the dashboard's
 * first request wins, the Clerk `user.created` webhook finds the row and used
 * to return `duplicate: true` on the spot — so the account never got its
 * starter sandbox key or its one-time onboarding display, and the
 * authoritative account_created (with signup_method and the +clerk_test
 * marker) was never recorded: every signup that lost the race was missing
 * from the signup count.
 *
 * Drives the real route against a fake pool. The once-per-account work must
 * happen exactly once whichever path created the row, across Clerk retries
 * and concurrent deliveries.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
process.env.DISABLE_REDIS = 'true';
process.env.CLERK_WEBHOOK_SECRET = 'whsec_dGVzdC1zaWdudXAtZmluaXNo';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

// Signature checking is not what this file is about.
const { Webhook } = require('svix');
Webhook.prototype.verify = function verify(payload) { return JSON.parse(payload); };

const db = require('../../src/config/db');
db.query = async () => ({ rows: [] });

const { redis } = require('../../src/config/redis');
let redisStore = new Map();
redis.get = async (k) => (redisStore.has(k) ? redisStore.get(k) : null);
redis.setex = async (k, _ttl, v) => { redisStore.set(k, v); return 'OK'; };
redis.set = async (k, v) => { redisStore.set(k, v); return 'OK'; };

// The route destructures this at require time, so it is replaced first.
const productEvents = require('../../src/services/productEventsService');
let events = [];
productEvents.recordProductEvent = async (actor, input) => {
    events.push({ user_id: actor.id, org_id: actor.org_id, event_name: input.event_name, metadata: input.metadata });
    return input;
};

const workspace = require('../../src/services/workspaceService');
workspace.ensureOwnerMembership = async () => {};

const router = require('../../src/routes/auth-webhooks');
const app = express();
app.use('/', router);

// --- fake database --------------------------------------------------------

let state;
const locks = new Map(); // advisory lock key -> promise released at COMMIT/ROLLBACK

function resetState() {
    state = { users: [], orgs: [], keys: [] };
    events = [];
    redisStore = new Map();
    locks.clear();
}

db.pool.connect = async () => {
    const held = [];
    const releaseHeld = () => { held.splice(0).forEach((release) => release()); };
    return {
        release() {},
        async query(text, params = []) {
            const sql = text.trim();
            if (sql === 'BEGIN') return { rows: [] };
            if (sql === 'COMMIT' || sql === 'ROLLBACK') { releaseHeld(); return { rows: [] }; }
            if (sql.startsWith('SELECT user_id, org_id, created_at FROM users')) {
                return { rows: state.users.filter((u) => u.auth_provider === params[0] && u.auth_subject === params[1]).slice(0, 1) };
            }
            if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
                const key = params[0];
                while (locks.has(key)) await locks.get(key);
                let release;
                locks.set(key, new Promise((r) => { release = () => { locks.delete(key); r(); }; }));
                held.push(release);
                return { rows: [{}] };
            }
            if (sql.startsWith('SELECT 1 FROM api_keys')) {
                const [userId, name] = params;
                const hasKey = state.keys.some((k) => k.owner_id === userId && k.name === name);
                const hasEvent = events.some((e) => e.user_id === userId && e.event_name === 'account_created');
                return { rows: hasKey || hasEvent ? [{}] : [] };
            }
            if (sql.startsWith('INSERT INTO organizations')) {
                state.orgs.push({ org_id: params[0] });
                return { rows: [] };
            }
            if (sql.startsWith('INSERT INTO users')) {
                state.users.push({ user_id: params[0], org_id: params[3], auth_provider: params[4], auth_subject: params[5], created_at: new Date() });
                return { rows: [] };
            }
            if (sql.startsWith('INSERT INTO api_keys')) {
                // Let a concurrent delivery run between the claim and the write.
                await new Promise((r) => setImmediate(r));
                state.keys.push({ key_id: params[0], name: params[3], owner_id: params[4], org_id: params[5] });
                return { rows: [] };
            }
            throw new Error(`unexpected query: ${sql}`);
        },
    };
};

// --- helpers -------------------------------------------------------------

const CLERK_ID = 'user_clerk_race';
const EMAIL = 'new@example.test';

function jitProvision({ createdAt = new Date() } = {}) {
    // What syncUser leaves behind when it wins: a user and org, nothing else.
    state.orgs.push({ org_id: 'org-jit' });
    state.users.push({ user_id: 'user-jit', org_id: 'org-jit', auth_provider: 'clerk', auth_subject: CLERK_ID, created_at: createdAt });
}

function deliver(svixId, { email = EMAIL, externalAccounts = [] } = {}) {
    const body = {
        type: 'user.created',
        data: {
            id: CLERK_ID,
            primary_email_address_id: 'idn_1',
            email_addresses: [{ id: 'idn_1', email_address: email }],
            first_name: 'New',
            last_name: 'Person',
            external_accounts: externalAccounts,
        },
    };
    return request(app)
        .post('/clerk')
        .set('content-type', 'application/json')
        .set('svix-id', svixId)
        .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
        .set('svix-signature', 'v1,test')
        .send(JSON.stringify(body));
}

const named = (name) => events.filter((e) => e.event_name === name);

// --- tests ---------------------------------------------------------------

test('a row syncUser created still gets its starter key and account_created', async () => {
    resetState();
    jitProvision();

    const res = await deliver('msg_1', { externalAccounts: [{ provider: 'oauth_google' }] });
    assert.strictEqual(res.status, 200);
    assert.notStrictEqual(res.body.duplicate, true, 'the skipped signup work was reported as a duplicate');

    assert.strictEqual(state.keys.length, 1);
    assert.strictEqual(state.keys[0].name, 'Default Sandbox Key');
    assert.strictEqual(state.keys[0].owner_id, 'user-jit');
    assert.strictEqual(state.keys[0].org_id, 'org-jit');
    assert.ok(redisStore.get('onboarding:user-jit:api_key'), 'the onboarding key was not stored for one-time display');

    const [created] = named('account_created');
    assert.ok(created, 'account_created was never recorded for a signup that lost the race');
    assert.strictEqual(created.user_id, 'user-jit');
    assert.strictEqual(created.org_id, 'org-jit');
    assert.strictEqual(created.metadata.signup_method, 'google');
    assert.strictEqual(created.metadata.is_test, false);
    assert.strictEqual(named('signup_completed').length, 1);

    // No second account was minted alongside the JIT one.
    assert.strictEqual(state.users.length, 1);
    assert.strictEqual(state.orgs.length, 1);
});

test('the +clerk_test marker survives the late path', async () => {
    resetState();
    jitProvision();
    await deliver('msg_t', { email: 'journey+clerk_test@example.test' });
    assert.strictEqual(named('account_created')[0].metadata.is_test, true);
});

test('a Clerk retry of the delivery that finished the signup does nothing', async () => {
    resetState();
    jitProvision();
    await deliver('msg_1');
    // Clerk retries with the same svix-id; also cover the replay cache being
    // gone (Redis restarted, or TTL expired) so the database claim is tested.
    redisStore.clear();
    const res = await deliver('msg_1');

    assert.strictEqual(res.body.duplicate, true);
    assert.strictEqual(state.keys.length, 1);
    assert.strictEqual(named('account_created').length, 1);
    assert.strictEqual(named('signup_completed').length, 1);
});

test('a retry of the delivery that CREATED the account does not emit again', async () => {
    resetState();
    const first = await deliver('msg_c');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(state.users.length, 1);
    assert.strictEqual(named('account_created').length, 1);

    redisStore.clear();
    const retry = await deliver('msg_c');
    assert.strictEqual(retry.body.duplicate, true);
    assert.strictEqual(state.keys.length, 1);
    assert.strictEqual(named('account_created').length, 1);
});

test('two deliveries at once finish the signup once', async () => {
    resetState();
    jitProvision();
    const [a, b] = await Promise.all([deliver('msg_a'), deliver('msg_b')]);

    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(state.keys.length, 1, 'both deliveries claimed the signup');
    assert.strictEqual(named('account_created').length, 1);
    assert.strictEqual([a, b].filter((r) => r.body.duplicate === true).length, 1);
});

test('a key revoked or removed later does not bring the signup events back', async () => {
    resetState();
    jitProvision();
    await deliver('msg_1');
    state.keys = [];
    redisStore.clear();

    const res = await deliver('msg_late');
    assert.strictEqual(res.body.duplicate, true);
    assert.strictEqual(state.keys.length, 0);
    assert.strictEqual(named('account_created').length, 1);
});

test('an old row adopted by email is not counted as a new signup', async () => {
    // syncUser also binds a Clerk identity to a long-standing local account by
    // email. That is a migration, not a signup.
    resetState();
    jitProvision({ createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) });

    const res = await deliver('msg_old');
    assert.strictEqual(res.body.duplicate, true);
    assert.strictEqual(state.keys.length, 0);
    assert.strictEqual(events.length, 0);
});
