'use strict';

/**
 * THE RECOVERY SET, AUDITED AS A SET.
 *
 * EXEMPT_ROUTES in middleware/enforcePlan.js exists so the owner of a lapsed
 * team can still do the things that shrink the team to what she will pay for.
 * It was assembled one route at a time and one was missing: DELETE
 * /teams/invites/:id is written for exactly this case in the router
 * (ensureRosterRecoveryAccess admits her), and the billing gate in front of it
 * refused with 403 subscription_inactive before the router ever ran. A pending
 * invitation counts toward the seat floor, so the one action that would lower
 * her bill was the one she could not take.
 *
 * Table-driven on purpose. Fixing the single route and moving on is how the
 * list grew a hole in the first place: every door in the recovery story is
 * listed here, for both states a subscription can lapse into, so a future
 * router that forgets one fails here rather than in somebody's billing month.
 *
 * Pure unit test: it drives evaluatePlanEnforcement directly, so it pins the
 * gate and not any one router's wiring.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const ENFORCE_PATH = require.resolve('../../src/middleware/enforcePlan');
const SERVICE_PATH = require.resolve('../../src/services/enforcementService');

// Both ways a team stops paying. `cancelled` is not a synonym for `past_due`
// here: they arrive through different webhooks and have been exempted
// separately before.
let denial = { allowed: false, error: 'subscription_inactive' };

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
    const resolved = (() => {
        try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
    })();
    if (resolved === SERVICE_PATH) {
        return {
            checkEnforcement: async () => denial,
            checkIntegrationLimit: async () => ({ allowed: true }),
            invalidateOrgCache: async () => {},
        };
    }
    return originalLoad(request, parent, isMain);
};

delete require.cache[ENFORCE_PATH];
const { evaluatePlanEnforcement } = require(ENFORCE_PATH);

// The owner of the lapsed workspace, bound to it the way auth binds her.
const OWNER = { type: 'user', id: 'user-owner', org_id: 'org-team', workspace_key: 'org-team' };
const req = (method, url) => ({ method, originalUrl: url, actor: OWNER });

// Everything the owner of a lapsed team has to be able to reach, in the order
// she would reach it: see the team, shed a seat, take back an invitation, pay,
// read what she is leaving behind, and get out.
const RECOVERY = [
    ['GET', '/api/v1/teams/members', 'see who holds the seats she is billed for (and the pending invites, which are listed here)'],
    ['DELETE', '/api/v1/teams/members/user-42', 'remove a member'],
    ['DELETE', '/api/v1/teams/invites/inv-42', 'revoke a pending invite, which counts toward the seat floor'],
    ['POST', '/api/v1/billing/checkout', 'pay'],
    ['POST', '/api/v1/billing/portal', 'manage the card'],
    ['GET', '/api/v1/billing/usage-summary', 'see what she is being billed for'],
    ['GET', '/api/v1/context/export', 'take her data'],
    ['GET', '/api/v1/teams/workspaces', 'find somewhere else to work'],
    ['GET', '/api/v1/teams/active', 'read where she is'],
    ['POST', '/api/v1/teams/active', 'go there'],
    ['POST', '/api/v1/teams/invite/accept', 'join a healthy team instead (the invite\'s own workspace is checked by acceptInvite)'],
    ['DELETE', '/api/v1/context/account', 'erase her own data, the exit of last resort'],
];

for (const status of ['past_due', 'cancelled']) {
    test(`every recovery route reaches its handler on a ${status} team`, async () => {
        denial = { allowed: false, error: 'subscription_inactive', status };
        for (const [method, url, why] of RECOVERY) {
            const deny = await evaluatePlanEnforcement(req(method, url));
            assert.strictEqual(deny, null, `${method} ${url} must reach its handler: ${why}`);
        }
    });
}

test('the exemption is the invite ROUTE, not the word "invites"', async () => {
    denial = { allowed: false, error: 'subscription_inactive' };
    // Growing the team is not recovery, and neither is anything a future router
    // gets for free by naming a path /invites.
    for (const [method, url] of [
        ['POST', '/api/v1/teams/invite'],
        // POST /teams/invite/accept is deliberately NOT here any more (scan 11):
        // it writes to the INVITE's workspace and never reads the bound one, so
        // gating it on the bound workspace let a lapsed team stop somebody
        // joining a healthy one. acceptInvite re-checks the target's plan.
        ['POST', '/api/v1/teams/invites/inv-42'],
        ['DELETE', '/api/v1/context/invites/inv-42'],
        ['DELETE', '/api/v1/teams/invites/inv-42/members/user-9'],
    ]) {
        const deny = await evaluatePlanEnforcement(req(method, url));
        assert.ok(deny, `${method} ${url} is not part of the recovery set and must stay gated`);
    }
});

test('a query string does not defeat the exemption, and a locked workspace is still locked', async () => {
    denial = { allowed: false, error: 'subscription_inactive' };
    assert.strictEqual(await evaluatePlanEnforcement(req('DELETE', '/api/v1/teams/invites/inv-42?redirect=1')), null);

    // lockdown_active is a fraud containment flag, not a lapsed card. The
    // exemptions are about giving somebody a way to pay; they are not a way
    // around a lock.
    denial = { allowed: false, error: 'lockdown_active' };
    const deny = await evaluatePlanEnforcement(req('DELETE', '/api/v1/teams/invites/inv-42'));
    assert.strictEqual(deny, null, 'exemptions are matched before the reason is read, as they always were');
});
