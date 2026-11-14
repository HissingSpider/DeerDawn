'use strict';

/**
 * ONE WEEKLY DIGEST PER PERSON PER WEEK, HOWEVER MANY TIMES THE JOB RUNS.
 *
 * Nothing recorded that a digest had been sent; the only guard was a five-minute
 * Redis lock. Every machine keeps its own 7-day timer from its own boot, so two
 * machines send two digests a week, a restart moves the send, and a run longer
 * than the lock outlives it.
 *
 * Real database, real job function, a transport that counts. The assertions are
 * on how many emails a person would actually have received.
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/weekly-digest-sent-marker.test.js
 */

process.env.RESEND_API_KEY = 're_test_not_a_real_key';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const service = require('../../src/services/contextSyncService');

// The transport. Replaced on the module object, which is how the sender reads it.
const resendClient = require('../../src/services/email/resendClient');
const outbox = [];
let transport = async () => ({ ok: true });
resendClient.sendEmail = async (message) => {
    const result = await transport(message);
    if (result.ok) outbox.push(message.to);
    return result;
};

const { sendWeeklyDigestEmails } = require('../../src/services/email/weeklyDigest');

const cleanup = [];

async function seedActiveAccount() {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const email = `digest-${uuidv4()}@digest.test`;
    cleanup.push(orgId);
    await db.query(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
         VALUES ($1, 'digest', 'free', 'free', 'trial_active', 'organization')`,
        [orgId], 'org-system'
    );
    await db.query(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject)
         VALUES ($1, $2, 'owner', $3, 'clerk', $4)`,
        [userId, email, orgId, `sub_${userId}`], 'org-system'
    );
    // A project touched this week, with its creation event: that is what makes
    // the digest have something to say (projects_touched > 0).
    await service.createProject({ type: 'user', id: userId, org_id: orgId, role: 'owner' }, { project_name: 'Digest fixture' });
    return { orgId, userId, email };
}

const received = (email) => outbox.filter((to) => to === email).length;

after(async () => {
    for (const orgId of cleanup) {
        await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId], 'org-system').catch(() => {});
        await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
        await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
        await db.query('DELETE FROM users WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
        await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    }
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('running the job again inside the week does not send again', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'weekly digest marker'))) return;
    transport = async () => ({ ok: true });
    const person = await seedActiveAccount();

    await sendWeeklyDigestEmails();
    assert.strictEqual(received(person.email), 1, 'the fixture must be a real recipient, or this test proves nothing');

    // A restart, a second machine's timer, a manual run.
    await sendWeeklyDigestEmails();
    await sendWeeklyDigestEmails();

    assert.strictEqual(received(person.email), 1, 'the same person received the weekly digest more than once in a week');
});

test('two machines running the job at the same moment send one email between them', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'weekly digest marker'))) return;
    // Slow transport, so both runs are genuinely inside the send window together.
    transport = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 150));
    const person = await seedActiveAccount();

    await Promise.all([sendWeeklyDigestEmails(), sendWeeklyDigestEmails()]);

    assert.strictEqual(received(person.email), 1);
});

test('a send that failed is retried by the next run, not written off for the week', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'weekly digest marker'))) return;
    const person = await seedActiveAccount();

    transport = async (message) => (message.to === person.email ? { ok: false, status: 503 } : { ok: true });
    await sendWeeklyDigestEmails();
    assert.strictEqual(received(person.email), 0);

    transport = async () => ({ ok: true });
    await sendWeeklyDigestEmails();
    assert.strictEqual(received(person.email), 1, 'a Resend outage must not cost somebody their digest');
});

test('next week, they get the next one', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'weekly digest marker'))) return;
    transport = async () => ({ ok: true });
    const person = await seedActiveAccount();

    await sendWeeklyDigestEmails();
    await db.query(
        `UPDATE weekly_digest_workspace_sends
            SET claimed_at = NOW() - interval '7 days', last_sent_at = NOW() - interval '7 days'
          WHERE user_id = $1`,
        [person.userId], 'org-system'
    );
    await sendWeeklyDigestEmails();

    assert.strictEqual(received(person.email), 2, 'the marker suppresses a repeat, not the product');
});

test('deleting the person removes their marker with them', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'weekly digest marker'))) return;
    transport = async () => ({ ok: true });
    const person = await seedActiveAccount();
    await sendWeeklyDigestEmails();

    await db.query('DELETE FROM users WHERE user_id = $1', [person.userId], 'org-system');

    const left = await db.query('SELECT 1 FROM weekly_digest_workspace_sends WHERE user_id = $1', [person.userId], 'org-system');
    assert.strictEqual(left.rows.length, 0, 'a row about an erased person must not survive them, or block the delete');
});
