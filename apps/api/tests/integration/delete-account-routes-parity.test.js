'use strict';

/**
 * TWO "DELETE MY ACCOUNT" ROUTES MUST AGREE ABOUT WHAT AN ACCOUNT'S DATA IS.
 *
 *   DELETE /api/v1/context/account   empties a workspace, keeps the login
 *   DELETE /api/v1/orgs              closes the account
 *
 * They differ on purpose in whether the account SHELL survives. They must not
 * differ in which DATA goes — and they did: the audit trail, decisions, policies
 * and enterprise inquiries were deleted inline by DELETE /orgs and by nothing
 * else, so the other route answered `deleted: true` and left them behind.
 *
 * Two identical accounts, one deleted each way, against a real database. The
 * assertion is a row count per table, so a table added to one path and not the
 * other fails here rather than in a subject-access request.
 *
 * Auth is replaced (both routers destructure requireAuth at load); WHO may call
 * these routes is covered by account-delete-export-scope.test.js and
 * teams-review-findings.test.js and is deliberately not this test's subject.
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/delete-account-routes-parity.test.js
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const auth = require('../../src/middleware/auth');
let actor = null;
auth.requireAuth = (req, _res, next) => { req.actor = { ...actor }; next(); };
auth.isClerkConfigured = () => false;
auth.deleteClerkUser = async () => ({ skipped: true });

const stripe = require('../../src/services/stripeService');
stripe.cancelSubscriptionForDeletion = async () => ({ ok: true, cancelled: false });

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const workspace = require('../../src/services/workspaceService');
const contextSync = require('../../src/services/contextSyncService');

const app = express();
app.use(express.json());
app.use('/api/v1/context', require('../../src/routes/context/context-sync'));
app.use('/api/v1/orgs', require('../../src/routes/shared/orgs'));

// Everything that holds a customer's data and is keyed by the workspace. Both
// routes must leave every one of these empty.
const DATA_TABLES = [
    ['audit_logs', 'org_id'],
    ['decisions', 'org_id'],
    ['escalation_resolutions', 'org_id'],
    ['policies', 'org_id'],
    ['policy_versions', 'org_id'],
    ['enterprise_inquiries', 'org_id'],
    ['access_logs', 'org_id'],
    ['api_keys', 'org_id'],
    ['context_projects', 'owner_key'],
    ['context_audit_logs', 'owner_key'],
    ['workspace_members', 'owner_key'],
];

const created = [];

async function seedAccount(label) {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const email = `${label}-${uuidv4().slice(0, 8)}@parity.test`;
    created.push(orgId);
    const q = (sql, params) => db.query(sql, params, 'org-system');

    await q(`INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
             VALUES ($1, $2, 'free', 'free', 'trial_active', 'organization')`, [orgId, `${label} workspace`]);
    await q(`INSERT INTO users (user_id, email, role, org_id, auth_provider)
             VALUES ($1, $2, 'owner', $3, 'local')`, [userId, email, orgId]);
    await workspace.ensureOwnerMembership(orgId, userId);

    const policyId = `pol-${uuidv4()}`;
    const decisionId = `dec-${uuidv4()}`;
    await q(`INSERT INTO policies (policy_id, name, org_id, environment, action_types, effect)
             VALUES ($1, 'parity', $2, 'production', '[]'::jsonb, 'allow')`, [policyId, orgId]);
    await q(`INSERT INTO policy_versions (version_id, policy_id, org_id, version, action_types, effect, conditions)
             VALUES ($1, $2, $3, 1, '[]'::jsonb, 'allow', '{}'::jsonb)`, [`pv-${uuidv4()}`, policyId, orgId]);
    await q(`INSERT INTO decisions (decision_id, trace_id, org_id, environment, action_type, decision)
             VALUES ($1, $2, $3, 'production', 'refund', 'allow')`, [decisionId, `trace-${uuidv4()}`, orgId]);
    await q(`INSERT INTO escalation_resolutions (resolution_id, decision_id, status, approver_email, org_id)
             VALUES ($1, $2, 'pending', $3, $4)`, [`res-${uuidv4()}`, decisionId, email, orgId]);
    await q(`INSERT INTO audit_logs (log_id, org_id, actor, action, target)
             VALUES ($1, $2, $3, 'policy.update', 'pol')`, [`log-${uuidv4()}`, orgId, email]);
    await q(`INSERT INTO enterprise_inquiries (inquiry_id, org_id, user_id, use_case)
             VALUES ($1, $2, $3, 'what we are building, in our own words')`, [`inq-${uuidv4()}`, orgId, userId]);
    await q(`INSERT INTO access_logs (access_id, org_id, actor_id, method, path, ip, user_agent)
             VALUES ($1, $2, $3, 'GET', '/api/v1/context/projects', '203.0.113.9', 'parity-test')`, [`acc-${uuidv4()}`, orgId, userId]);

    await q(`INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
             VALUES ($1, 'dd_test', $2, 'parity', $3, $4, 'production', now() + interval '1 year', $5)`,
    [`key-${uuidv4()}`, `hash-${uuidv4()}`, userId, orgId, ['context:read']]);

    await q(`INSERT INTO context_audit_logs (audit_id, owner_key, action, actor_type, actor_user_id, tool, metadata)
             VALUES ($1, $2, 'project.read', 'user', $3, 'dashboard', '{}'::jsonb)`, [`aud-${uuidv4()}`, orgId, userId]);

    const userActor = {
        type: 'user', id: userId, email, role: 'owner', org_id: orgId,
        scopes: ['context:read', 'context:write', 'context:admin'],
    };
    await contextSync.createProject(userActor, { project_name: `Parity ${label}` });
    return { orgId, userId, email, actor: userActor };
}

async function rowCounts(orgId) {
    const counts = {};
    for (const [table, column] of DATA_TABLES) {
        const res = await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1`, [orgId], 'org-system');
        counts[table] = res.rows[0].n;
    }
    return counts;
}

async function shell(orgId) {
    const users = await db.query('SELECT COUNT(*)::int AS n FROM users WHERE org_id = $1', [orgId], 'org-system');
    const orgs = await db.query('SELECT COUNT(*)::int AS n FROM organizations WHERE org_id = $1', [orgId], 'org-system');
    return { users: users.rows[0].n, organizations: orgs.rows[0].n };
}

after(async () => {
    for (const orgId of created) {
        const { purgeOwnerData } = require('../../src/services/dataErasureService');
        await purgeOwnerData(orgId).catch(() => {});
        await db.query('DELETE FROM users WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
        await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    }
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('both delete routes erase the same data; only the account shell differs', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'delete-account parity'))) return;
    const viaContext = await seedAccount('context');
    const viaOrgs = await seedAccount('orgs');

    // The fixture has to have put something in every table, or an empty table
    // "passes" without having been erased by anybody.
    for (const account of [viaContext, viaOrgs]) {
        const before = await rowCounts(account.orgId);
        for (const [table] of DATA_TABLES) {
            assert.ok(before[table] > 0, `fixture wrote nothing to ${table}`);
        }
    }

    actor = viaContext.actor;
    const a = await request(app)
        .delete('/api/v1/context/account')
        .send({ confirmation: 'DELETE MY DEERDAWN ACCOUNT' });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));

    actor = viaOrgs.actor;
    const b = await request(app)
        .delete('/api/v1/orgs/')
        .send({ confirm_email: viaOrgs.email });
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));

    const left = { context: await rowCounts(viaContext.orgId), orgs: await rowCounts(viaOrgs.orgId) };
    // The one row /context/account keeps, by design (scan 25): the person
    // emptying the workspace stays its owner. Their own roster row, and nothing
    // else on the roster.
    const roster = await db.query('SELECT user_id, role, removed_at FROM workspace_members WHERE owner_key = $1', [viaContext.orgId], 'org-system');
    assert.deepStrictEqual(roster.rows.map((r) => [r.user_id, r.role, r.removed_at]), [[viaContext.userId, 'owner', null]],
        '/context/account keeps exactly the caller\'s own active owner row');
    left.context.workspace_members -= 1;
    for (const [table] of DATA_TABLES) {
        assert.strictEqual(left.orgs[table], 0, `DELETE /orgs left rows in ${table}`);
        assert.strictEqual(
            left.context[table], 0,
            `DELETE /context/account answered deleted:true and left ${left.context[table]} row(s) in ${table}, which DELETE /orgs removes`
        );
    }

    // The documented difference, and the only one.
    assert.deepStrictEqual(await shell(viaContext.orgId), { users: 1, organizations: 1 }, '/context/account keeps the login');
    assert.deepStrictEqual(await shell(viaOrgs.orgId), { users: 0, organizations: 0 }, '/orgs closes the account');
});
