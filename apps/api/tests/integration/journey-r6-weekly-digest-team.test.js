/**
 * JOURNEY R6 - THE WEEKLY DIGEST GOES TO EVERY MEMBER (owner decision, round 3
 * table row "Weekly digest in a team": every member, scoped to what they may
 * read; backlog "the weekly digest timer counts seven days from boot").
 *
 * Real database, real job function, a transport that counts. Nothing here
 * reaches an email provider: resendClient.sendEmail is replaced on the module
 * object, which is how the sender reads it, and RESEND_API_KEY is a dummy that
 * only opens the job's own "is email configured" gate.
 *
 *   DATABASE_URL=... REDIS_URL=... DEERDAWN_TEST_DB_NO_LOCK=1 bash scripts/run-db-test.sh \
 *     node --test --test-concurrency=1 tests/integration/journey-r6-weekly-digest-team.test.js
 */

process.env.NODE_ENV = 'test';
process.env.RESEND_API_KEY = 're_test_not_a_real_key';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const service = require('../../src/services/contextSyncService');
const workspace = require('../../src/services/workspaceService');

const resendClient = require('../../src/services/email/resendClient');
const outbox = [];
let transport = async () => ({ ok: true });
resendClient.sendEmail = async (message) => {
    const result = await transport(message);
    if (result.ok) outbox.push(message);
    return result;
};

const digest = require('../../src/services/email/weeklyDigest');

const q = (sql, params) => db.query(sql, params, 'org-system');
const created = { orgs: new Set(), users: new Set() };

async function makePerson(label) {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const email = `${label}-${uuidv4().slice(0, 8)}@r6digest.test`;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type, purchased_seats)
         VALUES ($1, $2, 'developer_pro', 'developer_pro', 'active', 'organization', 5)`,
        [orgId, `${label} workspace`],
    );
    await q(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject)
         VALUES ($1, $2, 'admin', $3, 'clerk', $4)`,
        [userId, email, orgId, `sub_${userId}`],
    );
    await workspace.ensureOwnerMembership(orgId, userId);
    created.orgs.add(orgId);
    created.users.add(userId);
    return { label, orgId, userId, email };
}

async function join(owner, joiner, role) {
    const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
    const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
    assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function actorIn(person, ownerKey, role = 'member') {
    return { type: 'user', id: person.userId, org_id: ownerKey, workspace_key: ownerKey, role };
}

async function project(person, ownerKey, name, visibility) {
    const p = await service.createProject(actorIn(person, ownerKey), { project_name: `${name} ${uuidv4().slice(0, 6)}` });
    await q('UPDATE context_projects SET visibility = $1 WHERE project_id = $2', [visibility, p.project_id]);
    return p.project_id;
}

async function makeStale(projectId) {
    await q('UPDATE context_events SET created_at = NOW() - interval \'20 days\' WHERE project_id = $1', [projectId]);
    await q('UPDATE context_projects SET updated_at = NOW() - interval \'20 days\' WHERE project_id = $1', [projectId]);
}

async function decisionNode(ownerKey, projectId, title) {
    await q(
        `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, summary, source_tool)
         VALUES ($1, $2, $3, 'decision', $4, $5, $5, 'test')`,
        [`node-${uuidv4()}`, ownerKey, projectId, `decision-${uuidv4()}`, title],
    );
}

const mailTo = (email) => outbox.filter((m) => m.to === email);
const strong = (html, label) => {
    const m = html.match(new RegExp(`<strong>(\\d+)</strong> ${label}`));
    return m ? Number(m[1]) : 0;
};

after(async () => {
    for (const orgId of created.orgs) {
        await q('DELETE FROM context_graph_nodes WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId]).catch(() => {});
        await q('DELETE FROM context_projects WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId]).catch(() => {});
    }
    for (const userId of created.users) await q('DELETE FROM users WHERE user_id = $1', [userId]).catch(() => {});
    for (const orgId of created.orgs) await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

// A Wednesday, so the schedule tests know which Monday the slot opened on.
const WED = new Date('2026-09-30T10:00:00Z');

test('every member gets a digest, each scoped to what that member may read', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 digest'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    const memberM = await makePerson('memberm');
    const memberN = await makePerson('membern');
    const viewer = await makePerson('viewer');
    await join(owner, memberM, 'member');
    await join(owner, memberN, 'member');
    await join(owner, viewer, 'viewer');
    const ws = owner.orgId;

    const personalOfN = await project(memberN, ws, 'personal-n', 'personal');
    await project(memberM, ws, 'private-m', 'private');
    const sharedByN = await project(memberN, ws, 'shared-n', 'shared');
    // Older work: one shared, one N's personal. Drifting counts are visibility
    // filtered exactly like the active ones.
    const staleShared = await project(memberN, ws, 'stale-shared', 'shared');
    const stalePersonal = await project(memberN, ws, 'stale-personal', 'personal');
    await makeStale(staleShared);
    await makeStale(stalePersonal);
    // A decision captured this week inside N's personal project.
    await decisionNode(ws, personalOfN, 'N decided something private');
    await decisionNode(ws, sharedByN, 'the team decided something');

    await digest.sendWeeklyDigestEmails({ now: WED });

    for (const person of [owner, memberM, memberN, viewer]) {
        assert.equal(mailTo(person.email).length, 1, `${person.label} must receive exactly one digest`);
    }
    const html = (person) => mailTo(person.email)[0].html;

    // Projects active this week. personal: author only. private: author + owner.
    // shared: everybody. A viewer reads shared work only.
    assert.equal(strong(html(owner), 'projects active'), 2, 'owner: shared + private, never N\'s personal');
    assert.equal(strong(html(memberM), 'projects active'), 2, 'M: own private + shared');
    assert.equal(strong(html(memberN), 'projects active'), 2, 'N: own personal + shared, not M\'s private');
    assert.equal(strong(html(viewer), 'projects active'), 1, 'viewer: shared only');

    // Drifting: the stale personal project is N\'s alone.
    assert.match(html(memberN), /2 projects drifting/);
    assert.match(html(owner), /1 project drifting/);
    assert.match(html(viewer), /1 project drifting/);

    // Decisions: the one homed in N's personal project is counted for N only.
    assert.equal(strong(html(memberN), 'decisions captured'), 2);
    assert.equal(strong(html(owner), 'decisions captured'), 1);
    assert.equal(strong(html(viewer), 'decisions captured'), 1);
});

test('a member with nothing they may read this week gets no digest', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 digest'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    const member = await makePerson('member');
    await join(owner, member, 'member');
    await project(member, owner.orgId, 'only-personal', 'personal');

    await digest.sendWeeklyDigestEmails({ now: WED });

    assert.equal(mailTo(member.email).length, 1, 'the author of the only active work hears about it');
    assert.equal(mailTo(owner.email).length, 0, 'the owner may not read it, so the digest has nothing to say');
});

test('an unsubscribed member is skipped and a removed member is not written to', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 digest'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    const quiet = await makePerson('quiet');
    const gone = await makePerson('gone');
    await join(owner, quiet, 'member');
    await join(owner, gone, 'member');
    await project(owner, owner.orgId, 'shared', 'shared');
    await q('UPDATE users SET weekly_digest_unsubscribed = TRUE WHERE user_id = $1', [quiet.userId]);
    await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [owner.orgId, gone.userId]);

    await digest.sendWeeklyDigestEmails({ now: WED });

    assert.equal(mailTo(owner.email).length, 1);
    assert.equal(mailTo(quiet.email).length, 0, 'unsubscribed means unsubscribed');
    assert.equal(mailTo(gone.email).length, 0, 'a person the workspace removed is not its member any more');
});

test('the marker is per person per workspace: a second workspace is not suppressed by the first', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 digest'))) return;
    transport = async () => ({ ok: true });
    const ownerA = await makePerson('ownera');
    const ownerB = await makePerson('ownerb');
    const both = await makePerson('both');
    await join(ownerA, both, 'member');
    await join(ownerB, both, 'member');
    await project(ownerA, ownerA.orgId, 'a-shared', 'shared');
    await project(ownerB, ownerB.orgId, 'b-shared', 'shared');

    await digest.sendWeeklyDigestEmails({ now: WED });
    assert.equal(mailTo(both.email).length, 2, 'one digest for each workspace they belong to');

    await digest.sendWeeklyDigestEmails({ now: new Date(WED.getTime() + 3600e3) });
    assert.equal(mailTo(both.email).length, 2, 'and neither repeats');
});

// ── The schedule ────────────────────────────────────────────────────────────

test('the send slot is a fixed weekday and hour, not seven days from boot', () => {
    const at = (iso) => digest.currentSlotStart(new Date(iso)).toISOString();
    // Default: Monday 14:00 UTC.
    assert.equal(at('2026-09-28T14:00:00Z'), '2026-09-28T14:00:00.000Z', 'exactly on the slot');
    assert.equal(at('2026-09-28T13:59:00Z'), '2026-09-21T14:00:00.000Z', 'a minute before it is still last week\'s');
    assert.equal(at('2026-09-30T10:00:00Z'), '2026-09-28T14:00:00.000Z', 'Wednesday belongs to that Monday\'s slot');
    assert.equal(at('2026-10-04T23:59:00Z'), '2026-09-28T14:00:00.000Z', 'Sunday night too');
    assert.equal(at('2026-10-05T14:01:00Z'), '2026-10-05T14:00:00.000Z', 'and the next Monday opens the next slot');
});

test('restarts and extra ticks inside a slot send nothing; the next slot sends again; a late boot catches up once', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 digest'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    await project(owner, owner.orgId, 'shared', 'shared');
    const at = (iso) => new Date(iso);

    // The service boots on a Wednesday: nobody has had this slot's digest, so
    // the first tick is a catch-up rather than waiting a week from boot.
    await digest.sendWeeklyDigestEmails({ now: at('2026-09-30T10:00:00Z') });
    assert.equal(mailTo(owner.email).length, 1, 'a boot after the slot opened still delivers it');

    // Hourly ticks, a restart, a second machine: same slot, no second copy.
    await digest.sendWeeklyDigestEmails({ now: at('2026-09-30T11:00:00Z') });
    await digest.sendWeeklyDigestEmails({ now: at('2026-10-02T03:00:00Z') });
    await digest.sendWeeklyDigestEmails({ now: at('2026-10-04T23:00:00Z') });
    assert.equal(mailTo(owner.email).length, 1, 'no drift and no double send inside one slot');

    // The next slot opens on Monday 14:00 UTC and a tick that lands then sends.
    await q('UPDATE context_projects SET updated_at = NOW() WHERE owner_key = $1', [owner.orgId]);
    await digest.sendWeeklyDigestEmails({ now: at('2026-10-05T13:30:00Z') });
    assert.equal(mailTo(owner.email).length, 1, 'before the slot opens, still last week\'s');
    await digest.sendWeeklyDigestEmails({ now: at('2026-10-05T14:05:00Z') });
    assert.equal(mailTo(owner.email).length, 2, 'the next slot sends');
});

test('the scheduler ticks often enough to hit the slot and no longer arms a seven-day timer', async () => {
    const scheduler = require('../../src/jobs/scheduler');
    const intervals = [];
    const realSetInterval = global.setInterval;
    global.setInterval = (fn, ms) => {
        intervals.push({ fn, ms });
        return { unref() {}, ref() {} };
    };
    const realSetTimeout = global.setTimeout;
    global.setTimeout = () => ({ unref() {}, ref() {} });
    try {
        scheduler.startScheduler();
    } finally {
        global.setInterval = realSetInterval;
        global.setTimeout = realSetTimeout;
    }
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    assert.ok(
        !intervals.some((i) => i.ms === weekMs),
        'a timer that counts seven days from boot is the drift this fixes',
    );
    const tick = intervals.find((i) => i.fn === scheduler._jobs.runWeeklyDigest);
    assert.ok(tick, 'the digest job must be on a timer');
    assert.ok(tick.ms <= 60 * 60 * 1000, 'at most an hour between ticks, so a slot is never missed by a day');
    scheduler.stopScheduler();
});
