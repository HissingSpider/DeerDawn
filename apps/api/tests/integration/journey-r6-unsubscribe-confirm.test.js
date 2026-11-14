/**
 * JOURNEY R6 - UNSUBSCRIBE IS A CONFIRM PAGE AND A POST, NOT A GET WITH A SIDE
 * EFFECT (backlog: "Unsubscribe is a GET with a side effect").
 *
 * A mail client or a link scanner that merely FETCHES the link in a digest
 * used to unsubscribe the person. Now the GET shows a page with one button;
 * only the POST changes anything.
 *
 *   DATABASE_URL=... REDIS_URL=... DEERDAWN_TEST_DB_NO_LOCK=1 bash scripts/run-db-test.sh \
 *     node --test --test-concurrency=1 tests/integration/journey-r6-unsubscribe-confirm.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const digest = require('../../src/services/email/weeklyDigest');

const app = express();
app.use('/api/v1/email', require('../../src/routes/email'));

const q = (sql, params) => db.query(sql, params, 'org-system');
const created = { orgs: [], users: [] };

async function makeUser() {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
         VALUES ($1, 'unsub', 'free', 'free', 'trial_active', 'organization')`,
        [orgId],
    );
    await q(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject)
         VALUES ($1, $2, 'owner', $3, 'clerk', $4)`,
        [userId, `unsub-${uuidv4()}@r6.test`, orgId, `sub_${userId}`],
    );
    created.orgs.push(orgId);
    created.users.push(userId);
    return userId;
}

const unsubscribed = async (userId) => (await q('SELECT weekly_digest_unsubscribed AS u FROM users WHERE user_id = $1', [userId])).rows[0].u;

after(async () => {
    for (const id of created.users) await q('DELETE FROM users WHERE user_id = $1', [id]).catch(() => {});
    for (const id of created.orgs) await q('DELETE FROM organizations WHERE org_id = $1', [id]).catch(() => {});
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('fetching the link changes nothing and shows a confirm button', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 unsubscribe'))) return;
    const userId = await makeUser();
    const link = new URL(digest.unsubscribeUrl(userId));

    const res = await request(app).get(`${link.pathname}${link.search}`);

    assert.equal(res.status, 200);
    assert.equal(await unsubscribed(userId), false, 'a GET (a prefetch, a link scanner) must not unsubscribe anybody');
    assert.match(res.text, /<form[^>]+method="post"/i, 'the page asks for a confirmation');
    assert.match(res.text, /<button/i);
    assert.match(res.text, /weekly digest/i, 'the page says what it covers');
    assert.match(res.text, /reminder/i);
    assert.match(res.text, /still (get|receive)[^<]*(archived|account)/i, 'and what it does not');
});

test('the confirm button unsubscribes', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 unsubscribe'))) return;
    const userId = await makeUser();
    const link = new URL(digest.unsubscribeUrl(userId));

    const res = await request(app)
        .post(link.pathname)
        .type('form')
        .send({ u: link.searchParams.get('u'), t: link.searchParams.get('t') });

    assert.equal(res.status, 200);
    assert.equal(await unsubscribed(userId), true);
    assert.match(res.text, /unsubscribed/i);
    assert.match(res.text, /weekly digest/i, 'the confirmation repeats what was switched off');
});

test('a POST with a bad token does nothing', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 unsubscribe'))) return;
    const userId = await makeUser();

    const res = await request(app).post('/api/v1/email/unsubscribe').type('form').send({ u: userId, t: 'not-the-token' });

    assert.equal(res.status, 400);
    assert.equal(await unsubscribed(userId), false);
});

test('a GET with a bad token shows the expired page, not a button', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 unsubscribe'))) return;
    const userId = await makeUser();

    const res = await request(app).get(`/api/v1/email/unsubscribe?u=${encodeURIComponent(userId)}&t=nope`);

    assert.equal(res.status, 400);
    assert.doesNotMatch(res.text, /<form/i);
});
