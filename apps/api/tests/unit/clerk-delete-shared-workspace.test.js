'use strict';

/**
 * A FOUNDER DELETING THEIR CLERK IDENTITY MUST NOT DESTROY THEIR COLLEAGUES' WORK.
 *
 * `users.org_id` does not enumerate a workspace. An invited teammate's users row
 * still points at their own personal org — that is why workspace_members exists
 * at all — so the webhook's "is anyone left in this org?" check
 * (`SELECT 1 FROM users WHERE org_id = $1`) returns nothing for every shared
 * workspace, however many people are working in it.
 *
 * Both interactive delete routes already refuse while a workspace has other
 * members (409 workspace_has_members). This path cannot refuse — the Clerk
 * identity is gone and there is nobody left to retry — so it must instead erase
 * the PERSON and retain the WORKSPACE.
 *
 * Behavioural, not source-text: the assertions are about which side effects a
 * real signed webhook delivery produces, so they survive the handler being
 * rewritten.
 */

process.env.DISABLE_REDIS = 'true';
process.env.CLERK_WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { Webhook } = require('svix');

// ── stubs, installed before the router destructures them at load time ────────

const db = require('../../src/config/db');
const erasure = require('../../src/services/dataErasureService');
const stripeService = require('../../src/services/stripeService');
const workspace = require('../../src/services/workspaceService');
const apiKeyCache = require('../../src/services/apiKeyCache');
// The router destructures this at load time, so the stub has to be installed
// before the require below.
const reportSwallowedModule = require('../../src/utils/reportSwallowed');
reportSwallowedModule.reportSwallowed = (error, meta = {}) => {
    state?.reports?.push({ message: error?.message, ...meta });
};

const TEAM = 'org-team-aaaa';
const FOUNDER = 'user-founder';
// The credential the erased person is holding right now. requireAuth reads the
// 5-minute LRU before it reads the database, so this hash — not the row — is
// what decides whether their agent loop keeps working after the erasure.
const FOUNDER_KEY_HASH = 'hash-of-the-founders-live-key';

let state;

function resetState() {
    state = {
        purged: [],
        orgDeletes: [],
        keyRevocations: [],
        keyHashReads: [],
        usersDeleted: false,
        forgotten: [],
        reports: [],
        activeMembers: 0,
        usersLeftInOrg: 0,
        subscriptionCancels: [],
        queries: [],
    };
}

db.query = async (sql, params = []) => {
    state.queries.push({ sql, params });
    if (/SELECT user_id, org_id FROM users WHERE auth_subject/.test(sql)) {
        return { rows: [{ user_id: FOUNDER, org_id: TEAM }], rowCount: 1 };
    }
    if (/^\s*DELETE FROM users WHERE auth_subject/.test(sql)) {
        // The FK on api_keys.owner_id points at this row. Once it is gone the
        // keys are gone with it (cascade) or the DELETE itself fails — either
        // way a revoke issued afterwards matches nothing, which is the whole
        // defect. The stub models the survivable half: the rows vanish.
        state.usersDeleted = true;
        return { rows: [], rowCount: 1 };
    }
    if (/SELECT key_hash FROM api_keys WHERE owner_id/.test(sql)) {
        state.keyHashReads.push(params);
        return state.usersDeleted
            ? { rows: [], rowCount: 0 }
            : { rows: [{ key_hash: FOUNDER_KEY_HASH }], rowCount: 1 };
    }
    if (/UPDATE api_keys SET status/.test(sql)) {
        state.keyRevocations.push(params);
        return { rows: [], rowCount: state.usersDeleted ? 0 : 2 };
    }
    if (/SELECT 1 FROM users WHERE org_id/.test(sql)) {
        return { rows: new Array(state.usersLeftInOrg).fill({ '?column?': 1 }), rowCount: state.usersLeftInOrg };
    }
    if (/DELETE FROM organizations/.test(sql)) {
        state.orgDeletes.push(params[0]);
        return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
};

erasure.purgeOwnerData = async (ownerKey) => {
    state.purged.push(ownerKey);
    return {};
};

stripeService.cancelSubscriptionForDeletion = async (orgId) => {
    state.subscriptionCancels.push(orgId);
    return { ok: true, cancelled: true };
};

workspace.countActiveMembers = async () => state.activeMembers;
workspace.forgetPerson = async (userId) => {
    state.forgotten.push(userId);
    return 1;
};

const webhookRouter = require('../../src/routes/auth-webhooks');

function app() {
    const a = express();
    a.use('/webhooks', webhookRouter);
    return a;
}

let eventSeq = 0;

async function deliverUserDeleted() {
    const payload = JSON.stringify({
        id: `evt_${++eventSeq}_${Date.now()}`,
        type: 'user.deleted',
        data: { id: 'clerk_user_founder', email_addresses: [] },
    });
    const msgId = `msg_${eventSeq}_${Date.now()}`;
    const timestamp = new Date();
    const signature = new Webhook(process.env.CLERK_WEBHOOK_SECRET).sign(msgId, timestamp, payload);

    return request(app())
        .post('/webhooks/clerk')
        .set('svix-id', msgId)
        .set('svix-timestamp', String(Math.floor(timestamp.getTime() / 1000)))
        .set('svix-signature', signature)
        .set('content-type', 'application/json')
        .send(payload);
}

// ── the defect ───────────────────────────────────────────────────────────────

test('a founder deleting their identity does NOT purge a workspace others are in', async () => {
    resetState();
    state.activeMembers = 3;     // two colleagues, plus the founder's own row
    state.usersLeftInOrg = 0;    // and every one of them has their own personal org_id

    const res = await deliverUserDeleted();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(state.purged, [],
        'the team workspace was purged because users.org_id found nobody left in it');
    assert.deepStrictEqual(state.orgDeletes, [],
        'the organizations row for a workspace other people are still working in was deleted');
    assert.deepStrictEqual(state.subscriptionCancels, [],
        'the surviving team\'s subscription was cancelled out from under them');
});

test('the deleted PERSON is still erased: keys revoked, memberships dropped', async () => {
    resetState();
    state.activeMembers = 3;
    state.usersLeftInOrg = 0;

    await deliverUserDeleted();

    assert.ok(
        state.keyRevocations.some(([userId, status]) => userId === FOUNDER && status === 'revoked'),
        'a deleted identity\'s API keys keep reading and writing the workspace over MCP unless revoked'
    );
    assert.deepStrictEqual(state.forgotten, [FOUNDER],
        'the deleted person\'s workspace memberships must go, or they hold a seat forever');
});

// ── the ordering defect: a revoke that ran after the cascade ─────────────────
//
// api_keys.owner_id has a foreign key onto users.user_id. The handler deleted
// the users row FIRST and revoked afterwards, so by the time the UPDATE ran the
// key rows were already gone (or the DELETE itself had failed on the
// constraint). Either way the revoke matched nothing — and because nothing was
// matched, nothing was ever read back to invalidate: requireAuth's 5-minute LRU
// kept serving the erased person's key against a RETAINED team workspace for up
// to the full TTL. It reported success the whole time.

test('keys are read, revoked and un-cached BEFORE the users row is deleted', async () => {
    resetState();
    state.activeMembers = 3;
    state.usersLeftInOrg = 0;

    await deliverUserDeleted();

    const order = state.queries.map(({ sql }) => sql);
    const usersDeletedAt = order.findIndex((sql) => /^\s*DELETE FROM users WHERE auth_subject/.test(sql));
    const hashesReadAt = order.findIndex((sql) => /SELECT key_hash FROM api_keys WHERE owner_id/.test(sql));
    const revokedAt = order.findIndex((sql) => /UPDATE api_keys SET status/.test(sql));

    assert.ok(usersDeletedAt > -1, 'the users row must still be deleted');
    assert.ok(hashesReadAt > -1, 'the live key hashes have to be enumerated, or none can be invalidated');
    assert.ok(
        hashesReadAt < usersDeletedAt,
        'the key hashes must be read while the rows still exist: api_keys.owner_id references ' +
        'users.user_id, so after the DELETE there is nothing left to enumerate'
    );
    assert.ok(
        revokedAt < usersDeletedAt,
        'the revoke must run before the row it depends on is deleted, or it matches nothing and ' +
        'reports a clean erasure that revoked no credential at all'
    );
});

test('the key cache stops serving an erased person\'s credential', async () => {
    resetState();
    state.activeMembers = 3;     // a RETAINED workspace: the key still resolves to something
    state.usersLeftInOrg = 0;
    apiKeyCache.setApiKey(FOUNDER_KEY_HASH, { key_id: 'key-founder', owner_id: FOUNDER, org_id: TEAM });
    assert.ok(apiKeyCache.getApiKey(FOUNDER_KEY_HASH), 'precondition: the cache is holding the key');

    await deliverUserDeleted();

    assert.strictEqual(
        apiKeyCache.getApiKey(FOUNDER_KEY_HASH),
        undefined,
        'requireAuth reads this cache before the database, so an erased person\'s key kept working ' +
        'against their colleagues\' workspace for up to the 5-minute TTL — a credential outliving ' +
        'the account it belongs to, which is exactly what the erasure was for'
    );
});

test('a retained workspace says whether anyone is left who can administer it', async () => {
    // forgetPerson has just hard-deleted the founder's membership, so the
    // retained workspace frequently has no owner at all: nobody who can invite,
    // bill, or reach the projects the erased person authored there. A report
    // that says only "3 members remain" reads like a healthy team.
    resetState();
    state.activeMembers = 3;
    state.usersLeftInOrg = 0;
    const realCountActiveOwners = workspace.countActiveOwners;
    workspace.countActiveOwners = async () => 0;

    try {
        await deliverUserDeleted();
    } finally {
        workspace.countActiveOwners = realCountActiveOwners;
    }

    const retained = state.reports.find((r) => r.op === 'erasure_skipped_shared_workspace');
    assert.ok(retained, 'the retained workspace must still be reported');
    assert.strictEqual(retained.meta.owners_remaining, 0,
        'the fact a human has to act on is that nobody owns it, not how many members it has');
    assert.match(retained.message, /NO OWNER/,
        'and the sentence has to say so, or the report is filed next to the healthy ones');
});

test('a genuinely solo workspace is still purged (right to erasure is not weakened)', async () => {
    resetState();
    state.activeMembers = 0;     // forgetPerson has already dropped the founder's own row
    state.usersLeftInOrg = 0;

    const res = await deliverUserDeleted();

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(state.purged, [TEAM], 'a solo account must still be fully erased');
    assert.deepStrictEqual(state.orgDeletes, [TEAM]);
    assert.deepStrictEqual(state.subscriptionCancels, [TEAM],
        'and its subscription still has to be cancelled, or a deleted account keeps being billed');
});

test('the member count failing means SKIP the purge, not perform it', async () => {
    // Fail closed. An unpurged workspace is a support ticket; a wrongly purged
    // one is not recoverable, so a database blip must not be able to cause one.
    resetState();
    state.usersLeftInOrg = 0;
    workspace.countActiveMembers = async () => { throw new Error('db breaker open'); };

    try {
        const res = await deliverUserDeleted();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(state.purged, [],
            'an unreadable member count was treated as "nobody is here", which is the destructive reading');
    } finally {
        workspace.countActiveMembers = async () => state.activeMembers;
    }
});
