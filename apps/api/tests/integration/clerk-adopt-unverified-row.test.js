'use strict';

/**
 * A CLERK FIRST SIGN-IN MUST NOT ADOPT A ROW SOMEBODY ELSE PRE-CREATED.
 *
 * POST /auth/signup never verified the email and was live in production, so an
 * attacker could create `victim@bigco.com` with a password and a workspace
 * called whatever they liked. syncUser's provider-migration branch then adopted
 * that row on the victim's first Clerk sign-in: attacker-named workspace,
 * attacker's referral attribution, attacker's password_hash still on the row.
 *
 * Real database, real signup route (local provider, as in dev), real adapter.
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/clerk-adopt-unverified-row.test.js
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const authRouter = require('../../src/routes/shared/auth');
const { _authAdapter: adapter } = require('../../src/middleware/auth');

const q = (sql, params) => db.query(sql, params, 'org-system').then((r) => r.rows);

function app() {
    const a = express();
    a.use(express.json());
    a.use('/auth', authRouter);
    return a;
}

async function presignup(email, orgName) {
    const res = await request(app()).post('/auth/signup')
        .send({ email, password: 'attacker-password-1234', org_name: orgName });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.user;
}

test('an unverified, unused pre-created row: fresh workspace, no attacker state, no password', async () => {
    const email = `victim-${uuidv4().slice(0, 8)}@bigco.test`;
    const planted = await presignup(email, 'BigCo Security (verify your account)');

    const actor = await adapter.syncUser(`user_clerk_${uuidv4().slice(0, 10)}`, email, 'clerk');
    assert.ok(actor, 'the real owner must still get a session');

    assert.notStrictEqual(actor.org_id, planted.org_id,
        'the Clerk identity was handed the workspace the pre-signup created and named');
    assert.notStrictEqual(actor.org_name, 'BigCo Security (verify your account)');

    const [row] = await q('SELECT user_id, org_id, password_hash, auth_provider FROM users WHERE email = $1', [email]);
    assert.strictEqual(row.password_hash, null, 'the pre-signup\'s password must stop being a credential');
    assert.strictEqual(row.auth_provider, 'clerk');
    assert.strictEqual(row.org_id, actor.org_id);

    const planterMemberships = await q(
        'SELECT 1 FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [planted.org_id, row.user_id]
    );
    assert.strictEqual(planterMemberships.length, 0,
        'the person must not stay on the roster of the workspace somebody else made for them');
    const ownMembership = await q(
        'SELECT role FROM workspace_members WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL',
        [actor.org_id, row.user_id]
    );
    assert.strictEqual(ownMembership.length, 1, 'and must own the fresh one');
    assert.strictEqual((await q('SELECT 1 FROM organizations WHERE org_id = $1', [planted.org_id])).length, 0,
        'the empty pre-created workspace is removed');

    // The attacker's password no longer logs anybody in.
    const login = await request(app()).post('/auth/login').send({ email, password: 'attacker-password-1234' });
    assert.strictEqual(login.status, 401);
});

test('a pre-Clerk row that was actually used is still adopted (provider migration), password cleared', async () => {
    const email = `legacy-${uuidv4().slice(0, 8)}@bigco.test`;
    const legacy = await presignup(email, 'Legacy workspace');
    const projectId = `proj-${uuidv4()}`;
    await q(
        `INSERT INTO context_projects (project_id, owner_key, owner_user_id, visibility, project_name)
         VALUES ($1, $2, $3, 'shared', 'real work')`,
        [projectId, legacy.org_id, legacy.id]
    );

    const actor = await adapter.syncUser(`user_clerk_${uuidv4().slice(0, 10)}`, email, 'clerk');
    assert.ok(actor);
    assert.strictEqual(actor.org_id, legacy.org_id, 'a used account keeps its workspace and its data');
    const [row] = await q('SELECT password_hash FROM users WHERE email = $1', [email]);
    assert.strictEqual(row.password_hash, null,
        'once Clerk owns the identity, a local password is a second credential Clerk\'s MFA does not cover');
    assert.strictEqual((await q('SELECT 1 FROM context_projects WHERE project_id = $1', [projectId])).length, 1);
});

after(async () => {
    await closeRedisConnections().catch(() => {});
    await db.pool.end().catch(() => {});
});
