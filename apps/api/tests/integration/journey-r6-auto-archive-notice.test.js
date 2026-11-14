/**
 * JOURNEY R6 - AUTO-ARCHIVE SENDS ONE EMAIL WHEN IT HAPPENS (owner decision,
 * round 3 table row "Auto-archive: one email when it happens").
 *
 *   - It names the project(s) archived and says how to restore them.
 *   - One email per PERSON per archive run, however many projects they lose.
 *   - Never repeated for the same archive.
 *   - A SERVICE notice: sent even to somebody who unsubscribed from the digest.
 *   - Only to people who may read the project: its author and the workspace
 *     owners, and never an owner for a `personal` project. Viewers and other
 *     members are not told about work that was not theirs.
 *
 * The transport is replaced on the module object; nothing reaches a provider.
 *
 *   DATABASE_URL=... REDIS_URL=... DEERDAWN_TEST_DB_NO_LOCK=1 bash scripts/run-db-test.sh \
 *     node --test --test-concurrency=1 tests/integration/journey-r6-auto-archive-notice.test.js
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
const { generateApiKey } = require('../../src/utils/security');

const resendClient = require('../../src/services/email/resendClient');
const outbox = [];
let transport = async () => ({ ok: true });
resendClient.sendEmail = async (message) => {
    const result = await transport(message);
    if (result.ok) outbox.push(message);
    return result;
};

const { runAutoArchive } = require('../../src/jobs/autoArchiveJob');

const q = (sql, params) => db.query(sql, params, 'org-system');
const created = { orgs: new Set(), users: new Set() };

async function makePerson(label) {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const email = `${label}-${uuidv4().slice(0, 8)}@r6archive.test`;
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

async function idleProject(person, ownerKey, name, visibility, days = 45) {
    const actor = { type: 'user', id: person.userId, org_id: ownerKey, workspace_key: ownerKey, role: 'member' };
    const projectName = `${name}-${uuidv4().slice(0, 6)}`;
    const p = await service.createProject(actor, { project_name: projectName });
    await q('UPDATE context_projects SET visibility = $1, updated_at = NOW() - ($3 || \' days\')::interval WHERE project_id = $2', [visibility, p.project_id, String(days)]);
    return { id: p.project_id, name: projectName };
}

const mailTo = (email) => outbox.filter((m) => m.to === email);
const mentions = (email, project) => mailTo(email).some((m) => m.html.includes(project.name));

after(async () => {
    for (const orgId of created.orgs) {
        await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId]).catch(() => {});
        await q('DELETE FROM context_projects WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM api_keys WHERE org_id = $1', [orgId]).catch(() => {});
    }
    for (const userId of created.users) await q('DELETE FROM users WHERE user_id = $1', [userId]).catch(() => {});
    for (const orgId of created.orgs) await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('a solo account is told what was archived and how to restore it, once', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    transport = async () => ({ ok: true });
    const solo = await makePerson('solo');
    const a = await idleProject(solo, solo.orgId, 'alpha', 'private');
    const b = await idleProject(solo, solo.orgId, 'beta', 'private');

    await runAutoArchive();

    assert.equal(mailTo(solo.email).length, 1, 'one email per person per run, however many projects');
    const html = mailTo(solo.email)[0].html;
    assert.ok(html.includes(a.name) && html.includes(b.name), 'names every project archived');
    assert.match(html, /manage_projects/, 'says how to restore from an AI tool');
    assert.ok(html.includes(a.id), 'gives the id the restore call takes');
    assert.match(html, /projects\?manage=archived/, 'and where to restore it in the dashboard');
    assert.match(html, /30 days/);

    await runAutoArchive();
    assert.equal(mailTo(solo.email).length, 1, 'a second run has nothing new to say');
});

test('in a team, each project is announced to its author and the owners only', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    const authorA = await makePerson('authora');
    const authorB = await makePerson('authorb');
    const authorC = await makePerson('authorc');
    const viewer = await makePerson('viewer');
    for (const p of [authorA, authorB, authorC]) await join(owner, p, 'member');
    await join(owner, viewer, 'viewer');
    const ws = owner.orgId;

    const priv = await idleProject(authorA, ws, 'priv', 'private');
    const pers = await idleProject(authorB, ws, 'pers', 'personal');
    const shar = await idleProject(authorC, ws, 'shar', 'shared');
    // Fresh work is not archived and not mentioned.
    const fresh = await idleProject(authorC, ws, 'fresh', 'shared', 1);

    await runAutoArchive();

    assert.equal(mailTo(owner.email).length, 1, 'owner: one email');
    assert.ok(mentions(owner.email, priv) && mentions(owner.email, shar), 'owner is told about private and shared work');
    // Restore is the author's while the author is a member. The owner is told
    // the private one was archived and that its author can restore it, and is
    // given the restore call only for what they can restore themselves.
    const ownerHtml = mailTo(owner.email)[0].html;
    assert.match(ownerHtml, /author can restore/i);
    assert.ok(!ownerHtml.includes(priv.id), 'no restore id is offered for a colleague\'s private project');
    assert.ok(ownerHtml.includes(shar.id), 'the shared project is one the owner can restore');
    assert.ok(mailTo(authorA.email)[0].html.includes(priv.id), 'the author is given the id to restore');
    assert.doesNotMatch(mailTo(authorA.email)[0].html, /author can restore/i);
    assert.ok(!mentions(owner.email, pers), 'never about a colleague\'s personal project: an owner may not read it');

    assert.equal(mailTo(authorA.email).length, 1);
    assert.ok(mentions(authorA.email, priv) && !mentions(authorA.email, shar) && !mentions(authorA.email, pers));
    assert.equal(mailTo(authorB.email).length, 1);
    assert.ok(mentions(authorB.email, pers) && !mentions(authorB.email, priv));
    assert.equal(mailTo(authorC.email).length, 1);
    assert.ok(mentions(authorC.email, shar) && !mentions(authorC.email, priv));
    assert.equal(mailTo(viewer.email).length, 0, 'a viewer is not told about work they did not author');
    for (const m of outbox) assert.ok(!m.html.includes(fresh.name), 'a project that was not archived is not mentioned');
});

test('an owner told only about a colleague\'s private project is not told to restore it', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    const author = await makePerson('author');
    await join(owner, author, 'member');
    const priv = await idleProject(author, owner.orgId, 'only-priv', 'private');

    await runAutoArchive();

    const html = mailTo(owner.email)[0].html;
    assert.ok(html.includes(priv.name));
    assert.match(html, /author can restore/i);
    assert.doesNotMatch(html, /manage_projects/, 'nothing here is theirs to restore');
    assert.doesNotMatch(html, /projects\?manage=archived/, 'and no restore button');
    assert.doesNotMatch(mailTo(owner.email)[0].subject, /how to restore/i);
    assert.match(mailTo(author.email)[0].html, /manage_projects/, 'the author is told how');
});

test('when the private project\'s author is no longer a member, the owner can restore it and is told how', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    const author = await makePerson('leaver');
    await join(owner, author, 'member');
    const priv = await idleProject(author, owner.orgId, 'orphan-priv', 'private');
    await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [owner.orgId, author.userId]);

    await runAutoArchive();

    const html = mailTo(owner.email)[0].html;
    assert.ok(html.includes(priv.id));
    assert.match(html, /manage_projects/);
    assert.doesNotMatch(html, /author can restore/i);
    assert.equal(mailTo(author.email).length, 0);
});

// A project written before the identity fix carries its author's KEY id, not
// their user id. The API judges "has the author left" on the person the key
// belongs to (workspace.resolveAuthors); so must this email.
async function stampWithKey(person, projectId) {
    const { prefix, hash } = generateApiKey();
    const keyId = `key-${uuidv4()}`;
    await q(
        `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
         VALUES ($1, $2, $3, 'legacy', $4, $5, 'production', NOW() + interval '1 day', $6)`,
        [keyId, prefix, hash, person.userId, person.orgId, ['context:read', 'context:write']],
    );
    await q('UPDATE context_projects SET owner_user_id = $1 WHERE project_id = $2', [keyId, projectId]);
    return keyId;
}

test('a private project stamped with a member\'s key id is that member\'s: the owner is not told to restore it', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    const author = await makePerson('keyauthor');
    await join(owner, author, 'member');
    const priv = await idleProject(author, owner.orgId, 'key-priv', 'private');
    await stampWithKey(author, priv.id);

    await runAutoArchive();

    const ownerHtml = mailTo(owner.email)[0].html;
    assert.match(ownerHtml, /author can restore/i, 'the key id resolves to an active member');
    assert.doesNotMatch(ownerHtml, /manage_projects/);
    assert.equal(mailTo(author.email).length, 1, 'and the person the key belongs to is told, as the author');
    assert.ok(mailTo(author.email)[0].html.includes(priv.id));
});

test('a private project stamped with the key id of somebody who has left can be restored by the owner', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    const author = await makePerson('keyleaver');
    await join(owner, author, 'member');
    const priv = await idleProject(author, owner.orgId, 'key-orphan', 'private');
    await stampWithKey(author, priv.id);
    await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [owner.orgId, author.userId]);

    await runAutoArchive();

    const html = mailTo(owner.email)[0].html;
    assert.match(html, /manage_projects/);
    assert.ok(html.includes(priv.id));
    assert.equal(mailTo(author.email).length, 0);
});

test('a person who loses projects in two workspaces still gets one email', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    transport = async () => ({ ok: true });
    const ownerA = await makePerson('ownera');
    const ownerB = await makePerson('ownerb');
    const both = await makePerson('both');
    await join(ownerA, both, 'member');
    await join(ownerB, both, 'member');
    const a = await idleProject(both, ownerA.orgId, 'in-a', 'shared');
    const b = await idleProject(both, ownerB.orgId, 'in-b', 'shared');

    await runAutoArchive();

    assert.equal(mailTo(both.email).length, 1);
    assert.ok(mentions(both.email, a) && mentions(both.email, b));
});

test('the same archive is never announced twice, even if the sender is called again', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    transport = async () => ({ ok: true });
    const notices = require('../../src/services/email/autoArchiveNotice');
    const solo = await makePerson('again');
    const p = await idleProject(solo, solo.orgId, 'once', 'private');
    const row = { project_id: p.id, owner_key: solo.orgId, project_name: p.name, visibility: 'private', owner_user_id: solo.userId };
    const archivedAt = new Date().toISOString();

    await notices.sendAutoArchiveNotices([row], { archivedAt, days: 30 });
    await notices.sendAutoArchiveNotices([row], { archivedAt, days: 30 });
    await Promise.all([
        notices.sendAutoArchiveNotices([row], { archivedAt, days: 30 }),
        notices.sendAutoArchiveNotices([row], { archivedAt, days: 30 }),
    ]);

    assert.equal(mailTo(solo.email).length, 1);

    // Restored and idle again is a NEW archive, and is announced.
    await notices.sendAutoArchiveNotices([row], { archivedAt: new Date(Date.now() + 60000).toISOString(), days: 30 });
    assert.equal(mailTo(solo.email).length, 2);
});

test('an unsubscribed person is still told (a service notice), and a personal project whose author left tells nobody', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    transport = async () => ({ ok: true });
    const owner = await makePerson('owner');
    const quiet = await makePerson('quiet');
    const gone = await makePerson('gone');
    await join(owner, quiet, 'member');
    await join(owner, gone, 'member');
    await idleProject(quiet, owner.orgId, 'quiet-one', 'personal');
    const goneProject = await idleProject(gone, owner.orgId, 'gone-one', 'personal');
    await q('UPDATE users SET weekly_digest_unsubscribed = TRUE WHERE user_id = $1', [quiet.userId]);
    await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [owner.orgId, gone.userId]);

    await runAutoArchive();

    assert.equal(mailTo(quiet.email).length, 1, 'unsubscribing covers the digest and nudges, not a notice that their project was archived');
    assert.doesNotMatch(mailTo(quiet.email)[0].html, /email\/unsubscribe/, 'a service notice carries no unsubscribe link');
    assert.match(mailTo(quiet.email)[0].html, /service notice/i);
    assert.equal(mailTo(gone.email).length, 0, 'the author is no longer in the workspace');
    assert.ok(!mentions(owner.email, goneProject), 'and an owner never learns the name of a personal project');
});

test('a failed send does not fail the archive, and nothing is sent when email is not configured', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 archive notice'))) return;
    const solo = await makePerson('fails');
    const p = await idleProject(solo, solo.orgId, 'fails', 'private');
    transport = async () => ({ ok: false, status: 503 });

    const result = await runAutoArchive();
    assert.ok(result.archived >= 1, 'the archive itself still happened');
    const row = await q('SELECT archived_at FROM context_projects WHERE project_id = $1', [p.id]);
    assert.ok(row.rows[0].archived_at);

    const keep = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
        transport = async () => ({ ok: true });
        const other = await makePerson('nokey');
        await idleProject(other, other.orgId, 'nokey', 'private');
        await runAutoArchive();
        assert.equal(mailTo(other.email).length, 0);
    } finally {
        process.env.RESEND_API_KEY = keep;
    }
});
