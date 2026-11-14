'use strict';

/**
 * A REFUND NEVER CHANGES ACCESS. THE SUBSCRIPTION'S STATE IN STRIPE ALONE DECIDES.
 *
 * The owner's decision (2026-09-28). charge.refunded used to drop the workspace
 * to Free, mark it cancelled and forget its subscription id on ANY full refund,
 * without cancelling anything in Stripe:
 *   - refunding the latest invoice left the customer billed again next period
 *     with no access;
 *   - refunding a DUPLICATE charge took paid access from somebody still paying;
 *   - it also wrote lifetime_activated_at, a column only scripts/migrate-ltd.js
 *     created, so on a database without it every full refund answered 500.
 *
 * Each case below delivers a signed charge.refunded to the real app over a real
 * database and then checks two things: the billing row is exactly as it was,
 * and the plan still WORKS — the Team owner can still invite somebody, which is
 * the thing a Team subscription is bought for. Entitlements are checked by use,
 * not by reading a flag.
 *
 * Stripe is stubbed at the SDK edge (the real client object, read methods
 * replaced); nothing is sent to Stripe. Webhooks are signed with the test
 * secret, so the real signature check runs.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r3-billing-refunds.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_refunds_stub_never_sent_anywhere';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_journey_r3_refunds';
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly_refunds';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const stripeService = require('../../src/services/stripeService');
const app = require('../../src/app');
const db = require('../../src/config/db');
const { runAutoMigration } = require('../../src/config/autoMigrate');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

const TEAM = process.env.STRIPE_PRICE_DEVELOPER_PRO;
const TAG = crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, params) => db.query(sql, params, 'org-system');

// ── Stripe, stubbed at the SDK edge ─────────────────────────────────────────
// A refund is not a subscription event and is not supposed to read Stripe; the
// stubs are here so that any read that does happen is answered locally and
// recorded, never sent.
const world = new Map();
const stripeReads = [];
const client = stripeService.stripe;
assert.ok(client, 'the Stripe client must be constructed for this test');
client.subscriptions.retrieve = async (id) => {
    stripeReads.push(id);
    const found = world.get(id);
    if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    return JSON.parse(JSON.stringify(found));
};
client.subscriptions.list = async ({ customer }) => {
    stripeReads.push(customer);
    return { object: 'list', data: [...world.values()].filter((s) => s.customer === customer), has_more: false };
};

function sign(payload) {
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
    return `t=${t},v1=${v1}`;
}

const httpServer = app.listen(0);
const made = { orgs: [], users: [], events: [] };

test.before(async () => {
    await new Promise((r) => (httpServer.listening ? r() : httpServer.once('listening', r)));
    // The four access cases run on a database that HAS the column, so they
    // measure the rule (a refund changes no access) and not the schema. The
    // last case takes it away.
    await q('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lifetime_activated_at TIMESTAMPTZ');
});

test.after(async () => {
    await q('DELETE FROM subscription_events WHERE stripe_event_id = ANY($1::text[])', [made.events]).catch(() => {});
    await q('DELETE FROM stripe_events WHERE event_id = ANY($1::text[])', [made.events]).catch(() => {});
    for (const orgId of made.orgs) {
        await q('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM users WHERE org_id = $1', [orgId]).catch(() => {});
        await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    }
    // Whatever the last case did to the schema, leave it as a boot leaves it.
    await q('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lifetime_activated_at TIMESTAMPTZ').catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
});

const PERIOD_END = new Date('2026-10-28T00:00:00.000Z');

/** A Team workspace, three seats, paying through Stripe — or, with
 *  `subscription: false`, one that records no subscription at all. */
async function teamWorkspace(label, { subscription = true } = {}) {
    const orgId = `org-${uuidv4()}`;
    const customer = `cus_refund_${TAG}_${label}`;
    const subscriptionId = subscription ? `sub_refund_${TAG}_${label}` : null;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats,
                                    stripe_customer_id, stripe_subscription_id, billing_period_end)
         VALUES ($1, $2, 'developer_pro', 'developer_pro', 'active', 3, $3, $4, $5)`,
        [orgId, `refund ${label}`, customer, subscriptionId, PERIOD_END],
    );
    made.orgs.push(orgId);
    if (subscriptionId) {
        const start = Math.floor(Date.now() / 1000) - 86_400;
        world.set(subscriptionId, {
            id: subscriptionId, object: 'subscription', status: 'active', customer, created: start,
            items: { data: [{ id: `si_${subscriptionId}`, quantity: 3, current_period_start: start, current_period_end: start + 30 * 86_400, price: { id: TEAM } }] },
        });
    }
    const userId = `user-${uuidv4()}`;
    const email = `refund-owner-${label}-${TAG}@journey-r3.test`;
    await q(
        'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
        [userId, email, await hashPassword('password123'), 'admin', orgId],
    );
    made.users.push(userId);
    await workspace.ensureOwnerMembership(orgId, userId);
    await invalidateOrgCache(orgId).catch(() => {});
    const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin' });
    return { orgId, customer, subscriptionId, userId, email, jwt };
}

async function billingRow(orgId) {
    const res = await q(
        `SELECT plan, plan_tier, subscription_status, purchased_seats, stripe_subscription_id,
                stripe_customer_id, billing_period_end
           FROM organizations WHERE org_id = $1`,
        [orgId],
    );
    const row = res.rows[0];
    return {
        ...row,
        purchased_seats: row.purchased_seats == null ? null : Number(row.purchased_seats),
        billing_period_end: row.billing_period_end ? new Date(row.billing_period_end).toISOString() : null,
    };
}

async function refund(ws, { amount = 4500, refunded = amount, invoice = `in_${TAG}_latest`, label = 'refund' } = {}) {
    const eventId = `evt_${label}_${TAG}_${made.events.length}`;
    made.events.push(eventId);
    const payload = JSON.stringify({
        id: eventId,
        object: 'event',
        type: 'charge.refunded',
        created: Math.floor(Date.now() / 1000),
        data: {
            object: {
                id: `ch_${label}_${TAG}`,
                object: 'charge',
                customer: ws.customer,
                amount,
                amount_captured: amount,
                amount_refunded: refunded,
                refunded: refunded >= amount,
                invoice,
                currency: 'usd',
                status: 'succeeded',
            },
        },
    });
    const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/v1/webhooks/stripe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
        body: payload,
    });
    const body = await res.json().catch(() => null);
    // The ledger row is written after COMMIT, unawaited.
    await sleep(150);
    return { status: res.status, body, eventId };
}

/** The plan, by use: a Team owner inviting somebody. */
async function invite(ws, n) {
    await invalidateOrgCache(ws.orgId).catch(() => {});
    return request(httpServer)
        .post('/api/v1/teams/invite')
        .set('Authorization', `Bearer ${ws.jwt}`)
        .send({ email: `refund-invitee-${n}-${TAG}@journey-r3.test`, role: 'member' });
}

async function ledgerRows(eventId) {
    const res = await q('SELECT event_type FROM subscription_events WHERE stripe_event_id = $1', [eventId]).catch(() => ({ rows: [] }));
    return res.rows.map((r) => r.event_type);
}

async function assertAccessUnchanged(ws, before, what) {
    const after = await billingRow(ws.orgId);
    assert.deepStrictEqual(after, before, `${what} changed the workspace's billing row`);
    const inv = await invite(ws, `${what.replace(/\W+/g, '-')}`);
    assert.equal(inv.status, 201, `after ${what}, the Team owner could not invite anybody: ${inv.status} ${inv.text}`);
}

test('a full refund of the latest invoice leaves the Team workspace exactly as Stripe bills it', async () => {
    const ws = await teamWorkspace('latest');
    const before = await billingRow(ws.orgId);
    const res = await refund(ws, { label: 'latest' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertAccessUnchanged(ws, before, 'a full refund of the latest invoice');
    // What the revenue ledger booked for a full refund before, it still books.
    assert.deepStrictEqual(await ledgerRows(res.eventId), ['refunded']);
});

test('a full refund of a duplicate charge takes nothing from somebody who is still paying', async () => {
    const ws = await teamWorkspace('duplicate');
    const before = await billingRow(ws.orgId);
    // The same amount charged twice for one period; the second is refunded.
    const res = await refund(ws, { label: 'duplicate', invoice: `in_${TAG}_duplicate` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertAccessUnchanged(ws, before, 'a full refund of a duplicate charge');
});

test('a partial refund changes nothing and books nothing (guard)', async () => {
    const ws = await teamWorkspace('partial');
    const before = await billingRow(ws.orgId);
    const res = await refund(ws, { label: 'partial', amount: 4500, refunded: 1500 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertAccessUnchanged(ws, before, 'a partial refund');
    assert.deepStrictEqual(await ledgerRows(res.eventId), []);
});

test('a full refund on a workspace that records no subscription changes nothing', async () => {
    const ws = await teamWorkspace('nosub', { subscription: false });
    const before = await billingRow(ws.orgId);
    assert.equal(before.stripe_subscription_id, null);
    const res = await refund(ws, { label: 'nosub' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertAccessUnchanged(ws, before, 'a full refund with no subscription recorded');
});

test('a full refund answers 200 on a database without lifetime_activated_at, and the boot migration adds the column', async () => {
    await q('ALTER TABLE organizations DROP COLUMN IF EXISTS lifetime_activated_at');
    const ws = await teamWorkspace('nocolumn');
    const before = await billingRow(ws.orgId);
    const res = await refund(ws, { label: 'nocolumn' });
    assert.equal(res.status, 200, `a refund failed on a column DeerDawn's own schema lacked: ${res.status} ${JSON.stringify(res.body)}`);
    await assertAccessUnchanged(ws, before, 'a full refund before the boot migration');

    // The boot migration now owns the column: nullable, a timestamp, and a
    // second boot leaves it as it is.
    await runAutoMigration();
    const column = async () => (await q(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'organizations' AND column_name = 'lifetime_activated_at'`,
    )).rows[0] || null;
    assert.deepStrictEqual(await column(), { data_type: 'timestamp with time zone', is_nullable: 'YES' },
        'the boot migration did not add lifetime_activated_at');
    await runAutoMigration();
    assert.deepStrictEqual(await column(), { data_type: 'timestamp with time zone', is_nullable: 'YES' });
});

test('no refund read Stripe (guard)', () => {
    assert.deepStrictEqual(stripeReads, [], `a refund read Stripe: ${stripeReads.join(', ')}`);
});
