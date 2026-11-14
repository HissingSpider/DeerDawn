'use strict';

/**
 * THE "ABOUT TO BUY" MARK GOES ON THE WORKSPACE THAT IS ABOUT TO BE CHARGED.
 *
 * /checkout makes two calls back to back: PATCH /orgs/account-type {plan}, which
 * stamps organizations.pending_plan, then POST /billing/checkout, which opens
 * Stripe. Since PR #475 the second bills the BOUND workspace — the one the
 * x-deerdawn-workspace header selects. The first kept writing
 * req.actor.org_id, which is always the personal org.
 *
 * For the founder of a wizard-made team that is two different rows: their
 * personal account is marked "about to buy Team" while the team is what Stripe
 * charges. The webhook clears pending_plan on the org it reconciles — the team —
 * so the mark on the personal org is never cleared by anything.
 *
 * Same family as billing-pages-follow-bound-workspace.test.js: two requests
 * that are each reasonable alone and describe different workspaces together.
 */

process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const DB_PATH = require.resolve('../../src/config/db');
const AUTH_PATH = require.resolve('../../src/middleware/auth');
const WORKSPACE_PATH = require.resolve('../../src/services/workspaceService');
const ENFORCEMENT_PATH = require.resolve('../../src/services/enforcementService');
const ORGS_PATH = require.resolve('../../src/routes/shared/orgs');

const PERSONAL_ORG = 'org-personal-1111-2222-3333-444444444444';
const TEAM_WORKSPACE = 'org-team-aaaa-bbbb-cccc-dddddddddddd';

function loadOrgsRoute({ workspaceKey, workspaceRole = 'owner' }) {
    /** column -> value, per org, exactly as the UPDATEs leave it. */
    const written = {};

    async function query(text, params = []) {
        const update = /UPDATE organizations SET ([\s\S]*?) WHERE org_id = \$(\d+)/.exec(text);
        if (update) {
            const target = params[Number(update[2]) - 1];
            written[target] = written[target] || {};
            for (const assignment of update[1].split(',')) {
                const bound = /(\w+)\s*=\s*\$(\d+)/.exec(assignment);
                if (bound) written[target][bound[1]] = params[Number(bound[2]) - 1];
            }
            return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }

    for (const p of [DB_PATH, AUTH_PATH, WORKSPACE_PATH, ENFORCEMENT_PATH, ORGS_PATH]) delete require.cache[p];
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };

    stub(DB_PATH, { query, pool: { connect: async () => ({ query, release() {} }) } });
    stub(AUTH_PATH, {
        requireAuth: (req, _res, next) => {
            // users.org_id / users.role describe the PERSONAL org for everybody,
            // including the founder of a team; the team arrives on the header.
            req.actor = { id: 'user-1', org_id: PERSONAL_ORG, role: 'owner', workspace_key: workspaceKey, email: 'founder@acme.test' };
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
        defaultOwnerKey: (actor) => actor?.workspace_key || actor?.org_id || null,
        resolveRole: async () => workspaceRole,
        canAdminister: (role) => role === 'owner',
        actorPersonId: (actor) => actor?.id || null,
    });
    stub(ENFORCEMENT_PATH, { invalidateOrgCache: async () => {} });

    return { router: require(ORGS_PATH), written };
}

async function patchAccountType(router, body) {
    const app = express();
    app.use(express.json());
    app.use('/orgs', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/orgs/account-type`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

test('the pending plan is stamped on the bound team workspace, not on the founder\'s personal org', async () => {
    const { router, written } = loadOrgsRoute({ workspaceKey: TEAM_WORKSPACE });
    // Exactly what /checkout sends: no account_type, just the plan.
    const res = await patchAccountType(router, { plan: 'developer_pro' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(written[TEAM_WORKSPACE]?.pending_plan, 'developer_pro',
        'the workspace Stripe is about to charge was not the one marked');
    assert.strictEqual(written[PERSONAL_ORG]?.pending_plan, undefined,
        'the personal org was marked as buying Team, and no webhook will ever clear it');
});

test('a solo account still stamps its own org', async () => {
    const { router, written } = loadOrgsRoute({ workspaceKey: null });
    const res = await patchAccountType(router, { account_type: 'personal', plan: 'developer_basic' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(written[PERSONAL_ORG], { account_type: 'personal', pending_plan: 'developer_basic' });
});

test('a member who does not own the bound workspace cannot mark it', async () => {
    // POST /billing/checkout refuses them one request later; this must not have
    // written to somebody else's workspace in the meantime.
    const { router, written } = loadOrgsRoute({ workspaceKey: TEAM_WORKSPACE, workspaceRole: 'member' });
    const res = await patchAccountType(router, { plan: 'developer_pro' });

    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.deepStrictEqual(written, {});
});

test('account_type stays on the caller\'s own account even while switched into a team', async () => {
    // The onboarding handoff describes the PERSON's account. A teammate finishing
    // onboarding inside a shared workspace must not flip that workspace's type.
    const { router, written } = loadOrgsRoute({ workspaceKey: TEAM_WORKSPACE, workspaceRole: 'member' });
    const res = await patchAccountType(router, { account_type: 'personal' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(written[PERSONAL_ORG], { account_type: 'personal' });
    assert.strictEqual(written[TEAM_WORKSPACE], undefined);
});
