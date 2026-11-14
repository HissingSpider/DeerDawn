'use strict';

/**
 * JOURNEY SCAN ROUND 5, BILLING: the owner's two decisions, driven through the
 * real app over a real database.
 *
 * A. A SUBSCRIPTION STRIPE REPORTS AS `incomplete` LOCKS THE WORKSPACE, exactly
 *    as `unpaid` does. The first payment never succeeded, so nothing has been
 *    collected. `paused` keeps access (unchanged). `incomplete_expired` keeps
 *    its own path (the subscription is gone; the workspace is settled by
 *    customer.subscription.deleted). The webhook still reads Stripe before it
 *    opens a transaction and holds no database connection while it does.
 *
 * B. ONE TEAM TRIAL PER WORKSPACE. The trial is recorded on the workspace
 *    (organizations.team_trial_started_at) when Stripe CONFIRMS a trial
 *    subscription (a purchase is counted when granted, not when the checkout
 *    button is pressed). A workspace that has had one goes straight to paid at
 *    its next Team checkout: no trial days reach Stripe. A different, new
 *    workspace is unaffected. Workspaces that had a trial before the column
 *    existed are derived from the retention ledger and the recorded status.
 *
 * Stripe is stubbed at the SDK edge (the real client object, its methods
 * replaced); nothing is sent to Stripe. Webhooks are signed with the test
 * secret, so the real signature check runs.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r5-billing.test.js
 */

if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_journey_r5_billing_stub_never_sent_anywhere';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_journey_r5_billing';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = process.env.STRIPE_PRICE_DEVELOPER_BASIC || 'price_pro_monthly_r5';
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly_r5';

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
const { backfillTeamTrialStartedAt } = require('../../src/config/autoMigrate');

const PRO = process.env.STRIPE_PRICE_DEVELOPER_BASIC;
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
let watchingWebhook = false;
client.subscriptions.retrieve = async (id) => {
    if (watchingWebhook) heldDuringRead.push(db.pool.totalCount - db.pool.idleCount);
    const found = world.get(id);
    if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    return clone(found);
};
client.subscriptions.list = async ({ customer }) => ({
    object: 'list', data: [...world.values()].filter((s) => s.customer === customer).map(clone), has_more: false,
});
const stripeSessions = { checkout: [], portal: [] };
client.subscriptions.update = async () => { throw new Error('no write is expected in this file'); };
// A subscription cancelled in Stripe: the stub moves it to canceled, as Stripe does.
const cancelledInStripe = [];
client.subscriptions.cancel = async (id) => {
    cancelledInStripe.push(id);
    const found = world.get(id);
    if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    found.status = 'canceled';
    return clone(found);
};
// Charges and disputes, for the dispute events.
const charges = new Map();
const disputes = new Map();
let disputeReadFailure = null;
client.charges.retrieve = async (id) => {
    if (watchingWebhook) heldDuringRead.push(db.pool.totalCount - db.pool.idleCount);
    if (disputeReadFailure) throw disputeReadFailure();
    const found = charges.get(id);
    if (!found) throw Object.assign(new Error(`No such charge: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    return clone(found);
};
client.disputes.retrieve = async (id) => {
    if (watchingWebhook) heldDuringRead.push(db.pool.totalCount - db.pool.idleCount);
    if (disputeReadFailure) throw disputeReadFailure();
    const found = disputes.get(id);
    if (!found) throw Object.assign(new Error(`No such dispute: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    return clone(found);
};
client.customers.create = async (params) => ({ id: `cus_r5_new_${TAG}_${crypto.randomBytes(3).toString('hex')}`, ...clone(params || {}) });
client.checkout.sessions.create = async (params) => {
    stripeSessions.checkout.push(clone(params));
    return { id: `cs_r5_${TAG}_${stripeSessions.checkout.length}`, url: 'https://checkout.stripe.com/c/pay/stub' };
};
client.billingPortal.sessions.create = async (params) => {
    stripeSessions.portal.push(clone(params));
    return { id: `bps_r5_${TAG}_${stripeSessions.portal.length}`, url: 'https://billing.stripe.com/p/session/stub' };
};

function sign(payload) {
    const t = nowS();
    const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
    return `t=${t},v1=${v1}`;
}

const httpServer = app.listen(0);
const made = { orgs: [], events: [] };

test.before(async () => {
    await new Promise((r) => (httpServer.listening ? r() : httpServer.once('listening', r)));
});

test.after(async () => {
    await q('DELETE FROM subscription_events WHERE org_id = ANY($1::text[])', [made.orgs]).catch(() => {});
    await q('DELETE FROM stripe_events WHERE event_id = ANY($1::text[])', [made.events]).catch(() => {});
    for (const orgId of made.orgs) {
        await q('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM users WHERE org_id = $1', [orgId]).catch(() => {});
        await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    }
    await new Promise((resolve) => httpServer.close(resolve));
});

/**
 * A workspace with an owner. `paid` puts it on Team, billed by a live Stripe
 * subscription; otherwise it is Free with no subscription.
 */
async function workspaceFor(label, { paid = false, plan = 'developer_pro', price = TEAM, seats = 3 } = {}) {
    const orgId = `org-${uuidv4()}`;
    const customer = `cus_r5_${TAG}_${label}`;
    const subscriptionId = paid ? `sub_r5_${TAG}_${label}` : null;
    const start = nowS() - DAY;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats,
                                    stripe_customer_id, stripe_subscription_id, billing_period_start, billing_period_end, account_type)
         VALUES ($1, $2, $3, $3, 'active', $4, $5, $6, to_timestamp($7), to_timestamp($8), 'organization')`,
        [orgId, `r5 ${label}`, paid ? plan : 'free', paid && plan === 'developer_pro' ? seats : null, customer, subscriptionId, start, start + 30 * DAY],
    );
    made.orgs.push(orgId);
    if (paid) {
        world.set(subscriptionId, {
            id: subscriptionId, object: 'subscription', status: 'active', customer, created: start, metadata: {}, schedule: null,
            items: { data: [{ id: `si_${subscriptionId}`, quantity: seats, current_period_start: start, current_period_end: start + 30 * DAY, price: { id: price, recurring: { interval: 'month' } } }] },
        });
    }
    const userId = `user-${uuidv4()}`;
    await q(
        'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
        [userId, `r5-owner-${label}-${TAG}@journey-r5.test`, await hashPassword('password123'), 'admin', orgId],
    );
    await workspace.ensureOwnerMembership(orgId, userId);
    await invalidateOrgCache(orgId).catch(() => {});
    const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin' });
    return { label, orgId, customer, subscriptionId, userId, jwt };
}

async function row(orgId) {
    const res = await q('SELECT plan_tier, subscription_status, stripe_subscription_id FROM organizations WHERE org_id = $1', [orgId]);
    return res.rows[0];
}

async function trialRow(orgId) {
    const res = await q('SELECT plan_tier, subscription_status, stripe_subscription_id, team_trial_started_at FROM organizations WHERE org_id = $1', [orgId]);
    return res.rows[0];
}

let eventSeq = 0;
const eventId = (kind) => `evt_r5_${kind}_${TAG}_${(eventSeq += 1)}`;
async function deliver(event) {
    made.events.push(event.id);
    const payload = JSON.stringify(event);
    watchingWebhook = true;
    try {
        const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/v1/webhooks/stripe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
            body: payload,
        });
        const body = await res.json().catch(() => null);
        await sleep(120); // the ledger is written after COMMIT, unawaited
        return { status: res.status, body };
    } finally {
        watchingWebhook = false;
    }
}

/** Stripe moves the subscription to `status`; the update event that reports it arrives. */
async function stripeSays(ws, status) {
    const sub = world.get(ws.subscriptionId);
    const was = sub.status;
    sub.status = status;
    const res = await deliver({
        id: eventId('upd'), object: 'event', type: 'customer.subscription.updated', created: nowS(),
        data: { object: clone(sub), previous_attributes: { status: was } },
    });
    assert.equal(res.status, 200, `${ws.label}: Stripe says ${status}: ${JSON.stringify(res.body)}`);
}

/** What the workspace can actually do: open its project list, the portfolio, and invite. */
async function use(ws) {
    await invalidateOrgCache(ws.orgId).catch(() => {});
    const projects = await request(httpServer).get('/api/v1/context/projects').set('Authorization', `Bearer ${ws.jwt}`);
    const invite = await request(httpServer)
        .post('/api/v1/teams/invite')
        .set('Authorization', `Bearer ${ws.jwt}`)
        .send({ email: `r5-invitee-${crypto.randomBytes(3).toString('hex')}-${TAG}@journey-r5.test`, role: 'member' });
    if (invite.status === 201 && invite.body?.member?.id) {
        await request(httpServer).delete(`/api/v1/teams/invites/${invite.body.member.id}`).set('Authorization', `Bearer ${ws.jwt}`);
    }
    const describe = (res) => (res.status === 200 || res.status === 201 ? 'ok' : `${res.status} ${res.body?.error || ''}`.trim());
    return { workspace: describe(projects), invite: describe(invite) };
}

// ---------------------------------------------------------------------------
// A. incomplete locks; paused does not.
// ---------------------------------------------------------------------------

for (const c of [
    { name: 'Team', plan: 'developer_pro', price: TEAM, seats: 3 },
    { name: 'Pro', plan: 'developer_basic', price: PRO, seats: 1 },
]) {
    test(`decision A: a ${c.name} subscription Stripe reports as incomplete LOCKS the workspace, as unpaid does; paying unlocks it`, async () => {
        const incomplete = await workspaceFor(`${c.name}-incomplete`, { paid: true, ...c });
        const unpaid = await workspaceFor(`${c.name}-unpaid`, { paid: true, ...c });
        assert.deepEqual(await use(incomplete), await use(unpaid), 'the two workspaces differ before any event');
        assert.equal((await use(incomplete)).workspace, 'ok');

        await stripeSays(unpaid, 'unpaid');
        await stripeSays(incomplete, 'incomplete');
        assert.equal((await row(incomplete.orgId)).subscription_status, 'incomplete', 'the status is Stripe\'s');
        assert.equal((await row(incomplete.orgId)).plan_tier, c.plan, 'the plan is kept: the status alone decides the lock');
        const locked = await use(incomplete);
        assert.equal(locked.workspace, '403 subscription_inactive', `an incomplete ${c.name} workspace answered ${locked.workspace}`);
        assert.deepEqual(locked, await use(unpaid), 'incomplete must behave exactly like unpaid');

        await stripeSays(incomplete, 'active');
        assert.equal((await use(incomplete)).workspace, 'ok', 'the payment went through and the workspace is still locked');
    });
}

test('decision A: paused keeps access (unchanged)', async () => {
    const ws = await workspaceFor('paused', { paid: true });
    await stripeSays(ws, 'paused');
    assert.equal((await row(ws.orgId)).subscription_status, 'paused');
    const now = await use(ws);
    assert.equal(now.workspace, 'ok', `a paused workspace answered ${now.workspace}`);
    assert.equal(now.invite, 'ok');
});

test('decision A: an incomplete workspace is told the first payment did not go through, and is offered checkout again for the same plan', async () => {
    const ws = await workspaceFor('incomplete-message', { paid: true });
    await stripeSays(ws, 'incomplete');
    await invalidateOrgCache(ws.orgId).catch(() => {});
    const refused = await request(httpServer).get('/api/v1/context/projects').set('Authorization', `Bearer ${ws.jwt}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'subscription_inactive', 'the same error code as unpaid, so every screen that reads it still recognises a lock');
    assert.equal(refused.body.subscription_status, 'incomplete');
    assert.equal(refused.body.message, 'The first payment for this subscription did not go through. Check out again to finish setting it up.');
    assert.deepEqual(refused.body.retry_checkout, { plan: 'developer_pro', seats: 3 }, 'the refusal names what to check out again');
    assert.equal(refused.body.upgrade_required, true);

    // An unpaid workspace keeps the billing sentence and offers no retry.
    const unpaid = await workspaceFor('unpaid-message', { paid: true });
    await stripeSays(unpaid, 'unpaid');
    await invalidateOrgCache(unpaid.orgId).catch(() => {});
    const unpaidRefused = await request(httpServer).get('/api/v1/context/projects').set('Authorization', `Bearer ${unpaid.jwt}`);
    assert.equal(unpaidRefused.body.message, 'Your subscription is not active. Update billing to restore access.');
    assert.equal(unpaidRefused.body.retry_checkout, undefined);
});

test('decision A: incomplete_expired keeps its own path: the workspace is settled by the deletion, and is usable as Free', async () => {
    const ws = await workspaceFor('incomplete-expired', { paid: true });
    await stripeSays(ws, 'incomplete');
    assert.equal((await use(ws)).workspace, '403 subscription_inactive');
    const sub = world.get(ws.subscriptionId);
    sub.status = 'incomplete_expired';
    const expired = await deliver({
        id: eventId('exp'), object: 'event', type: 'customer.subscription.updated', created: nowS(),
        data: { object: clone(sub), previous_attributes: { status: 'incomplete' } },
    });
    assert.equal(expired.status, 200, JSON.stringify(expired.body));
    const gone = await deliver({
        id: eventId('del'), object: 'event', type: 'customer.subscription.deleted', created: nowS(),
        data: { object: clone(sub) },
    });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    const after = await row(ws.orgId);
    assert.equal(after.plan_tier, 'free');
    assert.equal(after.subscription_status, 'cancelled');
    assert.equal((await use(ws)).workspace, 'ok', 'a Free workspace is not locked');
});

test('decision A: every place that decides the lock uses one list: incomplete is in it, paused and trialing are not', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { INACTIVE_STATUSES } = require('../../src/services/entitlementService');
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'services', 'enforcementService.js'), 'utf8');
    const gate = src.match(/\[([^\]]*)\]\s*\.includes\(org\.subscription_status\)/);
    assert.ok(gate, 'enforcement must still gate on a subscription_status list');
    const gated = new Set([...gate[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    assert.deepEqual([...gated].sort(), [...INACTIVE_STATUSES].sort(), 'the gate and the entitlements disagree about which statuses lock');
    assert.ok(INACTIVE_STATUSES.has('incomplete'));
    assert.ok(INACTIVE_STATUSES.has('unpaid'));
    assert.ok(!INACTIVE_STATUSES.has('paused'));
    assert.ok(!INACTIVE_STATUSES.has('trialing'));
});

test('decision A: the webhook reads Stripe before it opens a transaction, and holds no connection while it does', async () => {
    const ws = await workspaceFor('read-first', { paid: true });
    heldDuringRead.length = 0;
    await stripeSays(ws, 'incomplete');
    assert.ok(heldDuringRead.length > 0, 'the webhook did not read Stripe at all');
    assert.deepEqual(heldDuringRead.filter((n) => n > 0), [],
        `connections checked out while Stripe was being read: ${heldDuringRead.join(',')}`);
    assert.equal((await row(ws.orgId)).subscription_status, 'incomplete');
});

// ---------------------------------------------------------------------------
// B. One Team trial per workspace.
// ---------------------------------------------------------------------------

/** The workspace buys Team, and Stripe puts it on a trial: the events that report it arrive. */
async function stripeGrantsTeamTrial(ws, { seats = 2, suffix = 'trial' } = {}) {
    const subscriptionId = `sub_r5_${TAG}_${ws.label}_${suffix}`;
    const start = nowS();
    world.set(subscriptionId, {
        id: subscriptionId, object: 'subscription', status: 'trialing', customer: ws.customer, created: start, metadata: {}, schedule: null,
        trial_start: start, trial_end: start + 14 * DAY,
        items: { data: [{ id: `si_${subscriptionId}`, quantity: seats, current_period_start: start, current_period_end: start + 14 * DAY, price: { id: TEAM, recurring: { interval: 'month' } } }] },
    });
    const res = await deliver({
        id: eventId('cs'), object: 'event', type: 'checkout.session.completed', created: nowS(),
        data: { object: { id: `cs_${TAG}_${ws.label}_${suffix}`, object: 'checkout.session', mode: 'subscription', customer: ws.customer, subscription: subscriptionId, amount_total: 0, currency: 'usd', metadata: { orgId: ws.orgId, tierId: 'developer_pro', billingCycle: 'monthly', seats: String(seats) } } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return subscriptionId;
}

const checkoutFor = (ws, headers = {}) => request(httpServer)
    .post('/api/v1/billing/checkout')
    .set('Authorization', `Bearer ${ws.jwt}`)
    .set(headers)
    .send({ tierId: 'developer_pro', billingCycle: 'monthly', seats: 2 });

const trialDaysOf = (session) => session.subscription_data?.trial_period_days ?? null;

test('decision B: a workspace that has never had a trial is offered one, and pressing the checkout button records nothing', async () => {
    const ws = await workspaceFor('fresh');
    assert.equal((await trialRow(ws.orgId)).team_trial_started_at, null);
    const res = await checkoutFor(ws);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const session = stripeSessions.checkout.at(-1);
    assert.equal(session.metadata.orgId, ws.orgId);
    assert.equal(trialDaysOf(session), 14, 'the first Team checkout of a workspace carries the trial');
    assert.equal(new URL(session.success_url.replace('{CHECKOUT_SESSION_ID}', 'cs_x')).searchParams.get('trial'), '1');
    assert.equal((await trialRow(ws.orgId)).team_trial_started_at, null,
        'a purchase is counted only when granted: the click is not the grant');
});

test('decision B: the trial is recorded when Stripe confirms it, and the next Team checkout goes straight to paid', async () => {
    const ws = await workspaceFor('used');
    await stripeGrantsTeamTrial(ws);
    const after = await trialRow(ws.orgId);
    assert.equal(after.subscription_status, 'trialing');
    assert.ok(after.team_trial_started_at instanceof Date, `team_trial_started_at: ${after.team_trial_started_at}`);

    // The trial ends without converting: Stripe deletes the subscription, and
    // the workspace is Free again with nothing to pay for.
    const subscriptionId = after.stripe_subscription_id;
    const sub = world.get(subscriptionId);
    sub.status = 'canceled';
    const gone = await deliver({
        id: eventId('del'), object: 'event', type: 'customer.subscription.deleted', created: nowS(),
        data: { object: clone(sub) },
    });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    const free = await trialRow(ws.orgId);
    assert.equal(free.plan_tier, 'free');
    assert.equal(free.stripe_subscription_id, null);
    assert.equal(free.team_trial_started_at.getTime(), after.team_trial_started_at.getTime(), 'churn must not forget the trial');

    const res = await checkoutFor(ws);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const session = stripeSessions.checkout.at(-1);
    assert.equal(session.metadata.orgId, ws.orgId);
    assert.equal(trialDaysOf(session), null, `trial days reached Stripe: ${JSON.stringify(session.subscription_data)}`);
    assert.equal(session.subscription_data?.trial_period_days, undefined);
    assert.equal(new URL(session.success_url.replace('{CHECKOUT_SESSION_ID}', 'cs_x')).searchParams.get('trial'), null,
        'the success page must not announce a trial that was not granted');
});

test('decision B: a trial that converted to paid still counts: a workspace that is paying Team has had its trial', async () => {
    const ws = await workspaceFor('converted');
    const subscriptionId = await stripeGrantsTeamTrial(ws, { suffix: 'conv' });
    const sub = world.get(subscriptionId);
    sub.status = 'active';
    // Stripe keeps trial_start on the subscription after it converts.
    const updated = await deliver({
        id: eventId('upd'), object: 'event', type: 'customer.subscription.updated', created: nowS(),
        data: { object: clone(sub), previous_attributes: { status: 'trialing' } },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const now = await trialRow(ws.orgId);
    assert.equal(now.subscription_status, 'active');
    assert.ok(now.team_trial_started_at, 'the trial is forgotten once the subscription converts');
});

test('decision B: a subscription that never trialed does not record a trial', async () => {
    const ws = await workspaceFor('never', { paid: true });
    await stripeSays(ws, 'past_due');
    await stripeSays(ws, 'active');
    assert.equal((await trialRow(ws.orgId)).team_trial_started_at, null);
    const pro = await workspaceFor('never-pro', { paid: true, plan: 'developer_basic', price: PRO, seats: 1 });
    await stripeSays(pro, 'unpaid');
    assert.equal((await trialRow(pro.orgId)).team_trial_started_at, null);
});

test('decision B: a person who used one workspace\'s trial may start a trial in a different, new workspace', async () => {
    const used = await workspaceFor('person-used');
    await stripeGrantsTeamTrial(used, { suffix: 'a' });
    assert.ok((await trialRow(used.orgId)).team_trial_started_at);

    // The same person owns a second workspace that has never had one.
    const second = `org-${uuidv4()}`;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
         VALUES ($1, 'r5 second', 'free', 'free', 'active', 'organization')`,
        [second],
    );
    made.orgs.push(second);
    await workspace.ensureOwnerMembership(second, used.userId);
    const res = await checkoutFor(used, { 'x-deerdawn-workspace': second });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const session = stripeSessions.checkout.at(-1);
    assert.equal(session.metadata.orgId, second, 'precondition: the checkout is for the new workspace');
    assert.equal(trialDaysOf(session), 14, 'the new workspace was refused a trial because ANOTHER workspace had one');
});

test('decision B: the workspace answers what it has had, for the dashboard to say the truth', async () => {
    const ws = await workspaceFor('exposed');
    const before = await request(httpServer).get('/api/v1/orgs/usage').set('Authorization', `Bearer ${ws.jwt}`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.plan.team_trial_started_at, null);
    await stripeGrantsTeamTrial(ws, { suffix: 'x' });
    const after = await request(httpServer).get('/api/v1/orgs/usage').set('Authorization', `Bearer ${ws.jwt}`);
    assert.ok(after.body.plan.team_trial_started_at, `plan.team_trial_started_at: ${JSON.stringify(after.body.plan)}`);
    const boot = await request(httpServer).get('/api/v1/dashboard/bootstrap').set('Authorization', `Bearer ${ws.jwt}`);
    if (boot.status === 200) {
        assert.ok(boot.body.org.team_trial_started_at, `bootstrap org.team_trial_started_at: ${JSON.stringify(boot.body.org)}`);
    }
});

test('decision B: workspaces that had a trial before the column existed are derived from the ledger and the recorded status', async () => {
    const ledgerTrial = await workspaceFor('old-ledger');
    const ledgerPaid = await workspaceFor('old-paid');
    const trialingNow = await workspaceFor('old-trialing');
    const proOnly = await workspaceFor('old-pro');
    const at = new Date(Date.now() - 40 * DAY * 1000);
    const later = new Date(Date.now() - 20 * DAY * 1000);
    const ledger = (orgId, type, tier, mrr, when) => q(
        'INSERT INTO subscription_events (org_id, event_type, plan_tier, mrr_cents, stripe_event_id, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, type, tier, mrr, `evt_r5_ledger_${TAG}_${crypto.randomBytes(4).toString('hex')}`, when],
    );
    // A Team trial books ZERO at creation; the conversion is a later paid row.
    await ledger(ledgerTrial.orgId, 'created', 'developer_pro', 0, at);
    await ledger(ledgerTrial.orgId, 'renewed', 'developer_pro', 6000, later);
    await ledger(ledgerPaid.orgId, 'created', 'developer_pro', 6000, at);
    await ledger(proOnly.orgId, 'created', 'developer_basic', 1200, at);
    await q('UPDATE organizations SET subscription_status = \'trialing\', plan_tier = \'developer_pro\', plan = \'developer_pro\', billing_period_start = to_timestamp($2) WHERE org_id = $1',
        [trialingNow.orgId, Math.floor(at.getTime() / 1000)]);

    const conn = await db.pool.connect();
    try {
        const count = await backfillTeamTrialStartedAt(conn);
        assert.ok(count >= 2, `backfilled ${count}`);
        // A second run changes nothing (a value already recorded is never moved).
        assert.equal(await backfillTeamTrialStartedAt(conn), 0);
    } finally {
        conn.release();
    }

    const started = async (ws) => (await trialRow(ws.orgId)).team_trial_started_at;
    assert.equal((await started(ledgerTrial))?.getTime(), at.getTime(), 'the ledger\'s zero-value Team purchase is the trial, at its own time');
    assert.equal(await started(ledgerPaid), null, 'a Team purchase that booked money never trialed');
    assert.equal(await started(proOnly), null);
    assert.ok(await started(trialingNow), 'a workspace Stripe last said is trialing has had its trial');
    // What it does for the buyer.
    await checkoutFor(ledgerTrial);
    assert.equal(trialDaysOf(stripeSessions.checkout.at(-1)), null, 'a workspace derived as having had a trial was offered another');
    await checkoutFor(ledgerPaid);
    assert.equal(trialDaysOf(stripeSessions.checkout.at(-1)), 14, 'a workspace that never trialed lost its trial to the backfill');
});

// ---------------------------------------------------------------------------
// A (owner's answer, 2026-09-29). An incomplete workspace CHECKS OUT AGAIN.
// ---------------------------------------------------------------------------

const checkoutBody = (ws, body, headers = {}) => request(httpServer)
    .post('/api/v1/billing/checkout')
    .set('Authorization', `Bearer ${ws.jwt}`)
    .set(headers)
    .send(body);

test('decision A: checking out again from an incomplete workspace opens a checkout for the same plan, ends the unfinished subscription, and adopts nothing', async () => {
    const ws = await workspaceFor('retry', { paid: true, seats: 3 });
    await stripeSays(ws, 'incomplete');
    const before = await trialRow(ws.orgId);
    const sessions = stripeSessions.checkout.length;
    const portals = stripeSessions.portal.length;
    const cancelled = cancelledInStripe.length;

    const res = await checkoutBody(ws, { tierId: 'developer_pro', billingCycle: 'monthly', seats: 3 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.url, 'https://checkout.stripe.com/c/pay/stub', 'a checkout, not the billing portal and not a refusal');
    assert.equal(res.body.portal, undefined);
    assert.equal(stripeSessions.portal.length, portals, 'the billing portal was opened');
    assert.equal(stripeSessions.checkout.length, sessions + 1);
    const session = stripeSessions.checkout.at(-1);
    assert.equal(session.metadata.orgId, ws.orgId);
    assert.equal(session.metadata.tierId, 'developer_pro', 'the same plan');
    assert.equal(session.line_items[0].quantity, 3, 'the same seats');

    // THE UNFINISHED SUBSCRIPTION MUST NOT COMPLETE LATER BESIDE THE NEW ONE.
    assert.deepEqual(cancelledInStripe.slice(cancelled), [ws.subscriptionId], 'the incomplete subscription was left open: paying it later would be a second subscription');
    assert.equal(world.get(ws.subscriptionId).status, 'canceled');

    // Nothing was adopted from it, and the row still says what Stripe told it.
    const after = await trialRow(ws.orgId);
    assert.equal(after.stripe_subscription_id, before.stripe_subscription_id);
    assert.equal(after.subscription_status, 'incomplete');
    assert.equal(after.team_trial_started_at, null, 'an unfinished subscription is not a trial');

    // Pressing it twice does not cancel anything twice: it is already ended.
    const again = await checkoutBody(ws, { tierId: 'developer_pro', billingCycle: 'monthly', seats: 3 });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(cancelledInStripe.length, cancelled + 1);
});

test('decision A: the retry may name any plan, since nothing was paid for the recorded one', async () => {
    const ws = await workspaceFor('retry-pro', { paid: true, seats: 3 });
    await stripeSays(ws, 'incomplete');
    const res = await checkoutBody(ws, { tierId: 'developer_basic', billingCycle: 'monthly' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(stripeSessions.checkout.at(-1).metadata.tierId, 'developer_basic');
});

test('decision A: when Stripe says the recorded subscription is paid after all, checkout again adopts it and opens nothing', async () => {
    const ws = await workspaceFor('retry-paid', { paid: true, seats: 3 });
    await stripeSays(ws, 'incomplete');
    // Stripe moves on without an event reaching the row (a late webhook).
    world.get(ws.subscriptionId).status = 'active';
    const sessions = stripeSessions.checkout.length;
    const cancelled = cancelledInStripe.length;
    const res = await checkoutBody(ws, { tierId: 'developer_pro', billingCycle: 'monthly', seats: 3 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.updated, false, JSON.stringify(res.body));
    assert.equal(res.body.url, null);
    assert.equal(stripeSessions.checkout.length, sessions, 'a paid subscription was charged for again');
    assert.equal(cancelledInStripe.length, cancelled, 'a paid subscription was cancelled');
    assert.equal((await row(ws.orgId)).subscription_status, 'active');
});

test('decision A: an unpaid workspace still cannot change plan from the plan page (refused as overdue, billing portal)', async () => {
    const ws = await workspaceFor('unpaid-change', { paid: true });
    await stripeSays(ws, 'unpaid');
    const change = await checkoutBody(ws, { tierId: 'developer_pro', seats: 5 });
    assert.equal(change.status, 402, JSON.stringify(change.body));
    assert.equal(change.body.error, 'payment_overdue');
    assert.equal(change.body.billing_portal, true);
    const portal = await request(httpServer).post('/api/v1/billing/portal').set('Authorization', `Bearer ${ws.jwt}`).send({});
    assert.equal(portal.status, 200, 'a locked workspace must still reach the billing portal');
});

// ---------------------------------------------------------------------------
// B (owner's answer). The trial gap: checkout learns of a trial from the
// subscription list it already reads.
// ---------------------------------------------------------------------------

test('decision B gap: a trial the webhook never recorded is found in the subscription list checkout already reads, and the checkout charges from the start', async () => {
    const ws = await workspaceFor('gap');
    const old = `sub_r5_${TAG}_gap_old`;
    const start = nowS() - 60 * DAY;
    world.set(old, {
        id: old, object: 'subscription', status: 'canceled', customer: ws.customer, created: start, metadata: {}, schedule: null,
        trial_start: start, trial_end: start + 14 * DAY,
        items: { data: [{ id: `si_${old}`, quantity: 2, current_period_start: start, current_period_end: start + 14 * DAY, price: { id: TEAM, recurring: { interval: 'month' } } }] },
    });
    assert.equal((await trialRow(ws.orgId)).team_trial_started_at, null, 'precondition: DeerDawn has no record of it');

    const lists = [];
    const realList = client.subscriptions.list;
    client.subscriptions.list = async (params) => { lists.push(params); return realList(params); };
    try {
        const res = await checkoutFor(ws);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(lists.length, 1, 'checkout made a Stripe read it did not make before');
    } finally {
        client.subscriptions.list = realList;
    }
    const session = stripeSessions.checkout.at(-1);
    assert.equal(session.metadata.orgId, ws.orgId);
    assert.equal(trialDaysOf(session), null, `a trial was offered to a workspace Stripe says had one: ${JSON.stringify(session.subscription_data)}`);
    assert.equal((await trialRow(ws.orgId)).team_trial_started_at.getTime(), start * 1000);
});

test('decision B gap: a live trialing subscription the row does not know is adopted and recorded as the trial', async () => {
    const ws = await workspaceFor('gap-live');
    const live = `sub_r5_${TAG}_gap_live`;
    const start = nowS() - DAY;
    world.set(live, {
        id: live, object: 'subscription', status: 'trialing', customer: ws.customer, created: start, metadata: {}, schedule: null,
        trial_start: start, trial_end: start + 14 * DAY,
        items: { data: [{ id: `si_${live}`, quantity: 2, current_period_start: start, current_period_end: start + 14 * DAY, price: { id: TEAM, recurring: { interval: 'month' } } }] },
    });
    const sessions = stripeSessions.checkout.length;
    const res = await checkoutFor(ws);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.updated, false, JSON.stringify(res.body));
    assert.equal(res.body.url, null);
    assert.equal(stripeSessions.checkout.length, sessions, 'a second subscription was opened beside the trial');
    assert.ok((await trialRow(ws.orgId)).team_trial_started_at);
});

test('decision B gap: a customer whose past subscriptions never trialed is still offered the trial', async () => {
    const ws = await workspaceFor('gap-none');
    const old = `sub_r5_${TAG}_gap_none_old`;
    const start = nowS() - 60 * DAY;
    world.set(old, {
        id: old, object: 'subscription', status: 'canceled', customer: ws.customer, created: start, metadata: {}, schedule: null,
        items: { data: [{ id: `si_${old}`, quantity: 1, current_period_start: start, current_period_end: start + 30 * DAY, price: { id: PRO, recurring: { interval: 'month' } } }] },
    });
    const res = await checkoutFor(ws);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(trialDaysOf(stripeSessions.checkout.at(-1)), 14);
    assert.equal((await trialRow(ws.orgId)).team_trial_started_at, null);
});

// ---------------------------------------------------------------------------
// 3. A dispute lock is its own lock.
// ---------------------------------------------------------------------------

let disputeSeq = 0;
function stripeHasDispute(ws, status = 'needs_response') {
    disputeSeq += 1;
    const id = `dp_r5_${TAG}_${disputeSeq}`;
    const chargeId = `ch_r5_${TAG}_${disputeSeq}`;
    charges.set(chargeId, { id: chargeId, object: 'charge', customer: ws.customer });
    disputes.set(id, { id, object: 'dispute', charge: chargeId, status });
    return { id, chargeId };
}
const disputeEvent = (type, dispute, status) => ({
    id: eventId('dp'), object: 'event', type, created: nowS(),
    data: { object: { id: dispute.id, object: 'dispute', charge: dispute.chargeId, status: status || disputes.get(dispute.id).status } },
});
async function withdrawn(dispute) {
    const res = await deliver(disputeEvent('charge.dispute.funds_withdrawn', dispute));
    assert.equal(res.status, 200, JSON.stringify(res.body));
}
async function closed(dispute, status) {
    disputes.get(dispute.id).status = status;
    const res = await deliver(disputeEvent('charge.dispute.closed', dispute, status));
    assert.equal(res.status, 200, JSON.stringify(res.body));
}
async function lockState(orgId) {
    const res = await q('SELECT is_locked, dispute_lock_ids FROM organizations WHERE org_id = $1', [orgId]);
    return { is_locked: res.rows[0].is_locked, dispute_lock_ids: res.rows[0].dispute_lock_ids };
}
const getProjects = (ws) => invalidateOrgCache(ws.orgId).catch(() => {})
    .then(() => request(httpServer).get('/api/v1/context/projects').set('Authorization', `Bearer ${ws.jwt}`));
const patchSettings = (ws, body) => request(httpServer).patch('/api/v1/orgs/settings').set('Authorization', `Bearer ${ws.jwt}`).send(body);

const DISPUTE_MESSAGE = 'This workspace is locked because a payment on this account was disputed with the card issuer. '
    + 'Billing cannot lift it. Email support from the address on this account and we will review it.';
const LOCKDOWN_MESSAGE = 'This workspace was locked on purpose by an owner of this account. Ask an owner to turn lockdown off. '
    + 'If you are the owner and did not do this, email support.';
const FOREIGN_MESSAGE = 'The workspace you are using is locked, so nothing in it will load. '
    + 'Switch to your own workspace to keep working, or ask its owner to lift the lock.';

test('decision 3: a dispute locks the workspace on its own column, with its own reason, and the owner cannot clear it through the lockdown setting', async () => {
    const ws = await workspaceFor('dp-lock', { paid: true });
    assert.equal((await getProjects(ws)).status, 200);
    const dispute = stripeHasDispute(ws);
    await withdrawn(dispute);

    const state = await lockState(ws.orgId);
    assert.equal(state.is_locked, false, 'the dispute must not be stored in the owner\'s lockdown switch');
    assert.deepEqual(state.dispute_lock_ids, [dispute.id]);
    const locked = await getProjects(ws);
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error, 'lockdown_active', 'the error code every screen already recognises');
    assert.equal(locked.body.lock_reason, 'dispute');
    assert.equal(locked.body.message, DISPUTE_MESSAGE);

    // The owner's lockdown setting, on and off, does not touch it.
    assert.equal((await patchSettings(ws, { is_locked: false })).status, 200);
    assert.equal((await getProjects(ws)).body.lock_reason, 'dispute');
    assert.equal((await patchSettings(ws, { is_locked: true })).status, 200);
    assert.equal((await getProjects(ws)).body.lock_reason, 'dispute', 'with both, billing cannot lift it: the dispute is what the person is told');
    assert.equal((await patchSettings(ws, { is_locked: false })).status, 200);
    assert.deepEqual((await lockState(ws.orgId)).dispute_lock_ids, [dispute.id], 'the owner\'s settings cleared the dispute lock');
    assert.equal((await getProjects(ws)).status, 403);

    // Redelivery of the same event is not a second lock.
    await withdrawn(dispute);
    assert.deepEqual((await lockState(ws.orgId)).dispute_lock_ids, [dispute.id]);
});

for (const outcome of ['won', 'warning_closed']) {
    test(`decision 3: charge.dispute.closed as ${outcome} lifts that dispute's lock by itself`, async () => {
        const ws = await workspaceFor(`dp-${outcome}`, { paid: true });
        const dispute = stripeHasDispute(ws);
        await withdrawn(dispute);
        assert.equal((await getProjects(ws)).status, 403);
        await closed(dispute, outcome);
        assert.deepEqual(await lockState(ws.orgId), { is_locked: false, dispute_lock_ids: [] });
        assert.equal((await getProjects(ws)).status, 200, 'the dispute was resolved in our favour and the workspace is still locked');
    });
}

test('decision 3: a LOST dispute keeps the workspace locked until DeerDawn lifts it by hand', async () => {
    const ws = await workspaceFor('dp-lost', { paid: true });
    const dispute = stripeHasDispute(ws);
    await withdrawn(dispute);
    await closed(dispute, 'lost');
    assert.deepEqual((await lockState(ws.orgId)).dispute_lock_ids, [dispute.id]);
    assert.equal((await getProjects(ws)).status, 403);
    // The runbook line (docs/RUNBOOK.md, "Disputes"): clear the array.
    await q('UPDATE organizations SET dispute_lock_ids = \'{}\', dispute_locked_at = NULL WHERE org_id = $1', [ws.orgId]);
    assert.equal((await getProjects(ws)).status, 200);
});

test('decision 3: a lost dispute is locked even when the funds_withdrawn event never arrived', async () => {
    const ws = await workspaceFor('dp-lost-only', { paid: true });
    const dispute = stripeHasDispute(ws);
    await closed(dispute, 'lost');
    assert.deepEqual((await lockState(ws.orgId)).dispute_lock_ids, [dispute.id]);
});

test('decision 3: each dispute holds its own lock: winning one leaves the other', async () => {
    const ws = await workspaceFor('dp-two', { paid: true });
    const a = stripeHasDispute(ws);
    const b = stripeHasDispute(ws);
    await withdrawn(a);
    await withdrawn(b);
    assert.deepEqual((await lockState(ws.orgId)).dispute_lock_ids.sort(), [a.id, b.id].sort());
    await closed(a, 'won');
    assert.deepEqual((await lockState(ws.orgId)).dispute_lock_ids, [b.id]);
    assert.equal((await getProjects(ws)).status, 403);
    await closed(b, 'won');
    assert.equal((await getProjects(ws)).status, 200);
});

test('decision 3: winning a dispute does not lift the owner\'s own lockdown', async () => {
    const ws = await workspaceFor('dp-and-lockdown', { paid: true });
    assert.equal((await patchSettings(ws, { is_locked: true })).status, 200);
    const dispute = stripeHasDispute(ws);
    await withdrawn(dispute);
    await closed(dispute, 'won');
    const res = await getProjects(ws);
    assert.equal(res.status, 403);
    assert.equal(res.body.lock_reason, 'lockdown');
    assert.equal(res.body.message, LOCKDOWN_MESSAGE);
    assert.deepEqual(await lockState(ws.orgId), { is_locked: true, dispute_lock_ids: [] });
    assert.equal((await patchSettings(ws, { is_locked: false })).status, 200);
    assert.equal((await getProjects(ws)).status, 200);
});

test('decision 3: a dispute Stripe already shows as won when the withdrawal arrives late locks nothing', async () => {
    const ws = await workspaceFor('dp-late', { paid: true });
    const dispute = stripeHasDispute(ws, 'won');
    await withdrawn(dispute);
    assert.deepEqual(await lockState(ws.orgId), { is_locked: false, dispute_lock_ids: [] });
    assert.equal((await getProjects(ws)).status, 200);
});

test('decision 3: the dispute is read from Stripe before the transaction opens, with no connection held; a refused read stays redeliverable', async () => {
    const ws = await workspaceFor('dp-read', { paid: true });
    const dispute = stripeHasDispute(ws);
    heldDuringRead.length = 0;
    await withdrawn(dispute);
    assert.ok(heldDuringRead.length > 0, 'the webhook did not read Stripe for the dispute');
    assert.deepEqual(heldDuringRead.filter((n) => n > 0), [], `connections held during the read: ${heldDuringRead.join(',')}`);

    const other = await workspaceFor('dp-refused', { paid: true });
    const refused = stripeHasDispute(other);
    disputeReadFailure = () => Object.assign(new Error('This API key does not have access to charges'), { type: 'StripePermissionError', statusCode: 403 });
    const event = { ...disputeEvent('charge.dispute.funds_withdrawn', refused), created: nowS() - 25 * 3600 };
    try {
        for (let i = 0; i < 2; i += 1) {
            const res = await deliver(event);
            assert.ok(res.status >= 500, `delivery ${i + 1} answered ${res.status}`);
        }
    } finally {
        disputeReadFailure = null;
    }
    assert.deepEqual((await lockState(other.orgId)).dispute_lock_ids, [], 'nothing may be written while Stripe refuses');
    const stored = await q('SELECT status FROM stripe_events WHERE event_id = $1', [event.id]);
    assert.equal(stored.rows[0]?.status, 'failed', 'the event must stay redeliverable');
    await sleep(150);
    assert.equal(sentEmails.filter((m) => m.emailType === 'stripe_event_not_applied_alert' && m.subject.includes(event.id)).length, 1, 'the owner is alerted once after 24 hours');
    const applied = await deliver(event);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual((await lockState(other.orgId)).dispute_lock_ids, [refused.id]);
});

// ---------------------------------------------------------------------------
// 4. What the person is told, by reason.
// ---------------------------------------------------------------------------

test('decision 4: an owner\'s lockdown says it was on purpose, and who can turn it off', async () => {
    const ws = await workspaceFor('lockdown-text', { paid: true });
    assert.equal((await patchSettings(ws, { is_locked: true })).status, 200);
    const res = await getProjects(ws);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'lockdown_active');
    assert.equal(res.body.lock_reason, 'lockdown');
    assert.equal(res.body.message, LOCKDOWN_MESSAGE);
});

test('decision 4: somebody else\'s locked workspace says so, and points at the person\'s own', async () => {
    const { evaluatePlanEnforcement } = require('../../src/middleware/enforcePlan');
    const team = await workspaceFor('foreign-team', { paid: true });
    const member = await workspaceFor('foreign-member');
    await workspace.addMember(team.orgId, member.userId, { role: 'member' });
    assert.equal((await patchSettings(team, { is_locked: true })).status, 200);
    await invalidateOrgCache(team.orgId).catch(() => {});
    const asRequest = (actor) => ({ actor, originalUrl: '/api/v1/context/projects', method: 'GET' });
    const deny = await evaluatePlanEnforcement(asRequest({ id: member.userId, type: 'user', org_id: member.orgId, workspace_key: team.orgId, workspace_binding: 'header', role: 'member' }));
    assert.equal(deny.status, 403);
    assert.equal(deny.body.error, 'lockdown_active');
    assert.equal(deny.body.lock_reason, 'foreign_workspace');
    assert.equal(deny.body.message, FOREIGN_MESSAGE);
    // Its owner is told the lockdown sentence, not the foreign one.
    const denyOwner = await evaluatePlanEnforcement(asRequest({ id: team.userId, type: 'user', org_id: team.orgId, workspace_key: team.orgId, workspace_binding: 'own_org', role: 'admin' }));
    assert.equal(denyOwner.body.lock_reason, 'lockdown');
});

test('decision 4: the API-key refusal names the reason in plain words, not LOCKDOWN mode', async () => {
    const ws = await workspaceFor('keys-text', { paid: true });
    assert.equal((await patchSettings(ws, { is_locked: true })).status, 200);
    const lockdown = await request(httpServer).post('/api/v1/keys').set('Authorization', `Bearer ${ws.jwt}`).send({ name: 'k', environment: 'sandbox' });
    assert.equal(lockdown.status, 403, JSON.stringify(lockdown.body));
    assert.ok(!/LOCKDOWN/.test(lockdown.body.message), lockdown.body.message);
    assert.equal(lockdown.body.lock_reason, 'lockdown');
    assert.ok(lockdown.body.message.includes(LOCKDOWN_MESSAGE), lockdown.body.message);

    const other = await workspaceFor('keys-dispute', { paid: true });
    await withdrawn(stripeHasDispute(other));
    const disputed = await request(httpServer).post('/api/v1/keys').set('Authorization', `Bearer ${other.jwt}`).send({ name: 'k', environment: 'sandbox' });
    assert.equal(disputed.status, 403, JSON.stringify(disputed.body));
    assert.equal(disputed.body.lock_reason, 'dispute');
    assert.ok(disputed.body.message.includes(DISPUTE_MESSAGE), disputed.body.message);
});

// ---------------------------------------------------------------------------
// A follow-up. Every surface that describes an incomplete workspace says the
// first payment did not go through, not "subscription is inactive".
// ---------------------------------------------------------------------------

test('decision A: a teammate whose team is incomplete is told about the first payment: the listing names what to check out again, and a refused write says it', async () => {
    const team = await workspaceFor('fb-team', { paid: true, seats: 3 });
    const member = await workspaceFor('fb-member');
    await workspace.addMember(team.orgId, member.userId, { role: 'member' });
    await workspace.setActiveWorkspace({ id: member.userId, org_id: member.orgId }, team.orgId);
    await stripeSays(team, 'incomplete');
    await invalidateOrgCache(team.orgId).catch(() => {});

    const listing = await request(httpServer).get('/api/v1/teams/workspaces').set('Authorization', `Bearer ${member.jwt}`);
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    assert.equal(listing.body.fallback?.from, team.orgId, JSON.stringify(listing.body.fallback));
    assert.equal(listing.body.fallback.reason, 'subscription_inactive');
    assert.deepEqual(listing.body.fallback.retry_checkout, { plan: 'developer_pro', seats: 3 });

    const write = await request(httpServer).post('/api/v1/context/projects').set('Authorization', `Bearer ${member.jwt}`).set('x-deerdawn-workspace', team.orgId).send({ name: 'x' });
    assert.equal(write.status, 409, JSON.stringify(write.body));
    assert.equal(write.body.error, 'workspace_inactive');
    assert.match(write.body.message, /first payment did not go through/);
    assert.doesNotMatch(write.body.message, /subscription is inactive|Update billing/);
    assert.match(write.body.message, /ask a workspace owner to check out again/, 'a member cannot check out');

    // An unpaid team is unchanged.
    const unpaid = await workspaceFor('fb-unpaid-team', { paid: true, seats: 3 });
    await workspace.addMember(unpaid.orgId, member.userId, { role: 'member' });
    await workspace.setActiveWorkspace({ id: member.userId, org_id: member.orgId }, unpaid.orgId);
    await stripeSays(unpaid, 'unpaid');
    await invalidateOrgCache(unpaid.orgId).catch(() => {});
    const unpaidListing = await request(httpServer).get('/api/v1/teams/workspaces').set('Authorization', `Bearer ${member.jwt}`);
    assert.equal(unpaidListing.body.fallback?.from, unpaid.orgId);
    assert.equal(unpaidListing.body.fallback.retry_checkout, undefined);
});

test('decision 3: the lockdown setting tells the truth on a disputed workspace: still locked, because of a disputed payment', async () => {
    const ws = await workspaceFor('dp-settings-reply', { paid: true });
    // No lock at all: turning lockdown on and off reports exactly that.
    const on = await patchSettings(ws, { is_locked: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.locked, true);
    assert.equal(on.body.lock_reason, 'lockdown');
    const off = await patchSettings(ws, { is_locked: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.success, true);
    assert.equal(off.body.locked, false, 'the owner\'s own lockdown turned off, and nothing else holds the workspace');
    assert.equal(off.body.lock_reason, null);
    assert.equal(off.body.message, undefined);

    // A dispute holds the workspace: the reply says so, in the approved words.
    await withdrawn(stripeHasDispute(ws));
    for (const body of [{ is_locked: false }, { is_locked: true }, { shadow_mode: false }]) {
        const res = await patchSettings(ws, body);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.locked, true, `${JSON.stringify(body)}: the reply let the owner believe the workspace was unlocked`);
        assert.equal(res.body.lock_reason, 'dispute');
        assert.equal(res.body.message, DISPUTE_MESSAGE);
    }
    const lifted = await patchSettings(ws, { is_locked: false });
    assert.equal(lifted.body.settings.is_locked, false, 'the owner\'s own switch is still reported as what it is');
    assert.equal(lifted.body.locked, true);
});
