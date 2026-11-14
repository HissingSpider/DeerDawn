'use strict';

/**
 * JOURNEY SCAN ROUND 6, BILLING: the owner's four decisions, driven through the
 * real app over a real database.
 *
 * 1. BILLING TAKEOVER (docs/audits/journey-r3-billing-takeover-design.md). The
 *    person who pays may not leave, step down from their last owner seat, be
 *    removed or delete their account while a live subscription renews on their
 *    card, until a remaining owner has taken over billing. They may always free
 *    themselves by setting the subscription to end at the period's end. A
 *    workspace whose billing owner is not on record refuses nobody (an owner
 *    whose email is the Stripe customer's is recognised as the payer).
 * 2. SEATS BELOW HEADCOUNT: more active members than paid seats is reported to
 *    the owner (the team page, the plan page, one email per episode); nobody is
 *    suspended.
 * 3. A PENDING CANCELLATION and the REAL PRICE are recorded from the webhook's
 *    one Stripe read, and the plan page returns them.
 * 4. AN OVERDUE PAYMENT (Stripe: past_due, unpaid, incomplete) emails the owner,
 *    once per overdue episode, with how to fix it.
 *
 * Stripe is stubbed at the SDK edge (the real client object, its methods
 * replaced); nothing is sent to Stripe. Email is captured; nothing is sent.
 * Webhooks are signed with the test secret, so the real signature check runs.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r6-billing.test.js
 */

if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_journey_r6_billing_stub_never_sent_anywhere';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_journey_r6_billing';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = process.env.STRIPE_PRICE_DEVELOPER_BASIC || 'price_pro_monthly_r6';
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly_r6';
delete process.env.RESEND_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const resendClient = require('../../src/services/email/resendClient');
const sentEmails = [];
resendClient.sendEmail = async (mail) => { sentEmails.push(mail); return { ok: true, id: 'captured' }; };

const stripeService = require('../../src/services/stripeService');
const app = require('../../src/app');
const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

const TEAM = process.env.STRIPE_PRICE_DEVELOPER_PRO;
const TAG = crypto.randomBytes(4).toString('hex');
const DAY = 86_400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, params) => db.query(sql, params, 'org-system');
const nowS = () => Math.floor(Date.now() / 1000);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── Stripe, stubbed at the SDK edge ─────────────────────────────────────────
const world = new Map(); // subscription id -> subscription
const customers = new Map(); // customer id -> customer
const client = stripeService.stripe;
assert.ok(client, 'the Stripe client must be constructed for this test');
const stripeCalls = []; // every call the stub answered, in order
const heldDuringRead = []; // connections checked out of the pool while Stripe was being read
let stripeDown = null; // a function returning the error every read throws, or null
const gone = (what, id) => Object.assign(new Error(`No such ${what}: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
const heldNow = () => db.pool.totalCount - db.pool.idleCount;
client.subscriptions.retrieve = async (id) => {
    stripeCalls.push(`subscriptions.retrieve ${id}`);
    heldDuringRead.push(heldNow());
    if (stripeDown) throw stripeDown();
    const found = world.get(id);
    if (!found) throw gone('subscription', id);
    return clone(found);
};
client.subscriptions.list = async ({ customer }) => {
    stripeCalls.push(`subscriptions.list ${customer}`);
    heldDuringRead.push(heldNow());
    if (stripeDown) throw stripeDown();
    return { object: 'list', data: [...world.values()].filter((s) => s.customer === customer).map(clone), has_more: false };
};
client.customers.retrieve = async (id) => {
    stripeCalls.push(`customers.retrieve ${id}`);
    heldDuringRead.push(heldNow());
    if (stripeDown) throw stripeDown();
    const found = customers.get(id);
    if (!found) throw gone('customer', id);
    return clone(found);
};
const updates = [];
client.subscriptions.update = async (id, params) => {
    stripeCalls.push(`subscriptions.update ${id}`);
    updates.push({ id, params: clone(params) });
    const found = world.get(id);
    if (!found) throw gone('subscription', id);
    if (params.cancel_at_period_end !== undefined) found.cancel_at_period_end = params.cancel_at_period_end;
    return clone(found);
};
const cancelledInStripe = [];
client.subscriptions.cancel = async (id) => {
    cancelledInStripe.push(id);
    const found = world.get(id);
    if (!found) throw gone('subscription', id);
    found.status = 'canceled';
    return clone(found);
};
const portalSessions = [];
client.billingPortal.sessions.create = async (params) => {
    portalSessions.push(clone(params));
    return { id: `bps_r6_${TAG}_${portalSessions.length}`, url: 'https://billing.stripe.com/p/session/stub' };
};
client.checkout.sessions.create = async () => { throw new Error('no checkout is expected in this file'); };

function sign(payload) {
    const t = nowS();
    const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
    return `t=${t},v1=${v1}`;
}

const httpServer = app.listen(0);
const made = { orgs: [], users: [], events: [] };

test.before(async () => {
    await new Promise((r) => (httpServer.listening ? r() : httpServer.once('listening', r)));
    // The context_* tables are created on first use; an account deletion erases
    // them, so they must exist.
    await require('../../src/store/contextSyncStore').ensureSchema();
});

test.after(async () => {
    await q('DELETE FROM subscription_events WHERE org_id = ANY($1::text[])', [made.orgs]).catch(() => {});
    await q('DELETE FROM stripe_events WHERE event_id = ANY($1::text[])', [made.events]).catch(() => {});
    await q('DELETE FROM billing_alert_sends WHERE alert_key LIKE $1', [`%${TAG}%`]).catch(() => {});
    for (const orgId of made.orgs) {
        await q('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM users WHERE org_id = $1', [orgId]).catch(() => {});
        await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    }
    await q('DELETE FROM workspace_members WHERE user_id = ANY($1::text[])', [made.users]).catch(() => {});
    await new Promise((resolve) => httpServer.close(resolve));
});

// ── people and workspaces ───────────────────────────────────────────────────

async function makePerson(label) {
    const orgId = `org-${uuidv4()}`;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
         VALUES ($1, $2, 'free', 'free', 'active', 'organization')`,
        [orgId, `r6 ${label} personal`],
    );
    made.orgs.push(orgId);
    const userId = `user-${uuidv4()}`;
    const email = `r6-${label}-${TAG}@journey-r6.test`;
    await q(
        'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
        [userId, email, await hashPassword('password123'), 'admin', orgId],
    );
    made.users.push(userId);
    await workspace.ensureOwnerMembership(orgId, userId);
    const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
    return { label, orgId, userId, email, jwt };
}

function subscription(id, customer, { status = 'active', price = TEAM, seats = 2, pm = 'pm_old', unitAmount = 1500, interval = 'month', start = nowS() - DAY } = {}) {
    return {
        id, object: 'subscription', status, customer, created: start, metadata: {}, schedule: null,
        cancel_at_period_end: false, cancel_at: null, default_payment_method: pm,
        items: {
            data: [{
                id: `si_${id}`, quantity: seats, current_period_start: start, current_period_end: start + 30 * DAY,
                price: { id: price, unit_amount: unitAmount, currency: 'usd', recurring: { interval, interval_count: 1 } },
            }],
        },
    };
}

/**
 * A paid Team workspace. `people` are its members, first the owners: each is
 * added to the roster with the role given. `payer` is recorded as the billing
 * owner unless it is null; `customerEmail` is the Stripe customer's email.
 */
async function teamFor(label, people, { payer = null, seats = null, customerEmail = null, customerPm = 'pm_old' } = {}) {
    const orgId = `org-${uuidv4()}`;
    const customer = `cus_r6_${TAG}_${label}`;
    const subscriptionId = `sub_r6_${TAG}_${label}`;
    const start = nowS() - DAY;
    const seatCount = seats ?? Math.max(2, people.length);
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats,
                                    stripe_customer_id, stripe_subscription_id, billing_period_start, billing_period_end, account_type)
         VALUES ($1, $2, 'developer_pro', 'developer_pro', 'active', $3, $4, $5, to_timestamp($6), to_timestamp($7), 'organization')`,
        [orgId, `r6 ${label}`, seatCount, customer, subscriptionId, start, start + 30 * DAY],
    );
    made.orgs.push(orgId);
    for (const { person, role } of people) {
        await q(
            `INSERT INTO workspace_members (owner_key, user_id, role) VALUES ($1, $2, $3)
             ON CONFLICT (owner_key, user_id) DO UPDATE SET role = EXCLUDED.role, removed_at = NULL`,
            [orgId, person.userId, role],
        );
    }
    world.set(subscriptionId, subscription(subscriptionId, customer, { seats: seatCount }));
    customers.set(customer, {
        id: customer, object: 'customer', email: customerEmail, default_source: null,
        invoice_settings: { default_payment_method: customerPm },
    });
    if (payer) await q('UPDATE organizations SET billing_owner_user_id = $2 WHERE org_id = $1', [orgId, payer.userId]);
    await invalidateOrgCache(orgId).catch(() => {});
    return { label, orgId, customer, subscriptionId };
}

function as(method, path, person, ws = null) {
    let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
    if (ws) r = r.set('x-deerdawn-workspace', ws.orgId);
    return r;
}

async function roleOf(ws, person) {
    const res = await q('SELECT role, removed_at FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [ws.orgId, person.userId]);
    return res.rows[0] ? { role: res.rows[0].role, removed: Boolean(res.rows[0].removed_at) } : null;
}

async function orgRow(ws) {
    const res = await q('SELECT * FROM organizations WHERE org_id = $1', [ws.orgId]);
    return res.rows[0];
}

// ── webhooks ────────────────────────────────────────────────────────────────

let eventSeq = 0;
const eventId = (kind) => `evt_r6_${kind}_${TAG}_${(eventSeq += 1)}`;
async function deliver(event) {
    made.events.push(event.id);
    const payload = JSON.stringify(event);
    const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/v1/webhooks/stripe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
        body: payload,
    });
    const body = await res.json().catch(() => null);
    await sleep(250); // the ledger, the owner's alerts and the notices are after COMMIT, unawaited
    return { status: res.status, body };
}

/** The subscription in Stripe as it is now; the update event that reports it arrives. */
async function updateEvent(ws, { previous = { status: 'active' } } = {}) {
    const sub = world.get(ws.subscriptionId);
    return deliver({
        id: eventId('upd'), object: 'event', type: 'customer.subscription.updated', created: nowS(),
        data: { object: clone(sub), previous_attributes: previous },
    });
}

function failedInvoice(ws, { attempt = 1 } = {}) {
    return deliver({
        id: eventId('inv'), object: 'event', type: 'invoice.payment_failed', created: nowS(),
        data: {
            object: {
                id: `in_${eventId('obj')}`, object: 'invoice', customer: ws.customer, subscription: ws.subscriptionId,
                billing_reason: 'subscription_cycle', amount_due: 3000, attempt_count: attempt,
                next_payment_attempt: nowS() + 3 * DAY, hosted_invoice_url: null,
            },
        },
    });
}

const emailsTo = (address, type) => sentEmails.filter((m) => m.to === address && (!type || m.emailType === type));

// ═══════════════════════════════════════════════════════════════════════════
// 1. BILLING TAKEOVER
// ═══════════════════════════════════════════════════════════════════════════

test('decision 1: the payer cannot leave while the subscription renews; the refusal changes nothing', async () => {
    const [payer, other] = [await makePerson('payer-leave'), await makePerson('other-leave')];
    const ws = await teamFor('leave', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });

    const left = await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws);
    assert.equal(left.status, 409, `THE BUG: the payer left while their card still renews the subscription: ${left.status} ${JSON.stringify(left.body)}`);
    assert.equal(left.body.error, 'billing_owner');
    assert.match(left.body.message, /take over billing|end at the (end|close) of the (paid )?period/i, 'the refusal names the two ways out');
    assert.deepEqual(await roleOf(ws, payer), { role: 'owner', removed: false }, 'a refusal must change nothing');
});

test('decision 1: stepping down from the last owner seat is refused too, and demotion BY ANOTHER owner is not', async () => {
    const [payer, other] = [await makePerson('payer-step'), await makePerson('other-step')];
    const ws = await teamFor('step', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });

    const stepDown = await as('patch', `/api/v1/teams/members/${payer.userId}`, payer, ws).send({ role: 'member' });
    assert.equal(stepDown.status, 409, `stepping down: ${stepDown.status} ${JSON.stringify(stepDown.body)}`);
    assert.equal(stepDown.body.error, 'billing_owner');
    assert.equal((await roleOf(ws, payer)).role, 'owner');

    // Another owner demoting the payer is not gated: the payer keeps both ways out.
    const demoted = await as('patch', `/api/v1/teams/members/${payer.userId}`, other, ws).send({ role: 'member' });
    assert.equal(demoted.status, 200, `demotion by another owner: ${demoted.status} ${JSON.stringify(demoted.body)}`);
    assert.equal((await roleOf(ws, payer)).role, 'member');
});

test('decision 1: removing the payer is refused, and the refusal is addressed to the owner removing them', async () => {
    const [payer, other] = [await makePerson('payer-rm'), await makePerson('other-rm')];
    const ws = await teamFor('rm', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });

    const removed = await as('delete', `/api/v1/teams/members/${payer.userId}`, other, ws);
    assert.equal(removed.status, 409, `removal: ${removed.status} ${JSON.stringify(removed.body)}`);
    assert.equal(removed.body.error, 'billing_owner');
    assert.match(removed.body.message, /take over billing|end at the (end|close) of the (paid )?period/i);
    assert.match(removed.body.message, /they|their|pays/i, 'addressed to the owner removing them, not to the payer');
    assert.deepEqual(await roleOf(ws, payer), { role: 'owner', removed: false });
});

test('decision 1: somebody who is not the payer leaves freely', async () => {
    const [payer, other] = [await makePerson('payer-free'), await makePerson('other-free')];
    const ws = await teamFor('free', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });
    const left = await as('delete', `/api/v1/teams/members/${other.userId}`, other, ws);
    assert.equal(left.status, 200, `a non-payer was refused: ${left.status} ${JSON.stringify(left.body)}`);
    assert.equal((await roleOf(ws, other)).removed, true);
});

test('decision 1: a workspace whose billing owner is unknown refuses nobody, when the Stripe customer\'s email matches no owner', async () => {
    const [a, b] = [await makePerson('unk-a'), await makePerson('unk-b')];
    const ws = await teamFor('unknown', [{ person: a, role: 'owner' }, { person: b, role: 'owner' }], { payer: null, customerEmail: 'somebody.else@nowhere.test' });
    const left = await as('delete', `/api/v1/teams/members/${a.userId}`, a, ws);
    assert.equal(left.status, 200, `an unknown billing owner refused somebody: ${left.status} ${JSON.stringify(left.body)}`);
    assert.equal((await orgRow(ws)).billing_owner_user_id, null, 'nothing is recorded from a customer email that matches nobody');
});

test('decision 1: an existing workspace\'s billing owner is filled in from the Stripe customer\'s email, and then holds', async () => {
    const [a, b] = [await makePerson('fill-a'), await makePerson('fill-b')];
    // The email differs in case only: an exact match on the address, not on its spelling.
    const ws = await teamFor('fill', [{ person: a, role: 'owner' }, { person: b, role: 'owner' }], { payer: null, customerEmail: a.email.toUpperCase() });
    const left = await as('delete', `/api/v1/teams/members/${a.userId}`, a, ws);
    assert.equal(left.status, 409, `THE BUG: the customer's own email did not identify the payer: ${left.status} ${JSON.stringify(left.body)}`);
    assert.equal(left.body.error, 'billing_owner');
    assert.equal((await orgRow(ws)).billing_owner_user_id, a.userId, 'the match is recorded');
    // The other owner is unaffected.
    const otherLeft = await as('delete', `/api/v1/teams/members/${b.userId}`, b, ws);
    assert.equal(otherLeft.status, 200);
});

test('decision 1: a Stripe that cannot be read answers 503 billing_owner_unconfirmed and writes nothing', async () => {
    const [payer, other] = [await makePerson('payer-down'), await makePerson('other-down')];
    const ws = await teamFor('down', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });
    stripeDown = () => Object.assign(new Error('connect ETIMEDOUT'), { type: 'StripeConnectionError' });
    try {
        const left = await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws);
        assert.equal(left.status, 503, `${left.status} ${JSON.stringify(left.body)}`);
        assert.equal(left.body.error, 'billing_owner_unconfirmed');
    } finally {
        stripeDown = null;
    }
    assert.deepEqual(await roleOf(ws, payer), { role: 'owner', removed: false });
});

test('decision 1: setting the subscription to end at the period\'s end opens the gate, for the payer in any role', async () => {
    const [payer, other] = [await makePerson('payer-cancel'), await makePerson('other-cancel')];
    const ws = await teamFor('cancel', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });
    // Another owner demotes the payer to member first: still the billing owner.
    assert.equal((await as('patch', `/api/v1/teams/members/${payer.userId}`, other, ws).send({ role: 'member' })).status, 200);
    assert.equal((await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws)).status, 409, 'a demoted payer is still held');

    updates.length = 0;
    const cancelled = await as('post', '/api/v1/billing/cancel-at-period-end', payer, ws).send({});
    assert.equal(cancelled.status, 200, `the payer's own way out: ${cancelled.status} ${JSON.stringify(cancelled.body)}`);
    assert.deepEqual(updates.map((u) => [u.id, u.params.cancel_at_period_end]), [[ws.subscriptionId, true]]);
    assert.ok(cancelled.body.ends_on, 'the answer says when it ends');
    assert.equal((await orgRow(ws)).cancel_at_period_end, true, 'the plan page reads it at once, without waiting for the webhook');

    const left = await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws);
    assert.equal(left.status, 200, `Stripe reports the subscription ending, so the payer may go: ${left.status} ${JSON.stringify(left.body)}`);
});

test('decision 1: cancel at period end is for owners and the billing owner, nobody else', async () => {
    const [payer, other, member] = [await makePerson('c-payer'), await makePerson('c-other'), await makePerson('c-member')];
    const ws = await teamFor('cancel-auth', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }, { person: member, role: 'member' }], { payer });
    updates.length = 0;
    const refused = await as('post', '/api/v1/billing/cancel-at-period-end', member, ws).send({});
    assert.equal(refused.status, 403, `${refused.status} ${JSON.stringify(refused.body)}`);
    assert.equal(updates.length, 0, 'nothing reached Stripe');
    // A subscription that already ends is left alone.
    world.get(ws.subscriptionId).cancel_at_period_end = true;
    const again = await as('post', '/api/v1/billing/cancel-at-period-end', other, ws).send({});
    assert.equal(again.status, 200);
    assert.equal(updates.length, 0, 'an ending subscription is not touched again');
});

test('decision 1: a subscription whose cancel_at falls inside the current period also opens the gate', async () => {
    const [payer, other] = [await makePerson('payer-cancelat'), await makePerson('other-cancelat')];
    const ws = await teamFor('cancelat', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });
    const sub = world.get(ws.subscriptionId);
    sub.cancel_at = sub.items.data[0].current_period_end - 60;
    assert.equal((await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws)).status, 200);
});

test('decision 1: a subscription that no longer renews (unpaid, cancelled) does not hold the payer', async () => {
    const [payer, other] = [await makePerson('payer-dead'), await makePerson('other-dead')];
    const ws = await teamFor('dead', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });
    world.get(ws.subscriptionId).status = 'canceled';
    assert.equal((await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws)).status, 200);
});

// ── the takeover ────────────────────────────────────────────────────────────

test('decision 1: takeover started by another owner stores the cards that were paying, opens the portal on the card flow, and holds the payer until the card changes', async () => {
    const [payer, taker] = [await makePerson('payer-take'), await makePerson('taker')];
    const ws = await teamFor('take', [{ person: payer, role: 'owner' }, { person: taker, role: 'owner' }], { payer });

    portalSessions.length = 0;
    const started = await as('post', '/api/v1/billing/takeover/start', taker, ws).send({});
    assert.equal(started.status, 200, `takeover start: ${started.status} ${JSON.stringify(started.body)}`);
    assert.equal(started.body.url, 'https://billing.stripe.com/p/session/stub');
    assert.deepEqual(portalSessions.map((p) => p.flow_data?.type), ['payment_method_update']);
    const stored = (await orgRow(ws)).billing_takeover;
    assert.equal(stored.user_id, taker.userId);
    assert.deepEqual(stored.payment_methods, ['pm_old'], 'the card that was paying, subscription and customer default alike');
    assert.ok(Date.parse(stored.started_at));
    assert.equal((await orgRow(ws)).billing_owner_user_id, payer.userId, 'starting changes nobody\'s billing ownership');

    // Back from the portal with the SAME card still paying: not taken over.
    const early = await as('post', '/api/v1/billing/takeover/confirm', taker, ws).send({});
    assert.equal(early.status, 200, `${early.status} ${JSON.stringify(early.body)}`);
    assert.equal(early.body.status, 'pending');
    assert.equal((await orgRow(ws)).billing_owner_user_id, payer.userId);
    assert.equal((await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws)).status, 409, 'still held');
});

test('decision 1: takeover is confirmed when every renewing subscription charges a card that was not paying at the start', async () => {
    const [payer, taker] = [await makePerson('payer-conf'), await makePerson('taker-conf')];
    const ws = await teamFor('conf', [{ person: payer, role: 'owner' }, { person: taker, role: 'owner' }], { payer });
    await as('post', '/api/v1/billing/takeover/start', taker, ws).send({});

    // The subscription moves to a new card; the customer default is still the old one.
    world.get(ws.subscriptionId).default_payment_method = 'pm_new';
    const stillCustomerDefault = await as('post', '/api/v1/billing/takeover/confirm', taker, ws).send({});
    assert.equal(stillCustomerDefault.body.status, 'confirmed', JSON.stringify(stillCustomerDefault.body));
    assert.equal((await orgRow(ws)).billing_owner_user_id, taker.userId);
    assert.equal((await orgRow(ws)).billing_takeover, null, 'the takeover is spent');

    const left = await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws);
    assert.equal(left.status, 200, `the takeover was confirmed and the payer was still held: ${left.status} ${JSON.stringify(left.body)}`);
});

test('decision 1: a subscription that follows the customer default is confirmed by the customer\'s new default', async () => {
    const [payer, taker] = [await makePerson('payer-cust'), await makePerson('taker-cust')];
    const ws = await teamFor('cust', [{ person: payer, role: 'owner' }, { person: taker, role: 'owner' }], { payer });
    world.get(ws.subscriptionId).default_payment_method = null;
    await as('post', '/api/v1/billing/takeover/start', taker, ws).send({});
    assert.deepEqual((await orgRow(ws)).billing_takeover.payment_methods, ['pm_old']);
    customers.get(ws.customer).invoice_settings.default_payment_method = 'pm_taker';
    const confirmed = await as('post', '/api/v1/billing/takeover/confirm', taker, ws).send({});
    assert.equal(confirmed.body.status, 'confirmed', JSON.stringify(confirmed.body));
});

test('decision 1: an empty payment method is not a takeover', async () => {
    const [payer, taker] = [await makePerson('payer-empty'), await makePerson('taker-empty')];
    const ws = await teamFor('empty', [{ person: payer, role: 'owner' }, { person: taker, role: 'owner' }], { payer });
    await as('post', '/api/v1/billing/takeover/start', taker, ws).send({});
    world.get(ws.subscriptionId).default_payment_method = null;
    customers.get(ws.customer).invoice_settings.default_payment_method = null;
    const confirm = await as('post', '/api/v1/billing/takeover/confirm', taker, ws).send({});
    assert.equal(confirm.body.status, 'pending', JSON.stringify(confirm.body));
    assert.equal((await orgRow(ws)).billing_owner_user_id, payer.userId);
});

test('decision 1: the gate itself notices a takeover that happened in the portal, so the payer is not stuck behind a button nobody pressed', async () => {
    const [payer, taker] = [await makePerson('payer-gate'), await makePerson('taker-gate')];
    const ws = await teamFor('gate', [{ person: payer, role: 'owner' }, { person: taker, role: 'owner' }], { payer });
    await as('post', '/api/v1/billing/takeover/start', taker, ws).send({});
    world.get(ws.subscriptionId).default_payment_method = 'pm_taker';
    const left = await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws);
    assert.equal(left.status, 200, `${left.status} ${JSON.stringify(left.body)}`);
    assert.equal((await orgRow(ws)).billing_owner_user_id, taker.userId, 'and the takeover is recorded');
});

test('decision 1: a takeover is applied only if the person who started it is still an owner', async () => {
    const [payer, taker, third] = [await makePerson('payer-cas'), await makePerson('taker-cas'), await makePerson('third-cas')];
    const ws = await teamFor('cas', [{ person: payer, role: 'owner' }, { person: taker, role: 'owner' }, { person: third, role: 'owner' }], { payer });
    await as('post', '/api/v1/billing/takeover/start', taker, ws).send({});
    // The taker is demoted before the card change is confirmed.
    assert.equal((await as('patch', `/api/v1/teams/members/${taker.userId}`, third, ws).send({ role: 'member' })).status, 200);
    world.get(ws.subscriptionId).default_payment_method = 'pm_taker';
    const confirm = await as('post', '/api/v1/billing/takeover/confirm', third, ws).send({});
    assert.equal(confirm.body.status, 'not_applied', JSON.stringify(confirm.body));
    assert.equal((await orgRow(ws)).billing_owner_user_id, payer.userId, 'a demoted taker does not become the billing owner');
});

test('decision 1: only an owner can start a takeover, and the billing owner cannot take over from themselves', async () => {
    const [payer, other, member] = [await makePerson('payer-auth'), await makePerson('other-auth'), await makePerson('member-auth')];
    const ws = await teamFor('auth', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }, { person: member, role: 'member' }], { payer });
    assert.equal((await as('post', '/api/v1/billing/takeover/start', member, ws).send({})).status, 403);
    const self = await as('post', '/api/v1/billing/takeover/start', payer, ws).send({});
    assert.equal(self.status, 409, `${self.status} ${JSON.stringify(self.body)}`);
    assert.equal(self.body.error, 'already_billing_owner');
});

test('decision 1: a takeover on a workspace whose billing owner was never recorded records the taker', async () => {
    const [a, b] = [await makePerson('unk-take-a'), await makePerson('unk-take-b')];
    const ws = await teamFor('unktake', [{ person: a, role: 'owner' }, { person: b, role: 'owner' }], { payer: null });
    assert.equal((await as('post', '/api/v1/billing/takeover/start', b, ws).send({})).status, 200);
    world.get(ws.subscriptionId).default_payment_method = 'pm_b';
    const confirmed = await as('post', '/api/v1/billing/takeover/confirm', b, ws).send({});
    assert.equal(confirmed.body.status, 'confirmed');
    assert.equal((await orgRow(ws)).billing_owner_user_id, b.userId);
});

test('decision 1: Stripe is read with no database connection held, by the gate, the takeover and the cancellation', async () => {
    const [payer, taker] = [await makePerson('payer-held'), await makePerson('taker-held')];
    const ws = await teamFor('held', [{ person: payer, role: 'owner' }, { person: taker, role: 'owner' }], { payer });
    heldDuringRead.length = 0;
    await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws); // 409
    await as('post', '/api/v1/billing/takeover/start', taker, ws).send({});
    world.get(ws.subscriptionId).default_payment_method = 'pm_taker';
    await as('post', '/api/v1/billing/takeover/confirm', taker, ws).send({});
    assert.ok(heldDuringRead.length >= 3, `the paths read Stripe (${heldDuringRead.length} reads seen)`);
    assert.ok(heldDuringRead.every((n) => n === 0), `a connection was held while Stripe was read: ${JSON.stringify(heldDuringRead)}`);
});

// ── deleting the account ────────────────────────────────────────────────────

test('decision 1: deleting the account is refused while the person pays for a workspace that survives it, and nothing is deleted or cancelled', async () => {
    const [payer, other] = [await makePerson('payer-del'), await makePerson('other-del')];
    const ws = await teamFor('del', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });
    cancelledInStripe.length = 0;
    const res = await as('delete', '/api/v1/orgs', payer).send({ password: 'password123' });
    assert.equal(res.status, 409, `THE BUG: the payer deleted their account under a live subscription: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'billing_owner');
    assert.equal(res.body.workspace, ws.orgId);
    assert.deepEqual(cancelledInStripe, [], 'no subscription was cancelled');
    const user = await q('SELECT 1 FROM users WHERE user_id = $1', [payer.userId]);
    assert.equal(user.rowCount, 1, 'the account is intact');
    assert.equal((await orgRow(ws)).subscription_status, 'active');
});

test('decision 1: deleting the account goes through once the subscription is set to end, and the surviving workspace is left as it was', async () => {
    const [payer, other] = [await makePerson('payer-del2'), await makePerson('other-del2')];
    const ws = await teamFor('del2', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });
    assert.equal((await as('post', '/api/v1/billing/cancel-at-period-end', payer, ws).send({})).status, 200);
    cancelledInStripe.length = 0;
    const res = await as('delete', '/api/v1/orgs', payer).send({ password: 'password123' });
    assert.equal(res.status, 200, `${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(!cancelledInStripe.includes(ws.subscriptionId), 'the team\'s subscription is not cancelled by one owner leaving');
    assert.equal((await q('SELECT 1 FROM organizations WHERE org_id = $1', [ws.orgId])).rowCount, 1);
});

test('decision 1: deleting the account is not refused over a workspace whose billing owner is not recorded and not the customer\'s email', async () => {
    const [a, b] = [await makePerson('unk-del-a'), await makePerson('unk-del-b')];
    await teamFor('unkdel', [{ person: a, role: 'owner' }, { person: b, role: 'owner' }], { payer: null, customerEmail: 'nobody@nowhere.test' });
    const res = await as('delete', '/api/v1/orgs', a).send({ password: 'password123' });
    assert.equal(res.status, 200, `${res.status} ${JSON.stringify(res.body)}`);
});

test('decision 1: a person who pays for nothing deletes their account exactly as before, with no Stripe read for it', async () => {
    const lone = await makePerson('lone');
    stripeCalls.length = 0;
    const res = await as('delete', '/api/v1/orgs', lone).send({ password: 'password123' });
    assert.equal(res.status, 200, `${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(stripeCalls, [], 'no workspace they belong to has a Stripe customer');
});

test('decision 1: a purchase records who bought it, when they are an owner; a member who bought is not recorded', async () => {
    const [buyer, other, member] = [await makePerson('buy-owner'), await makePerson('buy-other'), await makePerson('buy-member')];
    const ws = await teamFor('buy', [{ person: buyer, role: 'owner' }, { person: other, role: 'owner' }, { person: member, role: 'member' }], { payer: null });
    const checkout = (purchaser) => deliver({
        id: eventId('cs'), object: 'event', type: 'checkout.session.completed', created: nowS(),
        data: {
            object: {
                id: `cs_${eventId('obj')}`, object: 'checkout.session', mode: 'subscription', customer: ws.customer, subscription: ws.subscriptionId,
                amount_total: 3000, currency: 'usd', metadata: { orgId: ws.orgId, tierId: 'developer_pro', billingCycle: 'monthly', purchaserUserId: purchaser.userId },
            },
        },
    });
    assert.equal((await checkout(member)).status, 200);
    assert.equal((await orgRow(ws)).billing_owner_user_id, null, 'a member is not a billing owner');
    assert.equal((await checkout(buyer)).status, 200);
    assert.equal((await orgRow(ws)).billing_owner_user_id, buyer.userId, 'THE GAP: the purchaser was recorded nowhere, so the gate never knew who pays');
    const left = await as('delete', `/api/v1/teams/members/${buyer.userId}`, buyer, ws);
    assert.equal(left.status, 409, 'and from then on they are held');
});

test('decision 1: the checkout carries the person who pressed the button, and no card', async () => {
    const owner = await makePerson('buy-meta');
    const orgId = owner.orgId;
    let sent = null;
    const realCreate = client.checkout.sessions.create;
    client.checkout.sessions.create = async (params) => { sent = clone(params); return { id: 'cs_r6_meta', url: 'https://checkout.stripe.com/c/pay/stub' }; };
    const realCustomerCreate = client.customers.create;
    client.customers.create = async (params) => ({ id: `cus_r6_meta_${TAG}`, ...clone(params || {}) });
    try {
        const res = await request(httpServer).post('/api/v1/billing/checkout').set('Authorization', `Bearer ${owner.jwt}`)
            .send({ tierId: 'developer_basic', billingCycle: 'monthly' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(sent.metadata.orgId, orgId);
        assert.equal(sent.metadata.purchaserUserId, owner.userId);
    } finally {
        client.checkout.sessions.create = realCreate;
        client.customers.create = realCustomerCreate;
    }
});

test('decision 1: a recorded payer who is no longer in the workspace is reported as not on record', async () => {
    const [payer, other] = [await makePerson('gone-payer'), await makePerson('gone-other')];
    const ws = await teamFor('gonepayer', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });
    world.get(ws.subscriptionId).cancel_at_period_end = true; // ending: the payer may go
    assert.equal((await as('delete', `/api/v1/teams/members/${payer.userId}`, payer, ws)).status, 200);
    const usage = await as('get', '/api/v1/orgs/usage', other, ws);
    assert.equal(usage.body.plan.billing_owner.recorded, false, JSON.stringify(usage.body.plan.billing_owner));
    assert.equal(usage.body.plan.billing_owner.email, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. PENDING CANCELLATION AND THE REAL PRICE (written first: 4 and 2 read the row)
// ═══════════════════════════════════════════════════════════════════════════

test('decision 3: the webhook records the real price and the pending cancellation from its one Stripe read', async () => {
    const [owner] = [await makePerson('rec-owner')];
    const ws = await teamFor('rec', [{ person: owner, role: 'owner' }], { payer: owner });
    // A legacy $10 subscription on the Team plan's price id, billed monthly, seats 2.
    const sub = world.get(ws.subscriptionId);
    sub.items.data[0].price.unit_amount = 1000;
    stripeCalls.length = 0;
    heldDuringRead.length = 0;
    const res = await updateEvent(ws);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await orgRow(ws);
    assert.equal(row.price_unit_amount_cents, 1000, 'THE BUG: the price was not recorded, so a $10 subscriber is shown today\'s list price');
    assert.equal(row.price_currency, 'usd');
    assert.equal(row.price_interval, 'month');
    assert.equal(row.price_interval_count, 1);
    assert.equal(row.cancel_at_period_end, false);
    assert.equal(row.cancel_at, null);
    assert.deepEqual(stripeCalls, [`subscriptions.retrieve ${ws.subscriptionId}`], 'no extra Stripe call: one read of the subscription');
    assert.deepEqual(heldDuringRead, [0]);

    // The customer sets it to cancel at the period's end.
    const endsAt = sub.items.data[0].current_period_end;
    sub.cancel_at_period_end = true;
    sub.cancel_at = endsAt;
    assert.equal((await updateEvent(ws)).status, 200);
    const pending = await orgRow(ws);
    assert.equal(pending.cancel_at_period_end, true);
    assert.equal(new Date(pending.cancel_at).getTime(), endsAt * 1000);
    assert.equal(pending.plan_tier, 'developer_pro', 'a pending cancellation changes no access');
    assert.equal(pending.subscription_status, 'active');

    // Resumed.
    sub.cancel_at_period_end = false;
    sub.cancel_at = null;
    assert.equal((await updateEvent(ws)).status, 200);
    const resumed = await orgRow(ws);
    assert.equal(resumed.cancel_at_period_end, false);
    assert.equal(resumed.cancel_at, null);
});

test('decision 3: a yearly price is recorded as yearly; the subscription ending clears both', async () => {
    const owner = await makePerson('rec-year');
    const ws = await teamFor('recyear', [{ person: owner, role: 'owner' }], { payer: owner });
    const sub = world.get(ws.subscriptionId);
    Object.assign(sub.items.data[0].price, { unit_amount: 14400, recurring: { interval: 'year', interval_count: 1 } });
    await updateEvent(ws);
    const row = await orgRow(ws);
    assert.deepEqual([row.price_unit_amount_cents, row.price_interval, row.price_interval_count], [14400, 'year', 1]);

    sub.status = 'canceled';
    const deleted = await deliver({
        id: eventId('del'), object: 'event', type: 'customer.subscription.deleted', created: nowS(),
        data: { object: clone(sub) },
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    const after = await orgRow(ws);
    assert.equal(after.price_unit_amount_cents, null, 'no subscription, no price');
    assert.equal(after.cancel_at_period_end, null);
});

test('decision 3: a price the map does not know is still recorded as what Stripe bills, and the plan is kept', async () => {
    const owner = await makePerson('rec-unknown');
    const ws = await teamFor('recunk', [{ person: owner, role: 'owner' }], { payer: owner });
    const sub = world.get(ws.subscriptionId);
    Object.assign(sub.items.data[0].price, { id: `price_unmapped_${TAG}`, unit_amount: 999 });
    assert.equal((await updateEvent(ws)).status, 200);
    const row = await orgRow(ws);
    assert.equal(row.plan_tier, 'developer_pro', 'unknown price keeps the plan');
    assert.equal(row.price_unit_amount_cents, 999);
});

test('decision 3: the plan page\'s data carries the price, the cadence, the pending cancellation and the takeover state', async () => {
    const [payer, other] = [await makePerson('usage-payer'), await makePerson('usage-other')];
    const ws = await teamFor('usage', [{ person: payer, role: 'owner' }, { person: other, role: 'owner' }], { payer });
    const sub = world.get(ws.subscriptionId);
    sub.items.data[0].price.unit_amount = 1000;
    sub.cancel_at_period_end = true;
    sub.cancel_at = sub.items.data[0].current_period_end;
    await updateEvent(ws);
    await invalidateOrgCache(ws.orgId).catch(() => {});

    const mine = await as('get', '/api/v1/orgs/usage', payer, ws);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const plan = mine.body.plan;
    assert.deepEqual(plan.price, { unit_amount_cents: 1000, currency: 'usd', interval: 'month', interval_count: 1 });
    assert.equal(plan.cancel_at_period_end, true);
    assert.equal(new Date(plan.cancel_at).getTime(), sub.cancel_at * 1000);
    assert.equal(plan.billing_owner.is_you, true);
    assert.equal(plan.billing_owner.recorded, true);
    const theirs = await as('get', '/api/v1/orgs/usage', other, ws);
    assert.equal(theirs.body.plan.billing_owner.is_you, false);
    assert.equal(theirs.body.plan.billing_owner.recorded, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. SEATS BELOW HEADCOUNT
// ═══════════════════════════════════════════════════════════════════════════

test('decision 2: fewer paid seats than members tells the owner on both pages and by ONE email per episode, and suspends nobody', async () => {
    const [owner, second, third] = [await makePerson('seat-owner'), await makePerson('seat-two'), await makePerson('seat-three')];
    const ws = await teamFor('seat', [{ person: owner, role: 'owner' }, { person: second, role: 'member' }, { person: third, role: 'member' }], { payer: owner, seats: 3 });
    sentEmails.length = 0;

    // Stripe: the seat count is reduced to two while three people are in.
    world.get(ws.subscriptionId).items.data[0].quantity = 2;
    assert.equal((await updateEvent(ws)).status, 200);
    assert.equal((await orgRow(ws)).purchased_seats, 2);

    const mails = emailsTo(owner.email, 'seats_below_headcount');
    assert.equal(mails.length, 1, `the owner was told ${mails.length} times: ${JSON.stringify(sentEmails.map((m) => [m.to, m.emailType]))}`);
    assert.match(mails[0].html, /3 people/);
    assert.match(mails[0].html, /2 seats/);
    assert.match(mails[0].html, /settings\/plan/, 'links to the page where seats are changed');
    assert.equal(emailsTo(second.email, 'seats_below_headcount').length, 0, 'members are not emailed');

    // Suspends nobody.
    const members = await workspace.listMembers(ws.orgId);
    assert.equal(members.filter((m) => m.active).length, 3);
    await invalidateOrgCache(ws.orgId).catch(() => {});
    const still = await as('get', '/api/v1/context/projects', third, ws);
    assert.equal(still.status, 200, `a member was locked out over the seat shortfall: ${still.status} ${JSON.stringify(still.body)}`);

    // Both pages say so.
    const team = await as('get', '/api/v1/teams/members', owner, ws);
    assert.equal(team.status, 200, JSON.stringify(team.body));
    assert.deepEqual(team.body.billing.seat_shortfall, { members: 3, seats: 2, over_by: 1 });
    const plan = await as('get', '/api/v1/orgs/usage', owner, ws);
    assert.deepEqual(plan.body.plan.seat_shortfall, { members: 3, seats: 2, over_by: 1 });

    // Another event in the same episode does not email again.
    assert.equal((await updateEvent(ws, { previous: { default_payment_method: 'pm_a' } })).status, 200);
    assert.equal(emailsTo(owner.email, 'seats_below_headcount').length, 1, 'one email per shortfall episode, not one per event');

    // Resolved by removing somebody: the page stops saying it.
    const removed = await as('delete', `/api/v1/teams/members/${third.userId}`, owner, ws);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const resolved = await as('get', '/api/v1/teams/members', owner, ws);
    assert.equal(resolved.body.billing.seat_shortfall, null);

    // A new episode (seats cut again below the headcount) is told once more.
    await q('INSERT INTO workspace_members (owner_key, user_id, role) VALUES ($1, $2, \'member\') ON CONFLICT (owner_key, user_id) DO UPDATE SET removed_at = NULL', [ws.orgId, third.userId]);
    assert.equal((await updateEvent(ws, { previous: { default_payment_method: 'pm_b' } })).status, 200);
    assert.equal(emailsTo(owner.email, 'seats_below_headcount').length, 2, 'a new shortfall episode is a new email');
});

test('decision 2: enough seats is not a shortfall, and nothing is sent', async () => {
    const [owner, second] = [await makePerson('seat-ok-owner'), await makePerson('seat-ok-two')];
    const ws = await teamFor('seatok', [{ person: owner, role: 'owner' }, { person: second, role: 'member' }], { payer: owner, seats: 2 });
    sentEmails.length = 0;
    assert.equal((await updateEvent(ws)).status, 200);
    assert.equal(sentEmails.filter((m) => m.emailType === 'seats_below_headcount').length, 0);
    const team = await as('get', '/api/v1/teams/members', owner, ws);
    assert.equal(team.body.billing.seat_shortfall, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. AN OVERDUE PAYMENT EMAILS THE OWNER, ONCE PER EPISODE
// ═══════════════════════════════════════════════════════════════════════════

test('decision 4: a failed payment Stripe reports as past_due emails the owner once, with the billing portal route', async () => {
    const [owner, member] = [await makePerson('od-owner'), await makePerson('od-member')];
    const ws = await teamFor('od', [{ person: owner, role: 'owner' }, { person: member, role: 'member' }], { payer: owner });
    sentEmails.length = 0;
    world.get(ws.subscriptionId).status = 'past_due';

    assert.equal((await failedInvoice(ws)).status, 200);
    const mails = emailsTo(owner.email, 'payment_overdue');
    assert.equal(mails.length, 1, `THE BUG: DeerDawn told nobody its own customer's payment is overdue: ${JSON.stringify(sentEmails.map((m) => [m.to, m.emailType]))}`);
    assert.match(mails[0].subject, /payment/i);
    assert.match(mails[0].html, /Update payment method/);
    assert.ok(mails[0].html.includes(`/settings/plan?workspace=${ws.orgId}`), 'links to the plan page, where the billing portal opens on the card');
    assert.equal(emailsTo(member.email, 'payment_overdue').length, 0, 'a member is not the owner');

    // The retry fails again: same episode, no second email.
    assert.equal((await failedInvoice(ws, { attempt: 2 })).status, 200);
    assert.equal(emailsTo(owner.email, 'payment_overdue').length, 1, 'once per overdue episode');

    // Paid up ends the episode; the next failure is a new one.
    world.get(ws.subscriptionId).status = 'active';
    assert.equal((await updateEvent(ws, { previous: { status: 'past_due' } })).status, 200);
    world.get(ws.subscriptionId).status = 'past_due';
    assert.equal((await failedInvoice(ws, { attempt: 1 })).status, 200);
    assert.equal(emailsTo(owner.email, 'payment_overdue').length, 2);
});

test('decision 4: unpaid says the same; incomplete says to check out again, for the same plan', async () => {
    const [unpaidOwner, incompleteOwner] = [await makePerson('od-unpaid'), await makePerson('od-incomplete')];
    const unpaid = await teamFor('odu', [{ person: unpaidOwner, role: 'owner' }], { payer: unpaidOwner });
    const incomplete = await teamFor('odi', [{ person: incompleteOwner, role: 'owner' }], { payer: incompleteOwner, seats: 3 });
    sentEmails.length = 0;

    world.get(unpaid.subscriptionId).status = 'unpaid';
    assert.equal((await updateEvent(unpaid)).status, 200);
    const u = emailsTo(unpaidOwner.email, 'payment_overdue');
    assert.equal(u.length, 1);
    assert.match(u[0].html, /Update payment method/);

    world.get(incomplete.subscriptionId).status = 'incomplete';
    assert.equal((await updateEvent(incomplete)).status, 200);
    const i = emailsTo(incompleteOwner.email, 'payment_overdue');
    assert.equal(i.length, 1);
    assert.match(i[0].html, /check out again/i);
    assert.ok(i[0].html.includes('/checkout?plan=developer_pro&amp;seats=3') || i[0].html.includes('/checkout?plan=developer_pro&seats=3'), 'the checkout link names the plan and the seats');
    assert.doesNotMatch(i[0].html, /Update payment method/);
});

test('decision 4: nothing is sent for a charge Stripe says has since been paid, or for a subscription Stripe no longer has', async () => {
    const [paidOwner, goneOwner] = [await makePerson('od-paid'), await makePerson('od-gone')];
    const paid = await teamFor('odp', [{ person: paidOwner, role: 'owner' }], { payer: paidOwner });
    const goneWs = await teamFor('odg', [{ person: goneOwner, role: 'owner' }], { payer: goneOwner });
    sentEmails.length = 0;

    // The event says failed; Stripe says the subscription is active and paid.
    assert.equal((await failedInvoice(paid)).status, 200);
    assert.equal(emailsTo(paidOwner.email, 'payment_overdue').length, 0);

    // Gone from Stripe: the status is the event's word, not Stripe's, so no owner is told.
    world.delete(goneWs.subscriptionId);
    assert.equal((await failedInvoice(goneWs)).status, 200);
    assert.equal(emailsTo(goneOwner.email, 'payment_overdue').length, 0);
});

test('decision 4: a read Stripe refuses writes nothing and emails nobody; a transient failure answers 5xx', async () => {
    const owner = await makePerson('od-refused');
    const ws = await teamFor('odr', [{ person: owner, role: 'owner' }], { payer: owner });
    sentEmails.length = 0;
    world.get(ws.subscriptionId).status = 'past_due';
    stripeDown = () => Object.assign(new Error('connect ETIMEDOUT'), { type: 'StripeConnectionError' });
    try {
        const res = await failedInvoice(ws);
        assert.equal(res.status, 500);
    } finally {
        stripeDown = null;
    }
    assert.equal((await orgRow(ws)).subscription_status, 'active', 'nothing written');
    assert.equal(emailsTo(owner.email, 'payment_overdue').length, 0);
});

test('decision 4: with several owners and a recorded billing owner, the billing owner is told; with none recorded, every owner is', async () => {
    const [a, b] = [await makePerson('od-multi-a'), await makePerson('od-multi-b')];
    const recorded = await teamFor('odm1', [{ person: a, role: 'owner' }, { person: b, role: 'owner' }], { payer: a });
    const unrecorded = await teamFor('odm2', [{ person: a, role: 'owner' }, { person: b, role: 'owner' }], { payer: null });
    sentEmails.length = 0;
    world.get(recorded.subscriptionId).status = 'past_due';
    world.get(unrecorded.subscriptionId).status = 'past_due';
    assert.equal((await failedInvoice(recorded)).status, 200);
    assert.deepEqual(sentEmails.filter((m) => m.emailType === 'payment_overdue').map((m) => m.to), [a.email]);
    sentEmails.length = 0;
    assert.equal((await failedInvoice(unrecorded)).status, 200);
    assert.deepEqual(sentEmails.filter((m) => m.emailType === 'payment_overdue').map((m) => m.to).sort(), [a.email, b.email].sort());
});

test('rules: a refund still changes no access, and the notices make no Stripe read of their own', async () => {
    const owner = await makePerson('rules');
    const ws = await teamFor('rules', [{ person: owner, role: 'owner' }], { payer: owner });
    world.get(ws.subscriptionId).status = 'past_due';
    stripeCalls.length = 0;
    heldDuringRead.length = 0;
    assert.equal((await failedInvoice(ws)).status, 200);
    assert.deepEqual(stripeCalls, [`subscriptions.retrieve ${ws.subscriptionId}`], 'one read of the subscription, and nothing else');
    assert.deepEqual(heldDuringRead, [0], 'no connection held while it was read');

    const before = await orgRow(ws);
    const refund = await deliver({
        id: eventId('ref'), object: 'event', type: 'charge.refunded', created: nowS(),
        data: { object: { id: 'ch_r6', customer: ws.customer, amount: 3000, amount_refunded: 3000 } },
    });
    assert.equal(refund.status, 200);
    const after = await orgRow(ws);
    assert.deepEqual([after.plan_tier, after.subscription_status, after.stripe_subscription_id], [before.plan_tier, before.subscription_status, before.stripe_subscription_id]);
});
