'use strict';

/**
 * Thing 3f: the morning after a first save, the person gets their own brief.
 *
 * Real database, real save paths, encryption at rest ON, a transport that
 * counts; nothing reaches a provider. The clock is passed in (`now`), because
 * the job decides on "10-40 hours after the first save" and "inside the morning
 * window", and production has no simulated clock to lean on.
 *
 *   DATABASE_URL=... DEERDAWN_TEST_DB_NO_LOCK=1 bash scripts/run-db-test.sh \
 *     node --test --test-concurrency=1 tests/integration/morning-after-brief.test.js
 */

process.env.NODE_ENV = 'test';
process.env.RESEND_API_KEY = 're_test_not_a_real_key';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
delete process.env.MORNING_AFTER_BRIEF_ENABLED;
delete process.env.MORNING_AFTER_BRIEF_HOUR_UTC;
delete process.env.MORNING_AFTER_BRIEF_WINDOW_HOURS;

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
resendClient.sendEmail = async (message) => {
    outbox.push(message);
    return { ok: true };
};

const brief = require('../../src/services/email/morningAfterBrief');

const q = (sql, params) => db.query(sql, params, 'org-system');
const created = { orgs: new Set(), users: new Set() };
const mailsTo = (person) => outbox.filter((m) => m.to === person.email);

// The first moment at least `hours` from now whose UTC hour is 15: inside the
// default 14:00-18:00 window.
function windowTimeAfter(hours, from = new Date()) {
    const t = new Date(from.getTime() + hours * 3600000);
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 15, 0, 0));
    if (d < t) d.setUTCDate(d.getUTCDate() + 1);
    return d;
}

async function signUp(label, { unsubscribed = false, createdDaysAgo = 0 } = {}) {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const email = `${label}-${uuidv4().slice(0, 8)}@morningafter.test`;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status)
         VALUES ($1, $2, 'free', 'free', 'active')`,
        [orgId, `${label} workspace`],
    );
    await q(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject, weekly_digest_unsubscribed, created_at)
         VALUES ($1, $2, 'admin', $3, 'clerk', $4, $5, NOW() - make_interval(days => $6))`,
        [userId, email, orgId, `sub_${userId}`, unsubscribed, createdDaysAgo],
    );
    await workspace.ensureOwnerMembership(orgId, userId);
    created.orgs.add(orgId);
    created.users.add(userId);
    return { label, orgId, userId, email };
}

const actorOf = (p) => ({ type: 'user', id: p.userId, org_id: p.orgId, workspace_key: p.orgId, role: 'admin' });

// A save from a session: the hosted manage_memory update path.
async function saveFromChat(person, projectName) {
    const actor = actorOf(person);
    const project = await service.createProject(actor, { project_name: projectName });
    const outcome = await service.recordExplicitUpdate(actor, {
        session_id: `sess-${uuidv4()}`,
        tool: 'chatgpt_web',
        project_id: project.project_id,
        summary: 'We decided to ship the importer behind a flag.',
        extraction: {
            delta: {
                current_task: 'Ship the CSV importer',
                recent_decisions: [{ summary: 'Ship the importer behind a feature flag.', decided_at: new Date().toISOString() }],
                open_questions: ['Should the flag default on for teams?'],
                next_action: 'Write the migration for the import table',
            },
            confidence: 0.9,
        },
    });
    assert.ok(outcome.project, 'the save must land');
    return project;
}

before(async () => {
    const up = await db.pool.connect().then((c) => { c.release(); return true; }).catch(() => false);
    if (!up) return;
    await store.ensureSchema();
    await toolUsageDays.ensureTable();
    await brief.ensureTable();
});

after(async () => {
    for (const userId of created.users) {
        await q('DELETE FROM morning_after_brief_sends WHERE user_id = $1', [userId]).catch(() => {});
        await q('DELETE FROM tool_usage_days WHERE user_id = $1', [userId]).catch(() => {});
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

test('off by default: nothing is sent until MORNING_AFTER_BRIEF_ENABLED is set', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    const saver = await signUp('flagoff');
    await saveFromChat(saver, `Flag off ${uuidv4().slice(0, 6)}`);

    const result = await brief.sendMorningAfterBriefs({ now: windowTimeAfter(12) });

    assert.deepEqual(result, { skipped: true, reason: 'disabled' });
    assert.equal(mailsTo(saver).length, 0);
    assert.equal(brief.isEnabled({ MORNING_AFTER_BRIEF_ENABLED: 'true' }), true);
    assert.equal(brief.isEnabled({}), false);
    assert.equal(brief.isEnabled({ MORNING_AFTER_BRIEF_ENABLED: 'false' }), false);
});

test('the morning after a first save, the person gets their own brief, once, in plain text', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    try {
        const saver = await signUp('saver');
        const name = `Atlas Importer ${uuidv4().slice(0, 6)}`;
        const project = await saveFromChat(saver, name);
        // Encryption at rest is on: the stored context is ciphertext.
        const raw = await q('SELECT context FROM context_projects WHERE project_id = $1', [project.project_id]);
        assert.ok(raw.rows[0].context._enc, 'fixture must exercise the encrypted read path');

        // Too soon: within 10 hours of the save, nobody is due.
        const soon = await brief.findBriefRecipients({ now: new Date(Date.now() + 60000) });
        assert.ok(!soon.some((r) => r.user_id === saver.userId), 'not within 10 hours of the save');

        const morning = windowTimeAfter(12);
        await brief.sendMorningAfterBriefs({ now: morning });
        await brief.sendMorningAfterBriefs({ now: new Date(morning.getTime() + 3600000) });

        const mails = mailsTo(saver);
        assert.equal(mails.length, 1, 'exactly one brief, however many ticks run');
        const [mail] = mails;
        assert.equal(mail.subject, `Your ${name} brief for next time`);
        assert.ok(mail.text, 'plain text');
        assert.equal(mail.html, undefined, 'no html part');
        assert.match(mail.from, /john@deerdawn\.com/);
        assert.equal(mail.replyTo, 'john@deerdawn.com');
        assert.match(mail.text, /Working on: Ship the CSV importer/);
        assert.match(mail.text, /Latest decision: Ship the importer behind a feature flag\./);
        assert.match(mail.text, /Open question: Should the flag default on for teams\?/);
        assert.match(mail.text, /Next step: Write the migration for the import table/);
        assert.match(mail.text, /in ChatGPT: @DeerDawn where did I leave off\?/);
        assert.match(mail.text, /in Claude: Where did I leave off\? Check DeerDawn/);
        assert.doesNotMatch(mail.text, /in Codex/, 'Codex line only for people who use Codex');
        assert.match(mail.text, /reply with their name/, 'the teammate line');
        assert.match(mail.text, /Unsubscribe: \S+\/api\/v1\/email\/unsubscribe\?u=/);
        // No project name in any URL.
        for (const url of mail.text.match(/https?:\/\/\S+/g) || []) {
            assert.ok(!url.includes('Atlas') && !url.includes(project.project_id), `project in a URL: ${url}`);
        }

        // And the transport really does send it as text, with the postal line.
        assert.match(resendClient.withPostalFooterText('Hi'), /Wilmington, DE/);
    } finally {
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});

test('only a FIRST save: somebody who saved before gets nothing', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    try {
        const old = await signUp('oldhand');
        const project = await saveFromChat(old, `Old ${uuidv4().slice(0, 6)}`);
        // Their earlier save, a week ago.
        await q(
            `INSERT INTO context_events (event_id, project_id, source_type, source_id, event_kind, delta, confidence, contributing_user_id, created_at)
             VALUES ($1, $2, 'claude_code', 'x', 'context_delta_applied', '{}', 1, $3, NOW() - interval '7 days')`,
            [`evt-${uuidv4()}`, project.project_id, old.userId],
        );
        await brief.sendMorningAfterBriefs({ now: windowTimeAfter(12) });
        assert.equal(mailsTo(old).length, 0);
    } finally {
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});

test('unsubscribed people and a project that is only created (never saved from a session) get nothing', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    try {
        const unsub = await signUp('unsub', { unsubscribed: true });
        await saveFromChat(unsub, `Unsub ${uuidv4().slice(0, 6)}`);
        const maker = await signUp('maker');
        await service.createProject(actorOf(maker), { project_name: `Made ${uuidv4().slice(0, 6)}`, description: 'Typed in the dashboard.' });

        await brief.sendMorningAfterBriefs({ now: windowTimeAfter(12) });

        assert.equal(mailsTo(unsub).length, 0, 'weekly_digest_unsubscribed is honoured');
        assert.equal(mailsTo(maker).length, 0, 'creating a project is not a save from a session');
    } finally {
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});

test('outside the morning window nothing is sent', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    try {
        const late = windowTimeAfter(12);
        late.setUTCHours(22);
        const res = await brief.sendMorningAfterBriefs({ now: late });
        assert.deepEqual(res, { skipped: true, reason: 'outside_window' });
        assert.equal(brief.inMorningWindow(new Date('2026-10-04T14:00:00Z'), { hour: 14, windowHours: 4 }), true);
        assert.equal(brief.inMorningWindow(new Date('2026-10-04T18:00:00Z'), { hour: 14, windowHours: 4 }), false);
        assert.equal(brief.inMorningWindow(new Date('2026-10-04T01:00:00Z'), { hour: 22, windowHours: 4 }), true);
    } finally {
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});

test('one reminder three days later if they have not come back, then stop', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    try {
        const quiet = await signUp('quiet');
        const back = await signUp('cameback');
        const quietName = `Quiet ${uuidv4().slice(0, 6)}`;
        await saveFromChat(quiet, quietName);
        await saveFromChat(back, `Back ${uuidv4().slice(0, 6)}`);

        const morning = windowTimeAfter(12);
        await brief.sendMorningAfterBriefs({ now: morning });
        assert.equal(mailsTo(quiet).length, 1);
        assert.equal(mailsTo(back).length, 1);

        // `back` returns the next day and only READS: the usage-day row is the
        // whole evidence.
        const nextDay = new Date(morning.getTime() + 86400000);
        await q(
            'INSERT INTO tool_usage_days (user_id, day, tool_name, client) VALUES ($1, $2::date, $3, $4)',
            [back.userId, nextDay.toISOString().slice(0, 10), 'recall', 'chatgpt_web'],
        );

        // Two days on: too soon for a reminder.
        await brief.sendMorningAfterBriefs({ now: new Date(morning.getTime() + 2 * 86400000) });
        assert.equal(mailsTo(quiet).length, 1);

        const reminderMorning = new Date(morning.getTime() + 3 * 86400000);
        await brief.sendMorningAfterBriefs({ now: reminderMorning });
        await brief.sendMorningAfterBriefs({ now: new Date(reminderMorning.getTime() + 86400000) });
        await brief.sendMorningAfterBriefs({ now: new Date(reminderMorning.getTime() + 4 * 86400000) });

        const quietMails = mailsTo(quiet);
        assert.equal(quietMails.length, 2, 'one reminder, then stop');
        assert.equal(quietMails[1].subject, `Your brief for ${quietName} is waiting`);
        assert.match(quietMails[1].text, /The next step you saved: Write the migration for the import table\./);
        assert.match(quietMails[1].text, /Unsubscribe: /);
        assert.equal(mailsTo(back).length, 1, 'somebody who came back, even only to read, is not reminded');
    } finally {
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});

test('a failed send gives the claim back, so the next tick retries', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    const realSend = resendClient.sendEmail;
    try {
        const flaky = await signUp('flaky');
        await saveFromChat(flaky, `Flaky ${uuidv4().slice(0, 6)}`);
        const morning = windowTimeAfter(12);
        resendClient.sendEmail = async (m) => (m.to === flaky.email ? { ok: false, status: 500 } : realSend(m));
        await brief.sendMorningAfterBriefs({ now: morning });
        const row = await q('SELECT 1 FROM morning_after_brief_sends WHERE user_id = $1', [flaky.userId]);
        assert.equal(row.rows.length, 0, 'the claim was released');
        resendClient.sendEmail = realSend;
        await brief.sendMorningAfterBriefs({ now: new Date(morning.getTime() + 3600000) });
        assert.equal(mailsTo(flaky).length, 1);
    } finally {
        resendClient.sendEmail = realSend;
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});

test('rendering: the brief quotes one line of each, and skips a context with nothing to quote', () => {
    assert.equal(brief.briefLines({}), null);
    assert.equal(brief.briefLines({ _decrypt_error: true }), null);
    const lines = brief.briefLines({
        current_task: 'Line one\nline two',
        recent_decisions: [{ summary: 'Resolved one.', resolved: true, decided_at: '2026-10-01T00:00:00Z' }],
        open_questions: ['', 'Real question?'],
        next_action: '',
    });
    assert.deepEqual(lines, { task: 'Line one line two', decision: '', question: 'Real question?', next: '' });
    const text = brief.renderBriefText({ projectName: 'P', lines, unsubUrl: 'https://x/u', usesCodex: true });
    assert.match(text, /in Codex: it loads at the start of each task/);
    assert.doesNotMatch(text, /Next step:/, 'no empty "Next step:" line');
});

test('a SENT brief keeps its claim even when the bookkeeping after it fails: no second copy', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    const realMark = brief._internals.markBriefSent;
    try {
        const p = await signUp('markfails');
        await saveFromChat(p, `Mark ${uuidv4().slice(0, 6)}`);
        const morning = windowTimeAfter(12);
        brief._internals.markBriefSent = async () => { throw new Error('db blip after send'); };
        await brief.sendMorningAfterBriefs({ now: morning });
        brief._internals.markBriefSent = realMark;
        assert.equal(mailsTo(p).length, 1);
        await brief.sendMorningAfterBriefs({ now: new Date(morning.getTime() + 3600000) });
        assert.equal(mailsTo(p).length, 1, 'THE BUG: the claim was released after Resend accepted the email, and the next tick re-sent it');
    } finally {
        brief._internals.markBriefSent = realMark;
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});

test('a long-time user whose earlier saves the events table cannot show is not greeted as new', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    try {
        // Account months old: saves from before contributing_user_id existed
        // (2026-06-08), or in since-deleted projects, leave no trace.
        const veteran = await signUp('veteran', { createdDaysAgo: 120 });
        await saveFromChat(veteran, `Vet ${uuidv4().slice(0, 6)}`);
        // A newish account that has nonetheless called a tool before the window.
        const caller = await signUp('priorcaller', { createdDaysAgo: 1 });
        await saveFromChat(caller, `Caller ${uuidv4().slice(0, 6)}`);
        await q(
            `INSERT INTO product_events (event_id, event_name, org_id, user_id, source, metadata, created_at)
             VALUES ($1, 'mcp_tool_call_succeeded', $2, $3, 'mcp', '{}', NOW() - interval '3 days')`,
            [uuidv4(), caller.orgId, caller.userId],
        );
        // Control: a new account in the same run does get it.
        const fresh = await signUp('freshcontrol', { createdDaysAgo: 1 });
        await saveFromChat(fresh, `Fresh ${uuidv4().slice(0, 6)}`);

        await brief.sendMorningAfterBriefs({ now: windowTimeAfter(12) });

        assert.equal(mailsTo(veteran).length, 0, 'an old account is not a first save');
        assert.equal(mailsTo(caller).length, 0, 'an earlier MCP call is not a first session');
        assert.equal(mailsTo(fresh).length, 1, 'the guard must not stop a genuinely new person');
    } finally {
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});

test('an unattributed project is quoted only in a one-person workspace', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    try {
        const solo = await signUp('unattrsolo');
        const soloProject = await saveFromChat(solo, `Solo ${uuidv4().slice(0, 6)}`);
        await q('UPDATE context_projects SET owner_user_id = NULL WHERE project_id = $1', [soloProject.project_id]);

        const teamed = await signUp('unattrteam');
        const teamProject = await saveFromChat(teamed, `Team ${uuidv4().slice(0, 6)}`);
        await q('UPDATE context_projects SET owner_user_id = NULL WHERE project_id = $1', [teamProject.project_id]);
        const mate = await signUp('unattrmate');
        await q(
            'INSERT INTO workspace_members (owner_key, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [teamed.orgId, mate.userId, 'member'],
        );

        await brief.sendMorningAfterBriefs({ now: windowTimeAfter(12) });

        assert.equal(mailsTo(solo).length, 1, 'solo and unattributed: it is theirs');
        assert.equal(mailsTo(teamed).length, 0, 'in a team an unattributed project is read through a share policy; the email does not quote it');
    } finally {
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});

test('no reminder for somebody who has since left the workspace', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'morning-after brief'))) return;
    process.env.MORNING_AFTER_BRIEF_ENABLED = 'true';
    try {
        const leaver = await signUp('leaver');
        await saveFromChat(leaver, `Leaver ${uuidv4().slice(0, 6)}`);
        const morning = windowTimeAfter(12);
        await brief.sendMorningAfterBriefs({ now: morning });
        assert.equal(mailsTo(leaver).length, 1);
        await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [leaver.orgId, leaver.userId]);
        await brief.sendMorningAfterBriefs({ now: new Date(morning.getTime() + 3 * 86400000) });
        assert.equal(mailsTo(leaver).length, 1, 'the reminder re-checks membership before quoting the project');
    } finally {
        delete process.env.MORNING_AFTER_BRIEF_ENABLED;
    }
});
