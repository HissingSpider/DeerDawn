'use strict';

/**
 * AT THE SEAT CAP, RE-SENDING AN INVITATION WAS REFUSED BY ITSELF.
 *
 * The invite link is shown exactly once, so re-sending to the same address is
 * the ordinary way to get it to somebody who lost it. The seat gate counts
 * active members plus PENDING INVITES — correctly, or the cap would be evaded
 * by sending them all at once — and counted the very invitation being
 * refreshed, so a full workspace 402'd with "Upgrade to add another person" for
 * a person who already had a seat spent on them. The owner's only way through
 * was to revoke and re-invite: the same seat, two round trips, and a dead link
 * already sitting in somebody's inbox.
 *
 * Route-level, against a stubbed workspace and database, so the arithmetic is
 * exercised rather than described.
 *
 * Run: node --test tests/unit/team-invite-resend.test.js
 */

process.env.DISABLE_REDIS = 'true';
process.env.DASHBOARD_URL = 'https://app.deerdawn.com';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const DB_PATH = require.resolve('../../src/config/db');
const AUTH_PATH = require.resolve('../../src/middleware/auth');
const WORKSPACE_PATH = require.resolve('../../src/services/workspaceService');
const EMAIL_PATH = require.resolve('../../src/services/email/resendClient');
const TEAMS_PATH = require.resolve('../../src/routes/shared/teams');

const ORG_ID = 'org-team-invites';

// ONE mutable scenario rather than a closure per load. entitlementService is
// deliberately the real thing (the seat cap is its arithmetic), and it holds the
// db module it was first required with — so a fresh stub per load would leave
// the seat count reading whatever the first test set it to.
const scenario = { seats: 2, members: 1, pending: [], emailSent: true };

async function query(sql) {
    if (/FROM organizations/.test(sql)) {
        return {
            rows: [{
                org_id: ORG_ID,
                name: 'Payments team',
                plan_tier: 'developer_pro',
                subscription_status: 'active',
                referral_premium_until: null,
                purchased_seats: scenario.seats,
                stripe_subscription_id: 'sub_team_1',
            }],
        };
    }
    if (/FROM users/.test(sql)) return { rows: [{ user_id: 'user-invitee', email: 'owner@example.com' }] };
    return { rows: [] };
}

/** A Team workspace with `seats` bought, `members` in it and `pending` invitations out. */
function loadTeamsRoute({ seats = 2, members = 1, pending = [], emailSent = true } = {}) {
    const calls = { created: [], emails: [] };
    Object.assign(scenario, { seats, members, pending, emailSent });

    for (const p of [TEAMS_PATH, DB_PATH, AUTH_PATH, WORKSPACE_PATH, EMAIL_PATH]) delete require.cache[p];
    const stub = (path, exports) => { require.cache[path] = { id: path, filename: path, loaded: true, exports }; };

    stub(DB_PATH, { query, pool: { connect: async () => ({ query, release() {} }) } });
    stub(AUTH_PATH, {
        requireAuth: (req, _res, next) => {
            req.actor = { id: 'user-1', org_id: ORG_ID, workspace_key: ORG_ID, email: 'owner@example.com' };
            next();
        },
    });
    stub(WORKSPACE_PATH, {
        ROLES: ['owner', 'member', 'viewer'],
        defaultOwnerKey: (actor) => actor?.workspace_key || actor?.org_id || null,
        resolveRole: async () => 'owner',
        canAdminister: (role) => role === 'owner',
        actorPersonId: (actor) => actor?.id || null,
        countActiveMembers: async () => scenario.members,
        listInvites: async () => scenario.pending.map((email, i) => ({ invite_id: `winv_${i}`, email, role: 'member', status: 'pending' })),
        listMembers: async () => [{ user_id: 'user-1', email: 'owner@example.com', role: 'owner', active: true }],
        createInvite: async (ownerKey, email, opts) => {
            calls.created.push({ ownerKey, email, opts });
            return {
                invite_id: 'winv_refreshed',
                token: 'tok_refreshed',
                expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
                email,
                role: opts?.role || 'member',
            };
        },
    });
    stub(EMAIL_PATH, {
        // The shape resendClient answers with: `ok` is what the route reads.
        sendEmail: async (message) => {
            calls.emails.push(message);
            return scenario.emailSent ? { ok: true } : { ok: false, reason: 'no_sender_configured' };
        },
    });

    return { router: require(TEAMS_PATH), calls };
}

async function postInvite(router, body) {
    const app = express();
    app.use(express.json());
    app.use('/teams', router);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/teams/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        server.close();
    }
}

test('re-sending an invitation at the seat cap does not count it against itself', async () => {
    // Two seats, one member, one invitation already out to marcus. Every seat is
    // spent — and one of them is spent on the very person being re-invited.
    const { router, calls } = loadTeamsRoute({ seats: 2, members: 1, pending: ['marcus@example.com'] });

    const res = await postInvite(router, { email: 'marcus@example.com', role: 'member' });

    assert.strictEqual(res.status, 201,
        `THE BUG: the pending invitation was counted against itself: ${JSON.stringify(res.body)}`);
    assert.strictEqual(calls.created.length, 1, 'the invitation is refreshed, which is what re-sending means');
    assert.strictEqual(calls.created[0].email, 'marcus@example.com');
    assert.strictEqual(res.body.resent, true, 'the caller has to be able to say "re-sent" rather than "invited"');
    assert.ok(res.body.invite_link.includes('tok_refreshed'), 'the refreshed token is what the new link carries');
    assert.strictEqual(res.body.email_sent, true);
});

test('a resend is matched on the address, whatever case it was typed in', async () => {
    const { router } = loadTeamsRoute({ seats: 2, members: 1, pending: ['marcus@example.com'] });
    const res = await postInvite(router, { email: '  Marcus@Example.com ', role: 'member' });

    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.resent, true);
});

test('a NEW address at the seat cap is still refused', async () => {
    // The exemption is for a seat already spent. Growing past what the workspace
    // bought is the thing the gate exists to stop.
    const { router, calls } = loadTeamsRoute({ seats: 2, members: 1, pending: ['marcus@example.com'] });
    const res = await postInvite(router, { email: 'priya@example.com', role: 'member' });

    assert.strictEqual(res.status, 402, JSON.stringify(res.body));
    assert.strictEqual(res.body.upgrade_required, true);
    assert.strictEqual(calls.created.length, 0, 'nothing may be written when the seat is refused');
});

test('a resend that nobody could be emailed says so', async () => {
    // email_sent is the difference between "they have been told" and "the link
    // below is the only way this reaches them", and a resend is exactly the case
    // where that matters.
    const { router } = loadTeamsRoute({ seats: 2, members: 1, pending: ['marcus@example.com'], emailSent: false });
    const res = await postInvite(router, { email: 'marcus@example.com', role: 'member' });

    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.email_sent, false);
    assert.strictEqual(res.body.resent, true);
});

test('a first invitation under the cap is unchanged', async () => {
    const { router, calls } = loadTeamsRoute({ seats: 5, members: 2, pending: [] });
    const res = await postInvite(router, { email: 'priya@example.com', role: 'member' });

    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.resent, false);
    assert.strictEqual(calls.created.length, 1);
});
