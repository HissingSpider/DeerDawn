'use strict';

/**
 * THE PAGE AND THE BUTTON MUST BE TALKING ABOUT THE SAME WORKSPACE.
 *
 * PR #475 moved every /billing route onto the BOUND workspace — the one the
 * x-deerdawn-workspace header selects, resolved through
 * workspaceService.defaultOwnerKey. GET /orgs/usage, which is what
 * /settings/plan and /settings/usage actually render, was left reading
 * req.actor.org_id: always the personal org the person signed up under, never
 * the team they are looking at.
 *
 * So the billing page could describe your personal Free account while the
 * Upgrade button beside it charged the team workspace — or the reverse. Both
 * screens are truthful on their own; only together are they a lie, which is why
 * nothing about it looks like a bug until somebody's card is charged for the
 * wrong workspace.
 *
 * `users.org_id` for an invited teammate is still their own personal org
 * (see teams-multi-user.test.js and the inline `actor.org_id || actor.id` ban),
 * so this is not a rare edge: it is every member of every shared workspace.
 */

process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const DB_PATH = require.resolve('../../src/config/db');
const AUTH_PATH = require.resolve('../../src/middleware/auth');
const WORKSPACE_PATH = require.resolve('../../src/services/workspaceService');
const ENTITLEMENTS_PATH = require.resolve('../../src/services/entitlementService');
const ORGS_PATH = require.resolve('../../src/routes/shared/orgs');

const PERSONAL_ORG = 'org-personal-1111-2222-3333-444444444444';
const TEAM_WORKSPACE = 'org-team-aaaa-bbbb-cccc-dddddddddddd';

function loadOrgsRoute({ workspaceKey = TEAM_WORKSPACE, rows = {} } = {}) {
    const queriedOrgIds = [];

    async function query(text, params = [], orgScope) {
        if (orgScope) queriedOrgIds.push(orgScope);
        if (/^\s*SELECT org_id, name, account_type/.test(text)) {
            return {
                rows: [{
                    org_id: params[0],
                    name: params[0] === TEAM_WORKSPACE ? 'Acme Engineering' : 'John’s workspace',
                    account_type: params[0] === TEAM_WORKSPACE ? 'organization' : 'personal',
                    plan: params[0] === TEAM_WORKSPACE ? 'developer_pro' : 'free',
                    plan_tier: params[0] === TEAM_WORKSPACE ? 'developer_pro' : 'free',
                    subscription_status: 'active',
                    stripe_customer_id: params[0] === TEAM_WORKSPACE ? 'cus_team' : null,
                    redaction_keys: [],
                    ...rows,
                }],
                rowCount: 1,
            };
        }
        if (/briefs_delivered/.test(text)) {
            return { rows: [{ briefs_delivered: '3', briefs_all_time: '9', legacy_decisions: null, integrations: '1', admins: '1', decisions_remembered: '7', oldest_memory_at: null, projects_count: '2' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }

    for (const p of [DB_PATH, AUTH_PATH, WORKSPACE_PATH, ENTITLEMENTS_PATH, ORGS_PATH]) delete require.cache[p];
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };

    stub(DB_PATH, { query, pool: { connect: async () => ({ query, release() {} }) } });
    stub(AUTH_PATH, {
        requireAuth: (req, _res, next) => {
            // An invited teammate: users.org_id is still their OWN personal org,
            // and the workspace they are looking at arrives on the header, bound
            // by the auth middleware after a membership check.
            req.actor = { id: 'user-1', org_id: PERSONAL_ORG, workspace_key: workspaceKey, email: 'member@acme.test' };
            next();
        },
        isClerkConfigured: () => false,
        clerkUserHasPassword: async () => false,
        verifyClerkPassword: async () => false,
        deleteClerkUser: async () => ({}),
    });
    const real = require('../../src/services/workspaceService');
    stub(WORKSPACE_PATH, {
        ...real,
        defaultOwnerKey: (actor) => actor?.workspace_key || actor?.org_id || actor?.id || null,
        resolveRole: async () => 'owner',
        canAdminister: (role) => role === 'owner',
        actorPersonId: (actor) => actor?.id || null,
    });
    stub(ENTITLEMENTS_PATH, {
        getEntitlements: async () => ({ limits: { included_decisions: null, included_integrations: null, included_admins: 1, included_projects: null, history_days: null } }),
        checkFeature: async () => true,
        checkLimit: async () => true,
    });

    return { router: require(ORGS_PATH), queriedOrgIds };
}

async function getUsage(router) {
    const app = express();
    app.use(express.json());
    app.use('/orgs', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/orgs/usage`);
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

test('the plan page reads the BOUND workspace, not the personal org', async () => {
    const { router, queriedOrgIds } = loadOrgsRoute({ workspaceKey: TEAM_WORKSPACE });
    const res = await getUsage(router);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(
        queriedOrgIds.every((id) => id === TEAM_WORKSPACE),
        `the usage query ran against ${[...new Set(queriedOrgIds)].join(', ')} — `
        + 'anything but the bound workspace describes a different account than the Upgrade button charges'
    );
    assert.strictEqual(res.body.plan.tier, 'developer_pro',
        'the page showed the personal org\'s plan while checkout targets the team');
});

test('the response names the workspace it is describing', async () => {
    // Two screens that are each individually truthful about a DIFFERENT
    // workspace is the failure this whole item is about. The only durable fix
    // is for the payload to say which one it means, so the page can print it.
    const { router } = loadOrgsRoute({ workspaceKey: TEAM_WORKSPACE });
    const { body } = await getUsage(router);

    assert.strictEqual(body.workspace, TEAM_WORKSPACE,
        'the usage payload must name the workspace it describes');
    assert.strictEqual(body.org_name, 'Acme Engineering');
    assert.strictEqual(body.is_personal_workspace, false,
        'the page has to be able to say whether this is your own account or a shared one');
});

test('a solo account with no bound workspace still reads its own org', async () => {
    const { router, queriedOrgIds } = loadOrgsRoute({ workspaceKey: null });
    const { status, body } = await getUsage(router);

    assert.strictEqual(status, 200);
    assert.ok(queriedOrgIds.every((id) => id === PERSONAL_ORG));
    assert.strictEqual(body.workspace, PERSONAL_ORG);
    assert.strictEqual(body.is_personal_workspace, true);
});

test('no billing-adjacent route in orgs.js derives its workspace inline', () => {
    // The banned shape, from the teams work: `actor.org_id` read directly is
    // the personal org for every invited teammate. These four routes all spend
    // or describe money, so each one must resolve through workspaceService.
    const { readFileSync } = require('node:fs');
    const source = readFileSync(require.resolve('../../src/routes/shared/orgs.js'), 'utf8');

    const offenders = [];
    for (const route of ['/usage', '/upgrade', '/portal']) {
        const start = source.indexOf(`router.${route === '/usage' ? 'get' : 'post'}('${route}'`);
        assert.notStrictEqual(start, -1, `orgs.js no longer defines ${route} — re-point this test`);
        // Bounded by the NEXT route declaration, not by a character count: a
        // fixed window overran /portal (four lines long) into the handler after
        // it and reported that one's `req.actor.org_id` as this route's.
        const nextRoute = source.indexOf('\nrouter.', start + 1);
        const body = source.slice(start, nextRoute === -1 ? undefined : nextRoute);
        if (/const orgId = req\.actor\.org_id/.test(body)) offenders.push(route);
    }
    assert.deepStrictEqual(offenders, [],
        `these money routes read the personal org instead of the bound workspace: ${offenders.join(', ')}`);
});
