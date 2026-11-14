'use strict';

/**
 * AN EMAIL CHANGE IN CLERK HAS TO REACH `users.email`, AND A REPLAY HAS TO BE
 * RECOGNISED AS ONE.
 *
 * Three defects, all invisible from the outside because the endpoint answered
 * 200 to everything:
 *
 *   1. `user.updated` was not handled at all, so `users.email` was written once
 *      at signup and never again.
 *   2. The replay cache keyed on `evt.id`. A Clerk event body has no top-level
 *      id, so the key was always null and the cache never stored or refused a
 *      single delivery. The message identity is the `svix-id` header.
 *   3. `users.email` is UNIQUE. A change onto an address another account holds
 *      must neither 500 (Clerk retries a permanent failure for days) nor merge
 *      the two accounts.
 *
 * Behavioural on purpose: real signed deliveries against a real database, and
 * the assertions read the rows back. The suite this replaces the gaps in
 * matched the route's source text and passed throughout.
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/clerk-user-updated.test.js
 */

process.env.DISABLE_REDIS = 'true';
process.env.CLERK_WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { Webhook } = require('svix');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');

// Collisions are reported to a human; capture instead of shipping to Sentry.
const reports = [];
const reportSwallowedModule = require('../../src/utils/reportSwallowed');
reportSwallowedModule.reportSwallowed = (error, meta = {}) => {
    reports.push({ message: error?.message, ...meta });
};

const webhookRouter = require('../../src/routes/auth-webhooks');

function app() {
    const a = express();
    a.use('/webhooks', webhookRouter);
    return a;
}

function deliver(body, { msgId = `msg_${uuidv4()}` } = {}) {
    // Shaped like a real Clerk event: NO top-level `id`. The old cache key was
    // built from one, and the older tests put one in the fixture, which is how
    // a key that is always null in production looked populated under test.
    const payload = JSON.stringify({ object: 'event', instance_id: 'ins_test', timestamp: Date.now(), ...body });
    const timestamp = new Date();
    const signature = new Webhook(process.env.CLERK_WEBHOOK_SECRET).sign(msgId, timestamp, payload);
    return request(app())
        .post('/webhooks/clerk')
        .set('content-type', 'application/json')
        .set('svix-id', msgId)
        .set('svix-timestamp', String(Math.floor(timestamp.getTime() / 1000)))
        .set('svix-signature', signature)
        .send(payload);
}

function userUpdated(subject, addresses, primaryId) {
    return {
        type: 'user.updated',
        data: {
            id: subject,
            primary_email_address_id: primaryId,
            email_addresses: addresses.map(([id, email]) => ({ id, email_address: email })),
        },
    };
}

async function seedUser(t, email) {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const subject = `user_upd_${uuidv4()}`;
    t.after(async () => {
        await db.query('DELETE FROM users WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
        await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    });
    await db.query(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
         VALUES ($1, 'user.updated', 'pro', 'pro', 'active', 'organization')`,
        [orgId], 'org-system'
    );
    await db.query(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject)
         VALUES ($1, $2, 'owner', $3, 'clerk', $4)`,
        [userId, email, orgId, subject], 'org-system'
    );
    return { orgId, userId, subject };
}

async function readUser(userId) {
    const res = await db.query('SELECT email, org_id, auth_subject FROM users WHERE user_id = $1', [userId], 'org-system');
    return res.rows[0] || null;
}

after(async () => {
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('user.updated writes the new PRIMARY address, which is not the first in the list', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'clerk user.updated'))) return;
    const tag = uuidv4();
    const oldEmail = `old-${tag}@updated.test`;
    const newEmail = `new-${tag}@updated.test`;
    const person = await seedUser(t, oldEmail);

    // The old address is still on the account, and still FIRST: Clerk lists
    // addresses in the order they were added.
    const res = await deliver(userUpdated(person.subject, [['idn_old', oldEmail], ['idn_new', newEmail]], 'idn_new'));

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await readUser(person.userId)).email, newEmail, 'users.email must follow the primary address');
});

test('a change onto an address another account holds is acknowledged, reported, and merges nothing', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'clerk user.updated'))) return;
    const tag = uuidv4();
    const mover = await seedUser(t, `mover-${tag}@updated.test`);
    const holderEmail = `holder-${tag}@updated.test`;
    const holder = await seedUser(t, holderEmail);
    reports.length = 0;

    const res = await deliver(userUpdated(mover.subject, [['idn_a', `mover-${tag}@updated.test`], ['idn_b', holderEmail]], 'idn_b'));

    // 200, not 500: the collision is permanent, so a retry can never succeed
    // and Clerk would redeliver it for days.
    assert.strictEqual(res.status, 200, `a permanent collision must not ask Clerk to retry (got ${res.status})`);
    assert.strictEqual(res.body.skipped, 'email_in_use');

    const moverRow = await readUser(mover.userId);
    const holderRow = await readUser(holder.userId);
    assert.strictEqual(moverRow.email, `mover-${tag}@updated.test`, 'the mover keeps their stored address');
    assert.strictEqual(holderRow.email, holderEmail, 'the holder keeps theirs');
    assert.strictEqual(holderRow.auth_subject, holder.subject, 'the holder must not be re-pointed at the mover identity');
    assert.strictEqual(holderRow.org_id, holder.orgId, 'and must keep their own workspace');
    assert.strictEqual(moverRow.org_id, mover.orgId);

    assert.ok(
        reports.some((r) => r.op === 'clerk_user_updated_email_collision'),
        'a collision has to reach a person, not just a log line'
    );
    assert.ok(
        !JSON.stringify(reports).includes(holderEmail),
        'the report identifies the account by Clerk subject, not by putting an email address in it'
    );
});

test('the same address in a different case is the same mailbox, not a free one', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'clerk user.updated'))) return;
    const tag = uuidv4();
    const mover = await seedUser(t, `mover-${tag}@updated.test`);
    await seedUser(t, `holder-${tag}@updated.test`);

    const res = await deliver(userUpdated(mover.subject, [['idn_b', `HOLDER-${tag}@updated.test`]], 'idn_b'));

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await readUser(mover.userId)).email, `mover-${tag}@updated.test`);
});

test('a redelivery of the SAME svix-id is refused; a different svix-id with the same body is not', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'clerk user.updated'))) return;
    const tag = uuidv4();
    const first = `first-${tag}@updated.test`;
    const second = `second-${tag}@updated.test`;
    const person = await seedUser(t, first);
    const event = userUpdated(person.subject, [['idn_1', first], ['idn_2', second]], 'idn_2');

    const msgId = `msg_${uuidv4()}`;
    const original = await deliver(event, { msgId });
    assert.strictEqual(original.body.updated, true);

    // Something else moves the row on (support, a later event). A replay of the
    // OLD message must not drag it back.
    await db.query('UPDATE users SET email = $1 WHERE user_id = $2', [first, person.userId], 'org-system');

    const replay = await deliver(event, { msgId });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.body.duplicate, true, 'the same svix-id is the same message');
    assert.strictEqual((await readUser(person.userId)).email, first, 'a replay must not be applied a second time');

    // Same bytes, new message id: a distinct event, and it IS applied. A body
    // hash would have refused this one.
    const distinct = await deliver(event);
    assert.notStrictEqual(distinct.body.duplicate, true);
    assert.strictEqual((await readUser(person.userId)).email, second);
});

test('user.updated with no resolvable primary address leaves the stored one alone', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'clerk user.updated'))) return;
    const tag = uuidv4();
    const stored = `stored-${tag}@updated.test`;
    const person = await seedUser(t, stored);

    // The pointer names an id that is not in the list.
    const res = await deliver(userUpdated(person.subject, [['idn_x', `guess-${tag}@updated.test`]], 'idn_missing'));

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await readUser(person.userId)).email, stored, 'never overwrite a stored address with a guess');
});

// ── the Stripe customer follows the address (scan 19) ───────────────────────
//
// The customer was created with the checking-out person's email and never
// touched again, so after a Clerk email change receipts and dunning mail kept
// going to the old address. A fake client stands in for Stripe.

function fakeStripe(customers, { failUpdate = false } = {}) {
    const calls = { retrieved: [], updated: [] };
    return {
        calls,
        customers: {
            retrieve: async (id) => { calls.retrieved.push(id); return customers[id] || { id, deleted: true }; },
            update: async (id, body) => {
                if (failUpdate) throw Object.assign(new Error('stripe down'), { code: 'api_connection_error' });
                calls.updated.push([id, body]);
                return { id, ...body };
            },
        },
    };
}

async function withStripe(client, fn) {
    const stripeService = require('../../src/services/stripeService');
    const real = stripeService.stripe;
    stripeService.stripe = client;
    try { return await fn(); } finally { stripeService.stripe = real; }
}

test('an email change updates the Stripe customer the person is billed under', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'clerk user.updated'))) return;
    const tag = uuidv4();
    const oldEmail = `billed-${tag}@updated.test`;
    const newEmail = `billed-new-${tag}@updated.test`;
    const person = await seedUser(t, oldEmail);
    const customerId = `cus_${tag.slice(0, 12)}`;
    await db.query('UPDATE organizations SET stripe_customer_id = $1 WHERE org_id = $2', [customerId, person.orgId], 'org-system');

    const stripe = fakeStripe({ [customerId]: { id: customerId, email: oldEmail } });
    const res = await withStripe(stripe, () => deliver(userUpdated(person.subject, [['idn_new', newEmail]], 'idn_new')));

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await readUser(person.userId)).email, newEmail);
    assert.deepStrictEqual(stripe.calls.updated, [[customerId, { email: newEmail }]],
        'receipts and dunning mail go to the Stripe customer\'s address, which must follow the change');
});

test('a Stripe customer billed to SOMEBODY ELSE\'S address is left alone', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'clerk user.updated'))) return;
    const tag = uuidv4();
    const person = await seedUser(t, `owner2-${tag}@updated.test`);
    const customerId = `cus_${tag.slice(0, 12)}`;
    await db.query('UPDATE organizations SET stripe_customer_id = $1 WHERE org_id = $2', [customerId, person.orgId], 'org-system');

    const stripe = fakeStripe({ [customerId]: { id: customerId, email: `finance-${tag}@updated.test` } });
    const res = await withStripe(stripe, () => deliver(userUpdated(person.subject, [['idn_new', `owner2-new-${tag}@updated.test`]], 'idn_new')));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(stripe.calls.updated, [], 'a co-owner\'s or finance address is not this person\'s to change');
});

test('a Stripe failure never fails the webhook; it is reported', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'clerk user.updated'))) return;
    const tag = uuidv4();
    const oldEmail = `flaky-${tag}@updated.test`;
    const newEmail = `flaky-new-${tag}@updated.test`;
    const person = await seedUser(t, oldEmail);
    const customerId = `cus_${tag.slice(0, 12)}`;
    await db.query('UPDATE organizations SET stripe_customer_id = $1 WHERE org_id = $2', [customerId, person.orgId], 'org-system');

    reports.length = 0;
    const stripe = fakeStripe({ [customerId]: { id: customerId, email: oldEmail } }, { failUpdate: true });
    const res = await withStripe(stripe, () => deliver(userUpdated(person.subject, [['idn_new', newEmail]], 'idn_new')));

    assert.strictEqual(res.status, 200, 'Clerk retries a failed delivery for days; a Stripe blip must not cause that');
    assert.strictEqual((await readUser(person.userId)).email, newEmail, 'the users row still moves');
    assert.ok(reports.some((r) => r.op === 'clerk_user_updated_stripe_email_failed'), 'and the miss reaches a human');
});
