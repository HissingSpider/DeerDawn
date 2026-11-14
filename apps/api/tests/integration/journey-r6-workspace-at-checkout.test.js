'use strict';

/**
 * JOURNEY SCAN ROUND 6: A TEAM WORKSPACE IS CREATED AT CHECKOUT, NOT BEFORE.
 *
 * The new-team wizard used to create an empty Free workspace at its first step
 * (POST /teams/workspaces), before anything was paid. Free has no team feature,
 * so the workspace could not be invited into, and every abandoned checkout left
 * one behind. The owner's decision: the workspace comes into being when Stripe
 * confirms the Team subscription (a purchase is counted only when granted), and
 * an abandoned checkout leaves nothing.
 *
 * Driven through the real app over a real database. Stripe is stubbed at the SDK
 * edge (the real client object, its methods replaced); nothing is sent to it.
 * Webhooks are signed with the test secret, so the real signature check runs.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/integration/journey-r6-workspace-at-checkout.test.js
 */

if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_journey_r6_checkout_stub_never_sent_anywhere';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_journey_r6_checkout';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = process.env.STRIPE_PRICE_DEVELOPER_BASIC || 'price_pro_monthly_r6';
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly_r6';
process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://dashboard.journey-r6.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const resendClient = require('../../src/services/email/resendClient');
const sentEmails = [];
resendClient.sendEmail = async (mail) => { sentEmails.push(mail); return { ok: true, id: 'captured' }; };

const productEvents = require('../../src/services/productEventsService');
const purchases = [];
productEvents.recordProductEvent = async (actor, input) => { purchases.push({ actor, input }); return { ok: true }; };
const purchasesFor = (orgId) => purchases.filter((p) => p.actor?.org_id === orgId && p.input?.event_name === 'purchase_completed');
const billingOwnerOf = async (orgId) => (await q('SELECT billing_owner_user_id FROM organizations WHERE org_id = $1', [orgId])).rows[0]?.billing_owner_user_id || null;

const stripeService = require('../../src/services/stripeService');
const app = require('../../src/app');
const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const TEAM = process.env.STRIPE_PRICE_DEVELOPER_PRO;
const TAG = crypto.randomBytes(4).toString('hex');
const DAY = 86_400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, params) => db.query(sql, params, 'org-system');
const nowS = () => Math.floor(Date.now() / 1000);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── Stripe, stubbed at the SDK edge ─────────────────────────────────────────
const world = new Map();
const client = stripeService.stripe;
assert.ok(client, 'the Stripe client must be constructed for this test');
// Connections checked out of the pool at the moment the webhook read Stripe.
const heldDuringRead = [];
let watching = false;
client.subscriptions.retrieve = async (id) => {
    if (watching) heldDuringRead.push(db.pool.totalCount - db.pool.idleCount);
    const found = world.get(id);
    if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    return clone(found);
};
client.subscriptions.list = async ({ customer }) => ({
    object: 'list', data: [...world.values()].filter((s) => s.customer === customer).map(clone), has_more: false,
});
const sessions = [];
let customersCreated = 0;
client.customers.create = async (params) => {
    customersCreated += 1;
    return { id: `cus_r6_new_${TAG}_${customersCreated}`, ...clone(params || {}) };
};
client.checkout.sessions.create = async (params) => {
    sessions.push(clone(params));
    return { id: `cs_r6_${TAG}_${sessions.length}`, url: 'https://checkout.stripe.com/c/pay/stub' };
};

function sign(payload) {
    const t = nowS();
    const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
    return `t=${t},v1=${v1}`;
}

const httpServer = app.listen(0);
const made = { orgs: [], events: [], users: [] };
test.before(async () => {
    await new Promise((r) => (httpServer.listening ? r() : httpServer.once('listening', r)));
});
test.after(async () => {
    await q('DELETE FROM subscription_events WHERE org_id = ANY($1::text[])', [made.orgs]).catch(() => {});
    await q('DELETE FROM stripe_events WHERE event_id = ANY($1::text[])', [made.events]).catch(() => {});
    for (const orgId of made.orgs) {
        await q('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_ownership_backfills WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM context_audit_logs WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM users WHERE org_id = $1', [orgId]).catch(() => {});
        await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    }
    await new Promise((resolve) => httpServer.close(resolve));
});

async function person(label) {
    const orgId = `org-${uuidv4()}`;
    await q(
        'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type) VALUES ($1, $2, $3, $3, $4, $5)',
        [orgId, `r6 ${label} home`, 'free', 'active', 'organization'],
    );
    made.orgs.push(orgId);
    const userId = `user-${uuidv4()}`;
    const email = `r6-${label}-${TAG}@journey-r6.test`;
    await q(
        'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
        [userId, email, await hashPassword('password123'), 'admin', orgId],
    );
    await workspace.ensureOwnerMembership(orgId, userId);
    const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
    return { label, orgId, userId, email, jwt };
}

const as = (method, path, p, ws = null) => {
    let r = request(httpServer)[method](path).set('Authorization', `Bearer ${p.jwt}`);
    if (ws) r = r.set('x-deerdawn-workspace', ws);
    return r;
};

let eventSeq = 0;
async function deliver(event) {
    made.events.push(event.id);
    const payload = JSON.stringify(event);
    const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/v1/webhooks/stripe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
        body: payload,
    });
    const body = await res.json().catch(() => null);
    await sleep(120);
    return { status: res.status, body };
}

const orgRow = async (orgId) => (await q('SELECT org_id, name, plan_tier, subscription_status, purchased_seats, stripe_customer_id, stripe_subscription_id FROM organizations WHERE org_id = $1', [orgId])).rows[0] || null;
const members = async (orgId) => (await q('SELECT user_id, role FROM workspace_members WHERE owner_key = $1 AND removed_at IS NULL', [orgId])).rows;

// Stripe finished a checkout session that named a new workspace, and holds this subscription.
function completedCheckout(session, { status = 'active', seats = 2, customer = `cus_r6_${TAG}_${++eventSeq}` } = {}) {
    const subscriptionId = `sub_r6_${TAG}_${eventSeq}`;
    const start = nowS();
    world.set(subscriptionId, {
        id: subscriptionId, object: 'subscription', status, customer, created: start, metadata: {}, schedule: null,
        items: { data: [{ id: `si_${subscriptionId}`, quantity: seats, current_period_start: start, current_period_end: start + 30 * DAY, price: { id: TEAM, recurring: { interval: 'month' } } }] },
    });
    return {
        id: `evt_r6_co_${TAG}_${eventSeq}`, object: 'event', type: 'checkout.session.completed', created: nowS(),
        data: { object: {
            id: `cs_done_${TAG}_${eventSeq}`, object: 'checkout.session', mode: 'subscription', customer, subscription: subscriptionId,
            metadata: session.metadata, amount_total: 0, currency: 'usd', payment_status: 'paid',
        } },
    };
}

test('POST /teams/workspaces no longer creates an empty Free workspace', async () => {
    const ann = await person('ann');
    const name = `Empty ${TAG}`;
    const res = await as('post', '/api/v1/teams/workspaces', ann).send({ name });
    assert.equal(res.status, 402, `an unpaid workspace is not created: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'checkout_required');
    const found = await q('SELECT org_id FROM organizations WHERE name = $1', [name]);
    assert.equal(found.rows.length, 0, 'no organization row was written');
});

test('opening the checkout writes no workspace, no membership and no Stripe customer; abandoning it leaves nothing', async () => {
    const ann = await person('ann2');
    const before = { customers: customersCreated, orgs: (await q('SELECT COUNT(*)::int AS n FROM organizations')).rows[0].n };
    const res = await as('post', '/api/v1/billing/checkout', ann).send({
        tierId: 'developer_pro', billingCycle: 'monthly', seats: 2, newWorkspaceName: `Acme ${TAG}`,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.url, /^https:\/\/checkout\.stripe\.com\//);
    assert.match(res.body.workspace, /^org-[0-9a-f-]{36}$/);
    made.orgs.push(res.body.workspace);

    const params = sessions[sessions.length - 1];
    assert.equal(params.customer, undefined, 'no DeerDawn-made Stripe customer: Stripe makes one when the checkout completes');
    assert.equal(params.customer_email, ann.email);
    assert.equal(customersCreated, before.customers, 'no customer was created');
    assert.equal(params.metadata.orgId, res.body.workspace);
    assert.equal(params.metadata.newWorkspaceName, `Acme ${TAG}`);
    assert.equal(params.metadata.founderUserId, ann.userId);
    assert.equal(params.metadata.tierId, 'developer_pro');
    assert.match(params.cancel_url, /\/settings\/new-team\?canceled=true/, 'abandoning returns to the wizard, not to a workspace that does not exist');
    assert.match(params.success_url, /new_workspace=1/);

    // Nothing exists. The person abandons the checkout: there is no event to send.
    assert.equal(await orgRow(res.body.workspace), null, 'no organization row');
    assert.deepEqual(await members(res.body.workspace), [], 'no membership');
    const after = (await q('SELECT COUNT(*)::int AS n FROM organizations')).rows[0].n;
    assert.equal(after, before.orgs, 'the number of workspaces did not change');
    const listed = await as('get', '/api/v1/teams/workspaces', ann);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(!(listed.body.workspaces || []).some((w) => w.workspace === res.body.workspace), 'the switcher does not list it');
});

test('the workspace is created when Stripe confirms the Team subscription, owned by the buyer, on Team', async () => {
    const ann = await person('ann3');
    const name = `Confirmed ${TAG}`;
    const opened = await as('post', '/api/v1/billing/checkout', ann).send({ tierId: 'developer_pro', billingCycle: 'monthly', seats: 2, newWorkspaceName: name });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const orgId = opened.body.workspace;
    made.orgs.push(orgId);
    const session = sessions[sessions.length - 1];
    assert.equal(await orgRow(orgId), null, 'nothing before payment');

    const event = completedCheckout(session);
    const delivered = await deliver(event);
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));

    const row = await orgRow(orgId);
    assert.ok(row, 'the workspace exists once Stripe confirmed the subscription');
    assert.equal(row.name, name);
    assert.equal(row.plan_tier, 'developer_pro', 'and it is on Team, granted by the same webhook');
    assert.equal(row.subscription_status, 'active');
    assert.equal(row.purchased_seats, 2);
    assert.equal(row.stripe_customer_id, event.data.object.customer);
    assert.equal(row.stripe_subscription_id, event.data.object.subscription);
    assert.deepEqual(await members(orgId), [{ user_id: ann.userId, role: 'owner' }], 'the buyer is its owner');
    assert.equal((await q('SELECT 1 FROM workspace_ownership_backfills WHERE owner_key = $1', [orgId])).rows.length, 1, 'born as a team: no solo history to backfill');
    assert.equal((await q('SELECT 1 FROM context_audit_logs WHERE owner_key = $1 AND action = $2', [orgId, 'workspace_created'])).rows.length, 1, 'the creation is in the audit log');

    // The buyer's own workspace is untouched.
    assert.equal((await orgRow(ann.orgId)).plan_tier, 'free');

    // It shows up in the switcher and the owner can invite into it straight away.
    const listed = await as('get', '/api/v1/teams/workspaces', ann);
    const entry = (listed.body.workspaces || []).find((w) => w.workspace === orgId);
    assert.ok(entry, `the switcher lists it: ${JSON.stringify(listed.body)}`);
    assert.equal(entry.role, 'owner');
    const invite = await as('post', '/api/v1/teams/invite', ann, orgId).send({ email: `r6-invitee-${TAG}@journey-r6.test`, role: 'member' });
    assert.equal(invite.status, 201, `the new Team workspace can invite: ${invite.status} ${JSON.stringify(invite.body)}`);

    // A redelivery changes nothing: one workspace, one owner row.
    const again = await deliver(event);
    assert.equal(again.status, 200);
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM organizations WHERE org_id = $1', [orgId])).rows[0].n, 1);
    assert.equal((await members(orgId)).length, 1);
});

test('a checkout whose subscription is not live grants nothing and creates nothing', async () => {
    const ann = await person('ann4');
    const opened = await as('post', '/api/v1/billing/checkout', ann).send({ tierId: 'developer_pro', billingCycle: 'monthly', seats: 2, newWorkspaceName: `Unpaid ${TAG}` });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const orgId = opened.body.workspace;
    made.orgs.push(orgId);
    const delivered = await deliver(completedCheckout(sessions[sessions.length - 1], { status: 'incomplete' }));
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
    assert.equal(await orgRow(orgId), null, 'an unpaid subscription creates no workspace');
    assert.deepEqual(await members(orgId), []);
});

test('a checkout for an existing workspace is unchanged: it never creates one', async () => {
    const ann = await person('ann5');
    const res = await as('post', '/api/v1/billing/checkout', ann).send({ tierId: 'developer_pro', billingCycle: 'monthly', seats: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const params = sessions[sessions.length - 1];
    assert.equal(params.metadata.orgId, ann.orgId, 'bought for the workspace the caller is in');
    assert.equal(params.metadata.newWorkspaceName, undefined);
    assert.ok(params.customer, 'an existing workspace still has its Stripe customer');
    assert.match(params.cancel_url, /\/checkout\?/);
});

test('the new-workspace checkout refuses a missing name, a long one, and a plan that is not Team', async () => {
    const ann = await person('ann6');
    const noName = await as('post', '/api/v1/billing/checkout', ann).send({ tierId: 'developer_pro', newWorkspaceName: '   ' });
    assert.equal(noName.status, 400);
    assert.equal(noName.body.error, 'name_required');
    const tooLong = await as('post', '/api/v1/billing/checkout', ann).send({ tierId: 'developer_pro', newWorkspaceName: 'x'.repeat(121) });
    assert.equal(tooLong.status, 400);
    const pro = await as('post', '/api/v1/billing/checkout', ann).send({ tierId: 'developer_basic', newWorkspaceName: 'Pro team' });
    assert.equal(pro.status, 400, 'buying Pro upgrades the person\'s own workspace; it does not create one');
    assert.equal(pro.body.error, 'invalid_plan');
});


// ---------------------------------------------------------------------------
// Whichever event first shows the subscription live creates the workspace.
// A card that needed extra confirmation completes the checkout while the
// subscription is `incomplete`, and it turns active minutes later, reported by a
// subscription update or a paid invoice rather than by the checkout again.
// ---------------------------------------------------------------------------

async function openCheckout(label, name) {
    const buyer = await person(label);
    const opened = await as('post', '/api/v1/billing/checkout', buyer).send({ tierId: 'developer_pro', billingCycle: 'monthly', seats: 2, newWorkspaceName: name });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    made.orgs.push(opened.body.workspace);
    return { buyer, orgId: opened.body.workspace, params: sessions[sessions.length - 1], name };
}

// The subscription Stripe makes from that checkout, carrying the metadata the
// session asked it to carry (subscription_data.metadata).
function subscriptionFor(checkout, { status }) {
    eventSeq += 1;
    const id = `sub_r6_late_${TAG}_${eventSeq}`;
    const customer = `cus_r6_late_${TAG}_${eventSeq}`;
    const start = nowS();
    const sub = {
        id, object: 'subscription', status, customer, created: start, schedule: null,
        metadata: clone(checkout.params.subscription_data?.metadata || {}),
        items: { data: [{ id: `si_${id}`, quantity: 2, current_period_start: start, current_period_end: start + 30 * DAY, price: { id: TEAM, recurring: { interval: 'month' } } }] },
    };
    world.set(id, sub);
    return sub;
}

const checkoutDone = (checkout, sub) => ({
    id: `evt_r6_late_co_${TAG}_${++eventSeq}`, object: 'event', type: 'checkout.session.completed', created: nowS(),
    data: { object: { id: `cs_late_${TAG}_${eventSeq}`, object: 'checkout.session', mode: 'subscription', customer: sub.customer, subscription: sub.id, metadata: checkout.params.metadata, amount_total: 0, currency: 'usd' } },
});
const subscriptionUpdated = (sub) => ({
    id: `evt_r6_late_upd_${TAG}_${++eventSeq}`, object: 'event', type: 'customer.subscription.updated', created: nowS(),
    data: { object: clone(sub), previous_attributes: { status: 'incomplete' } },
});
const invoicePaid = (sub) => ({
    id: `evt_r6_late_inv_${TAG}_${++eventSeq}`, object: 'event', type: 'invoice.payment_succeeded', created: nowS(),
    data: { object: {
        id: `in_r6_${TAG}_${eventSeq}`, object: 'invoice', customer: sub.customer, subscription: sub.id, billing_reason: 'subscription_create',
        parent: { subscription_details: { subscription: sub.id, metadata: clone(sub.metadata) } },
    } },
});

const countOrgs = async (orgId) => (await q('SELECT COUNT(*)::int AS n FROM organizations WHERE org_id = $1', [orgId])).rows[0].n;

test('the checkout puts the workspace name and founder on the subscription too, so later events carry them', async () => {
    const co = await openCheckout('late0', `Carried ${TAG}`);
    const meta = co.params.subscription_data?.metadata;
    assert.ok(meta, 'subscription_data.metadata is set');
    assert.equal(meta.orgId, co.orgId);
    assert.equal(meta.newWorkspaceName, `Carried ${TAG}`);
    assert.equal(meta.founderUserId, co.buyer.userId);
    assert.equal(co.params.subscription_data.trial_period_days, 14, 'the trial is still requested');
});

test('a card that needed confirmation: checkout completes incomplete, the workspace appears when the subscription turns active', async () => {
    const co = await openCheckout('late1', `Late ${TAG}`);
    const sub = subscriptionFor(co, { status: 'incomplete' });

    const first = await deliver(checkoutDone(co, sub));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(await orgRow(co.orgId), null, 'not live yet: nothing is created');

    const stillIncomplete = await deliver(subscriptionUpdated(sub));
    assert.equal(stillIncomplete.status, 200);
    assert.equal(await orgRow(co.orgId), null, 'an update that is still incomplete creates nothing');

    sub.status = 'active';
    heldDuringRead.length = 0;
    watching = true;
    const activated = await deliver(subscriptionUpdated(sub));
    watching = false;
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.ok(heldDuringRead.length > 0, 'the webhook read Stripe');
    assert.deepEqual(heldDuringRead.filter((n) => n > 0), [], `Stripe is read with no connection held: ${heldDuringRead.join(',')}`);

    const row = await orgRow(co.orgId);
    assert.ok(row, 'the workspace exists once the subscription is live');
    assert.equal(row.name, `Late ${TAG}`);
    assert.equal(row.plan_tier, 'developer_pro');
    assert.equal(row.subscription_status, 'active');
    assert.equal(row.purchased_seats, 2);
    assert.equal(row.stripe_subscription_id, sub.id);
    assert.equal(row.stripe_customer_id, sub.customer);
    assert.deepEqual(await members(co.orgId), [{ user_id: co.buyer.userId, role: 'owner' }]);
    const invite = await as('post', '/api/v1/teams/invite', co.buyer, co.orgId).send({ email: `r6-late-${TAG}@journey-r6.test`, role: 'member' });
    assert.equal(invite.status, 201, `${invite.status} ${JSON.stringify(invite.body)}`);
});

test('a paid invoice is enough too, and nothing is duplicated by the events that follow', async () => {
    const co = await openCheckout('late2', `Invoice ${TAG}`);
    const sub = subscriptionFor(co, { status: 'active' });
    const paid = await deliver(invoicePaid(sub));
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const row = await orgRow(co.orgId);
    assert.ok(row, 'the invoice that shows the subscription live created the workspace');
    assert.equal(row.plan_tier, 'developer_pro');
    assert.deepEqual(await members(co.orgId), [{ user_id: co.buyer.userId, role: 'owner' }]);

    // The checkout completing afterwards, and the subscription update, change nothing.
    assert.equal((await deliver(checkoutDone(co, sub))).status, 200);
    assert.equal((await deliver(subscriptionUpdated(sub))).status, 200);
    assert.equal(await countOrgs(co.orgId), 1);
    assert.equal((await members(co.orgId)).length, 1);
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM context_audit_logs WHERE owner_key = $1 AND action = $2', [co.orgId, 'workspace_created'])).rows[0].n, 1);
    assert.equal((await orgRow(co.orgId)).plan_tier, 'developer_pro');
});

test('an invoice for a subscription that carries no workspace claim still asks Stripe nothing', async () => {
    const stranger = { id: `sub_r6_stranger_${TAG}`, object: 'subscription', status: 'active', customer: `cus_stranger_${TAG}`, metadata: {}, items: { data: [] } };
    world.set(stranger.id, stranger);
    heldDuringRead.length = 0;
    watching = true;
    const res = await deliver({
        id: `evt_r6_stranger_${TAG}`, object: 'event', type: 'invoice.payment_succeeded', created: nowS(),
        data: { object: { id: `in_stranger_${TAG}`, object: 'invoice', customer: stranger.customer, subscription: stranger.id, billing_reason: 'subscription_cycle' } },
    });
    watching = false;
    assert.equal(res.status, 200);
    assert.equal(heldDuringRead.length, 0, 'no Stripe read for an invoice that names no new workspace');
});

test('two events showing the same live subscription at once create one workspace', async () => {
    const co = await openCheckout('late3', `Race ${TAG}`);
    const sub = subscriptionFor(co, { status: 'active' });
    const results = await Promise.all([deliver(subscriptionUpdated(sub)), deliver(invoicePaid(sub)), deliver(checkoutDone(co, sub))]);
    for (const res of results) assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await countOrgs(co.orgId), 1);
    assert.deepEqual(await members(co.orgId), [{ user_id: co.buyer.userId, role: 'owner' }]);
    assert.equal((await orgRow(co.orgId)).plan_tier, 'developer_pro');
    assert.equal((await orgRow(co.orgId)).stripe_subscription_id, sub.id);
});


// A workspace is never lost quietly: when Stripe shows a paid subscription and the
// workspace cannot be created yet, the event stays failed (Stripe redelivers it),
// and the owner of the API is told once.
test('a paid checkout on a price the plan map does not know creates nothing, stays redeliverable, alerts once, and applies once the price is known', async () => {
    const co = await openCheckout('late4', `Unmapped ${TAG}`);
    const sub = subscriptionFor(co, { status: 'active' });
    const knownPrice = sub.items.data[0].price.id;
    sub.items.data[0].price.id = `price_unmapped_${TAG}`;
    const event = subscriptionUpdated(sub);
    const before = sentEmails.length;

    const refused = await deliver(event);
    assert.equal(refused.status, 500, `the event is not closed: ${refused.status} ${JSON.stringify(refused.body)}`);
    assert.equal(await orgRow(co.orgId), null, 'no workspace without a plan to give it');
    const stored = await q('SELECT status FROM stripe_events WHERE event_id = $1', [event.id]);
    assert.equal(stored.rows[0]?.status, 'failed', 'left failed, so Stripe redelivers it');
    const alerts = sentEmails.slice(before).filter((mail) => /Unrecognised Stripe price/.test(mail.subject));
    assert.equal(alerts.length, 1, `the owner is told: ${JSON.stringify(sentEmails.slice(before).map((m) => m.subject))}`);
    assert.match(alerts[0].html, /no workspace was created/i);

    // A redelivery before the price is mapped changes nothing and does not alert again.
    assert.equal((await deliver(event)).status, 500);
    assert.equal(sentEmails.slice(before).filter((mail) => /Unrecognised Stripe price/.test(mail.subject)).length, 1, 'once');

    // The price is mapped (Stripe's subscription is on a price the map knows): the same event applies.
    sub.items.data[0].price.id = knownPrice;
    const applied = await deliver(event);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal((await orgRow(co.orgId))?.plan_tier, 'developer_pro');
});

test('a founder with no account: nothing is created, the event stays redeliverable, and the owner is told once', async () => {
    const co = await openCheckout('late5', `Founderless ${TAG}`);
    const sub = subscriptionFor(co, { status: 'active' });
    sub.metadata.founderUserId = `user-gone-${TAG}`;
    const event = subscriptionUpdated(sub);
    const before = sentEmails.length;

    assert.equal((await deliver(event)).status, 500);
    assert.equal((await deliver(event)).status, 500);
    assert.equal(await orgRow(co.orgId), null);
    const alerts = sentEmails.slice(before).filter((mail) => /not created/i.test(mail.subject));
    assert.equal(alerts.length, 1, `told once: ${JSON.stringify(sentEmails.slice(before).map((m) => m.subject))}`);
    assert.match(alerts[0].html, new RegExp(co.orgId));
});


// A workspace the LATE path creates (checkout incomplete, then the update or the
// invoice) is bought like any other: its purchaser is recorded and the purchase is
// counted once, however many of the events show the subscription live.
test('a workspace created by the late path records its purchaser and counts the purchase once', async () => {
    const co = await openCheckout('late6', `Purchaser ${TAG}`);
    const sub = subscriptionFor(co, { status: 'incomplete' });
    assert.equal((await deliver(checkoutDone(co, sub))).status, 200);
    assert.equal(purchasesFor(co.orgId).length, 0, 'not counted until it is granted');

    sub.status = 'active';
    assert.equal((await deliver(subscriptionUpdated(sub))).status, 200);
    await sleep(200);
    assert.equal(await billingOwnerOf(co.orgId), co.buyer.userId, 'the founder is the billing owner');
    assert.equal(purchasesFor(co.orgId).length, 1, 'the purchase is counted');
    assert.equal(purchasesFor(co.orgId)[0].input.metadata.tier, 'developer_pro');
    assert.equal(purchasesFor(co.orgId)[0].actor.id, co.buyer.userId, 'attributed to the buyer');

    // The other events that show it live change nothing and count nothing more.
    assert.equal((await deliver(invoicePaid(sub))).status, 200);
    assert.equal((await deliver(checkoutDone(co, sub))).status, 200);
    await sleep(200);
    assert.equal(purchasesFor(co.orgId).length, 1, 'once');
    assert.equal(await billingOwnerOf(co.orgId), co.buyer.userId);
});

test('the checkout path still counts its purchase once when an update follows', async () => {
    const co = await openCheckout('late7', `Purchaser2 ${TAG}`);
    const sub = subscriptionFor(co, { status: 'active' });
    assert.equal((await deliver(checkoutDone(co, sub))).status, 200);
    assert.equal((await deliver(subscriptionUpdated(sub))).status, 200);
    assert.equal((await deliver(invoicePaid(sub))).status, 200);
    await sleep(200);
    assert.equal(purchasesFor(co.orgId).length, 1);
    assert.equal(await billingOwnerOf(co.orgId), co.buyer.userId);
});
