/**
 * JOURNEY R6 - THE ACTIVATION FOLLOW-UP SAYS "NOTHING SAVED YET" ONLY TO PEOPLE
 * WHO HAVE SAVED NOTHING (owner decision, round 3 table row "Activation
 * follow-up email: 'Nothing saved' only when nothing is saved").
 *
 * The follow-up asked whether the person had RECEIVED value (a brief delivered,
 * a first sync). That is a proxy: somebody who saved through a hosted connector,
 * or into a colleague's team project, and simply had not yet had a brief read
 * back to them, was told their AI "has nothing to tell you" while their own
 * decisions sat in the project. The signal here is the saved content itself, for
 * the PERSON, across every workspace they have written to.
 *
 * Real database, real save paths, a transport that counts; nothing reaches a
 * provider.
 *
 *   DATABASE_URL=... REDIS_URL=... DEERDAWN_TEST_DB_NO_LOCK=1 bash scripts/run-db-test.sh \
 *     node --test --test-concurrency=1 tests/integration/journey-r6-activation-nothing-saved.test.js
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
resendClient.sendEmail = async (message) => {
    outbox.push(message);
    return { ok: true };
};

const productEvents = require('../../src/services/productEventsService');
const { generateApiKey } = require('../../src/utils/security');
const followUp = require('../../src/services/email/activationFollowUp');

const q = (sql, params) => db.query(sql, params, 'org-system');
const created = { orgs: new Set(), users: new Set() };

// Signed up about a day ago: inside the follow-up's 20-44h window.
async function signUp(label) {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const email = `${label}-${uuidv4().slice(0, 8)}@r6activation.test`;
    await q(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type, purchased_seats)
         VALUES ($1, $2, 'developer_pro', 'developer_pro', 'active', 'organization', 5)`,
        [orgId, `${label} workspace`],
    );
    await q(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject, created_at)
         VALUES ($1, $2, 'admin', $3, 'clerk', $4, NOW() - interval '24 hours')`,
        [userId, email, orgId, `sub_${userId}`],
    );
    await workspace.ensureOwnerMembership(orgId, userId);
    created.orgs.add(orgId);
    created.users.add(userId);
    return { label, orgId, userId, email };
}

function actorIn(person, ownerKey) {
    return { type: 'user', id: person.userId, org_id: ownerKey, workspace_key: ownerKey, role: 'member' };
}

// A tool that handshook: the follow-up's "connected" variant (the one that says
// nothing is saved yet).
async function connect(person) {
    await productEvents.recordProductEvent(
        { type: 'user', id: person.userId, org_id: person.orgId },
        { event_name: 'mcp_runtime_started', source: 'mcp', surface: 'test', metadata: {} },
    );
}

const lastMail = (person) => outbox.filter((m) => m.to === person.email).pop();
const got = (person) => outbox.filter((m) => m.to === person.email).length;

after(async () => {
    for (const orgId of created.orgs) {
        await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId]).catch(() => {});
        await q('DELETE FROM context_projects WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId]).catch(() => {});
        await q('DELETE FROM product_events WHERE org_id = $1', [orgId]).catch(() => {});
        await q('DELETE FROM api_keys WHERE org_id = $1', [orgId]).catch(() => {});
    }
    for (const userId of created.users) await q('DELETE FROM users WHERE user_id = $1', [userId]).catch(() => {});
    for (const orgId of created.orgs) await q('DELETE FROM organizations WHERE org_id = $1', [orgId]).catch(() => {});
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('a person who has saved nothing still gets the follow-up', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 activation'))) return;
    // The context tables are created lazily by the store; on a brand-new database
    // nothing has touched it yet and the follow-up's query would find no table.
    await require('../../src/store/contextSyncStore').ensureSchema();
    const nothing = await signUp('nothing');

    await followUp.sendActivationFollowUpEmails();

    assert.equal(got(nothing), 1, 'the fixture must be a real recipient, or the rest of this file proves nothing');
});

test('somebody who saved through a hosted connector is not told nothing is saved', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 activation'))) return;
    const saver = await signUp('hostedsaver');
    await connect(saver);
    const actor = actorIn(saver, saver.orgId);
    const project = await service.createProject(actor, { project_name: `hosted-${uuidv4().slice(0, 6)}` });
    // The hosted manage_memory update path: recordExplicitUpdate with a summary.
    const outcome = await service.recordExplicitUpdate(actor, {
        session_id: `sess-${uuidv4()}`,
        tool: 'claude_web',
        project_id: project.project_id,
        summary: 'We decided to ship the importer behind a flag.',
        extraction: { delta: { current_status: 'Importer behind a flag' }, confidence: 0.9 },
    });
    assert.ok(outcome.project, 'the save must have landed');

    await followUp.sendActivationFollowUpEmails();

    assert.equal(got(saver), 0, 'a hosted save is a save, whether or not a brief has been read back yet');
});

test('somebody who saved only into a colleague\'s team project is not told nothing is saved', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 activation'))) return;
    const owner = await signUp('teamowner');
    const member = await signUp('teammember');
    await connect(member);
    const invite = await workspace.createInvite(owner.orgId, member.email, { role: 'member', invitedBy: owner.userId });
    const accepted = await workspace.acceptInvite(invite.token, { id: member.userId, email: member.email });
    assert.equal(accepted.ok, true, accepted.reason);
    const project = await service.createProject(actorIn(owner, owner.orgId), { project_name: `team-${uuidv4().slice(0, 6)}` });
    await q('UPDATE context_projects SET visibility = \'shared\' WHERE project_id = $1', [project.project_id]);
    // The member's own personal workspace stays empty: everything they wrote is
    // in the team's project, under the team's key.
    await service.applyStructuredContextEvent(actorIn(member, owner.orgId), {
        event_type: 'decision_made',
        project_id: project.project_id,
        summary: 'Use the queue for retries.',
        metadata: { surface: 'claude_web' },
    });

    await followUp.sendActivationFollowUpEmails();

    assert.equal(got(member), 0, 'a team save counts for the person who made it');
});

test('a connected person who created a project is not told nothing is saved', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 activation'))) return;
    const maker = await signUp('maker');
    await connect(maker);
    await service.createProject(actorIn(maker, maker.orgId), { project_name: `made-${uuidv4().slice(0, 6)}`, description: 'Their own words.' });

    await followUp.sendActivationFollowUpEmails();

    assert.equal(got(maker), 0);
});

test('somebody who saved but never connected a tool still gets "connect a tool", worded without "nothing saved"', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 activation'))) return;
    const saver = await signUp('dashsaver');
    await service.createProject(actorIn(saver, saver.orgId), { project_name: `dash-${uuidv4().slice(0, 6)}`, description: 'Written in the dashboard.' });
    const nothing = await signUp('stillnothing');

    await followUp.sendActivationFollowUpEmails();

    assert.equal(got(saver), 1, 'they still need to connect a tool');
    const mail = lastMail(saver);
    assert.match(mail.html, /Connect your first tool/);
    assert.doesNotMatch(mail.html, /nothing saved|something to remember|nothing to tell|first brief/i, 'they have saved something; the copy must not say otherwise');
    assert.doesNotMatch(mail.subject, /first brief|nothing/i);
    assert.match(mail.html, /dd_email=activation_followup_unconnected_saved/, 'measured separately from the never-saved variant');

    // The never-saved, never-connected reader keeps the copy they always had.
    assert.equal(got(nothing), 1);
    assert.match(lastMail(nothing).html, /something to remember/);
});

test('a project stamped with the person\'s KEY id (written before the identity fix) is theirs', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 activation'))) return;
    const legacy = await signUp('keystamped');
    await connect(legacy);
    const project = await service.createProject(actorIn(legacy, legacy.orgId), { project_name: `key-${uuidv4().slice(0, 6)}` });
    const { prefix, hash } = generateApiKey();
    const keyId = `key-${uuidv4()}`;
    await q(
        `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
         VALUES ($1, $2, $3, 'legacy', $4, $5, 'production', NOW() + interval '1 day', $6)`,
        [keyId, prefix, hash, legacy.userId, legacy.orgId, ['context:read', 'context:write']],
    );
    await q('UPDATE context_projects SET owner_user_id = $1 WHERE project_id = $2', [keyId, project.project_id]);
    await q('UPDATE context_events SET contributing_user_id = $1 WHERE project_id = $2', [keyId, project.project_id]);

    await followUp.sendActivationFollowUpEmails();

    assert.equal(got(legacy), 0, 'work stamped with their key id is their saved work');
});

test('a colleague\'s save does not stand in for the person\'s own', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 activation'))) return;
    const owner = await signUp('busyowner');
    await connect(owner);
    const bystander = await signUp('bystander');
    const invite = await workspace.createInvite(owner.orgId, bystander.email, { role: 'member', invitedBy: owner.userId });
    const accepted = await workspace.acceptInvite(invite.token, { id: bystander.userId, email: bystander.email });
    assert.equal(accepted.ok, true, accepted.reason);
    const project = await service.createProject(actorIn(owner, owner.orgId), { project_name: `busy-${uuidv4().slice(0, 6)}` });
    await service.applyStructuredContextEvent(actorIn(owner, owner.orgId), {
        event_type: 'decision_made',
        project_id: project.project_id,
        summary: 'The owner decided something.',
        metadata: { surface: 'claude_web' },
    });

    await followUp.sendActivationFollowUpEmails();

    assert.equal(got(owner), 0);
    assert.equal(got(bystander), 1, 'the person who saved nothing is still told so');
});

test('an activation event still suppresses it, and an email already sent is not repeated', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'r6 activation'))) return;
    const delivered = await signUp('delivered');
    await productEvents.recordProductEvent(
        { type: 'user', id: delivered.userId, org_id: delivered.orgId },
        { event_name: 'context_delivered', source: 'api', surface: 'test', metadata: {} },
    );
    const again = await signUp('again');

    await followUp.sendActivationFollowUpEmails();
    await followUp.sendActivationFollowUpEmails();

    assert.equal(got(delivered), 0);
    assert.equal(got(again), 1, 'sent once, then the marker holds');
});
