'use strict';

/**
 * DELETING YOUR ACCOUNT REACHES INTO OTHER PEOPLE'S WORKSPACES. IT MUST SAY SO.
 *
 * purgeOwnerData sweeps by owner_key — the person's own workspace — and then,
 * correctly, by PERSON: their membership rows, access logs and product events in
 * workspaces belonging to other people are still their data. But the person-keyed
 * sweep and the workspace-keyed sweep were doing two different jobs and only one
 * of them was finished.
 *
 *   1. THE CREDENTIALS DID NOT FOLLOW. Key hashes were enumerated with
 *      `WHERE org_id = $ownerKey`, and api_keys rows are deleted by org_id too —
 *      so a key the person minted INSIDE somebody else's workspace (keys.js
 *      stamps a key with the resolved workspace, which is the whole point of it)
 *      was neither deleted, nor revoked, nor evicted from the auth cache. Their
 *      roster row vanished from that team while the credential that had been
 *      acting there kept working. Removal without revocation is the exact failure
 *      DELETE /teams/members/:userId already names.
 *
 *   2. NOBODY WAS TOLD THE WORKSPACE LOST ITS OWNER. Hard-deleting the
 *      memberships can take the last owner off a workspace that still has
 *      members, projects and a subscription — nobody left who can invite, bill,
 *      or reach the erased person's projects. #484 chose RETAIN-AND-REPORT for
 *      exactly this shape of problem on the Clerk path
 *      (`erasure_skipped_shared_workspace`), and for the same reason: promoting
 *      somebody automatically is a privilege grant, and a privilege grant is a
 *      decision a human takes. The same choice has to be made visible here.
 *
 * Behavioural, through an injected query function: no database, and the
 * assertions are about which side effects a purge produces.
 */

process.env.DISABLE_REDIS = 'true';

const { test } = require('node:test');
const assert = require('node:assert');

// Stubs installed before dataErasureService destructures them at load time.
const reportSwallowedModule = require('../../src/utils/reportSwallowed');
const reports = [];
reportSwallowedModule.reportSwallowed = (error, meta) => {
    reports.push({ message: error?.message, ...meta });
};

const apiKeyCache = require('../../src/services/apiKeyCache');
const invalidated = [];
apiKeyCache.invalidateApiKey = async (hash) => { invalidated.push(hash); };

const posthog = require('../../src/services/posthog');
posthog.captureProductEvent = () => {};

const erasure = require('../../src/services/dataErasureService');

const MINE = 'org-mine';
const THEIRS = 'org-theirs';
const ME = 'user-me';

// Every key this person holds, in every workspace. The one in THEIRS is the
// credential that used to survive its owner.
const KEYS = [
    { key_hash: 'hash-own-workspace', org_id: MINE },
    { key_hash: 'hash-their-workspace', org_id: THEIRS },
];

const ORG_NAMES = { [THEIRS]: 'Acme Engineering' };

function makeQuery({ myRoleThere = 'owner', otherOwnersThere = 0, foreignMemberships = null } = {}) {
    const foreign = foreignMemberships || [{ owner_key: THEIRS, role: myRoleThere }];
    const calls = [];
    const query = async (rawSql, params = []) => {
        // Normalized: these statements are written across several lines, and a
        // stub that only matches the single-line spelling silently falls through
        // to "no rows" — which reads exactly like the bug it is meant to catch.
        const sql = rawSql.replace(/\s+/g, ' ').trim();
        calls.push({ sql, params });

        if (/SELECT key_hash FROM api_keys WHERE org_id/.test(sql)) {
            return { rows: KEYS.filter((k) => k.org_id === params[0]).map(({ key_hash }) => ({ key_hash })) };
        }
        if (/SELECT key_hash FROM api_keys WHERE owner_id/.test(sql)) {
            return { rows: KEYS.map(({ key_hash }) => ({ key_hash })) };
        }
        if (/SELECT user_id FROM users WHERE org_id/.test(sql)) {
            return { rows: [{ user_id: ME }] };
        }
        // The workspaces this person belongs to that are not their own.
        if (/FROM workspace_members WHERE user_id/.test(sql) && /SELECT/.test(sql)) {
            return { rows: foreign };
        }
        // Their names, read before the membership rows go.
        if (/SELECT org_id, name FROM organizations WHERE org_id = ANY/.test(sql)) {
            return { rows: (params[0] || []).map((id) => ({ org_id: id, name: ORG_NAMES[id] || null })) };
        }
        // How many owners THEIRS still has once this person is gone.
        if (/FROM workspace_members WHERE owner_key/.test(sql) && /SELECT/.test(sql)) {
            return { rows: [{ owner_key: THEIRS, owners: otherOwnersThere }], rowCount: 1 };
        }
        if (/FROM context_projects WHERE owner_user_id/.test(sql) && /SELECT/.test(sql)) {
            return { rows: [{ owner_key: THEIRS, projects: 2 }] };
        }
        return { rows: [], rowCount: 0 };
    };
    query.calls = calls;
    return query;
}

function reset() {
    reports.length = 0;
    invalidated.length = 0;
}

test('a key the erased person holds in SOMEBODY ELSE\'S workspace is revoked and un-cached', async () => {
    reset();
    const query = makeQuery();

    await erasure.purgeOwnerData(MINE, { query });

    assert.ok(
        invalidated.includes('hash-their-workspace'),
        'the auth cache went on serving a credential whose owner had been erased, in a workspace ' +
        'the purge never touched — requireAuth reads that cache before the database'
    );
    const revokes = query.calls.filter(({ sql }) => /api_keys/.test(sql) && /owner_id/.test(sql) && /(DELETE|UPDATE)/.test(sql));
    assert.ok(
        revokes.length > 0,
        'stripping somebody from a roster while their key keeps reading and writing that workspace ' +
        'is removal without revocation — the failure DELETE /teams/members/:userId already names'
    );
});

test('the credentials go before the roster row that justified them', async () => {
    reset();
    const query = makeQuery();

    await erasure.purgeOwnerData(MINE, { query });

    const order = query.calls.map(({ sql }) => sql);
    const keysAt = order.findIndex((sql) => /api_keys/.test(sql) && /owner_id/.test(sql) && /(DELETE|UPDATE)/.test(sql));
    const membershipAt = order.findIndex((sql) => /DELETE FROM workspace_members WHERE user_id/.test(sql));

    assert.ok(keysAt > -1 && membershipAt > -1, 'both sweeps must happen');
    assert.ok(
        keysAt < membershipAt,
        'the membership is what records that this credential belonged in that workspace; deleting it ' +
        'first leaves a live key nothing points at'
    );
});

test('a workspace left with no owner is reported, not silently orphaned', async () => {
    reset();
    const query = makeQuery({ myRoleThere: 'owner', otherOwnersThere: 0 });

    await erasure.purgeOwnerData(MINE, { query });

    const orphan = reports.find((r) => r.op === 'erasure_left_workspace_ownerless');
    assert.ok(
        orphan,
        'an erased founder can take the last owner off a workspace that still has members, projects ' +
        'and a subscription. #484 reports erasure_skipped_shared_workspace rather than auto-promoting ' +
        'somebody, because a privilege grant is a decision a human takes — the same is true here'
    );
    assert.strictEqual(orphan.meta?.org_id, THEIRS);
    assert.strictEqual(orphan.meta?.orphaned_projects, 2, 'and how much work is now unreachable');
});

test('a workspace that still has an owner is not reported', async () => {
    reset();
    const query = makeQuery({ myRoleThere: 'owner', otherOwnersThere: 1 });

    await erasure.purgeOwnerData(MINE, { query });

    assert.strictEqual(
        reports.find((r) => r.op === 'erasure_left_workspace_ownerless'),
        undefined,
        'a report nobody needs to act on trains people to ignore the ones they do'
    );
});

test('leaving a workspace you were only a member of is not an ownership event', async () => {
    reset();
    const query = makeQuery({ myRoleThere: 'member', otherOwnersThere: 0 });

    await erasure.purgeOwnerData(MINE, { query });

    assert.strictEqual(
        reports.find((r) => r.op === 'erasure_left_workspace_ownerless'),
        undefined,
        'a member leaving takes no authority with them'
    );
});

/**
 * AND THE PERSON DOING IT HAS TO BE TOLD.
 *
 * What is deleted is deliberate and unchanged. What was NOT said is that
 * deleting "your account" takes you off every roster you were on and revokes
 * your keys there — rows in other people's workspaces that change. The counts
 * recording it are table names (`workspace_members_by_user`,
 * `api_keys_by_owner`), which nobody reads as "you left Acme Engineering", so
 * the workspaces have to come back named.
 */
test('the purge reports which workspaces the person was removed from, by name', async () => {
    reset();
    const query = makeQuery({ myRoleThere: 'member', otherOwnersThere: 1 });

    const deleted = await erasure.purgeOwnerData(MINE, { query });

    assert.deepStrictEqual(
        deleted.leftWorkspaces,
        [{ key: THEIRS, name: 'Acme Engineering' }],
        'THE BUG: the memberships were deleted and nothing named the teams they were in'
    );
    // The counts that record the same thing were already there, and stay.
    assert.ok('workspace_members_by_user' in deleted);
    assert.ok('api_keys_by_owner' in deleted);
    // Still a plain per-table report on the wire: the list is not a count and
    // must not appear among them.
    assert.ok(
        !Object.keys(deleted).includes('leftWorkspaces'),
        'deleted_counts is serialised as-is, so a non-count key would show up there'
    );
});

test('a solo account reports no workspaces left, not a missing field', async () => {
    reset();
    const query = makeQuery({ foreignMemberships: [] });

    const deleted = await erasure.purgeOwnerData(MINE, { query });

    assert.deepStrictEqual(deleted.leftWorkspaces, []);
});
