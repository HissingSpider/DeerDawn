'use strict';

/**
 * JOURNEY SCAN ROUND 4, BILLING: the owner's decisions, driven through the real
 * app over a real database.
 *
 * 1. AN UNRECOGNISED PRICE KEEPS THE PLAN IN EVERY STATUS. A live subscription
 *    at a price the map does not know kept the workspace's plan while Stripe
 *    said active, trialing or past_due. When Stripe said unpaid, incomplete or
 *    paused the workspace was written Free, and it stayed Free after the
 *    customer paid. Now the plan is never changed by an unrecognised price,
 *    whatever the status; the status alone decides whether the workspace is
 *    locked, exactly as it does on a recognised price.
 *
 * Entitlements are checked BY USE, not by reading a flag: a Team owner invites
 * somebody, a Pro owner opens the portfolio, and a locked workspace answers 403
 * on its own project list. Every unrecognised-price workspace is walked beside
 * a CONTROL workspace on a recognised price through the same Stripe states, and
 * the two must be usable in exactly the same way at every step.
 *
 * 3. THE RETURN FROM STRIPE OPENS THE WORKSPACE THAT WAS BOUGHT FOR. Checkout's
 *    success and cancel URLs, and the billing portal's return URL, name the
 *    workspace the session was for (`?workspace=`), which the dashboard opens
 *    in. They used to name none, and the dashboard opened in whichever
 *    workspace the person had used most recently.
 *
 * 5. A PLAN OR SEAT CHANGE WHILE THE PRICE IS UNRECOGNISED answered 200 with a
 *    portal link and "your existing subscription is still active", and did
 *    not say why. It now says why, in the product's own billing-page sentence,
 *    and the owner's unrecognised-price alert fires for it too.
 *
 * Stripe is stubbed at the SDK edge (the real client object, its methods
 * replaced); nothing is sent to Stripe. Webhooks are signed with the test
 * secret, so the real signature check runs. Outgoing email is captured.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r4-billing.test.js
 */

if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_journey_r4_billing_stub_never_sent_anywhere';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_journey_r4_billing';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = process.env.STRIPE_PRICE_DEVELOPER_BASIC || 'price_pro_monthly_r4';
process.env.STRIPE_PRICE_DEVELOPER_PRO = process.env.STRIPE_PRICE_DEVELOPER_PRO || 'price_team_monthly_r4';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

// Captured before anything that sends mail is loaded: the webhook takes
// sendEmail by destructuring at require time.
const resendClient = require('../../src/services/email/resendClient');
const sentEmails = [];
resendClient.sendEmail = async (mail) => { sentEmails.push(mail); return { ok: true, id: 'captured' }; };

const stripeService = require('../../src/services/stripeService');
const app = require('../../src/app');
const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

const PRO = process.env.STRIPE_PRICE_DEVELOPER_BASIC;
const TEAM = process.env.STRIPE_PRICE_DEVELOPER_PRO;
const TAG = crypto.randomBytes(4).toString('hex');
// Prices created in Stripe that no env var names. Unique per run: the alert
// guard's table is shared by every file and every run on this database.
const NEW_PRO = `price_pro_unmapped_${TAG}`;
const NEW_TEAM = `price_team_unmapped_${TAG}`;
const DAY = 86_400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, params) => db.query(sql, params, 'org-system');
const nowS = () => Math.floor(Date.now() / 1000);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── Stripe, stubbed at the SDK edge ─────────────────────────────────────────
const world = new Map();
const client = stripeService.stripe;
assert.ok(client, 'the Stripe client must be constructed for this test');
// Subscription ids Stripe refuses to show for good (a key without the permission).
const refusedIds = new Set();
client.subscriptions.retrieve = async (id) => {
    if (refusedIds.has(id)) throw Object.assign(new Error('This API key does not have access to this subscription'), { type: 'StripePermissionError', statusCode: 403 });
    const found = world.get(id);
    if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    return clone(found);
};
client.subscriptions.list = async ({ customer }) => ({
    object: 'list', data: [...world.values()].filter((s) => s.customer === customer).map(clone), has_more: false,
});
const stripeSessions = { checkout: [], portal: [] };
const subscriptionWrites = [];
client.subscriptions.update = async (id, params) => { subscriptionWrites.push({ id, params: clone(params) }); throw new Error('no write is expected in this file'); };
client.customers.create = async (params) => ({ id: `cus_r4_new_${TAG}_${crypto.randomBytes(3).toString('hex')}`, ...clone(params || {}) });
client.checkout.sessions.create = async (params) => {
    stripeSessions.checkout.push(clone(params));
    return { id: `cs_r4_${TAG}_${stripeSessions.checkout.length}`, url: 'https://checkout.stripe.com/c/pay/stub' };
};
client.billingPortal.sessions.create = async (params) => {
    stripeSessions.portal.push(clone(params));
    return { id: `bps_r4_${TAG}_${stripeSessions.portal.length}`, url: 'https://billing.stripe.com/p/session/stub' };
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
    await q('DELETE FROM subscription_events WHERE stripe_event_id = ANY($1::text[])', [made.events]).catch(() => {});
    await q('DELETE FROM stripe_events WHERE event_id = ANY($1::text[])', [made.events]).catch(() => {});
    await q('DELETE FROM billing_alert_sends WHERE alert_key LIKE $1', [`%${TAG}%`]).catch(() => {});
    for (const orgId of made.orgs) {
        await q('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM users WHERE org_id = $1', [orgId]).catch(() => {});
        await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    }
    await new Promise((resolve) => httpServer.close(resolve));
});

/** A paying workspace on `plan`, billed by Stripe at `price` x `seats`. */
async function payingWorkspace(label, { plan, price, seats }) {
    const orgId = `org-${uuidv4()}`;
    const customer = `cus_r4_${TAG}_${label}`;
    const subscriptionId = `sub_r4_${TAG}_${label}`;
    const start = nowS() - DAY;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats,
                                    stripe_customer_id, stripe_subscription_id, billing_period_start, billing_period_end)
         VALUES ($1, $2, $3, $3, 'active', $4, $5, $6, to_timestamp($7), to_timestamp($8))`,
        [orgId, `r4 ${label}`, plan, plan === 'developer_pro' ? seats : null, customer, subscriptionId, start, start + 30 * DAY],
    );
    made.orgs.push(orgId);
    world.set(subscriptionId, {
        id: subscriptionId, object: 'subscription', status: 'active', customer, created: start, metadata: {}, schedule: null,
        items: { data: [{ id: `si_${subscriptionId}`, quantity: seats, current_period_start: start, current_period_end: start + 30 * DAY, price: { id: price, recurring: { interval: 'month' } } }] },
    });
    const userId = `user-${uuidv4()}`;
    const email = `r4-owner-${label}-${TAG}@journey-r4.test`;
    await q(
        'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
        [userId, email, await hashPassword('password123'), 'admin', orgId],
    );
    await workspace.ensureOwnerMembership(orgId, userId);
    await invalidateOrgCache(orgId).catch(() => {});
    const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin' });
    return { label, plan, price, seats, orgId, customer, subscriptionId, userId, email, jwt };
}

async function billingRow(orgId) {
    const res = await q('SELECT plan, plan_tier, subscription_status, purchased_seats, stripe_subscription_id FROM organizations WHERE org_id = $1', [orgId]);
    const row = res.rows[0];
    return { ...row, purchased_seats: row.purchased_seats == null ? null : Number(row.purchased_seats) };
}

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
    // The ledger and the alerts are written after COMMIT, unawaited.
    await sleep(120);
    return { status: res.status, body };
}

const eventId = (kind) => `evt_r4_${kind}_${TAG}_${(eventSeq += 1)}`;

/** Stripe moves the subscription to `status`; the two events that report it arrive. */
async function stripeSays(ws, status) {
    const sub = world.get(ws.subscriptionId);
    const was = sub.status;
    sub.status = status;
    const results = [];
    if (status === 'unpaid' || status === 'past_due') {
        results.push(await deliver({
            id: eventId('failed'), object: 'event', type: 'invoice.payment_failed', created: nowS(),
            data: { object: { id: `in_${TAG}_${eventSeq}`, object: 'invoice', customer: ws.customer, subscription: ws.subscriptionId, billing_reason: 'subscription_cycle', amount_due: 1200, attempt_count: 4, next_payment_attempt: null, hosted_invoice_url: null } },
        }));
    }
    if (status === 'active' && (was === 'unpaid' || was === 'past_due')) {
        results.push(await deliver({
            id: eventId('paid'), object: 'event', type: 'invoice.payment_succeeded', created: nowS(),
            data: { object: { id: `in_${TAG}_${eventSeq}`, object: 'invoice', customer: ws.customer, subscription: ws.subscriptionId, billing_reason: 'subscription_cycle', amount_due: 1200 } },
        }));
    }
    results.push(await deliver({
        id: eventId('upd'), object: 'event', type: 'customer.subscription.updated', created: nowS(),
        data: { object: clone(sub), previous_attributes: { status: was } },
    }));
    for (const r of results) assert.equal(r.status, 200, `${ws.label}: Stripe says ${status}: ${JSON.stringify(r.body)}`);
}

/**
 * What the workspace can actually do: open its project list, open the
 * portfolio (a paid feature), and — for Team — invite somebody.
 */
async function use(ws) {
    await invalidateOrgCache(ws.orgId).catch(() => {});
    const projects = await request(httpServer).get('/api/v1/context/projects').set('Authorization', `Bearer ${ws.jwt}`);
    const portfolio = await request(httpServer).get('/api/v1/context/portfolio').set('Authorization', `Bearer ${ws.jwt}`);
    const invite = await request(httpServer)
        .post('/api/v1/teams/invite')
        .set('Authorization', `Bearer ${ws.jwt}`)
        .send({ email: `r4-invitee-${crypto.randomBytes(3).toString('hex')}-${TAG}@journey-r4.test`, role: 'member' });
    if (invite.status === 201 && invite.body?.member?.id) {
        await request(httpServer).delete(`/api/v1/teams/invites/${invite.body.member.id}`).set('Authorization', `Bearer ${ws.jwt}`);
    }
    const describe = (res) => (res.status === 200 || res.status === 201 ? 'ok' : `${res.status} ${res.body?.error || ''}`.trim());
    return {
        workspace: describe(projects),
        portfolio: portfolio.status === 200 ? (portfolio.body?.locked === true || portfolio.body?.upgrade_required ? 'locked' : 'open') : describe(portfolio),
        invite: describe(invite),
    };
}

const priceAlertsFor = (price) => sentEmails.filter((m) => m.emailType === 'unrecognised_price_alert' && m.subject.includes(price));

const WALKS = [
    { name: 'unpaid, then paid', path: ['unpaid', 'active'] },
    { name: 'paused, then resumed', path: ['paused', 'active'] },
];

for (const tier of [
    { label: 'pro', plan: 'developer_basic', seats: 1, mapped: PRO, unmapped: NEW_PRO },
    { label: 'team', plan: 'developer_pro', seats: 3, mapped: TEAM, unmapped: NEW_TEAM },
]) {
    for (const walk of WALKS) {
        test(`decision 1: ${tier.label} at an unrecognised price, ${walk.name}: keeps its plan and is usable exactly like the same plan at a recognised price`, async () => {
            const tagged = `${tier.label}-${walk.path[0]}`;
            // One price per walk: the alert guard allows one alert per price per day.
            const price = `${tier.unmapped}_${walk.path[0]}`;
            const unmapped = await payingWorkspace(`${tagged}-unmapped`, { plan: tier.plan, price, seats: tier.seats });
            const control = await payingWorkspace(`${tagged}-control`, { plan: tier.plan, price: tier.mapped, seats: tier.seats });

            const start = await use(control);
            assert.deepEqual(await use(unmapped), start, 'the two workspaces differ before any event');
            assert.equal(start.portfolio, 'open', 'a paid plan opens the portfolio');
            if (tier.plan === 'developer_pro') assert.equal(start.invite, 'ok', 'a Team owner can invite');

            for (const status of walk.path) {
                await stripeSays(unmapped, status);
                await stripeSays(control, status);
                const row = await billingRow(unmapped.orgId);
                assert.equal(row.plan_tier, tier.plan,
                    `Stripe says ${status} on an unrecognised price and the workspace was put on "${row.plan_tier}"`);
                assert.equal(row.plan, tier.plan);
                assert.equal(row.purchased_seats, tier.plan === 'developer_pro' ? tier.seats : null, 'the seats it has are kept');
                assert.equal(row.subscription_status, status, 'the status is Stripe\'s');
                assert.equal(row.stripe_subscription_id, unmapped.subscriptionId);
                assert.deepEqual(await use(unmapped), await use(control),
                    `after Stripe says ${status}, the workspace at an unrecognised price is not usable like the one at a recognised price`);
            }

            // Paid up again: everything the plan is bought for works.
            const end = await use(unmapped);
            assert.equal(end.workspace, 'ok');
            assert.equal(end.portfolio, 'open', 'the customer paid and the plan does not work');
            if (tier.plan === 'developer_pro') assert.equal(end.invite, 'ok', 'the Team owner paid and cannot invite anybody');

            // The owner is told about the price, no more than once a day.
            assert.equal(priceAlertsFor(price).length, 1, `alerts for ${price}: ${priceAlertsFor(price).length}`);
            assert.equal(priceAlertsFor(tier.mapped).length, 0, 'a recognised price alerts nobody');
        });
    }
}

test('decision 1: unpaid LOCKS a paid workspace at an unrecognised price, as it does at a recognised one', async () => {
    const ws = await payingWorkspace('team-lock', { plan: 'developer_pro', price: `${NEW_TEAM}_lock`, seats: 3 });
    await stripeSays(ws, 'unpaid');
    const now = await use(ws);
    assert.equal(now.workspace, '403 subscription_inactive', `an unpaid Team workspace answered ${now.workspace}`);
    assert.equal(now.invite, '403 subscription_inactive');
});

// ---------------------------------------------------------------------------
// 3. The return from Stripe names the workspace the session was for.
// ---------------------------------------------------------------------------

/** A person with their own (personal) workspace who also owns a second, team, workspace. */
async function personWithTwoWorkspaces(label) {
    const own = await payingWorkspace(`${label}-own`, { plan: 'developer_basic', price: PRO, seats: 1 });
    const teamOrg = `org-${uuidv4()}`;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
         VALUES ($1, $2, 'free', 'free', 'active', 'organization')`,
        [teamOrg, `r4 ${label} team`],
    );
    made.orgs.push(teamOrg);
    await workspace.ensureOwnerMembership(teamOrg, own.userId);
    return { ...own, teamOrg };
}

const returnWorkspace = (url) => new URL(url).searchParams.get('workspace');

test('decision 3: a checkout bought for a team workspace sends the person back to THAT workspace, on success and on cancel', async () => {
    const p = await personWithTwoWorkspaces('checkout');
    const before = stripeSessions.checkout.length;
    const res = await request(httpServer)
        .post('/api/v1/billing/checkout')
        .set('Authorization', `Bearer ${p.jwt}`)
        .set('x-deerdawn-workspace', p.teamOrg)
        .send({ tierId: 'developer_pro', billingCycle: 'monthly', seats: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(stripeSessions.checkout.length, before + 1, 'no checkout session was opened');
    const session = stripeSessions.checkout.at(-1);
    assert.equal(session.metadata.orgId, p.teamOrg, 'precondition: the checkout is for the team workspace');
    assert.equal(returnWorkspace(session.success_url.replace('{CHECKOUT_SESSION_ID}', 'cs_x')), p.teamOrg,
        `success_url names ${returnWorkspace(session.success_url.replace('{CHECKOUT_SESSION_ID}', 'cs_x'))}: ${session.success_url}`);
    assert.ok(session.success_url.includes('session_id={CHECKOUT_SESSION_ID}'), 'Stripe\'s placeholder must stay literal');
    assert.equal(new URL(session.success_url).pathname, '/');
    assert.equal(new URL(session.success_url.replace('{CHECKOUT_SESSION_ID}', 'cs_x')).searchParams.get('upgrade'), 'success');
    assert.equal(returnWorkspace(session.cancel_url), p.teamOrg, `cancel_url: ${session.cancel_url}`);
    assert.equal(new URL(session.cancel_url).pathname, '/checkout');
    assert.equal(new URL(session.cancel_url).searchParams.get('canceled'), 'true');
});

test('decision 3: the billing portal returns the person to the workspace it was opened for', async () => {
    const p = await personWithTwoWorkspaces('portal');
    // The personal workspace's own portal session.
    const own = await request(httpServer).post('/api/v1/billing/portal').set('Authorization', `Bearer ${p.jwt}`).send({});
    assert.equal(own.status, 200, JSON.stringify(own.body));
    const ownSession = stripeSessions.portal.at(-1);
    assert.equal(ownSession.customer, p.customer);
    assert.equal(new URL(ownSession.return_url).pathname, '/settings/plan');
    assert.equal(returnWorkspace(ownSession.return_url), p.orgId, `return_url: ${ownSession.return_url}`);

    // The team workspace, once it has a Stripe customer of its own.
    const teamCustomer = `cus_r4_${TAG}_portal_team`;
    await q('UPDATE organizations SET stripe_customer_id = $1 WHERE org_id = $2', [teamCustomer, p.teamOrg]);
    const team = await request(httpServer)
        .post('/api/v1/billing/portal')
        .set('Authorization', `Bearer ${p.jwt}`)
        .set('x-deerdawn-workspace', p.teamOrg)
        .send({});
    assert.equal(team.status, 200, JSON.stringify(team.body));
    const teamSession = stripeSessions.portal.at(-1);
    assert.equal(teamSession.customer, teamCustomer);
    assert.equal(returnWorkspace(teamSession.return_url), p.teamOrg, `return_url: ${teamSession.return_url}`);
});

test('decision 3: a workspace named by hand that the person does not belong to is refused by the server, as any other request (guard)', async () => {
    const p = await personWithTwoWorkspaces('stranger');
    const stranger = await payingWorkspace('stranger-owner', { plan: 'developer_pro', price: TEAM, seats: 3 });
    const res = await request(httpServer)
        .post('/api/v1/billing/portal')
        .set('Authorization', `Bearer ${p.jwt}`)
        .set('x-deerdawn-workspace', stranger.orgId)
        .send({});
    assert.equal(res.status, 403, `a portal was opened on somebody else's workspace: ${res.status} ${JSON.stringify(res.body)}`);
});

// ---------------------------------------------------------------------------
// 5. A plan or seat change while the price is unrecognised.
// ---------------------------------------------------------------------------

const UNRECOGNISED_PRICE_MESSAGE = 'This subscription is on a price DeerDawn does not recognise, so nothing was changed. '
    + 'Make this change from the billing page instead. Your existing subscription is still active.';

for (const c of [
    { name: 'a seat change on Team', plan: 'developer_pro', seats: 3, body: { tierId: 'developer_pro', seats: 5 }, source: 'a seat change' },
    { name: 'an upgrade from Pro to Team', plan: 'developer_basic', seats: 1, body: { tierId: 'developer_pro', seats: 2 }, source: 'a plan change' },
]) {
    test(`decision 5: ${c.name} while the price is unrecognised says why, changes nothing, and alerts the owner`, async () => {
        const price = `price_unmapped_change_${c.plan}_${TAG}`;
        const ws = await payingWorkspace(`change-${c.plan}`, { plan: c.plan, price, seats: c.seats });
        const before = await billingRow(ws.orgId);
        const writes = subscriptionWrites.length;
        const portals = stripeSessions.portal.length;

        const res = await request(httpServer)
            .post('/api/v1/billing/checkout')
            .set('Authorization', `Bearer ${ws.jwt}`)
            .send(c.body);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.portal, true, 'the billing page is still where the change can be made');
        assert.equal(res.body.reason, 'no_plan_item');
        assert.equal(res.body.url, 'https://billing.stripe.com/p/session/stub');
        assert.equal(stripeSessions.portal.length, portals + 1);
        assert.equal(res.body.message, UNRECOGNISED_PRICE_MESSAGE, `the person read: ${res.body.message}`);

        assert.equal(subscriptionWrites.length, writes, 'nothing may be sent to Stripe');
        assert.deepEqual(await billingRow(ws.orgId), before, 'nothing may be written');

        await sleep(150); // the alert is sent after the answer, best-effort
        const alerts = priceAlertsFor(price);
        assert.equal(alerts.length, 1, `alerts for ${price}: ${alerts.length}`);
        assert.match(alerts[0].html, new RegExp(ws.orgId), 'the alert names the workspace');
        assert.match(alerts[0].html, new RegExp(ws.subscriptionId), 'the alert names the subscription');
        assert.match(alerts[0].html, new RegExp(`POST /billing/checkout \\(${c.source}\\)`), 'the alert names what was asked for');
        assert.match(alerts[0].html, /nothing was written/);

        // Asked again the same day: the answer is the same, the owner is not told twice.
        const again = await request(httpServer).post('/api/v1/billing/checkout').set('Authorization', `Bearer ${ws.jwt}`).send(c.body);
        assert.equal(again.body.message, UNRECOGNISED_PRICE_MESSAGE);
        await sleep(150);
        assert.equal(priceAlertsFor(price).length, 1, 'one alert per price per day');
    });
}

// ---------------------------------------------------------------------------
// 2 (revised 2026-09-29). A read Stripe refuses for good: never closed, the
// owner alerted once (the claim a row in billing_alert_sends), applied the
// moment Stripe can be read.
// ---------------------------------------------------------------------------

test('decision 2: a purchase refused for 25 hours stays redeliverable, alerts once (a durable claim), and is granted when the refusal lifts', async () => {
    const ws = await payingWorkspace('refused-purchase', { plan: 'developer_basic', price: PRO, seats: 1 });
    // The workspace is Free and records no subscription: the purchase has not landed.
    await q('UPDATE organizations SET plan = $2, plan_tier = $2, stripe_subscription_id = NULL, purchased_seats = NULL WHERE org_id = $1', [ws.orgId, 'free']);
    const bought = `sub_r4_${TAG}_refused_team`;
    const start = nowS() - DAY;
    world.set(bought, {
        id: bought, object: 'subscription', status: 'active', customer: ws.customer, created: start, metadata: {}, schedule: null,
        items: { data: [{ id: `si_${bought}`, quantity: 3, current_period_start: start, current_period_end: start + 30 * DAY, price: { id: TEAM, recurring: { interval: 'month' } } }] },
    });
    refusedIds.add(bought);
    const event = {
        id: eventId('refused_cs'), object: 'event', type: 'checkout.session.completed', created: nowS() - 25 * 3600,
        data: { object: { id: `cs_${TAG}_refused`, object: 'checkout.session', mode: 'subscription', customer: ws.customer, subscription: bought, amount_total: 4500, currency: 'usd', metadata: { orgId: ws.orgId, tierId: 'developer_pro', billingCycle: 'monthly', seats: '3' } } },
    };
    const alertsFor = () => sentEmails.filter((m) => m.emailType === 'stripe_event_not_applied_alert' && m.subject.includes(event.id));

    for (let i = 0; i < 3; i += 1) {
        const res = await deliver(event);
        assert.ok(res.status >= 500, `delivery ${i + 1} answered ${res.status}`);
    }
    const row = await q('SELECT status FROM stripe_events WHERE event_id = $1', [event.id]);
    assert.equal(row.rows[0]?.status, 'failed', 'the event must stay redeliverable');
    assert.equal((await billingRow(ws.orgId)).plan_tier, 'free');
    assert.equal(alertsFor().length, 1, `alerts: ${alertsFor().length}`);
    const claim = await q('SELECT alert_key FROM billing_alert_sends WHERE alert_key = $1', [`stripe_event_not_applied:${event.id}`]);
    assert.equal(claim.rows.length, 1, 'the once-only claim is not in the database, so a restart would alert again');

    refusedIds.delete(bought);
    const applied = await deliver(event);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const after = await billingRow(ws.orgId);
    assert.equal(after.plan_tier, 'developer_pro', 'the purchase was not granted once Stripe could be read');
    assert.equal(after.purchased_seats, 3);
    assert.equal(after.stripe_subscription_id, bought);
    assert.equal((await use(ws)).invite, 'ok', 'the Team owner cannot invite anybody');
    assert.equal(alertsFor().length, 1);
});

test('decision 2: an invoice for a subscription no workspace records reads nothing and answers 200 while Stripe refuses (N2)', async () => {
    const orphan = `sub_r4_${TAG}_orphan`;
    refusedIds.add(orphan);
    const res = await deliver({
        id: eventId('orphan_inv'), object: 'event', type: 'invoice.payment_failed', created: nowS() - 30 * 3600,
        data: { object: { id: `in_${TAG}_orphan`, object: 'invoice', customer: `cus_r4_${TAG}_orphan`, subscription: orphan, billing_reason: 'subscription_cycle', amount_due: 1200, attempt_count: 1 } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    refusedIds.delete(orphan);
});
