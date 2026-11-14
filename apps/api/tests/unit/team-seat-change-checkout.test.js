'use strict';

/**
 * THERE WAS NO WAY TO BUY A THIRD SEAT.
 *
 * Every dashboard purchase buys the two-seat minimum. The third invite then 402s
 * with "Upgrade to add another person", and the only request that could raise
 * the count — POST /billing/checkout with a higher `seats` — was refused by the
 * tier guard: "Cannot start checkout for the same or lower tier", because the
 * tier had not moved. A team that wanted to grow had to leave the product.
 *
 * A same-tier request from an OWNER that names a seat count is a SEAT CHANGE. It
 * goes through changeSubscriptionPlan, which reprices the existing plan item with
 * a new quantity and prorates — never through a second Checkout session, which
 * would be the duplicate-subscription bug wearing a different hat.
 */

process.env.DISABLE_REDIS = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_seats';
process.env.DASHBOARD_URL = 'https://app.deerdawn.com';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const DB_PATH = require.resolve('../../src/config/db');
const AUTH_PATH = require.resolve('../../src/middleware/auth');
const WORKSPACE_PATH = require.resolve('../../src/services/workspaceService');
const ENFORCEMENT_PATH = require.resolve('../../src/services/enforcementService');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
const BILLING_PATH = require.resolve('../../src/routes/shared/billing');

const ORG_ID = 'org-team-seats';

/** A live two-seat Team, plus whoever is currently in the workspace. */
function loadBillingRoute({
    org,
    changeResult = { changed: true, planId: 'developer_pro', seats: 3, subscriptionId: 'sub_team_1' },
    members = 2,
    pendingInvites = 0,
    role = 'owner',
}) {
    const calls = { checkout: [], change: [], portal: [], writes: [] };

    async function query(sql, params = []) {
        if (/FROM organizations/.test(sql) && /SELECT/.test(sql)) return { rows: [org] };
        if (/UPDATE organizations/.test(sql)) { calls.writes.push({ sql, params }); return { rows: [{ org_id: ORG_ID }] }; }
        if (/FROM users/.test(sql)) return { rows: [{ email: 'owner@example.com' }] };
        return { rows: [] };
    }

    for (const p of [BILLING_PATH, DB_PATH, AUTH_PATH, WORKSPACE_PATH, ENFORCEMENT_PATH, STRIPE_SERVICE_PATH]) {
        delete require.cache[p];
    }
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };

    stub(DB_PATH, { query, pool: { connect: async () => ({ query, release() {} }) } });
    stub(AUTH_PATH, {
        requireAuth: (req, _res, next) => { req.actor = { id: 'user-1', org_id: ORG_ID, workspace_key: ORG_ID, email: 'owner@example.com' }; next(); },
    });
    stub(WORKSPACE_PATH, {
        defaultOwnerKey: (actor) => actor?.workspace_key || actor?.org_id || null,
        resolveRole: async () => role,
        canAdminister: (r) => r === 'owner',
        actorPersonId: (actor) => actor?.id || null,
        countActiveMembers: async () => members,
        listInvites: async () => Array.from({ length: pendingInvites }, (_, i) => ({ email: `pending${i}@example.com` })),
    });
    stub(ENFORCEMENT_PATH, { invalidateOrgCache: async () => {} });
    stub(STRIPE_SERVICE_PATH, {
        createCheckoutSession: async (...args) => { calls.checkout.push(args); return 'https://checkout.stripe.test/new_session'; },
        createPortalSession: async (...args) => { calls.portal.push(args); return 'https://billing.stripe.test/portal'; },
        changeSubscriptionPlan: async (...args) => { calls.change.push(args); return changeResult; },
    });

    return { router: require(BILLING_PATH), calls };
}

const liveTeam = (seats = 2) => ({
    plan_tier: 'developer_pro',
    account_type: 'organization',
    stripe_subscription_id: 'sub_team_1',
    subscription_status: 'active',
    purchased_seats: seats,
});

async function postCheckout(router, body) {
    const app = express();
    app.use(express.json());
    app.use('/billing', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/billing/checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

test('an owner on Team asking for a third seat gets a seat change, not a refusal', async () => {
    const { router, calls } = loadBillingRoute({ org: liveTeam(2) });

    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 3 });

    assert.strictEqual(res.status, 200,
        `THE BUG: "Cannot start checkout for the same or lower tier" was the only answer to "add a seat": ${JSON.stringify(res.body)}`);
    assert.strictEqual(calls.change.length, 1, 'the existing subscription is what changes');
    assert.strictEqual(calls.checkout.length, 0,
        'a second Checkout session here is the duplicate-subscription bug');
    assert.strictEqual(calls.change[0][2].seats, 3, 'the requested count must reach Stripe');
    assert.strictEqual(res.body.updated, true);
    assert.strictEqual(res.body.seats, 3);
    // A seat change is not a plan change, and saying so sends people to the
    // portal to check what happened to their plan.
    assert.match(res.body.message, /3 seats/);
    assert.ok(!/moved to the new plan/.test(res.body.message), res.body.message);
});

test('asking for the seats you already have is an answer, not an error', async () => {
    const { router, calls } = loadBillingRoute({ org: liveTeam(3) });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 3 });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.updated, false);
    assert.strictEqual(res.body.seats, 3);
    assert.strictEqual(calls.change.length, 0, 'nothing to change, so nothing may be charged');
    assert.strictEqual(calls.checkout.length, 0);
});

test('seats below the people already in the workspace are refused, in plain words', async () => {
    // Three people and one pending invite: four seats are already spent, and the
    // cap is only ever checked on INVITE, so nothing downstream would notice.
    const { router, calls } = loadBillingRoute({ org: liveTeam(5), members: 3, pendingInvites: 1 });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });

    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'seats_below_headcount');
    assert.strictEqual(res.body.minimum_seats, 4);
    assert.match(res.body.message, /Remove somebody/);
    assert.strictEqual(calls.change.length, 0);
});

test('a same-tier checkout that names no seat count is still refused as before', async () => {
    // The tier guard exists to stop a no-op or downgrade checkout opening a
    // second subscription. Only a named seat count turns a same-tier request
    // into a seat change.
    const { router, calls } = loadBillingRoute({ org: liveTeam(2) });
    const res = await postCheckout(router, { tierId: 'developer_pro' });

    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'invalid_plan');
    assert.match(res.body.message, /same or lower tier/);
    assert.strictEqual(calls.change.length, 0);
    assert.strictEqual(calls.checkout.length, 0);
});

test('a seat count on a plan that is not per-seat changes nothing', async () => {
    // Pro is one person. A `seats` field on it is noise, not a seat change, and
    // must not become a path around the tier guard.
    const { router, calls } = loadBillingRoute({
        org: {
            plan_tier: 'developer_basic',
            account_type: 'personal',
            stripe_subscription_id: 'sub_pro_1',
            subscription_status: 'active',
            purchased_seats: null,
        },
    });
    const res = await postCheckout(router, { tierId: 'developer_basic', seats: 4 });

    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'invalid_plan');
    assert.strictEqual(calls.change.length, 0);
});

test('a member cannot change the seat count', async () => {
    // Spending money on a workspace is an owner's power, and a seat is money.
    const { router, calls } = loadBillingRoute({ org: liveTeam(2), role: 'member' });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 5 });

    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(calls.change.length, 0);
});

test('a team with no live subscription is not sold a seat change', async () => {
    // There is nothing to reprice. The tier guard is the right answer, because
    // buying Team from scratch is a normal checkout with its own seat picker.
    const { router, calls } = loadBillingRoute({
        org: { ...liveTeam(2), stripe_subscription_id: null },
    });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 4 });

    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'invalid_plan');
    assert.strictEqual(calls.change.length, 0);
    assert.strictEqual(calls.checkout.length, 0);
});

test('an upgrade to Team is still an upgrade, seats and all', async () => {
    // The seat-change branch must not swallow the ordinary path: a Pro
    // subscriber moving to Team still moves TIER, and still moves the one
    // subscription they have.
    const { router, calls } = loadBillingRoute({
        org: {
            plan_tier: 'developer_basic',
            account_type: 'personal',
            stripe_subscription_id: 'sub_pro_1',
            subscription_status: 'active',
            purchased_seats: null,
        },
        changeResult: { changed: true, planId: 'developer_pro', seats: 2, subscriptionId: 'sub_pro_1' },
    });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.change.length, 1);
    assert.strictEqual(calls.checkout.length, 0);
    assert.match(res.body.message, /moved to the new plan/, 'an actual plan change still says so');
});

// ---------------------------------------------------------------------------
// Scan round 7: what a seat count means before anything compares it, and what a
// SMALLER one means.
// ---------------------------------------------------------------------------

test('a fractional seat count is normalised before it is compared, not after', () => {
    // THE BUG: resolveSeatQuantity floors on the way to Stripe, but the
    // seat-change branch compared the RAW body value to purchased_seats. 2.5
    // !== 2, so "already at 2 seats" was sent as a real subscription move and
    // prorated for a change nobody asked for.
    return (async () => {
        const { router, calls } = loadBillingRoute({ org: liveTeam(2) });
        const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2.5 });

        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.updated, false, '2.5 floors to the 2 seats this workspace has');
        assert.strictEqual(calls.change.length, 0, 'nothing moved, so nothing may be charged');
    })();
});

test('a seat count that is not a whole number of one or more is a plain 400', async () => {
    // NaN and '' are deliberately absent: both arrive over the wire as "did not
    // ask" (JSON.stringify writes NaN as null), which the next test covers.
    for (const seats of [0, -3, 'lots']) {
        const { router, calls } = loadBillingRoute({ org: liveTeam(2) });
        const res = await postCheckout(router, { tierId: 'developer_pro', seats });
        assert.strictEqual(res.status, 400, `seats=${String(seats)}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.error, 'invalid_seats', `seats=${String(seats)}`);
        assert.strictEqual(calls.change.length, 0);
        assert.strictEqual(calls.checkout.length, 0);
    }
});

test('an explicit null seat count still means "did not ask"', async () => {
    // Number(null) is 0, not NaN, so this used to arrive as a request for zero
    // seats rather than as a plain same-tier checkout.
    const { router, calls } = loadBillingRoute({ org: liveTeam(2) });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: null });

    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'invalid_plan', 'the ordinary same-tier guard, not a seat error');
    assert.strictEqual(calls.change.length, 0);
});

test('reducing the seat count needs the caller to say they meant it', async () => {
    // THE BUG: this route is reachable from marketing links that carry a seat
    // count, and an owner with 5 seats arriving on a 2-seat link had their
    // subscription silently cut and prorated. The headcount floor does not catch
    // it: 2 people in a 5-seat workspace clears that check easily.
    const { router, calls } = loadBillingRoute({ org: liveTeam(5), members: 2 });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2 });

    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'seat_reduction_not_confirmed');
    assert.strictEqual(res.body.current, 5);
    assert.strictEqual(res.body.requested, 2);
    assert.strictEqual(calls.change.length, 0, 'nothing may be repriced on an unconfirmed reduction');
});

test('a confirmed reduction goes through', async () => {
    const { router, calls } = loadBillingRoute({
        org: liveTeam(5),
        members: 2,
        changeResult: { changed: true, planId: 'developer_pro', seats: 2, subscriptionId: 'sub_team_1' },
    });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 2, allow_reduce: true });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.change.length, 1);
    assert.strictEqual(calls.change[0][2].seats, 2);
});

test('growing the seat count still needs no confirmation', async () => {
    // The guard is about losing something, and adding a seat loses nothing.
    const { router, calls } = loadBillingRoute({ org: liveTeam(2) });
    const res = await postCheckout(router, { tierId: 'developer_pro', seats: 4 });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.change.length, 1);
});
