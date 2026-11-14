'use strict';

/**
 * A CLERK DELETION ERASES THE PERSON, NOT ONLY THE WORKSPACE THEY SIGNED UP IN.
 *
 * The user.deleted webhook has to delete the users row before it purges the
 * person's org (api_keys cascade off it, and the revoke/uncache has to happen
 * first). purgeOwnerData then enumerated "the people in this org" by
 * `users WHERE org_id`, found nobody, and skipped everything keyed by PERSON:
 * a teammate's `personal` projects inside a team workspace (readable by their
 * author and nobody else), their product events and access logs. DELETE
 * /context/account erased all of it; the webhook erased none of it, leaving
 * data nobody can read and nobody will ever delete.
 *
 * Real database, real signed webhook delivery, real erasure service.
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/clerk-delete-personal-erasure.test.js
 */

process.env.CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET || 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { Webhook } = require('svix');
const { v4: uuidv4 } = require('uuid');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const workspace = require('../../src/services/workspaceService');
const webhookRouter = require('../../src/routes/auth-webhooks');

const q = (sql, params) => db.query(sql, params, 'org-system').then((r) => r.rows);

async function makePerson(label, { clerk = false } = {}) {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const subject = clerk ? `user_clerk_${uuidv4().slice(0, 12)}` : null;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status)
         VALUES ($1, $2, 'free', 'free', 'active')`,
        [orgId, `${label} workspace`]
    );
    await q(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject)
         VALUES ($1, $2, 'admin', $3, $4, $5)`,
        [userId, `${label}-${uuidv4().slice(0, 8)}@erasure.test`, orgId, clerk ? 'clerk' : null, subject]
    );
    await workspace.ensureOwnerMembership(orgId, userId);
    return { orgId, userId, subject };
}

async function addMember(ownerKey, userId, role = 'member') {
    await q(
        `INSERT INTO workspace_members (owner_key, user_id, role, joined_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [ownerKey, userId, role]
    );
}

async function makeProject(ownerKey, ownerUserId, visibility) {
    const projectId = `proj-${uuidv4()}`;
    await q(
        `INSERT INTO context_projects (project_id, owner_key, owner_user_id, visibility, project_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [projectId, ownerKey, ownerUserId, visibility, `${visibility}-${projectId.slice(5, 13)}`]
    );
    return projectId;
}

async function deliverUserDeleted(subject) {
    const app = express();
    app.use('/webhooks', webhookRouter);
    const payload = JSON.stringify({
        id: `evt_${uuidv4()}`,
        type: 'user.deleted',
        data: { id: subject, deleted: true, object: 'user' },
        object: 'event',
    });
    const msgId = `msg_${uuidv4()}`;
    const ts = new Date();
    const sig = new Webhook(process.env.CLERK_WEBHOOK_SECRET).sign(msgId, ts, payload);
    return request(app)
        .post('/webhooks/clerk')
        .set('svix-id', msgId)
        .set('svix-timestamp', String(Math.floor(ts.getTime() / 1000)))
        .set('svix-signature', sig)
        .set('content-type', 'application/json')
        .send(payload);
}

const exists = async (projectId) => (await q('SELECT 1 FROM context_projects WHERE project_id = $1', [projectId])).length === 1;

test('a teammate\'s Clerk deletion erases their PERSONAL project in the team workspace', async () => {
    const owner = await makePerson('owner');
    const mate = await makePerson('mate', { clerk: true });
    await addMember(owner.orgId, mate.userId, 'member');

    const personal = await makeProject(owner.orgId, mate.userId, 'personal');
    const shared = await makeProject(owner.orgId, mate.userId, 'shared');
    const priv = await makeProject(owner.orgId, mate.userId, 'private');
    const ownersOwn = await makeProject(owner.orgId, owner.userId, 'personal');
    await q(
        `INSERT INTO product_events (event_id, event_name, user_id, org_id, source, created_at)
         VALUES ($1, 'probe', $2, $3, 'api', NOW())`,
        [uuidv4(), mate.userId, owner.orgId]
    );

    const res = await deliverUserDeleted(mate.subject);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.strictEqual((await q('SELECT 1 FROM users WHERE user_id = $1', [mate.userId])).length, 0);
    assert.strictEqual(await exists(personal), false,
        'a personal project is readable by its author alone; after erasure it is readable by nobody and must go');
    assert.strictEqual(
        (await q('SELECT count(*)::int AS n FROM product_events WHERE user_id = $1', [mate.userId]))[0].n, 0,
        'product events filed under the erased person must be erased, as DELETE /account erases them'
    );
    assert.strictEqual(await exists(shared), true, 'a shared project is the team\'s and stays');
    assert.strictEqual(await exists(priv), true, 'a private project is the org\'s (owners read it) and stays');
    assert.strictEqual(await exists(ownersOwn), true, 'nobody else\'s personal project is touched');
    assert.strictEqual((await q('SELECT 1 FROM organizations WHERE org_id = $1', [owner.orgId])).length, 1);
});

test('a founder whose workspace is RETAINED still has their personal projects erased', async () => {
    const founder = await makePerson('founder', { clerk: true });
    const colleague = await makePerson('colleague');
    await addMember(founder.orgId, colleague.userId, 'member');

    const founderPersonal = await makeProject(founder.orgId, founder.userId, 'personal');
    const founderShared = await makeProject(founder.orgId, founder.userId, 'shared');
    const colleaguePersonal = await makeProject(founder.orgId, colleague.userId, 'personal');

    const res = await deliverUserDeleted(founder.subject);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.strictEqual((await q('SELECT 1 FROM organizations WHERE org_id = $1', [founder.orgId])).length, 1,
        'a workspace other people are still in is retained');
    assert.strictEqual(await exists(founderPersonal), false,
        'the founder\'s personal project has no reader left once they are erased');
    assert.strictEqual(await exists(founderShared), true, 'the team\'s shared work stays');
    assert.strictEqual(await exists(colleaguePersonal), true, 'a colleague\'s personal project stays');
});

after(async () => {
    await closeRedisConnections().catch(() => {});
    await db.pool.end().catch(() => {});
});
