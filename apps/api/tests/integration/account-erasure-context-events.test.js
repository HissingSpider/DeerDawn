'use strict';

/**
 * "DELETE MY ACCOUNT" HAS TO SUCCEED ON THE SCHEMA THE MIGRATIONS BUILD.
 *
 * dataErasureService deleted context_events `WHERE org_id = $1`. Neither place
 * that creates that table gives it an org_id — it hangs off context_projects by
 * project_id — so on a database built by the migrations every strict erasure
 * raised 42703, threw erasure_incomplete, and both delete routes answered 500.
 * (autoMigrate later bolts on an org_id that no writer fills, which turned the
 * 500 into a statement that matched nothing; the events then went only because
 * the project cascade happened to take them.)
 *
 * Two pins:
 *   1. End to end, through both routes, with a real account holding projects,
 *      events written by the real writer, graph rows, sessions and keys: 200,
 *      no `error:` entry in the report, the events deleted BY THE ERASURE (a
 *      positive count, not a cascade), and nothing left keyed to the owner.
 *   2. Schema consistency: every (table, column) the erasure service deletes or
 *      reads by exists on this database. This is the test that would have
 *      caught it. It is only as strict as the database it runs on — run it on
 *      one bootstrapped by scripts/run-db-test.sh, which does not boot
 *      autoMigrate; a database autoMigrate has touched carries extra columns.
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/account-erasure-context-events.test.js
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
const store = require('../../src/store/contextSyncStore');
const erasure = require('../../src/services/dataErasureService');

const app = express();
app.use(express.json());
app.use('/api/v1/context', require('../../src/routes/context/context-sync'));
app.use('/api/v1/orgs', require('../../src/routes/shared/orgs'));

const q = (sql, params) => db.query(sql, params, 'org-system');
const created = [];

async function seedAccount(label) {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const email = `${label}-${uuidv4().slice(0, 8)}@erasure-events.test`;
    created.push(orgId);

    await q(`INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
             VALUES ($1, $2, 'free', 'free', 'trial_active', 'organization')`, [orgId, `${label} workspace`]);
    await q(`INSERT INTO users (user_id, email, role, org_id, auth_provider)
             VALUES ($1, $2, 'owner', $3, 'local')`, [userId, email, orgId]);
    await workspace.ensureOwnerMembership(orgId, userId);

    const userActor = {
        type: 'user', id: userId, email, role: 'owner', org_id: orgId,
        scopes: ['context:read', 'context:write', 'context:admin'],
    };
    const projectIds = [];
    for (const name of ['one', 'two']) {
        const project = await contextSync.createProject(userActor, { project_name: `Erasure ${label} ${name}` });
        projectIds.push(project.project_id);
        // The real writer, so the row has exactly the columns production gives it.
        for (let i = 0; i < 2; i += 1) {
            await store.appendEvent({
                event_id: `evt-${uuidv4()}`,
                project_id: project.project_id,
                source_type: 'mcp',
                source_id: 'erasure-test',
                event_kind: 'context_update',
                delta: { current_task: `task ${i}` },
                confidence: 1,
                contributing_user_id: userId,
                created_at: new Date().toISOString(),
            });
        }
    }

    const nodeA = `node-${uuidv4()}`;
    const nodeB = `node-${uuidv4()}`;
    for (const nodeId of [nodeA, nodeB]) {
        await q(`INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, source_tool)
                 VALUES ($1, $2, $3, 'decision', $4, 'a decision', 'claude')`, [nodeId, orgId, projectIds[0], `k-${nodeId}`]);
    }
    await q(`INSERT INTO context_graph_edges (edge_id, owner_key, project_id, from_node_id, to_node_id, edge_type, source_tool)
             VALUES ($1, $2, $3, $4, $5, 'relates_to', 'claude')`, [`edge-${uuidv4()}`, orgId, projectIds[0], nodeA, nodeB]);
    await q(`INSERT INTO context_sessions (session_id, owner_key, project_id, surface_type, tool)
             VALUES ($1, $2, $3, 'cli', 'claude')`, [`sess-${uuidv4()}`, orgId, projectIds[0]]);
    await q(`INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
             VALUES ($1, 'dd_test', $2, 'erasure', $3, $4, 'production', now() + interval '1 year', $5)`,
    [`key-${uuidv4()}`, `hash-${uuidv4()}`, userId, orgId, ['context:read']]);

    return { orgId, userId, email, actor: userActor, projectIds };
}

// Rows still keyed to this owner, in every table the erasure claims to cover.
async function residue(account) {
    const left = {};
    const count = async (label, sql, params) => {
        const r = await q(sql, params);
        left[label] = r.rows[0].n;
    };
    // context_events is counted on its own terms, not through the service's
    // lists: which list it belongs in is exactly what was wrong.
    const byService = (tables) => tables.filter((table) => table !== 'context_events');
    for (const table of byService(erasure.OWNER_KEY_TABLES)) {
        await count(table, `SELECT COUNT(*)::int AS n FROM ${table} WHERE owner_key = $1`, [account.orgId]);
    }
    for (const table of byService(erasure.ORG_ID_TABLES)) {
        await count(table, `SELECT COUNT(*)::int AS n FROM ${table} WHERE org_id = $1`, [account.orgId]);
    }
    // By the project ids captured at seed time: the projects are gone by now.
    await count('context_events', 'SELECT COUNT(*)::int AS n FROM context_events WHERE project_id = ANY($1)', [account.projectIds]);
    return left;
}

function errorsIn(report) {
    return Object.entries(report || {}).filter(([, v]) => typeof v === 'string' && v.startsWith('error:'));
}

after(async () => {
    for (const orgId of created) {
        await erasure.purgeOwnerData(orgId).catch(() => {});
        await q('DELETE FROM users WHERE org_id = $1', [orgId]).catch(() => {});
        await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    }
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('DELETE /context/account erases an account with events, graph rows, sessions and keys', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'account erasure'))) return;
    const account = await seedAccount('context');

    const before = await residue(account);
    for (const table of ['context_events', 'context_projects', 'context_graph_nodes', 'context_graph_edges', 'context_sessions', 'api_keys', 'workspace_members']) {
        assert.ok(before[table] > 0, `fixture wrote nothing to ${table}, so its erasure proves nothing`);
    }

    actor = account.actor;
    const res = await request(app)
        .delete('/api/v1/context/account')
        .send({ confirmation: 'DELETE MY DEERDAWN ACCOUNT' });
    assert.strictEqual(res.status, 200, `THE BUG: delete my account answered ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.deleted, true);
    assert.deepStrictEqual(errorsIn(res.body.deleted_counts), [], 'every table must report a clean delete');
    // Deleted by the erasure's own statement, not left to the project cascade:
    // the org_id statement matched nothing on a schema where it did not 500.
    assert.strictEqual(res.body.deleted_counts.context_events, before.context_events,
        'context_events must be erased by the erasure itself, by project');

    const left = await residue(account);
    // The one row that stays, by design (scan 25): the person emptying the
    // workspace is still its owner, so their own roster row survives and
    // nothing else on the roster does.
    const roster = await q('SELECT user_id, role, removed_at FROM workspace_members WHERE owner_key = $1', [account.orgId]);
    assert.deepStrictEqual(roster.rows.map((r) => [r.user_id, r.role, r.removed_at]), [[account.userId, 'owner', null]],
        'the caller keeps exactly their own active owner row');
    delete left.workspace_members;
    for (const [table, n] of Object.entries(left)) {
        assert.strictEqual(n, 0, `DELETE /context/account left ${n} row(s) in ${table}`);
    }
});

test('DELETE /orgs closes an account with events, graph rows, sessions and keys', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'account erasure'))) return;
    const account = await seedAccount('orgs');
    const before = await residue(account);
    assert.ok(before.context_events > 0, 'fixture wrote no events');

    actor = account.actor;
    const res = await request(app)
        .delete('/api/v1/orgs/')
        .send({ confirm_email: account.email });
    assert.strictEqual(res.status, 200, `THE BUG: DELETE /orgs answered ${res.status} ${JSON.stringify(res.body)}`);

    const left = await residue(account);
    for (const [table, n] of Object.entries(left)) {
        assert.strictEqual(n, 0, `DELETE /orgs left ${n} row(s) in ${table}`);
    }
    const shell = await q(
        'SELECT (SELECT COUNT(*)::int FROM users WHERE org_id = $1) AS users, (SELECT COUNT(*)::int FROM organizations WHERE org_id = $1) AS orgs',
        [account.orgId]
    );
    assert.deepStrictEqual(shell.rows[0], { users: 0, orgs: 0 }, 'DELETE /orgs must close the account');
});

test('every (table, column) the erasure service deletes or reads by exists on this schema', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'erasure schema consistency'))) return;
    // The lazily-created tables, created the way the app creates them, so a
    // missing table here is a real gap and not test ordering.
    await store.ensureSchema();
    await workspace.ensureSchema();

    const pairs = [
        ...erasure.OWNER_KEY_TABLES.map((table) => [table, 'owner_key']),
        ...erasure.ORG_ID_TABLES.map((table) => [table, 'org_id']),
        ...(erasure.PROJECT_SCOPED_TABLES || []).map((table) => [table, 'project_id']),
        ...(erasure.PERSON_KEYED_DELETES || []).map(({ table, column }) => [table, column]),
        // The reads and the one UPDATE, inline in purgeOwnerData.
        ['context_projects', 'project_id'],
        ['context_projects', 'owner_user_id'],
        ['api_keys', 'key_hash'],
        ['api_keys', 'status'],
        ['users', 'user_id'],
        ['users', 'org_id'],
        ['workspace_members', 'role'],
        ['workspace_members', 'removed_at'],
        ['organizations', 'org_id'],
        ['organizations', 'name'],
    ];
    const r = await q(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema()`,
        []
    );
    const have = new Set(r.rows.map((row) => `${row.table_name}.${row.column_name}`));
    const tables = new Set(r.rows.map((row) => row.table_name));
    const missing = pairs
        .filter(([table, column]) => !have.has(`${table}.${column}`))
        .map(([table, column]) => (tables.has(table) ? `${table}.${column} (no such column)` : `${table} (no such table)`));
    assert.deepStrictEqual(missing, [], 'the erasure deletes by columns this schema does not have');
});
