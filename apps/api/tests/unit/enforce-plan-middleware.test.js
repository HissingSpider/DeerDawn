// ENF-01 regression test.
//
// checkEnforcement() used to have zero callers outside its own tests, so is_locked and an
// inactive subscription_status were unenforced. These tests pin the wiring: a locked or
// delinquent org is blocked on the data plane, but billing/auth/settings stay reachable so
// the customer can actually fix their card.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const ENFORCE_PATH = require.resolve('../../src/middleware/enforcePlan');
const SERVICE_PATH = require.resolve('../../src/services/enforcementService');

// Stub enforcementService before enforcePlan pulls it in.
let stubResult = { allowed: true };
let stubError = null;
let calls = 0;
let lastOrg = null;

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
    const resolved = (() => {
        try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
    })();
    if (resolved === SERVICE_PATH) {
        return {
            checkEnforcement: async (orgId) => {
                calls += 1;
                lastOrg = orgId;
                if (stubError) throw stubError;
                return stubResult;
            },
            checkIntegrationLimit: async () => ({ allowed: true }),
            invalidateOrgCache: async () => {},
        };
    }
    return originalLoad(request, parent, isMain);
};

delete require.cache[ENFORCE_PATH];
const { evaluatePlanEnforcement } = require(ENFORCE_PATH);

const req = (url, actor) => ({ originalUrl: url, actor });
const USER = { type: 'user', id: 'user-1', org_id: 'org-1' };

test.beforeEach(() => {
    stubResult = { allowed: true };
    stubError = null;
    calls = 0;
    lastOrg = null;
});

test('gates the BOUND workspace, not the org the person signed up under', async () => {
    // A teammate whose personal org is past_due must not be locked out of a paying
    // team, and a lapsed team must not be reachable through a healthy personal org.
    const teammate = { type: 'user', id: 'user-1', org_id: 'org-personal', workspace_key: 'org-team' };
    await evaluatePlanEnforcement(req('/api/v1/context/projects', teammate));
    assert.strictEqual(lastOrg, 'org-team');

    await evaluatePlanEnforcement(req('/api/v1/context/projects', USER));
    assert.strictEqual(lastOrg, 'org-1', 'with no bound workspace the own org is still the answer');
});

test('an actor with neither an org nor a bound workspace is not gated on its own id', async () => {
    const orphan = { type: 'user', id: 'user-orphan' };
    assert.strictEqual(await evaluatePlanEnforcement(req('/api/v1/context/projects', orphan)), null);
    assert.strictEqual(calls, 0);
});

test('blocks the data plane when the org is locked', async () => {
    stubResult = { allowed: false, error: 'lockdown_active', upgrade_required: false };
    const deny = await evaluatePlanEnforcement(req('/api/v1/context/projects', USER));
    assert.ok(deny, 'expected a deny for a locked org');
    assert.strictEqual(deny.status, 403);
    assert.strictEqual(deny.body.error, 'lockdown_active');
});

test('blocks the data plane when the subscription is inactive', async () => {
    stubResult = { allowed: false, error: 'subscription_inactive', upgrade_required: true };
    const deny = await evaluatePlanEnforcement(req('/mcp', USER));
    assert.ok(deny);
    assert.strictEqual(deny.body.upgrade_required, true);
});

test('allows the data plane for a healthy org', async () => {
    assert.strictEqual(await evaluatePlanEnforcement(req('/api/v1/context/projects', USER)), null);
    assert.strictEqual(calls, 1);
});

test('never traps a delinquent customer: billing, auth, orgs, dashboard and key revocation stay reachable', async () => {
    stubResult = { allowed: false, error: 'subscription_inactive', upgrade_required: true };
    for (const url of [
        '/api/v1/billing/checkout',
        '/api/v1/auth/login',
        '/api/v1/orgs',
        '/api/v1/dashboard/bootstrap',
        // Revoking a leaked credential is containment, not a paid feature — an expired
        // card must never stop a customer from responding to a compromise.
        '/api/v1/keys',
        '/api/v1/keys/key-abc123',
    ]) {
        assert.strictEqual(
            await evaluatePlanEnforcement(req(url, USER)), null,
            `${url} must stay reachable so the customer can restore billing`
        );
    }
    assert.strictEqual(calls, 0, 'exempt paths should not even consult enforcement');
});

test('connecting is not a paid action: OAuth consent approval is reachable for a delinquent org', async () => {
    // A past_due org used to reach the consent screen, press Connect, and get a
    // generic "approve_failed": /api/v1/oauth/approve sits behind requireAuth, so
    // the plan gate ran on it. Approving only mints an authorization code; every
    // tool call the resulting token makes is still gated on the data plane.
    stubResult = { allowed: false, error: 'subscription_inactive', upgrade_required: true };
    assert.strictEqual(await evaluatePlanEnforcement(req('/api/v1/oauth/approve', USER)), null);
    assert.strictEqual(calls, 0);
    const deny = await evaluatePlanEnforcement(req('/mcp', USER));
    assert.ok(deny, 'the MCP data plane stays enforced');
    assert.strictEqual(deny.body.error, 'subscription_inactive');
});

test('system key is never gated', async () => {
    stubResult = { allowed: false, error: 'lockdown_active' };
    const actor = { type: 'system', id: 'system-key', org_id: 'org-system' };
    assert.strictEqual(await evaluatePlanEnforcement(req('/api/v1/context/projects', actor)), null);
});

test('anonymous actor is passed through (requireAuth owns rejection)', async () => {
    stubResult = { allowed: false, error: 'lockdown_active' };
    assert.strictEqual(await evaluatePlanEnforcement(req('/api/v1/context/projects', null)), null);
});

test('fails open when the enforcement check itself errors', async () => {
    stubError = new Error('redis unavailable');
    assert.strictEqual(
        await evaluatePlanEnforcement(req('/api/v1/context/projects', USER)), null,
        'an infra outage must not take the product down'
    );
});

test.after(() => { Module._load = originalLoad; });
