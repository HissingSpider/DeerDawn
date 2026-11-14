'use strict';

/**
 * THE LEGACY BILLING TWINS NEED THE SAME OWNER GATE AS /billing/*.
 *
 * PR #475 pointed POST /orgs/upgrade and POST /orgs/portal at the BOUND
 * workspace instead of the caller's personal org. PR #480 then added an owner
 * check to every route in routes/shared/billing.js — and not to these two,
 * which are the same actions under older paths.
 *
 * The combination is worse than either half. Before #475 a member hitting
 * /orgs/portal reached their own personal org's Stripe portal, which is
 * harmless. Afterwards they reached the TEAM's, where the subscription can be
 * cancelled and the payment method changed, with no check of any kind.
 *
 * Asserted through the effect — did Stripe get called, for which workspace —
 * rather than by looking for a particular line in the handler.
 */

process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const PERSONAL_ORG = 'org-personal-member';
const TEAM = 'org-team-acme';

const calls = { checkout: [], portal: [] };
let workspaceRole = 'member';

const db = require('../../src/config/db');
db.query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/SELECT plan_tier, stripe_subscription_id FROM organizations/.test(text)) {
        return { rows: [{ plan_tier: 'free', stripe_subscription_id: null }], rowCount: 1 };
    }
    if (/SELECT email FROM users/.test(text)) {
        return { rows: [{ email: 'member@acme.test' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0, params };
};

const authMiddleware = require('../../src/middleware/auth');
authMiddleware.requireAuth = (req, _res, next) => {
    // An invited teammate operating in the team workspace: users.org_id is
    // still their own personal org, and users.role is 'admin' — the default for
    // nearly every self-signup, and the reason an org-level role check would
    // separate nobody from anybody here.
    req.actor = { id: 'user-member', org_id: PERSONAL_ORG, workspace_key: TEAM, role: 'admin', email: 'member@acme.test' };
    next();
};

const entitlements = require('../../src/services/entitlementService');
entitlements.checkFeature = async () => true;
entitlements.checkLimit = async () => true;
entitlements.getEntitlements = async () => ({ limits: {}, features: {} });

const enforcement = require('../../src/services/enforcementService');
enforcement.invalidateOrgCache = async () => {};

const stripeService = require('../../src/services/stripeService');
stripeService.createCheckoutSession = async (orgId, email, tier, opts) => {
    calls.checkout.push({ orgId, email, tier, opts });
    return 'https://checkout.stripe.test/session';
};
stripeService.createPortalSession = async (orgId) => {
    calls.portal.push(orgId);
    return 'https://billing.stripe.test/portal';
};

const workspace = require('../../src/services/workspaceService');
workspace.resolveRole = async () => workspaceRole;

const orgsRouter = require('../../src/routes/shared/orgs');

function app() {
    const a = express();
    a.use(express.json());
    a.use('/orgs', orgsRouter);
    return a;
}

function reset(role) {
    calls.checkout = [];
    calls.portal = [];
    workspaceRole = role;
}

test('a member cannot open the team\'s Stripe portal', async () => {
    reset('member');

    const res = await request(app()).post('/orgs/portal').send({});

    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.deepStrictEqual(calls.portal, [],
        'a member reached the workspace billing portal, where the subscription can be cancelled');
});

test('a viewer cannot open it either', async () => {
    reset('viewer');

    const res = await request(app()).post('/orgs/portal').send({});

    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.deepStrictEqual(calls.portal, []);
});

test('a member cannot start a checkout against the team\'s account', async () => {
    reset('member');

    const res = await request(app()).post('/orgs/upgrade').send({ tierId: 'developer_pro' });

    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.deepStrictEqual(calls.checkout, [],
        'a member started a subscription on a workspace that is not theirs to spend');
});

test('the workspace owner still can — both routes still work', async () => {
    reset('owner');

    const portal = await request(app()).post('/orgs/portal').send({});
    assert.strictEqual(portal.status, 200, JSON.stringify(portal.body));
    assert.deepStrictEqual(calls.portal, [TEAM],
        'the portal must open against the BOUND workspace, not the personal org');

    const upgrade = await request(app()).post('/orgs/upgrade').send({ tierId: 'developer_pro' });
    assert.strictEqual(upgrade.status, 200, JSON.stringify(upgrade.body));
    assert.strictEqual(calls.checkout.length, 1);
    assert.strictEqual(calls.checkout[0].orgId, TEAM);
});

test('an unresolvable role is not an owner', async () => {
    // Failing open here would make a database blip the way in.
    reset('owner');
    workspace.resolveRole = async () => { throw new Error('db breaker open'); };
    try {
        const res = await request(app()).post('/orgs/portal').send({});
        assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
        assert.deepStrictEqual(calls.portal, []);
    } finally {
        workspace.resolveRole = async () => workspaceRole;
    }
});
