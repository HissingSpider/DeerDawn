'use strict';

/**
 * The value ladder against a real database: the facts query, the claims, the
 * cooldown across lifecycle jobs, and the milestone events. Real save paths,
 * encryption at rest ON, a transport that counts; nothing reaches a provider.
 *
 *   DATABASE_URL=... bash scripts/run-db-test.sh \
 *     node --test --test-concurrency=1 tests/integration/value-ladder.test.js
 */

process.env.NODE_ENV = 'test';
process.env.RESEND_API_KEY = 're_test_not_a_real_key';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
delete process.env.VALUE_LADDER_EMAILS_ENABLED;
delete process.env.VALUE_LADDER_HOUR_UTC;
delete process.env.VALUE_LADDER_WINDOW_HOURS;

const test = require('node:test');
const { after, before } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const workspace = require('../../src/services/workspaceService');
const toolUsageDays = require('../../src/services/toolUsageDays');

const resendClient = require('../../src/services/email/resendClient');
const outbox = [];
let failNextSend = false;
resendClient.sendEmail = async (message) => {
    if (failNextSend) {
        failNextSend = false;
        return { ok: false, error: 'provider down' };
    }
    outbox.push(message);
    return { ok: true };
};

const ladder = require('../../src/services/email/valueLadder');
const morningAfter = require('../../src/services/email/morningAfterBrief');
const weeklyDigest = require('../../src/services/email/weeklyDigest');
const autoArchiveNotice = require('../../src/services/email/autoArchiveNotice');

const q = (sql, params) => db.query(sql, params, 'org-system');
const created = { orgs: new Set(), users: new Set() };
const mailsTo = (person) => outbox.filter((m) => m.to === person.email);

// 15:00 UTC today, inside the default 14:00-22:00 window.
const NOW = (() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0));
})();
const daysBefore = (n) => new Date(NOW.getTime() - n * 86400000);
const dayBefore = (n) => daysBefore(n).toISOString().slice(0, 10);

async function signUp(label, { createdDaysAgo = 0, unsubscribed = false, domain = 'valueladder.test' } = {}) {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const email = `${label}-${uuidv4().slice(0, 8)}@${domain}`;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status)
         VALUES ($1, $2, 'free', 'free', 'active')`,
        [orgId, `${label} workspace`],
    );
    await q(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject, weekly_digest_unsubscribed, created_at)
         VALUES ($1, $2, 'admin', $3, 'clerk', $4, $5, $6)`,
        [userId, email, orgId, `sub_${userId}`, unsubscribed, daysBefore(createdDaysAgo).toISOString()],
    );
    await workspace.ensureOwnerMembership(orgId, userId);
    created.orgs.add(orgId);
    created.users.add(userId);
    return { label, orgId, userId, email };
}

const actorOf = (p) => ({ type: 'user', id: p.userId, org_id: p.orgId, workspace_key: p.orgId, role: 'admin' });

// A save from a ChatGPT session, then dated `savedDaysAgo` before NOW.
async function saveFromChat(person, projectName, savedDaysAgo) {
    const actor = actorOf(person);
    const project = await service.createProject(actor, { project_name: projectName });
    await service.recordExplicitUpdate(actor, {
        session_id: `sess-${uuidv4()}`,
        tool: 'chatgpt_web',
        project_id: project.project_id,
        summary: 'We decided to ship the importer behind a flag.',
        extraction: {
            delta: {
                current_task: 'Ship the CSV importer',
                recent_decisions: [{ summary: 'Ship the importer behind a feature flag.', decided_at: new Date().toISOString() }],
                next_action: 'Write the migration for the import table',
            },
            confidence: 0.9,
        },
    });
    await q('UPDATE context_events SET created_at = $2 WHERE project_id = $1', [project.project_id, daysBefore(savedDaysAgo).toISOString()]);
    return project;
}

async function usedOn(person, ...daysAgo) {
    for (const n of daysAgo) {
        await q(
            `INSERT INTO tool_usage_days (user_id, day, tool_name, client) VALUES ($1, $2::date, 'start_session', 'chatgpt_web')
             ON CONFLICT DO NOTHING`,
            [person.userId, dayBefore(n)],
        );
    }
}

async function eventsOf(person, name) {
    const res = await q('SELECT metadata FROM product_events WHERE user_id = $1 AND event_name = $2', [person.userId, name]);
    return res.rows;
}

const run = (people) => ladder.runValueLadder({ now: NOW, userIds: people.map((p) => p.userId) });

before(async () => {
    const up = await db.pool.connect().then((c) => { c.release(); return true; }).catch(() => false);
    if (!up) return;
    await store.ensureSchema();
    await toolUsageDays.ensureTable();
    await morningAfter.ensureTable();
    await ladder.ensureTable();
    await weeklyDigest.ensureSendLog();
    await autoArchiveNotice.ensureNoticeLog();
});

after(async () => {
    for (const userId of created.users) {
        await q('DELETE FROM value_ladder_sends WHERE user_id = $1', [userId]).catch(() => {});
        await q('DELETE FROM morning_after_brief_sends WHERE user_id = $1', [userId]).catch(() => {});
        await q('DELETE FROM tool_usage_days WHERE user_id = $1', [userId]).catch(() => {});
        await q('DELETE FROM weekly_digest_workspace_sends WHERE user_id = $1', [userId]).catch(() => {});
        await q('DELETE FROM project_archive_notices WHERE user_id = $1', [userId]).catch(() => {});
        await q('DELETE FROM product_events WHERE user_id = $1', [userId]).catch(() => {});
    }
    for (const orgId of created.orgs) {
        await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId]).catch(() => {});
        await q('DELETE FROM context_sessions WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM context_projects WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM product_events WHERE org_id = $1', [orgId]).catch(() => {});
    }
    for (const userId of created.users) await q('DELETE FROM users WHERE user_id = $1', [userId]).catch(() => {});
    for (const orgId of created.orgs) await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('off by default: milestones are recorded, nothing is sent', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'value ladder'))) return;
    const p = await signUp('flagoff', { createdDaysAgo: 4 });
    await saveFromChat(p, `Flag off ${uuidv4().slice(0, 6)}`, 4);
    await usedOn(p, 4, 1);

    const result = await run([p]);

    assert.equal(result.sending, false);
    assert.equal(mailsTo(p).length, 0);
    assert.equal((await eventsOf(p, ladder.RETURN_EVENT)).length, 1, 'the return is recorded even with sending off');
    await run([p]);
    assert.equal((await eventsOf(p, ladder.RETURN_EVENT)).length, 1, 'once per person');
});

test('a first return gets "it worked" with their own brief, once', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'value ladder'))) return;
    process.env.VALUE_LADDER_EMAILS_ENABLED = 'true';
    try {
        const p = await signUp('returner', { createdDaysAgo: 4 });
        await saveFromChat(p, `Importer ${uuidv4().slice(0, 6)}`, 4);
        await usedOn(p, 4, 1);

        await run([p]);
        const mails = mailsTo(p);
        assert.equal(mails.length, 1);
        assert.match(mails[0].subject, /make it automatic/i);
        assert.match(mails[0].text, /Working on: Ship the CSV importer/);
        assert.match(mails[0].text, /Custom instructions/);
        const sent = await eventsOf(p, ladder.SENT_EVENT);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].metadata.email_type, ladder.EMAIL.RETURNED);

        await run([p]);
        assert.equal(mailsTo(p).length, 1, 'never twice');
    } finally {
        delete process.env.VALUE_LADDER_EMAILS_ENABLED;
    }
});

test('a signup who never connected gets the /start nudge on day 4-10, and a failed send is retried', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'value ladder'))) return;
    process.env.VALUE_LADDER_EMAILS_ENABLED = 'true';
    try {
        const p = await signUp('unused', { createdDaysAgo: 5 });
        failNextSend = true;
        await run([p]);
        assert.equal(mailsTo(p).length, 0);
        await run([p]);
        const mails = mailsTo(p);
        assert.equal(mails.length, 1, 'the failed send gave its claim back');
        assert.match(mails[0].text, /not connected/);
        assert.match(mails[0].text, /\/start\?/);
    } finally {
        delete process.env.VALUE_LADDER_EMAILS_ENABLED;
    }
});

test('48 hours of quiet after another lifecycle email; unsubscribed and internal accounts never', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'value ladder'))) return;
    process.env.VALUE_LADDER_EMAILS_ENABLED = 'true';
    try {
        const recent = await signUp('cooldown', { createdDaysAgo: 5 });
        await q(
            `INSERT INTO product_events (event_id, event_name, user_id, org_id, source, created_at)
             VALUES ($1, 'activation_followup_email_sent', $2, $3, 'api', $4)`,
            [uuidv4(), recent.userId, recent.orgId, daysBefore(1).toISOString()],
        );
        const unsub = await signUp('unsub', { createdDaysAgo: 5, unsubscribed: true });
        const internal = await signUp('staff', { createdDaysAgo: 5, domain: 'deerdawn.com' });

        await run([recent, unsub, internal]);

        assert.equal(mailsTo(recent).length, 0);
        assert.equal(mailsTo(unsub).length, 0);
        assert.equal(mailsTo(internal).length, 0);
    } finally {
        delete process.env.VALUE_LADDER_EMAILS_ENABLED;
    }
});

test('third day of use: the habit email and the milestone; no upgrade without a paid signal', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'value ladder'))) return;
    process.env.VALUE_LADDER_EMAILS_ENABLED = 'true';
    try {
        const p = await signUp('habit', { createdDaysAgo: 6 });
        await saveFromChat(p, `Habit ${uuidv4().slice(0, 6)}`, 6);
        await usedOn(p, 6, 3, 1);

        await run([p]);
        assert.equal(mailsTo(p).length, 1);
        assert.match(mailsTo(p)[0].subject, /Three days in/);
        assert.equal((await eventsOf(p, ladder.HABIT_EVENT)).length, 1);

        const facts = (await ladder.loadFacts({ now: NOW, userIds: [p.userId] }))[0];
        assert.equal(facts.ownProjects, 1);
        assert.equal(ladder.upgradeSignal(facts), null);
    } finally {
        delete process.env.VALUE_LADDER_EMAILS_ENABLED;
    }
});

test('day 21: one "still there?" email, a week clear of the digest and the archive notice', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'value ladder'))) return;
    process.env.VALUE_LADDER_EMAILS_ENABLED = 'true';
    try {
        const quiet = await signUp('day21', { createdDaysAgo: 25 });
        const digested = await signUp('day21digest', { createdDaysAgo: 25 });
        await q(
            `INSERT INTO weekly_digest_workspace_sends (user_id, owner_key, claimed_at, last_sent_at, sends)
             VALUES ($1, $2, $3, $3, 1)`,
            [digested.userId, digested.orgId, daysBefore(3).toISOString()],
        );
        const archived = await signUp('day21archive', { createdDaysAgo: 25 });
        await q(
            'INSERT INTO project_archive_notices (user_id, project_id, archived_at, sent_at) VALUES ($1, $2, $3, $3)',
            [archived.userId, `proj-${uuidv4()}`, daysBefore(1).toISOString()],
        );
        const returned = await signUp('day21returned', { createdDaysAgo: 25 });
        await saveFromChat(returned, `Returned ${uuidv4().slice(0, 6)}`, 24);
        await usedOn(returned, 24, 22);

        await run([quiet, digested, archived, returned]);

        const mails = mailsTo(quiet);
        assert.equal(mails.length, 1);
        assert.equal(mails[0].subject, 'Did something get in the way?');
        assert.match(mails[0].text, /\/start\?utm_source=lifecycle&utm_medium=email&utm_campaign=day21/);
        const sent = await eventsOf(quiet, ladder.SENT_EVENT);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].metadata.email_type, ladder.EMAIL.STILL_THERE);
        assert.equal(mailsTo(digested).length, 0, 'a weekly digest 3 days ago holds it');
        assert.equal(mailsTo(archived).length, 0, 'an auto-archive notice yesterday holds it');
        assert.equal(mailsTo(returned).length, 0, 'a person who came back is never asked');

        const facts = (await ladder.loadFacts({ now: NOW, userIds: [digested.userId, archived.userId] }));
        assert.ok(facts.every((f) => f.lastLifecycleSentAt), 'both send logs feed the cooldown');

        await run([quiet]);
        assert.equal(mailsTo(quiet).length, 1, 'once per person, ever');
    } finally {
        delete process.env.VALUE_LADDER_EMAILS_ENABLED;
    }
});
